// src/routes.js
// 路由表：透传 + 便利封装 + 任务查询 + 工作区 + 静态 app。
//
// 约定：
//   - 普通路由返回 { status, headers, body }
//   - 流式路由值是 { stream: '<endpoint>', ... }
//   - 需要 lookup 参数的端点（agentId、workspaceFileScopeId），
//     由调用方在 args 里显式传，DSH 会自己解析

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildCatalog } = require('./catalog');

function createRoutes({ rpc, events, mux, registry }) {
  // ---------------- 工具 ----------------

  const json = (status, obj) => ({
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(obj),
  });

  const ok = (value) => json(200, { ok: true, value });

  const fail = (e) => {
    if (e && e.code) {
      const status = String(e.code).startsWith('gateway/') ? 400 : 200;
      return json(status, {
        ok: false,
        code: e.code,
        message: e.message,
        details: e.details,
      });
    }
    return json(e?.status || 500, {
      ok: false,
      code: e?.code,
      message: e?.message || String(e),
    });
  };

  const call = async (ns, method, args) => {
    try {
      const value = await rpc.call(ns, method, args);
      return ok(value);
    } catch (e) {
      return fail(e);
    }
  };

  // ---------------- 静态 app ----------------
  const APP_CANDIDATES = [
    path.join(__dirname, '..', 'dsh-app.html'),
    path.join(__dirname, '..', 'test-app-demo.html'),
    path.join(__dirname, '..', 'public', 'dsh-app.html'),
  ];
  let APP_HTML = null;
  for (const p of APP_CANDIDATES) {
    if (fs.existsSync(p)) {
      APP_HTML = fs.readFileSync(p, 'utf8');
      console.log(`[routes] loaded app from ${p}`);
      break;
    }
  }
  if (!APP_HTML) {
    console.warn('[routes] dsh-app.html not found; /app will 404');
  }

  // ---------------- 路由 ----------------

  return {
    // ============================================================
    // 静态 app
    // ============================================================
    'GET /app': async () => {
      if (!APP_HTML) {
        return {
          status: 404,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
          body: 'dsh-app.html not found',
        };
      }
      return {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: APP_HTML,
      };
    },

    // ============================================================
    // 桥接自身
    // ============================================================
    'GET /health': async () => json(200, {
      status: 'ok',
      service: 'dsh-bridge',
      version: '2.0.0',
      events: events.clientId ? 'connected' : 'pending',
      mux: mux.ready ? 'connected' : 'disconnected',
      tasks: registry.list().length,
    }),

    'GET /api/info': async () => json(200, {
      dshBaseUrl: rpc.baseUrl,
      eventsClientId: events.clientId,
      muxReady: mux.ready,
      taskCount: registry.list().length,
      appAvailable: !!APP_HTML,
      note: 'all endpoints open; use /api/dsh/rpc for passthrough',
    }),

    'GET /api/endpoints': async () => json(200, buildCatalog()),

    // ============================================================
    // 工作区：抓 workspace/follow 第一帧就断
    // ============================================================
    'GET /api/workspaces': async () => {
      try {
        const frame = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new Error('workspace/follow timeout (5s)'));
          }, 5000);

          const stream = mux.open('workspace/follow', {}, {
            onItem: (v) => {
              clearTimeout(timer);
              try { stream.cancel(); } catch {}
              resolve(v);
            },
            onError: (e) => {
              clearTimeout(timer);
              reject(new Error(e?.message || 'workspace stream error'));
            },
          });
        });

        // 多形态兜底提取
        let workspaces = [];
        if (Array.isArray(frame?.workspaces)) workspaces = frame.workspaces;
        else if (Array.isArray(frame?.value?.workspaces)) workspaces = frame.value.workspaces;
        else if (Array.isArray(frame?.value?.items)) workspaces = frame.value.items;
        else if (Array.isArray(frame?.items)) workspaces = frame.items;
        else if (Array.isArray(frame)) workspaces = frame;

        // 归一化
        const normalized = workspaces.map((ws) => ({
          workspaceId: ws.workspaceId || ws.id || null,
          title: ws.title || ws.name || null,
          path: ws.path || ws.cwd || null,
          sessionIds: Array.isArray(ws.sessionIds) ? ws.sessionIds : [],
          createdAt: ws.createdAt || null,
          updatedAt: ws.updatedAt || null,
        }));

        return json(200, {
          ok: true,
          count: normalized.length,
          workspaces: normalized,
          raw: frame,   // ★ 第一次调用用它核对结构
        });
      } catch (e) {
        return json(500, { ok: false, error: e.message });
      }
    },

    // ============================================================
    // 万能透传
    // ============================================================
    'POST /api/dsh/rpc': async ({ params }) => {
      const { ns, method, args } = params || {};
      if (!ns || !method) return json(400, { error: 'ns and method required' });
      return call(ns, method, args || {});
    },

    // ============================================================
    // 任务表
    // ============================================================
    'GET /api/tasks': async () => json(200, {
      ok: true,
      tasks: registry.list(),
    }),

    'GET /api/tasks/:sessionId': async ({ params }) => {
      const { sessionId } = params;
      const t = registry.get(sessionId);
      if (!t) return json(404, { ok: false, error: 'task not found', sessionId });

      try {
        const proj = await rpc.call('session', 'projections', {
          request: { sessionId },
        });
        if (proj) {
          registry.upsert(sessionId, {
            lastSeq: proj.asOfSeq ?? t.lastSeq,
            sandbox: proj.values?.permissions?.currentValue ?? t.sandbox,
            model: proj.values?.modelSelection?.next?.model ?? t.model,
          });
        }
      } catch {}

      return json(200, { ok: true, task: registry.get(sessionId) });
    },

    'POST /api/tasks/:sessionId/cancel': async ({ params }) => {
      const { sessionId } = params;
      try {
        await rpc.call('session', 'cancel', { request: { sessionId } });
        registry.upsert(sessionId, { status: 'cancelled', running: false });
        return json(200, { ok: true });
      } catch (e) {
        return fail(e);
      }
    },

    'GET /api/tasks/:sessionId/stream': {
      stream: 'session/follow',
      taskScoped: true,
    },

    // ============================================================
    // 会话
    // ============================================================
    'POST /api/session/create': async ({ params }) => {
      try {
        const value = await rpc.call('session', 'create', { request: params });
        if (value?.sessionId) {
          registry.upsert(value.sessionId, {
            cwd: params?.cwd,
            status: 'idle',
            running: false,
          });
        }
        return ok(value);
      } catch (e) {
        return fail(e);
      }
    },

    'POST /api/session/prompt': async ({ params }) => {
      try {
        const value = await rpc.call('session', 'prompt', { request: params });
        if (params?.sessionId) {
          registry.upsert(params.sessionId, {
            status: 'running',
            running: true,
            lastActivityAt: Date.now(),
          });
        }
        return ok(value);
      } catch (e) {
        return fail(e);
      }
    },

    'POST /api/session/list': async ({ params }) => {
      return call('session', 'list', { _request: params || {} });
    },

    'POST /api/session/page': async ({ params }) => {
      return call('session', 'page', { request: params });
    },

    'POST /api/session/cancel': async ({ params }) => {
      try {
        const value = await rpc.call('session', 'cancel', { request: params });
        if (params?.sessionId) {
          registry.upsert(params.sessionId, { status: 'cancelled', running: false });
        }
        return ok(value);
      } catch (e) {
        return fail(e);
      }
    },

    'POST /api/session/fork': async ({ params }) => {
      return call('session', 'fork', { request: params });
    },

    'POST /api/session/rename': async ({ params }) => {
      return call('session', 'rename', { request: params });
    },

    'POST /api/session/search': async ({ params }) => {
      return call('session', 'search', { request: params });
    },

    'POST /api/session/projections': async ({ params }) => {
      return call('session', 'projections', { request: params });
    },

    'POST /api/session/selectModel': async ({ params }) => {
      return call('session', 'selectModel', { request: params });
    },

    'POST /api/session/updateQueue': async ({ params }) => {
      return call('session', 'updateQueue', { request: params });
    },

    'GET /api/session/models': async () => {
      return call('session', 'modelCatalog', {});
    },

    // ============================================================
    // 工作区
    // ============================================================
    'POST /api/workspace/create': async ({ params }) => {
      return call('workspace', 'create', { request: params });
    },
    'POST /api/workspace/delete': async ({ params }) => {
      return call('workspace', 'delete', { request: params });
    },
    'POST /api/workspace/rename': async ({ params }) => {
      return call('workspace', 'rename', { request: params });
    },
    'POST /api/workspace/archiveSession': async ({ params }) => {
      return call('workspace', 'archiveSession', { request: params });
    },
    'POST /api/workspace/unarchiveSession': async ({ params }) => {
      return call('workspace', 'unarchiveSession', { request: params });
    },

    // ============================================================
    // 工作区文件（scope = sessionId）
    // ============================================================
    'POST /api/workspaceFiles/read': async ({ params }) => {
      return call('workspaceFiles', 'read', params);
    },
    'POST /api/workspaceFiles/list': async ({ params }) => {
      return call('workspaceFiles', 'list', params);
    },
    'POST /api/workspaceFiles/stat': async ({ params }) => {
      return call('workspaceFiles', 'stat', params);
    },
    'POST /api/workspaceFiles/readBytes': async ({ params }) => {
      return call('workspaceFiles', 'readBytes', params);
    },
    'GET /api/workspaceFiles/changes': {
      stream: 'workspaceFiles/changes',
    },

    // ============================================================
    // 终端（lookup: agentId）
    // ============================================================
    'POST /api/terminal/create': async ({ params }) => {
      return call('terminal', 'create', params);
    },
    'POST /api/terminal/write': async ({ params }) => {
      return call('terminal', 'write', params);
    },
    'POST /api/terminal/resize': async ({ params }) => {
      return call('terminal', 'resize', params);
    },
    'POST /api/terminal/close': async ({ params }) => {
      return call('terminal', 'close', params);
    },
    'POST /api/terminal/list': async ({ params }) => {
      return call('terminal', 'list', params);
    },
    'POST /api/terminal/environment': async ({ params }) => {
      return call('terminal', 'environment', params);
    },
    'POST /api/terminal/shells': async ({ params }) => {
      return call('terminal', 'shells', params);
    },
    'GET /api/terminal/follow': {
      stream: 'terminal/follow',
    },

    // ============================================================
    // Job
    // ============================================================
    'POST /api/job/list': async ({ params }) => {
      return call('job', 'list', { request: params || {} });
    },
    'POST /api/job/kill': async ({ params }) => {
      return call('job', 'kill', { request: params });
    },
    'GET /api/job/follow': { stream: 'job/follow' },

    // ============================================================
    // Skills / Commands / Presets
    // ============================================================
    'POST /api/skills/list': async ({ params }) => {
      return call('skills', 'list', { request: params || {} });
    },
    'GET /api/commands/list': async () => {
      return call('commands', 'list', {});
    },
    'POST /api/commands/execute': async ({ params }) => {
      return call('commands', 'execute', params);
    },
    'GET /api/agentPresets/list': async () => {
      return call('agentPresets', 'list', {});
    },
    'POST /api/agentPresets/select': async ({ params }) => {
      return call('agentPresets', 'select', params);
    },

    // ============================================================
    // 通用流式路由
    // ============================================================
    'GET /api/stream/session.follow':   { stream: 'session/follow' },
    'GET /api/stream/session.control':  { stream: 'session/control' },
    'GET /api/stream/workspace.follow': { stream: 'workspace/follow' },
    'GET /api/stream/job.follow':       { stream: 'job/follow' },
    'GET /api/stream/job.list':         { stream: 'job/list' },
    'GET /api/stream/terminal.follow':  { stream: 'terminal/follow' },
    'GET /api/stream/terminal.retain':  { stream: 'terminal/retain' },
    'GET /api/stream/account.watch':    { stream: 'account/watch' },
    'GET /api/stream/account.watchExpiry': { stream: 'account/watchExpiry' },
    'GET /api/stream/productAnalytics.watchPolicy': { stream: 'productAnalytics/watchPolicy' },
    'GET /api/stream/events':           { stream: '$events' },
  };
}

module.exports = { createRoutes };