// src/tunnel.js
// 隧道客户端（DTNS 二进制协议 v2.0 / sdk.js 兼容）。
//
// 与 1.0 的差异：
//   1. 帧格式：JSON 文本 -> DTNS 二进制帧（13 字节头 + payload）
//   2. body：base64 字符串 -> 原始字节（Uint8Array / Buffer），零 base64 开销
//   3. 注册：register_tunnel 固定字段 + 独立 capabilities 声明流式能力
//   4. 流式：ws_open/ws_frame/ws_close -> HTTP_RESPONSE(101) + WEBSOCKET_DATA/WEBSOCKET_CLOSE
//   5. 域名：ai.dsh.<id>.html.dtns.top -> ai.dsh2.<id>.html.dtns.top（v2 服务端）
//
// 对外契约：onRequest({ requestId, domain, method, url, headers, body, rawBody })
//   - body 为 Buffer（方案 B：字节契约），空 body 为 null
//   - 返回 { status, headers, body }，body 可为 Buffer / string / null
// onStreamOpen(endpoint, args) 返回 mux 流对象（send/end/cancel），签名不变。

'use strict';

const WebSocket = require('ws');
const P = require('./dtns-protocol');

const RECONNECT_BASE_MS = 1500;
const RECONNECT_FACTOR = 1.7;
const RECONNECT_MAX_MS = 20000;
const HEARTBEAT_MS = 25000;
const EMPTY = Buffer.alloc(0);

function toBuffer(bytes) {
  if (!bytes) return EMPTY;
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof Uint8Array) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes instanceof ArrayBuffer) return Buffer.from(bytes);
  return EMPTY;
}

class Tunnel {
  constructor({ serverUrl, clientId, onRequest, onStreamOpen, openStream, description }) {
    if (!serverUrl) throw new Error('tunnel.serverUrl required');
    if (!clientId) throw new Error('tunnel.clientId required');
    if (typeof onRequest !== 'function') throw new Error('tunnel.onRequest required');

    this.serverUrl = serverUrl;
    this.clientId = clientId;
    this.onRequest = onRequest;
    this.onStreamOpen = onStreamOpen || null;
    // openStream(endpoint, args, handlers) -> 支持在创建时绑定 handlers（SSE 用）
    this.openStream = openStream || null;
    this.description = description || 'DSH Bridge - DSH HTTP/WS API over tunnel (v2)';

    this.ws = null;
    this.connected = false;
    this.registered = false;
    this.serverVersion = P.VERSION_2;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.registeredDomains = new Set();

    // wsRequestId -> { send, end, cancel }
    this.activeStreams = new Map();
    // streamId -> { stream, stopHeartbeat, finish }  隧道 SSE 常驻流
    this.activeSse = new Map();

    this.stats = {
      requestsTotal: 0, requestsOk: 0, requestsError: 0,
      streamsOpened: 0, streamsActive: 0,
      lastRequestAt: null, connectedAt: null,
    };
    this.listeners = [];
  }

  on(event, fn) { this.listeners.push({ event, fn }); }
  emit(event, data) {
    for (const l of this.listeners) {
      if (l.event === event) { try { l.fn(data); } catch (e) { console.warn(e); } }
    }
  }

  // ---------- 生命周期 ----------

