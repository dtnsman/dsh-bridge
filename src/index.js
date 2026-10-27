// src/index.js
'use strict';

const path = require('node:path');
const { AuthCookie } = require('./auth');
const { DshRpcClient } = require('./rpc');
const { DshMuxClient } = require('./mux');
const { EventBridge } = require('./events');
const { TaskRegistry } = require('./tasks');
const { Tracker } = require('./tracker');
const { createRoutes } = require('./routes');
const { LocalServer } = require('./server');
const { Tunnel } = require('./tunnel');
const { findDshPort } = require('./discovery'); // ★ 引入扫描模块

class DshBridge {
  constructor(config) {
    this.config = config;
    
    // 初始化时，如果配置里没有指定端口，或者显式要求扫描
    if (config.autoDiscoverPort) {
      this._discoverAndUpdateBaseUrl();
    }

    this.auth = new AuthCookie({
      dshHome: config.dshHome,
      authority: new URL(this.config.dshBaseUrl).host,
      maxAgeMs: config.cookieMaxAgeMs,
      baseUrl: this.config.dshBaseUrl,
      launchToken: config.launchToken,
    });
    
    this.rpc = new DshRpcClient({ baseUrl: this.config.dshBaseUrl, auth: this.auth });

    const persistPath = config.taskPersistPath
      || path.join(config.dshHome, 'dsh-bridge-tasks.json');
    this.registry = new TaskRegistry({ persistPath });
  }

  // ★ 扫描并更新所有的 baseUrl
  _discoverAndUpdateBaseUrl() {
    const port = findDshPort();
    if (port) {
      const newUrl = `http://127.0.0.1:${port}`;
      if (newUrl !== this.config.dshBaseUrl) {
        console.log(`[discovery] 发现 DSH 新端口: ${port}，更新 BaseURL`);
        this.config.dshBaseUrl = newUrl;
        
        // 动态更新组件里的地址
        if (this.rpc) this.rpc.baseUrl = newUrl;
        if (this.mux) this.mux.baseUrl = newUrl;
        if (this.auth) {
          this.auth.authority = new URL(newUrl).host;
          this.auth.baseUrl = newUrl;
          this.auth.invalidate(); // 端口变了，cookie 里的 authority 也要变，强制重铸
        }
        return true;
      }
    } else {
      console.warn('[discovery] 未扫描到 DSH 端口，继续使用:', this.config.dshBaseUrl);
    }
    return false;
  }

  async start() {
    this.mux = new DshMuxClient({ baseUrl: this.config.dshBaseUrl, auth: this.auth });

    // ★ 在重连循环前触发自愈扫描
    this.mux.on('reconnect-attempt', () => {
      this._discoverAndUpdateBaseUrl();
    });

    this.mux.on('error', (e) => {
      console.warn('[mux] socket error:', e.code || e.message);
    });
    this.mux.on('auth-rejected', ({ status }) => {
      console.warn(`[mux] DSH rejected auth (HTTP ${status})`);
    });

    await this.mux.connect();

    this.mux.on('reopen', () => {
      console.log('[bridge] mux reopened, reopening streams');
      this.mux.reopenAll();
    });

    this.events = new EventBridge({
      mux: this.mux,
      rpc: this.rpc,
      registry: this.registry,
    });
    await this.events.start();

    this.tracker = new Tracker({
      rpc: this.rpc,
      registry: this.registry,
    });
    this.tracker.start();

    const routes = createRoutes({
      rpc: this.rpc,
      events: this.events,
      mux: this.mux,
      registry: this.registry,
    });
    this.local = new LocalServer({
      port: this.config.localPort,
      routes,
      mux: this.mux,
    });
    await this.local.start();

    if (this.config.tunnelUrl && !this.config.noTunnel) {
      this.tunnel = new Tunnel({
        serverUrl: this.config.tunnelUrl,
        clientId: this.config.clientId,
        onRequest: (req) => this.local.handle(req),
        onStreamOpen: (endpoint, args) => this.mux.open(endpoint, args),
        // SSE 需要在创建流时就绑定 handlers（mux.open 会复制一份 handlers）
        openStream: (endpoint, args, handlers) => this.mux.open(endpoint, args, handlers),
      });
      await this.tunnel.start();
    }

    console.log('[bridge] ready', {
      local: `http://127.0.0.1:${this.config.localPort}`,
      tunnel: this.config.tunnelUrl,
      clientId: this.config.clientId,
      tasksTracked: this.registry.list().length,
    });
  }

  async stop() {
    this.tracker?.stop();
    this.tunnel?.stop();
    this.mux?.close();
    await this.local?.stop?.();
    this.registry?.stop();
  }
}

module.exports = { DshBridge };