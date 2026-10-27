// src/auth.js
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const b64url = (b) => Buffer.from(b).toString('base64')
  .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');

class AuthCookie {
  constructor({ dshHome, authority, maxAgeMs, baseUrl, launchToken }) {
    this.dshHome = dshHome;
    this.authority = authority;       // "127.0.0.1:19387"
    this.maxAgeMs = maxAgeMs;
    this.baseUrl = baseUrl || null;   // 用于 launch token 交换（可选）
    this.launchToken = launchToken || null;
    this._cache = null;
    this._exchanging = null;          // 防止并发重复交换
  }

  // 强制下次 cookieHeader() 重新铸造/交换
  invalidate() {
    this._cache = null;
  }

  _readSecret() {
    const file = path.join(this.dshHome, '.credentials.yaml');
    const yaml = fs.readFileSync(file, 'utf8');
    const m = yaml.match(
      /client-connection\/browser-session:[\s\S]*?secret:\s*(\S+)/);
    if (!m) {
      const err = new Error(
        'browser-session secret not found in .credentials.yaml; ' +
        'DSH may need re-authorization (provide a launch token)',
      );
      err.code = 'AUTH_SECRET_MISSING';
      throw err;
    }
    return Buffer.from(m[1], 'base64url');
  }

  _mint() {
    const secret = this._readSecret();
    const now = Date.now();
    const payload = {
      version: 1,
      authority: this.authority,
      issuedAt: now,
      expiresAt: now + this.maxAgeMs,
    };
    const body = b64url(JSON.stringify(payload));
    const sig = b64url(
      crypto.createHmac('sha256', secret).update(body).digest());
    const name = 'dsh-auth-' + b64url(
      crypto.createHash('sha256').update(this.authority).digest());
    return { header: `${name}=v1.${body}.${sig}`, expiresAt: payload.expiresAt };
  }

  // 用 launch token 走 GET /?token= 换 cookie（需要 baseUrl）
  async _exchangeLaunchToken() {
    if (!this.baseUrl) {
      throw new Error('launchToken exchange requires baseUrl');
    }
    if (this._exchanging) return this._exchanging;
    this._exchanging = (async () => {
      try {
        const url = `${this.baseUrl}/?token=${encodeURIComponent(this.launchToken)}`;
        const res = await fetch(url, { redirect: 'manual' });
        const setCookies =
          typeof res.headers.getSetCookie === 'function'
            ? res.headers.getSetCookie()
            : [res.headers.get('set-cookie')].filter(Boolean);
        const target = setCookies.find((c) => c && c.startsWith('dsh-auth-'));
        if (!target) {
          throw new Error(
            `launch token exchange failed: status=${res.status}, no dsh-auth cookie`,
          );
        }
        const header = target.split(';')[0].trim();
        // 从 cookie 的 Max-Age/Expires 里粗略推算，取不到就用 maxAgeMs
        let expiresAt = Date.now() + this.maxAgeMs;
        const ma = target.match(/Max-Age=(\d+)/i);
        if (ma) expiresAt = Date.now() + parseInt(ma[1], 10) * 1000;
        else {
          const ex = target.match(/Expires=([^;]+)/i);
          if (ex) {
            const t = Date.parse(ex[1]);
            if (!Number.isNaN(t)) expiresAt = t;
          }
        }
        this._cache = { header, expiresAt };
        console.log('[auth] cookie exchanged via launch token');
      } finally {
        this._exchanging = null;
      }
    })();
    return this._exchanging;
  }

  // 同步接口保持兼容：有 launchToken 时用已缓存的交换结果；
  // 没有缓存且需要交换时，抛错让上层走 async 路径（mux 会调 ensureCookieHeader）
  cookieHeader() {
    const now = Date.now();
    if (!this._cache || this._cache.expiresAt - now < 3600_000) {
      this._cache = this._mint();
    }
    return this._cache.header;
  }

  // 异步版本：优先 launchToken 交换，否则本地铸造
  async ensureCookieHeader() {
    const now = Date.now();
    if (this._cache && this._cache.expiresAt - now > 3600_000) {
      return this._cache.header;
    }
    if (this.launchToken) {
      try {
        await this._exchangeLaunchToken();
        return this._cache.header;
      } catch (e) {
        console.warn('[auth] launch token exchange failed, falling back to mint:', e.message);
      }
    }
    this._cache = this._mint();
    return this._cache.header;
  }
}

module.exports = { AuthCookie };