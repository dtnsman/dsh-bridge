// src/server.js
'use strict';

const http = require('node:http');

// 每个请求动态生成 CORS 头：
// - 回显 Origin（包括 file:// / 扩展的 "null"），这样带 credentials 的请求也能通过；
// - 回显 Access-Control-Request-Headers，避免自定义头预检失败；
// - 支持 Private Network Access 和跨源资源读取。
function corsHeaders(req) {
  const headers = req?.headers || {};
  const origin = headers.origin || headers.Origin || '';
  const requestedHeaders = headers['access-control-request-headers']
    || headers['Access-Control-Request-Headers']
    || '';
  const out = {
    'access-control-allow-origin': origin || '*',
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'access-control-allow-headers': requestedHeaders
      || 'Content-Type, Authorization, X-Requested-With, X-Request-ID, Accept, Origin',
    'access-control-expose-headers': 'Content-Type, Content-Length, X-Request-ID',
    'access-control-max-age': '86400',
    'access-control-allow-private-network': 'true',
    'cross-origin-resource-policy': 'cross-origin',
    vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
  };
  if (origin) out['access-control-allow-credentials'] = 'true';
  return out;
}

class LocalServer {
  constructor({ port, routes, mux }) {
    this.port = port;
    this.routes = routes;
    this.mux = mux;
    this.server = null;
  }