  start() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN ||
                    this.ws.readyState === WebSocket.CONNECTING)) return;

    const url = `${this.serverUrl}?clientId=${encodeURIComponent(this.clientId)}`;
    this.emit('connecting', { url });

    let ws;
    try { ws = new WebSocket(url); }
    catch (e) { this.emit('error', { error: e.message }); return this._scheduleReconnect(); }

    this.ws = ws;
    ws.binaryType = 'arraybuffer';

    ws.on('open', () => {
      if (this.ws !== ws) return;
      this.connected = true;
      this.reconnectAttempts = 0;
      this.stats.connectedAt = Date.now();
      this._sendCapabilities();
      this._sendRegister();
      this._startHeartbeat();
      this.emit('connected', { clientId: this.clientId });
    });

    ws.on('message', (raw) => {
      if (this.ws !== ws) return;
      if (process.env.DSH_BRIDGE_VERBOSE === '1') {
        try {
          const f = P.decodeFrame(raw);
          console.log('[tunnel] << frame', f.type, 'v' + f.version, 'flags=0x' + f.flags.toString(16), 'len=' + f.payload.length);
        } catch (e) {
          console.log('[tunnel] << undecodable frame', raw.length, 'bytes');
        }
      }
      this._onFrame(raw);
    });

    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.connected = false;
      this.registered = false;
      this._stopHeartbeat();
      for (const [, s] of this.activeStreams) {
        try { s.cancel(); } catch (e) {}
      }
      this.activeStreams.clear();
      for (const [, s] of this.activeSse) {
        try { s.cancel(); } catch (e) {}
      }
      this.activeSse.clear();
      this.stats.streamsActive = 0;
      this.emit('disconnected', {});
      this._scheduleReconnect();
    });

    ws.on('error', (e) => {
      this.emit('error', { error: e.message || String(e) });
    });
  }

  stop() {
    this._stopHeartbeat();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    for (const [, s] of this.activeStreams) {
      try { s.cancel(); } catch (e) {}
    }
    this.activeStreams.clear();
    for (const [, s] of this.activeSse) {
      try { s.cancel(); } catch (e) {}
    }
    this.activeSse.clear();
    if (this.ws) {
      this.ws.removeAllListeners();
      try { this.ws.close(); } catch (e) {}
      this.ws = null;
    }
    this.connected = false;
    this.registered = false;
    this.registeredDomains.clear();
    this.emit('stopped', {});
  }

  // ---------- 注册 ----------

  _sendCapabilities() {
    this._sendFrame(P.encodeCapabilities({
      clientId: this.clientId,
      stream: true,
      multiValueHeaders: true,
    }));
  }

  _sendRegister() {
    this._sendFrame(P.encodeRegisterTunnel({
      clientId: this.clientId,
      tunnel: {
        id: 'dsh-bridge-' + this.clientId,
        domain: this._domainFor(this.clientId),
        localPort: 10998,
        localHost: 'dsh-bridge',
        protocol: 'http',
        description: this.description,
      },
    }));
  }

  _domainFor(clientId) {
    // v2 服务端专用前缀：ai.dsh2.*（ai.dsh.* 指向 1.0 服务端）
    return `ai.dsh2.${clientId}.html.dtns.top`;
  }

  _scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectAttempts++;
    const base = Math.min(
      RECONNECT_BASE_MS * Math.pow(RECONNECT_FACTOR, this.reconnectAttempts - 1),
      RECONNECT_MAX_MS,
    );
    const jittered = base * (0.5 + Math.random() * 0.5);
    this.emit('reconnecting', { attempt: this.reconnectAttempts, delay: jittered });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.start();
    }, jittered);
  }

  // ---------- 收发 ----------

  _sendFrame(frame) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(frame); return true; }
      catch (e) { this.emit('error', { error: 'send failed: ' + e.message }); return false; }
    }
    return false;
  }

  _sendNamed(typeName, payload, version, flags) {
    return this._sendFrame(P.encodeFrame(typeName, payload, version, flags));
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this._sendHeartbeat();
    this.heartbeatTimer = setInterval(() => this._sendHeartbeat(), HEARTBEAT_MS);
  }

  _stopHeartbeat() {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  _sendHeartbeat() {
    this._sendFrame(P.encodeHeartbeat({
      clientId: this.clientId,
      timestamp: new Date().toISOString(),
      stats: {
        tunnelCount: 1,
        registeredCount: this.registered ? 1 : 0,
        sseConnections: 0,
        totalRequests: this.stats.requestsTotal,
        totalErrors: this.stats.requestsError,
      },
    }));
  }

  // ---------- 入站帧分发 ----------

  _onFrame(raw) {
    let frame;
    try {
      frame = P.decodeFrame(raw);
    } catch (e) {
      this.emit('error', { error: 'frame decode failed: ' + e.message });
      return;
    }

    let msg;
    try {
      msg = P.decodeMessage(frame);
    } catch (e) {
      this.emit('error', { error: `decode ${frame.type} failed: ${e.message}` });
      return;
    }

    switch (msg.type) {
      case 'welcome':
        this.serverVersion = msg.protocolVersion >= P.VERSION_2 ? P.VERSION_2 : P.VERSION;
        this.emit('welcome', { clientId: msg.clientId, protocolVersion: this.serverVersion });
        break;

      case 'registered':
        if (msg.success) {
          this.registered = true;
          this.registeredDomains.add(msg.domain);
          this.emit('registered', { domain: msg.domain });
        } else {
          this.registered = false;
          this.emit('register_failed', { error: msg.error, domain: msg.domain });
        }
        break;

      case 'heartbeat_ack':
        break;

      case 'http_request':
        this._handleHttpRequest(msg);
        break;

      case 'stream_open':
        this._handleStreamOpen(msg);
        break;

      case 'stream_chunk':
        this._handleStreamChunk(msg);
        break;

      case 'stream_end':
        this._handleStreamEnd(msg);
        break;

      case 'stream_cancel':
        this._handleStreamCancel(msg);
        break;

      case 'websocket_data':
      case 'websocket_data_from_server':
        this._handleWsData(msg);
        break;

      case 'websocket_close':
      case 'websocket_close_from_server':
        this._handleWsClose(msg);
        break;

      default:
        this.emit('error', { error: `unknown frame type: ${msg.type}` });
    }
  }

  // ---------- 一元 HTTP ----------

  async _handleHttpRequest(msg) {
    const { requestId, domain, method, url, headers } = msg;
    this.stats.requestsTotal++;
    this.stats.lastRequestAt = Date.now();
    const startTime = Date.now();

    const rawBody = toBuffer(msg.body);

    // WebSocket 升级请求走独立分支（标准 101 + 双向帧）
    if (msg.isWebSocket && msg.wsRequestId) {
      this._handleWsUpgrade(msg, rawBody);
      return;
    }

    let response;
    try {
      response = await this.onRequest({
        requestId, domain, method, url,
        headers: headers || {},
        body: rawBody.length ? rawBody : null,
        rawBody,
        remoteAddress: msg.remoteAddress,
      });
      response = this._applyCors(response || {}, msg);
      this.stats.requestsOk++;
    } catch (e) {
      this.stats.requestsError++;
      response = this._applyCors({
        status: 500,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: Buffer.from(JSON.stringify({ ok: false, error: e.message }), 'utf8'),
      }, msg);
    }

    const duration = Date.now() - startTime;
    const outHeaders = {
      ...(response.headers || {}),
      'x-dsh-bridge-duration': String(duration),
    };

    this._sendFrame(P.encodeHttpResponse({
      requestId,
      domain,
      status: response.status || 200,
      headers: outHeaders,
      body: this._responseBodyToBuffer(response.body),
      isSSE: false,
      isWebSocket: false,
      sseRequestId: msg.sseRequestId || null,
      wsRequestId: null,
      error: null,
    }, this.serverVersion));

    this.emit('request', { method, url, status: response.status || 200, duration });
  }

  _responseBodyToBuffer(body) {
    if (body == null) return EMPTY;
    if (Buffer.isBuffer(body)) return body;
    if (body instanceof Uint8Array) return toBuffer(body);
    if (body instanceof ArrayBuffer) return Buffer.from(body);
    return Buffer.from(String(body), 'utf8');
  }

  _applyCors(response, requestMessage) {
    const requestHeaders = requestMessage?.headers || {};
    const origin = requestHeaders.origin || requestHeaders.Origin || '';
    const requestedHeaders = requestHeaders['access-control-request-headers']
      || requestHeaders['Access-Control-Request-Headers']
      || '';
    return {
      ...response,
      headers: {
        ...(response.headers || {}),
        'access-control-allow-origin': origin || '*',
        'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'access-control-allow-headers': requestedHeaders
          || 'Content-Type, Authorization, X-Requested-With, X-Request-ID, Accept, Origin',
        'access-control-expose-headers': 'Content-Type, Content-Length, X-Request-ID, X-Dsh-Bridge-Duration',
        'access-control-max-age': '86400',
        'access-control-allow-private-network': 'true',
        'cross-origin-resource-policy': 'cross-origin',
        vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
        ...(origin ? { 'access-control-allow-credentials': 'true' } : {}),
      },
    };
  }

  // ---------- WebSocket（标准 upgrade 流程）----------

  _handleWsUpgrade(msg, rawBody) {
    const { requestId, domain, wsRequestId, method, url, headers } = msg;

    if (!this.onStreamOpen) {
      this._sendFrame(P.encodeHttpResponse({
        requestId, domain, status: 501,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: Buffer.from(JSON.stringify({
          ok: false, error: 'stream_not_supported',
          hint: 'bridge has no onStreamOpen handler',
        }), 'utf8'),
        isWebSocket: true, wsRequestId, error: 'stream_not_supported',
      }, this.serverVersion));
      return;
    }

    // 从 URL 解析 endpoint + args，与 1.0 ws_open 语义保持一致：
    //   /api/stream/<endpoint>?args=<json>  或  ?endpoint=<ns/method>
    let endpoint = '';
    let args = {};
    try {
      const parsed = new URL(url, 'http://bridge.local');
      const q = parsed.searchParams;
      endpoint = q.get('endpoint') || this._endpointFromPath(parsed.pathname);
      if (q.has('args')) args = JSON.parse(q.get('args'));
      else for (const [k, v] of q) if (k !== 'endpoint') args[k] = v;
    } catch (e) {
      this._rejectWs(requestId, domain, wsRequestId, 400, 'bad websocket url: ' + e.message);
      return;
    }

    if (!endpoint) {
      this._rejectWs(requestId, domain, wsRequestId, 400, 'missing endpoint for websocket stream');
      return;
    }

    let stream;
    try {
      stream = this.onStreamOpen(endpoint, args || {});
    } catch (e) {
      this._rejectWs(requestId, domain, wsRequestId, 500, 'stream open failed: ' + e.message);
      return;
    }

    this.activeStreams.set(wsRequestId, stream);
    this.stats.streamsOpened++;
    this.stats.streamsActive = this.activeStreams.size;

    // 回 101：完成 upgrade，后续走 WEBSOCKET_DATA
    this._sendFrame(P.encodeHttpResponse({
      requestId, domain, status: 101,
      headers: {
        upgrade: 'websocket',
        connection: 'Upgrade',
        ...(headers && headers['sec-websocket-protocol']
          ? { 'sec-websocket-protocol': headers['sec-websocket-protocol'] }
          : {}),
      },
      body: EMPTY,
      isWebSocket: true,
      wsRequestId,
      error: null,
    }, this.serverVersion));

    const cleanup = () => {
      this.activeStreams.delete(wsRequestId);
      this.stats.streamsActive = this.activeStreams.size;
    };

    stream.onItem = (value) => {
      const payload = Buffer.from(JSON.stringify(value === undefined ? null : value), 'utf8');
      this._sendFrame(P.encodeWebSocketData({
        wsRequestId,
        data: payload,
        binary: false,
        timestamp: new Date().toISOString(),
      }));
    };
    stream.onEnd = () => {
      this._sendFrame(P.encodeWebSocketClose({
        wsRequestId, code: 1000, reason: 'stream ended',
      }));
      cleanup();
    };
    stream.onError = (error) => {
      const payload = Buffer.from(JSON.stringify(error || { message: 'stream error' }), 'utf8');
      this._sendFrame(P.encodeWebSocketData({
        wsRequestId, data: payload, binary: false,
      }));
      this._sendFrame(P.encodeWebSocketClose({
        wsRequestId, code: 1011, reason: 'stream error',
      }));
      cleanup();
    };

    this.emit('stream_open', { wsRequestId, endpoint });
  }

  // ---------- STREAM 系列（v2 服务端承载普通 HTTP 往返）----------
  //
  // 严格对齐服务端实现（E:\dtns.http-proxy\server\protocol.js + proxy-server.js）：
  //
  //   上行（服务端 -> 本地）：
  //     STREAM_OPEN  : streamId requestId direction("up") method url status(u16) headers
  //                    ← 注意：没有 body！
  //     STREAM_CHUNK : streamId data(encodeBuffer)        ← 请求体逐块到达
  //     STREAM_END   : streamId                            ← 请求体结束
  //   下行（本地 -> 服务端）：
  //     STREAM_OPEN  : 同布局，direction="down"，status + headers 在这里
  //     STREAM_CHUNK : streamId data(encodeBuffer)        ← 响应体走这里
  //     STREAM_END   : streamId                            ← 仅结束标记
  //   流控：服务端会回 STREAM_ACK(streamId, credit)，本地按窗口回补 ACK。

  _handleStreamOpen(msg) {
    const { streamId, requestId, direction, method, url, headers } = msg;

    if (direction && direction !== 'up') {
      this.emit('error', { error: `unexpected stream_open direction: ${direction}` });
      return;
    }

    this.stats.requestsTotal++;
    this.stats.lastRequestAt = Date.now();
    const startTime = Date.now();

    // 登记该流的上行状态，等 STREAM_CHUNK 累积、STREAM_END 触发 onRequest
    if (!this._pendingStreams) this._pendingStreams = new Map();
    this._pendingStreams.set(streamId, {
      streamId, requestId, method, url,
      headers: headers || {},
      chunks: [],
      startTime,
    });

    // 若该请求没有 body（GET/HEAD 等），服务端不会发 STREAM_CHUNK 和 STREAM_END 吗？
    // 实际上 proxy-server.js 的 req.on('end') 始终会发 STREAM_END，所以这里只登记。
    // 但为了不依赖对端行为，若 content-length 为 0/缺失且非 chunked，直接跑。
    const h = headers || {};
    const cl = h['content-length'];
    const te = h['transfer-encoding'];
    if (!te && (cl === undefined || cl === '0' || cl === 0)) {
      this._finishUpStream(streamId);
    }
  }

  _handleStreamChunk(msg) {
    const { streamId, data } = msg;
    if (!this._pendingStreams) return;
    const st = this._pendingStreams.get(streamId);
    if (!st) {
      // 可能是下行 ACK 或未知流，忽略
      return;
    }
    const buf = toBuffer(data);
    if (buf.length) st.chunks.push(buf);
    // 回 ACK（流控）：proxy-server.js 的 onUpStreamAck 期望 credit 累加
    this._sendFrame(P.encodeStreamAck({ streamId, credit: buf.length }));
  }

  _handleStreamEnd(msg) {
    const { streamId } = msg;
    if (!this._pendingStreams || !this._pendingStreams.has(streamId)) return;
    this._finishUpStream(streamId);
  }

  _finishUpStream(streamId) {
    const st = this._pendingStreams.get(streamId);
    if (!st) return;
    this._pendingStreams.delete(streamId);

    const rawBody = st.chunks.length ? Buffer.concat(st.chunks) : EMPTY;

    this._runStreamRequest({
      streamId,
      requestId: st.requestId,
      method: st.method,
      url: st.url,
      headers: st.headers,
      rawBody,
      startTime: st.startTime,
    }).catch((e) => {
      this.emit('error', { error: 'stream request failed: ' + e.message });
      this._sendStreamResponse(streamId, {
        status: 500,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: Buffer.from(JSON.stringify({ ok: false, error: e.message }), 'utf8'),
      });
    });
  }

  async _runStreamRequest({ streamId, requestId, method, url, headers, rawBody, startTime }) {
    let response;
    try {
      response = await this.onRequest({
        requestId,
        domain: '',
        method,
        url,
        headers,
        body: rawBody.length ? rawBody : null,
        rawBody,
      });

      // SSE：server.js 返回 __sse 描述，需要保持连接并逐事件推送
      if (response && response.__sse) {
        this.stats.requestsOk++;
        this._streamSse(streamId, response.__sse, headers);
        this.emit('stream_sse_open', { streamId, endpoint: response.__sse.endpoint });
        return;
      }

      response = this._applyCors(response || {}, { headers });
      this.stats.requestsOk++;
    } catch (e) {
      this.stats.requestsError++;
      response = this._applyCors({
        status: 500,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: Buffer.from(JSON.stringify({ ok: false, error: e.message }), 'utf8'),
      }, { headers });
    }

    const duration = Date.now() - startTime;
    this._sendStreamResponse(streamId, {
      status: response.status || 200,
      headers: {
        ...(response.headers || {}),
        'x-dsh-bridge-duration': String(duration),
      },
      body: this._responseBodyToBuffer(response.body),
    });

    this.emit('request', { method, url, status: response.status || 200, duration });
  }

  // ---------- 隧道 SSE ----------
  // 下行仍是 STREAM_OPEN(status+headers) -> STREAM_CHUNK(事件字节) -> STREAM_END。
  // 事件格式与本地 _handleSse 保持一致：id + data(JSON) / event: end / event: error。
  _streamSse(streamId, sse, reqHeaders) {
    const cors = this._applyCors({}, { headers: reqHeaders }).headers;
    const headers = {
      ...cors,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      'x-accel-buffering': 'no',
    };
    for (const k of Object.keys(headers)) {
      const lk = k.toLowerCase();
      if (lk === 'connection' || lk === 'keep-alive' || lk === 'transfer-encoding'
        || lk === 'upgrade' || lk === 'te' || lk === 'trailer' || lk === 'proxy-connection') {
        delete headers[k];
      }
    }

    const open = () => this._sendFrame(P.encodeStreamOpen({
      streamId,
      requestId: '',
      direction: 'down',
      method: 'HTTP/1.1',
      url: '',
      status: 200,
      headers,
    }));
    const write = (text) => this._sendFrame(P.encodeStreamChunk({
      streamId,
      data: Buffer.from(text, 'utf8'),
    }));

    open();

    // 参数非法等前置错误：推一条 error 事件后立即结束
    if (sse.prelude) {
      write(sse.prelude);
      this._sendFrame(P.encodeStreamEnd({ streamId }));
      return;
    }

    if (typeof this.openStream !== 'function') {
      write('event: error\ndata: {"error":"bridge has no openStream handler"}\n\n');
      this._sendFrame(P.encodeStreamEnd({ streamId }));
      return;
    }

    write(': connected\n\n');

    let seq = 0;
    let closed = false;
    let heartbeat = null;

    const finish = (finalText) => {
      if (closed) return;
      closed = true;
      if (finalText) write(finalText);
      if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
      this.activeSse.delete(streamId);
      this.stats.streamsActive = this.activeSse.size + this.activeStreams.size;
      this._sendFrame(P.encodeStreamEnd({ streamId }));
    };

    let stream;
    try {
      stream = this.openStream(sse.endpoint, sse.args || {}, {
        onItem: (v) => {
          if (closed) return;
          seq++;
          write(`id: ${seq}\ndata: ${JSON.stringify(v)}\n\n`);
        },
        onEnd: () => finish('event: end\ndata: {}\n\n'),
        onError: (e) => finish(`event: error\ndata: ${JSON.stringify(e)}\n\n`),
      });
    } catch (e) {
      finish(`event: error\ndata: ${JSON.stringify({ message: e.message })}\n\n`);
      return;
    }

    heartbeat = setInterval(() => {
      if (!closed) write(': heartbeat\n\n');
    }, 25000);
    heartbeat.unref?.();

    this.activeSse.set(streamId, {
      stream,
      finish: () => finish(null),
      cancel: () => {
        if (closed) return;
        closed = true;
        if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
        this.activeSse.delete(streamId);
        this.stats.streamsActive = this.activeSse.size + this.activeStreams.size;
        try { stream.cancel?.(); } catch (e) {}
        this._sendFrame(P.encodeStreamEnd({ streamId }));
      },
    });
    this.stats.streamsActive = this.activeSse.size + this.activeStreams.size;
  }

  // 下行响应：STREAM_OPEN(down) 带 status+headers -> STREAM_CHUNK(down) 带 body -> STREAM_END
  _sendStreamResponse(streamId, { status, headers, body }) {
    const hdrs = headers || {};
    // 删掉逐跳头，proxy-server.js 的 onDownStreamOpen 也会再过滤一次
    for (const k of Object.keys(hdrs)) {
      const lk = k.toLowerCase();
      if (lk === 'connection' || lk === 'keep-alive' || lk === 'transfer-encoding'
        || lk === 'upgrade' || lk === 'te' || lk === 'trailer' || lk === 'proxy-connection') {
        delete hdrs[k];
      }
    }

    this._sendFrame(P.encodeStreamOpen({
      streamId,
      requestId: '',
      direction: 'down',
      method: 'HTTP/1.1',
      url: '',
      status: status || 200,
      headers: hdrs,
    }));

    const buf = this._responseBodyToBuffer(body);
    if (buf.length) {
      this._sendFrame(P.encodeStreamChunk({ streamId, data: buf }));
    }

    this._sendFrame(P.encodeStreamEnd({ streamId }));
  }

  _handleStreamCancel(msg) {
    const { streamId } = msg;
    const sse = this.activeSse.get(streamId);
    if (sse) {
      try { sse.cancel(); } catch (e) {}
      return;
    }
    if (this._pendingStreams && this._pendingStreams.has(streamId)) {
      this._pendingStreams.delete(streamId);
    }
  }

  _handleStreamAck(msg) {
    // 下行 ACK：服务端告诉我们已写入浏览器的字节数，当前实现一次性写完，无需回补窗口
    const st = this._downStreams && this._downStreams.get(msg.streamId);
    if (st) st.acked += msg.credit || 0;
  }

  _endpointFromPath(pathname) {
    // /api/stream/session.follow -> session/follow
    const m = /^\/api\/stream\/(.+)$/.exec(pathname || '');
    if (!m) return '';
    const name = decodeURIComponent(m[1]);
    if (name === '$events' || name === 'events') return '$events';
    return name.replace(/^([^.]+)\.(.+)$/, '$1/$2');
  }

  _rejectWs(requestId, domain, wsRequestId, status, message) {
    this._sendFrame(P.encodeHttpResponse({
      requestId, domain, status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: Buffer.from(JSON.stringify({ ok: false, error: message }), 'utf8'),
      isWebSocket: true,
      wsRequestId,
      error: message,
    }, this.serverVersion));
  }

  _handleWsData(msg) {
    const stream = this.activeStreams.get(msg.wsRequestId);
    if (!stream) return;

    const bytes = toBuffer(msg.data);
    if (msg.isBinary) {
      stream.send?.(bytes);
      return;
    }

    // 文本帧：优先按 JSON 解析后 send，失败则原样发字符串
    const text = bytes.toString('utf8');
    if (!text) { stream.send?.(''); return; }
    try { stream.send?.(JSON.parse(text)); }
    catch (e) { stream.send?.(text); }
  }

  _handleWsClose(msg) {
    const stream = this.activeStreams.get(msg.wsRequestId);
    if (!stream) return;
    try { stream.cancel?.(); } catch (e) {}
    this.activeStreams.delete(msg.wsRequestId);
    this.stats.streamsActive = this.activeStreams.size;
  }

  // ---------- 状态 ----------

  getStatus() {
    return {
      protocol: 'dtns-v2',
      serverVersion: this.serverVersion,
      connected: this.connected,
      registered: this.registered,
      clientId: this.clientId,
      domain: this._domainFor(this.clientId),
      registeredDomains: Array.from(this.registeredDomains),
      stats: { ...this.stats },
    };
  }
}

module.exports = { Tunnel };
