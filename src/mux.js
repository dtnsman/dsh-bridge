// src/mux.js
// 相比原版，加了：
//   1. close 后自动重连（指数退避）
//   2. 重连成功后 emit('reopen')
//   3. open() 时记录 endpoint + args，重连后自动重开
//   4. upgrade 被拒（401/403）时识别为 auth 问题，触发重新铸 cookie
//   5. 连续失败到阈值时兜底 invalidate cookie
//   6. AUTH_SECRET_MISSING 时给出明确提示（需要 launch token）
//   7. watchdog：超过 6s 没收到任何帧就主动 destroy，触发重连

'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 30000;
const AUTH_RETRY_THRESHOLD = 1;     // 401/403 后重铸一次
const FALLBACK_INVALIDATE_EVERY = 20; // 连续失败 N 次兜底重铸
const WATCHDOG_IDLE_MS = 6000;      // DSH 2s 一 Ping，6s 无帧视为死链
const WATCHDOG_TICK_MS = 2000;

class DshMuxClient extends EventEmitter {
  constructor({ baseUrl, auth }) {
    super();
    this.baseUrl = baseUrl;
    this.auth = auth;
    this.socket = null;
    this.ready = false;
    this.streams = new Map();
    this.seq = 0;
    this._buf = Buffer.alloc(0);

    this._closing = false;             // 主动关闭标记
    this._reconnectAttempt = 0;
    this._reconnectTimer = null;
    this._everConnected = false;
    this._authInvalidated = false;     // 本轮 401/403 是否已重铸过
    this._lastFrameAt = 0;
    this._watchdog = null;
    this._reopenListeners = new Set();
  }

