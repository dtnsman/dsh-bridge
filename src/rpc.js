// src/rpc.js
class DshRpcClient {
  constructor({ baseUrl, auth }) {
    this.baseUrl = baseUrl;
    this.auth = auth;
    this.seq = 0;
  }

  async call(ns, method, args = {}, { signal } = {}) {
    const endpoint = `${ns}/${method}`;
    const res = await fetch(`${this.baseUrl}/api/${endpoint}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: this.auth.cookieHeader(),
      },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: `bridge-${++this.seq}`,
        method: endpoint,
        payload: { args },              // 只能有 args 一个键
      }),
      signal,
    });

    const ct = res.headers.get('content-type') || '';
    if (ct.includes('multipart/form-data')) {
      return this._parseMultipart(res);
    }
    if (!ct.includes('application/json')) {
      throw new DshTransportError(res.status, await res.text());
    }
    const envelope = await res.json();
    if (envelope.result?.ok !== true) {
      const e = envelope.result?.error || {};
      throw new DshRpcError(e.code, e.message, e.details, endpoint);
    }
    return envelope.result.value;
  }

  async _parseMultipart(res) {
    const form = await res.formData();
    const metadata = JSON.parse(await form.get('metadata').text());
    const bytes = {};
    for (const [key, value] of form.entries()) {
      if (key === 'metadata') continue;
      bytes[key] = Buffer.from(await value.arrayBuffer());
    }
    return { metadata, bytes };
  }
}

class DshRpcError extends Error {
  constructor(code, message, details, endpoint) {
    super(`${endpoint}: ${code || 'unknown'} ${message || ''}`);
    this.code = code; this.details = details; this.endpoint = endpoint;
  }
}
class DshTransportError extends Error {
  constructor(status, body) {
    super(`transport ${status}: ${body}`);
    this.status = status; this.body = body;
  }
}

module.exports = { DshRpcClient, DshRpcError, DshTransportError };