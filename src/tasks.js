// src/tasks.js
// TaskRegistry：跟踪所有会话的状态。
//
// 关键点：
//   - 不是自己造一套 id，直接用 sessionId 作为 taskId。
//   - 状态更新有两个来源：
//       a) events.js 收到的 $events emit（增量）
//       b) tracker.js 的后台轮询（兜底，防止事件丢）
//   - updatedAt 只在状态真变化时更新（否则全是"2 秒前"）
//   - 落盘用 JSON，重启不丢。

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const FLUSH_INTERVAL_MS = 2000;

class TaskRegistry {
  constructor({ persistPath } = {}) {
    this.persistPath = persistPath || null;
    this.tasks = new Map();          // sessionId -> TaskRecord
    this.listeners = new Set();
    this._dirty = false;
    this._flushTimer = null;

    if (this.persistPath) this._load();
    this._startFlushTimer();
  }

  // ---------- 读写 ----------

  get(sessionId) { return this.tasks.get(sessionId) || null; }

  list() {
    return Array.from(this.tasks.values())
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  upsert(sessionId, patch) {
    let t = this.tasks.get(sessionId);
    const isNew = !t;

    if (!t) {
      t = {
        sessionId,
        title: null,
        cwd: null,
        status: 'unknown',            // running | idle | waiting-approval | done | failed | cancelled | unknown
        running: false,
        lastSeq: 0,
        lastActivityAt: null,
        lastAssistantText: null,
        pendingApprovals: [],         // [{ eventId, toolName, reason, requestedAt }]
        lastError: null,
        model: null,
        sandbox: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        closedAt: null,
      };
      this.tasks.set(sessionId, t);
    }

    // 判断状态是否真变化
    const statusChanged =
      isNew ||
      ('status' in patch && patch.status !== t.status) ||
      ('running' in patch && patch.running !== t.running);

    Object.assign(t, patch);

    // updatedAt 只在状态变化时刷新
    if (statusChanged) {
      t.updatedAt = Date.now();
    }
    if (!t.updatedAt) t.updatedAt = Date.now();

    this._dirty = true;
    this._emit(t);
    return t;
  }

  remove(sessionId) {
    if (this.tasks.delete(sessionId)) {
      this._dirty = true;
      this._emit({ sessionId, status: 'removed' });
    }
  }

  // ---------- 事件驱动 ----------

  // 处理 $events 转发的 emit 事件
  applyEvent(event, args) {
    try {
      switch (event) {
        case 'api-session/added': {
          const s = args?.[0] || {};
          if (s.sessionId) this.upsert(s.sessionId, {
            cwd: s.cwd, running: s.running,
            status: s.running ? 'running' : 'idle',
          });
          break;
        }

        case 'api-session/removed': {
          const s = args?.[0] || {};
          if (s.sessionId) this.remove(s.sessionId);
          break;
        }

        case 'api-session/status': {
          const s = args?.[0] || {};
          if (!s.sessionId) break;
          this.upsert(s.sessionId, {
            running: !!s.running,
            status: s.running ? 'running' : 'idle',
          });
          break;
        }

        case 'api-session/activity': {
          const s = args?.[0] || {};
          if (!s.sessionId) break;
          this.upsert(s.sessionId, { lastActivityAt: Date.now() });
          break;
        }

        case 'api-session/error': {
          const s = args?.[0] || {};
          if (!s.sessionId) break;
          this.upsert(s.sessionId, {
            status: 'failed',
            running: false,
            lastError: s.message || s.error || 'unknown',
          });
          break;
        }

        // 审批由 events.js 的瀑布处理，但这里也记录一个挂起项
        case 'approval/asked': {
          const s = args?.[0] || {};
          if (!s.sessionId) break;
          const t = this.tasks.get(s.sessionId);
          if (t) {
            t.pendingApprovals.push({
              eventId: s.eventId,
              toolName: s.toolName,
              reason: s.reason,
              requestedAt: Date.now(),
            });
            t.status = 'waiting-approval';
            t.updatedAt = Date.now();
            this._dirty = true;
            this._emit(t);
          }
          break;
        }

        case 'approval/decided': {
          const s = args?.[0] || {};
          if (!s.sessionId) break;
          const t = this.tasks.get(s.sessionId);
          if (t) {
            t.pendingApprovals = t.pendingApprovals.filter(
              (p) => p.eventId !== s.eventId,
            );
            if (t.pendingApprovals.length === 0 && t.running) {
              t.status = 'running';
            }
            t.updatedAt = Date.now();
            this._dirty = true;
            this._emit(t);
          }
          break;
        }

        default:
          // 其他事件不改 task 状态
          break;
      }
    } catch (e) {
      console.warn('[tasks] applyEvent failed:', e.message);
    }
  }

  // ---------- 订阅 ----------

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit(t) {
    for (const fn of this.listeners) {
      try { fn(t); } catch (e) { console.warn('[tasks] listener failed:', e.message); }
    }
  }

  // ---------- 持久化 ----------

  _startFlushTimer() {
    this._flushTimer = setInterval(() => {
      if (this._dirty) this._flush();
    }, FLUSH_INTERVAL_MS);
    this._flushTimer.unref?.();
  }

  _flush() {
    if (!this.persistPath) return;
    try {
      const tmp = this.persistPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({
        version: 1,
        savedAt: new Date().toISOString(),
        tasks: Array.from(this.tasks.values()),
      }, null, 2));
      fs.renameSync(tmp, this.persistPath);
      this._dirty = false;
    } catch (e) {
      console.warn('[tasks] flush failed:', e.message);
    }
  }

  _load() {
    try {
      if (!fs.existsSync(this.persistPath)) return;
      const raw = JSON.parse(fs.readFileSync(this.persistPath, 'utf8'));
      for (const t of raw.tasks || []) {
        // 重启后 pendingApprovals 一律清空，因为旧审批已经不在 DSH 里等着了
        t.pendingApprovals = [];
        if (t.status === 'running') t.status = 'unknown';
        t.running = false;
        this.tasks.set(t.sessionId, t);
      }
      console.log(`[tasks] loaded ${this.tasks.size} tasks from ${this.persistPath}`);
    } catch (e) {
      console.warn('[tasks] load failed:', e.message);
    }
  }

  stop() {
    if (this._flushTimer) clearInterval(this._flushTimer);
    this._flush();
  }
}

module.exports = { TaskRegistry };