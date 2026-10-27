// src/tracker.js
'use strict';

const POLL_MS = 15000;

class Tracker {
  constructor({ rpc, registry }) {
    this.rpc = rpc;
    this.registry = registry;
    this._timer = null;
    this._stop = false;
    this._ticking = false;
    this._failCount = 0;
  }

  start() {
    console.log(`[tracker] polling every ${POLL_MS}ms`);
    this._tick();
    this._timer = setInterval(() => this._tick(), POLL_MS);
    this._timer.unref?.();
  }

  stop() {
    this._stop = true;
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  async _tick() {
    if (this._stop) return;
    if (this._ticking) return;
    this._ticking = true;
    try {
      await this._tickOnce();
      this._failCount = 0;
    } catch (e) {
      this._failCount++;
      const cause = e.cause?.code || e.cause?.message || e.code || e.message;
      if (this._failCount === 1 || this._failCount % 20 === 0) {
        console.warn(`[tracker] tick failed (${this._failCount}x): ${cause}`);
      }
      if (this._failCount === 1 && cause === 'ECONNREFUSED') {
        console.warn(`[tracker] DSH 未监听 ${this.rpc.baseUrl}，检查桌面版是否在跑`);
      }
    } finally {
      this._ticking = false;
    }
  }

  async _tickOnce() {
    const list = await this.rpc.call('session', 'list', { _request: {} });
    const items = list.items || [];
    const seen = new Set();

    for (const s of items) {
      seen.add(s.sessionId);
      const old = this.registry.get(s.sessionId);
      const title = s.projections?.values?.title || old?.title || null;
      const sandbox = s.projections?.values?.permissions?.currentValue
        || old?.sandbox || null;
      const model = s.projections?.values?.modelSelection?.next?.model
        || old?.model || null;

      this.registry.upsert(s.sessionId, {
        cwd: s.cwd,
        running: !!s.running,
        status: this._deriveStatus(s, old),
        title, sandbox, model,
      });
    }

    for (const t of this.registry.list()) {
      if (seen.has(t.sessionId)) continue;
      if (['cancelled', 'done', 'failed'].includes(t.status)) continue;
      this.registry.upsert(t.sessionId, { status: 'removed' });
    }

    await this._enrichRunning(items);
  }

  _deriveStatus(s, old) {
    if (old?.status === 'cancelled') return 'cancelled';
    if (old?.status === 'done') return 'done';
    if (old?.status === 'failed') return 'failed';
    if (old?.status === 'waiting-approval' && s.running) return 'waiting-approval';
    if (s.running) return 'running';
    if (old?.status === 'running') return 'done';
    return 'idle';
  }

  async _enrichRunning(items) {
    const interesting = items.filter((s) => s.running);
    for (const s of interesting.slice(0, 5)) {
      try {
        const proj = await this.rpc.call('session', 'projections', {
          request: { sessionId: s.sessionId },
        });
        if (typeof proj?.asOfSeq === 'number') {
          this.registry.upsert(s.sessionId, { lastSeq: proj.asOfSeq });
        }
      } catch {}
    }
  }
}

module.exports = { Tracker };