  async start() {
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        console.error('[server] unhandled:', e);
        try {
          res.writeHead(500, {
            'content-type': 'application/json; charset=utf-8',
            ...corsHeaders(req),
          });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        } catch {}
      });
    });
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, '127.0.0.1', resolve);
    });
    console.log(`[server] listening on http://127.0.0.1:${this.port}`);
  }

  async stop() {
    if (!this.server) return;
    await new Promise((r) => this.server.close(r));
    this.server = null;
  }

  async handle(req, res) {
    const url = new URL(req.url, `http://127.0.0.1:${this.port}`);
    const pathname = url.pathname;
    const method = req.method || 'GET';
    const isTunnel = !res || typeof res.writeHead !== 'function';

    // ============================================================
    // ★ OPTIONS 预检：在路由匹配之前处理。
    // 用 200 而不是 204：部分反向代理会过滤 204 响应的自定义 CORS 头
    // （例如 Access-Control-Allow-Private-Network），200 能完整保留。
    // ============================================================
    if (method === 'OPTIONS') {
      const headers = {
        'content-type': 'application/json; charset=utf-8',
        'content-length': '2',
        ...corsHeaders(req),
      };
      if (isTunnel) return { status: 200, headers, body: '{}' };
      res.writeHead(200, headers);
      return res.end('{}');
    }

    // 1) 精确匹配
    const key = `${method} ${pathname}`;
    let route = this.routes[key];

    // 2) 带路径参数的路由
    if (!route) {
      route = this._matchParamRoute(method, pathname);
    }

    // 3) 方法不匹配 → 405
    if (!route) {
      const other = this._findByPathname(pathname);
      if (other) {
        const body = JSON.stringify({
          error: `method not allowed: ${method} ${pathname}`,
          hint: `try ${other.methods.join(' or ')}`,
          allowedMethods: other.methods,
        });
        const headers = { 'content-type': 'application/json; charset=utf-8', ...corsHeaders(req) };
        if (isTunnel) return { status: 405, headers, body };
        res.writeHead(405, headers);
        return res.end(body);
      }

      // 4) 404
      const body = JSON.stringify({
        error: `no route: ${key}`,
        available: Object.keys(this.routes),
      });
      const headers = { 'content-type': 'application/json; charset=utf-8', ...corsHeaders(req) };
      if (isTunnel) return { status: 404, headers, body };
      res.writeHead(404, headers);
      return res.end(body);
    }

    // 5) 流式路由
    if (route.stream) {
      if (isTunnel) {
        // 隧道模式：不能直接写 res，交回 tunnel.js 用 STREAM 帧常驻推送。
        const parsed = this._sseArgs(route, url, pathname);
        if (parsed.error) {
          const body = JSON.stringify({ error: parsed.error });
          return {
            status: 200,
            headers: { 'content-type': 'text/event-stream', ...corsHeaders(req) },
            body,
            __sse: { prelude: `event: error\ndata: ${body}\n\n` },
          };
        }
        return {
          status: 200,
          headers: { 'content-type': 'text/event-stream; charset=utf-8' },
          body: null,
          __sse: { endpoint: route.stream, args: parsed.args },
        };
      }
      return this._handleSse(req, res, route, url, pathname);
    }

    // 6) 普通路由
    const handler = typeof route === 'function'
      ? route
      : (route && typeof route.handler === 'function' ? route.handler : null);

    if (!handler) {
      const body = JSON.stringify({
        error: `route has no handler: ${key}`,
        routeType: typeof route,
      });
      const headers = { 'content-type': 'application/json; charset=utf-8', ...corsHeaders(req) };
      if (isTunnel) return { status: 500, headers, body };
      res.writeHead(500, headers);
      return res.end(body);
    }

    let params;
    if (isTunnel) {
      const bodyObj = this._parseTunnelBody(req.body, req.headers);
      params = {
        ...Object.fromEntries(url.searchParams),
        ...(route.params || {}),
        ...(bodyObj || {}),
      };
    } else {
      const bodyObj = await this._readBody(req);
      params = {
        ...Object.fromEntries(url.searchParams),
        ...(route.params || {}),
        ...(bodyObj || {}),
      };
    }

    let result;
    try {
      result = await handler({ params, req, url, method, pathname });
    } catch (e) {
      console.error('[server] route handler error:', e);
      result = {
        status: 500,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ ok: false, error: e.message }),
      };
    }

    const finalHeaders = { ...(result?.headers || {}), ...corsHeaders(req) };

    if (isTunnel) return { ...result, headers: finalHeaders };

    const status = result?.status || 200;
    res.writeHead(status, finalHeaders);
    res.end(result?.body ?? '');
    return undefined;
  }

  _matchParamRoute(method, pathname) {
    for (const key of Object.keys(this.routes)) {
      const sp = key.indexOf(' ');
      if (sp < 0) continue;
      const m = key.slice(0, sp);
      const p = key.slice(sp + 1);
      if (m !== method) continue;
      if (!p.includes(':')) continue;

      const m2 = this._matchPattern(p, pathname);
      if (m2) {
        const original = this.routes[key];
        if (typeof original === 'function') {
          return { handler: original, params: m2 };
        }
        return { ...original, params: m2 };
      }
    }
    return null;
  }

  _matchPattern(pattern, pathname) {
    const pp = pattern.split('/').filter(Boolean);
    const pn = pathname.split('/').filter(Boolean);
    if (pp.length !== pn.length) return null;

    const params = {};
    for (let i = 0; i < pp.length; i++) {
      if (pp[i].startsWith(':')) {
        params[pp[i].slice(1)] = decodeURIComponent(pn[i]);
      } else if (pp[i] !== pn[i]) {
        return null;
      }
    }
    return params;
  }

  _findByPathname(pathname) {
    const methods = [];
    for (const key of Object.keys(this.routes)) {
      const sp = key.indexOf(' ');
      if (sp < 0) continue;
      const m = key.slice(0, sp);
      const p = key.slice(sp + 1);
      if (p === pathname) methods.push(m);
      else if (p.includes(':')) {
        if (this._matchPattern(p, pathname)) methods.push(m);
      }
    }
    return methods.length ? { methods } : null;
  }

  // 解析流式路由的 args（本地 SSE 与隧道 SSE 共用）
  _sseArgs(route, url, pathname) {
    if (route.taskScoped) {
      const m = pathname.match(/^\/api\/tasks\/([^/]+)\/stream$/);
      const sessionId = m ? decodeURIComponent(m[1]) : null;
      if (!sessionId) return { error: 'missing sessionId' };
      return { args: { request: { address: { kind: 'session', sessionId } } } };
    }
    if (route.params && Object.keys(route.params).length) {
      const args = { ...route.params };
      for (const [k, v] of url.searchParams) if (k !== 'args') args[k] = v;
      return { args };
    }
    if (url.searchParams.has('args')) {
      try { return { args: JSON.parse(url.searchParams.get('args')) }; }
      catch { return { error: 'args is not JSON' }; }
    }
    const args = {};
    for (const [k, v] of url.searchParams) if (k !== 'args') args[k] = v;
    return { args };
  }

  _handleSse(req, res, route, url, pathname) {
    const headers = {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      ...corsHeaders(req),
    };
    res.writeHead(200, headers);
    res.write(': connected\n\n');

    const parsed = this._sseArgs(route, url, pathname);
    if (parsed.error) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: parsed.error })}\n\n`);
      return res.end();
    }
    const args = parsed.args;

    const endpoint = route.stream;
    const seq = { n: 0 };

    let stream;
    try {
      stream = this.mux.open(endpoint, args, {
        onItem: (v) => {
          seq.n++;
          try {
            res.write(`id: ${seq.n}\n`);
            res.write(`data: ${JSON.stringify(v)}\n\n`);
          } catch {}
        },
        onEnd: () => {
          try {
            res.write('event: end\ndata: {}\n\n');
            res.end();
          } catch {}
        },
        onError: (e) => {
          try {
            res.write(`event: error\ndata: ${JSON.stringify(e)}\n\n`);
            res.end();
          } catch {}
        },
      });
    } catch (e) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: e.message })}\n\n`);
      return res.end();
    }

    const hb = setInterval(() => {
      try { res.write(': heartbeat\n\n'); } catch {}
    }, 30000);
    hb.unref?.();

    const cleanup = () => {
      clearInterval(hb);
      try { stream.cancel(); } catch {}
    };
    req.on('close', cleanup);
    req.on('error', cleanup);

    return undefined;
  }

  async _readBody(req) {
    if (req.method === 'GET' || req.method === 'HEAD') return null;
    const chunks = [];
    for await (const c of req) chunks.push(c);
    if (!chunks.length) return null;
    return this._parseTunnelBody(Buffer.concat(chunks), req.headers);
  }

  // 方案 B（字节契约）：body 可能是 Buffer / Uint8Array / string / null。
  // 先统一成 Buffer，再按 content-type 决定是否解码为文本；
  // 非文本类型（二进制上传）保持字节原样返回。
  _parseTunnelBody(body, headers) {
    if (body == null) return null;

    let buf;
    if (Buffer.isBuffer(body)) buf = body;
    else if (body instanceof Uint8Array) buf = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
    else if (body instanceof ArrayBuffer) buf = Buffer.from(body);
    else buf = Buffer.from(String(body), 'utf8');

    if (!buf.length) return null;

    const ct = String(
      headers?.['content-type'] || headers?.['Content-Type'] || '',
    ).toLowerCase();

    const isText = ct.includes('application/json')
      || ct.includes('application/x-www-form-urlencoded')
      || ct.startsWith('text/')
      || ct === '';

    if (!isText) return buf;

    const text = buf.toString('utf8');

    if (ct.includes('application/json')) {
      try { return JSON.parse(text); } catch { return null; }
    }
    if (ct.includes('application/x-www-form-urlencoded')) {
      return Object.fromEntries(new URLSearchParams(text));
    }
    try { return JSON.parse(text); }
    catch { return Object.fromEntries(new URLSearchParams(text)); }
  }
}

module.exports = { LocalServer };