  async connect() {
    if (this.socket && this.ready) return;
    this._closing = false;

    const url = new URL(this.baseUrl);
    const key = crypto.randomBytes(16).toString('base64');

    // 支持 launchToken 交换的异步取 cookie
    let cookie;
    try {
      cookie = typeof this.auth.ensureCookieHeader === 'function'
        ? await this.auth.ensureCookieHeader()
        : this.auth.cookieHeader();
    } catch (e) {
      // AUTH_SECRET_MISSING 直接抛出，让上层提示
      throw e;
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, arg) => {
        if (settled) return;
        settled = true;
        fn(arg);
      };

      const req = http.request({
        host: url.hostname,
        port: url.port,
        path: '/api/remote.mux',
        headers: {
          connection: 'Upgrade',
          upgrade: 'websocket',
          'sec-websocket-version': '13',
          'sec-websocket-key': key,
          cookie,
          host: url.host,
        },
      });

      req.on('upgrade', (res, socket) => {
        const accept = crypto.createHash('sha1')
          .update(key + WS_GUID).digest('base64');
        if (res.headers['sec-websocket-accept'] !== accept) {
          socket.destroy();
          return done(reject, new Error('bad websocket accept'));
        }
        this.socket = socket;
        this.ready = true;
        this._everConnected = true;
        this._reconnectAttempt = 0;
        this._authInvalidated = false;
        this._lastFrameAt = Date.now();

        socket.on('data', (c) => this._onData(c));
        socket.on('close', () => this._onClose());
        socket.on('error', (e) => this.emit('error', e));

        this._startWatchdog();
        this.emit('open');
        done(resolve);
      });

      // upgrade 被拒：DSH 返回普通 HTTP 响应（401/403/404…）
      req.on('response', (res) => {
        const status = res.statusCode;
        res.resume();
        const err = Object.assign(
          new Error(`upgrade rejected: HTTP ${status}`),
          { status },
        );
        if (status === 401 || status === 403) {
          this.emit('auth-rejected', { status });
        }
        if (!this._closing && this._everConnected) {
          this._scheduleReconnect();
        }
        done(reject, err);
      });

      req.on('error', (e) => {
        if (this._closing) return done(reject, e);
        // 冷启动 ECONNREFUSED：不排重连，让上层明确失败
        if (!this._everConnected && e.code === 'ECONNREFUSED') {
          return done(reject, Object.assign(e, {
            hint: `DSH 未监听 ${this.baseUrl}`,
          }));
        }
        this._scheduleReconnect();
        done(reject, e);
      });

      req.end();
    });
  }

  _startWatchdog() {
    this._stopWatchdog();
    this._watchdog = setInterval(() => {
      if (!this.socket) return;
      if (Date.now() - this._lastFrameAt > WATCHDOG_IDLE_MS) {
        console.warn(
          `[mux] no frames for ${WATCHDOG_IDLE_MS}ms, destroying socket to force reconnect`,
        );
        try { this.socket.destroy(); } catch {}
      }
    }, WATCHDOG_TICK_MS);
    this._watchdog.unref?.();
  }

  _stopWatchdog() {
    if (this._watchdog) {
      clearInterval(this._watchdog);
      this._watchdog = null;
    }
  }

  _onClose() {
    this.ready = false;
    this.socket = null;
    this._stopWatchdog();
    this.emit('close');

    if (!this._closing) this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    if (this._closing) return;

    this._reconnectAttempt++;
    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this._reconnectAttempt - 1),
      RECONNECT_MAX_MS,
    );
    const jittered = delay * (0.5 + Math.random() * 0.5);
    console.log(
      `[mux] reconnecting in ${Math.round(jittered)}ms (attempt ${this._reconnectAttempt})`,
    );

    // ★ 通知外部进行扫描，更新 baseUrl
    this.emit('reconnect-attempt');

    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      try {
        await this.connect();
        console.log('[mux] reconnected');
        this.emit('reopen');
      } catch (e) {
        // 认证被拒：重铸一次 cookie
        if (
          (e.status === 401 || e.status === 403) &&
          !this._authInvalidated
        ) {
          console.warn(
            `[mux] auth rejected (HTTP ${e.status}), re-minting cookie`,
          );
          this.auth.invalidate();
          this._authInvalidated = true;
        } else if (
          (e.status === 401 || e.status === 403) &&
          this._authInvalidated
        ) {
          console.error(
            '[mux] auth still rejected after re-mint; ' +
            'secret may be stale — provide a fresh launch token ' +
            '(DSH_LAUNCH_TOKEN / --launch-token) and restart bridge',
          );
        }

        // secret 文件里读不到：明确提示
        if (e.code === 'AUTH_SECRET_MISSING') {
          console.error('[mux] cannot read browser-session secret from .credentials.yaml');
          console.error('      DSH may have re-authorized. Copy the token from DSH\'s');
          console.error('      "dsh web:" startup URL and pass it via');
          console.error('      DSH_LAUNCH_TOKEN=<token> or --launch-token <token>, then restart.');
        }

        // 连续失败兜底重铸（覆盖 DSH 重启后 secret 轮换但没返回 401 的情况）
        if (this._reconnectAttempt % FALLBACK_INVALIDATE_EVERY === 0) {
          console.warn(
            `[mux] ${this._reconnectAttempt} consecutive failures, ` +
            'invalidating cookie as fallback',
          );
          this.auth.invalidate();
          this._authInvalidated = false;
        }

        console.warn('[mux] reconnect failed:', e.code || e.status || e.message);
        this._scheduleReconnect();
      }
    }, jittered);
  }

  close() {
    this._closing = true;
    this._stopWatchdog();
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this.socket) {
      try { this.socket.end(); } catch {}
      this.socket = null;
    }
    this.ready = false;
  }

  // ---------- 帧编解码 ----------

  _sendFrame(opcode, payload) {
    if (!this.socket) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;
    const mask = crypto.randomBytes(4);
    header[1] |= 0x80;
    const masked = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
    try {
      this.socket.write(Buffer.concat([header, mask, masked]));
    } catch (e) {
      this.emit('error', e);
    }
  }

  _sendText(obj) {
    this._sendFrame(0x1, Buffer.from(JSON.stringify(obj), 'utf8'));
  }

  _sendPong(payload) {
    this._sendFrame(0xA, payload || Buffer.alloc(0));
  }

  _onData(chunk) {
    this._lastFrameAt = Date.now();
    this._buf = Buffer.concat([this._buf, chunk]);
    while (this._buf.length >= 2) {
      const b0 = this._buf[0], b1 = this._buf[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) {
        if (this._buf.length < 4) break;
        len = this._buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this._buf.length < 10) break;
        len = Number(this._buf.readBigUInt64BE(2));
        off = 10;
      }
      const need = off + (masked ? 4 : 0) + len;
      if (this._buf.length < need) break;
      let payload;
      if (masked) {
        const mask = this._buf.subarray(off, off + 4);
        const data = this._buf.subarray(off + 4, off + 4 + len);
        payload = Buffer.from(data);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      } else {
        payload = this._buf.subarray(off, off + len);
      }
      this._buf = this._buf.subarray(need);

      if (opcode === 0x1) {
        try { this._onMessage(JSON.parse(payload.toString('utf8'))); }
        catch (e) { this.emit('error', e); }
      } else if (opcode === 0x9) {
        this._sendPong(payload);
      } else if (opcode === 0x8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : null;
        const reason = payload.length > 2
          ? payload.subarray(2).toString('utf8')
          : '';
        console.warn(`[mux] DSH sent close frame: code=${code} reason=${reason}`);
        try { this.socket.end(); } catch {}
      }
    }
  }

  _onMessage(msg) {
    const s = this.streams.get(msg.streamId);
    if (msg.type === 'item') s?.onItem?.(msg.value);
    else if (msg.type === 'end') {
      s?.onEnd?.();
      this.streams.delete(msg.streamId);
    } else if (msg.type === 'error') {
      s?.onError?.(msg.error);
      this.streams.delete(msg.streamId);
    }
  }

  // ---------- 流 API ----------

  open(endpoint, args = {}, handlers = {}) {
    const streamId = `s-${++this.seq}`;
    this.streams.set(streamId, { ...handlers, endpoint, args });

    if (this.ready) {
      this._sendText({ type: 'open', streamId, endpoint, payload: { args } });
    }
    return {
      streamId,
      send: (value) => {
        if (this.ready) this._sendText({ type: 'item', streamId, value });
      },
      end: () => {
        if (this.ready) this._sendText({ type: 'end', streamId });
      },
      cancel: () => {
        if (this.ready) this._sendText({ type: 'cancel', streamId });
        this.streams.delete(streamId);
      },
    };
  }

  reopenAll() {
    for (const [streamId, s] of this.streams) {
      if (!s.endpoint) continue;
      this._sendText({
        type: 'open', streamId,
        endpoint: s.endpoint,
        payload: { args: s.args || {} },
      });
    }
  }
}

module.exports = { DshMuxClient };