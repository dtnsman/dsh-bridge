#!/usr/bin/env node
// bin/dsh-bridge.js
'use strict';

const { DshBridge } = require('../src');
const baseConfig = require('../src/config');
const { AuthCookie } = require('../src/auth');
const { DshRpcClient } = require('../src/rpc');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-tunnel') out.noTunnel = true;
    else if (a === '--check') out.check = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--port') out.port = argv[++i];
    else if (a === '--client-id') out.clientId = argv[++i];
    else if (a === '--dsh-url') out.dshUrl = argv[++i];
    else if (a === '--dsh-home') out.dshHome = argv[++i];
    else if (a === '--tunnel-url') out.tunnelUrl = argv[++i];
    else if (a === '--launch-token') out.launchToken = argv[++i];
    else if (a.startsWith('--')) { console.error(`unknown flag: ${a}`); process.exit(2); }
    else out._.push(a);
  }
  return out;
}

function printHelp() {
  console.log(`
dsh-bridge — 把 DSH 桌面版控制面桥接成远程 HTTP API

用法:
  dsh-bridge [options]

选项:
  --port <n>            本地 HTTP 端口（默认 ${baseConfig.localPort}）
  --client-id <id>      隧道 clientId（默认随机）
  --dsh-url <url>       DSH 控制面地址（默认 ${baseConfig.dshBaseUrl}）
  --dsh-home <path>     DSH_HOME（默认 ${baseConfig.dshHome}）
  --tunnel-url <url>    隧道服务地址（默认 ${baseConfig.tunnelUrl}）
  --launch-token <tok>  DSH 启动 URL 里的 token，用于 cookie 失效后重新授权
  --no-tunnel           只跑本地 HTTP，不接隧道
  --check               自检：验证 cookie 铸造 + RPC 连通，然后退出
  --help, -h            显示本帮助

环境变量:
  DSH_BASE_URL, DSH_HOME, DSH_BRIDGE_PORT,
  DSH_TUNNEL_URL, DSH_BRIDGE_CLIENT_ID, DSH_LAUNCH_TOKEN
示例:
  dsh-bridge                              # 默认启动
  dsh-bridge --port 8080                  # 换本地端口
  dsh-bridge --no-tunnel                  # 本机调试
  dsh-bridge --check                      # 自检
`);
}

function mergeConfig(args) {
  const cfg = { ...baseConfig };
  if (args.port) cfg.localPort = parseInt(args.port, 10);
  if (args.clientId) cfg.clientId = args.clientId;
  if (args.dshUrl) cfg.dshBaseUrl = args.dshUrl;
  if (args.dshHome) cfg.dshHome = args.dshHome;
  if (args.tunnelUrl) cfg.tunnelUrl = args.tunnelUrl;
  if (args.launchToken) cfg.launchToken = args.launchToken;
  return cfg;
}

async function runCheck(cfg) {
  console.log('[check] DSH base URL :', cfg.dshBaseUrl);
  console.log('[check] DSH home     :', cfg.dshHome);
  console.log('[check] tunnel URL   :', cfg.tunnelUrl);
  console.log('[check] clientId     :', cfg.clientId);
  console.log('[check] launchToken  :', cfg.launchToken ? '(set)' : '(none)');
  console.log('');

  const authority = new URL(cfg.dshBaseUrl).host;
  let auth;
  try {
    auth = new AuthCookie({
      dshHome: cfg.dshHome,
      authority,
      maxAgeMs: cfg.cookieMaxAgeMs,
      baseUrl: cfg.dshBaseUrl,
      launchToken: cfg.launchToken,
    });
    const header = await auth.ensureCookieHeader();
    const name = header.split('=')[0];
    console.log(`[check] ✅ cookie ready: ${name}=v1.<${header.length} bytes>`);
  } catch (e) {
    console.error('[check] ❌ cookie mint failed:', e.message);
    if (e.code === 'AUTH_SECRET_MISSING') {
      console.error('        .credentials.yaml 里没有 browser-session secret。');
      console.error('        从 DSH 启动日志的 "dsh web:" URL 复制 token，然后：');
      console.error('        --launch-token <token>  或  DSH_LAUNCH_TOKEN=<token>');
    } else {
      console.error('        确认 DSH 已启动过，且', cfg.dshHome, '下存在 .credentials.yaml');
    }
    process.exit(1);
  }

  const rpc = new DshRpcClient({ baseUrl: cfg.dshBaseUrl, auth });
  try {
    const value = await rpc.call('session', 'modelCatalog', {});
    const models = value?.models?.length ?? value?.length ?? '?';
    console.log(`[check] ✅ RPC ok: session/modelCatalog (${models} models)`);
  } catch (e) {
    console.error('[check] ❌ RPC failed:', e.code || e.message);
    if (e.status === 401) console.error('        cookie 被拒，检查 authority 是否与 Host 头一致');
    if (e.status === 403) console.error('        Host/Origin 栅栏拒绝，确认走 127.0.0.1');
    process.exit(1);
  }

  try {
    const { DshMuxClient } = require('../src/mux');
    const mux = new DshMuxClient({ baseUrl: cfg.dshBaseUrl, auth });
    mux.on('error', (e) => console.warn('[check] mux error:', e.code || e.message));
    await mux.connect();
    console.log('[check] ✅ mux connected: /api/remote.mux');
    mux.close();
  } catch (e) {
    console.warn('[check] ⚠️  mux connect failed:', e.code || e.status || e.message);
    console.warn('        一元调用仍可用，但流式（session/follow、$events）走不通');
  }

  console.log('');
  console.log('[check] 全部通过，可以启动 bridge。');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); return; }

  const cfg = mergeConfig(args);

  if (args.check) { await runCheck(cfg); return; }

  const bridge = new DshBridge(cfg);

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n[bridge] ${signal} received, shutting down...`);
    try { await bridge.stop(); } catch (e) { console.warn(e); }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (e) => {
    console.error('[bridge] unhandled rejection:', e);
  });
  process.on('uncaughtException', (e) => {
    console.error('[bridge] uncaught exception:', e);
  });

  try {
    await bridge.start();
  } catch (e) {
    console.error('[bridge] ❌ start failed:', e.code || e.message);
    if (e.code === 'ENOENT') {
      console.error('        找不到 .credentials.yaml，确认 DSH_HOME =', cfg.dshHome);
    }
    if (e.code === 'ECONNREFUSED') {
      console.error('        连不上 DSH，确认桌面版已启动且监听', cfg.dshBaseUrl);
    }
    if (e.code === 'AUTH_SECRET_MISSING') {
      console.error('        .credentials.yaml 缺少 browser-session secret。');
      console.error('        从 DSH 启动日志复制 launch token，用 --launch-token 传入后重试。');
    }
    process.exit(1);
  }

  const status = bridge.tunnel?.getStatus?.() || {};
  console.log('');
  console.log('  DSH Bridge 已启动');
  console.log('  ─────────────────────────────────────────');
  console.log(`  本地 HTTP : http://127.0.0.1:${cfg.localPort}`);
  console.log(`  DSH 控制面: ${cfg.dshBaseUrl}`);
  console.log(`  隧道      : ${args.noTunnel ? '(已禁用)' : cfg.tunnelUrl}`);
  console.log(`  clientId  : ${cfg.clientId}`);
  console.log(`  launchToken: ${cfg.launchToken ? '(set)' : '(none)'}`);
  console.log(`  域名      : ${status.domain || '(未注册)'}`);
  console.log('');
  console.log('  自检: dsh-bridge --check');
  console.log('  帮助: dsh-bridge --help');
  console.log('  退出: Ctrl+C');
  console.log('');

  if (process.env.DSH_BRIDGE_VERBOSE === '1') {
    setInterval(() => {
      const s = bridge.tunnel?.getStatus?.() || {};
      console.log('[bridge] status:', JSON.stringify({
        connected: s.connected,
        registered: s.registered,
        reqOk: s.stats?.requestsOk,
        reqErr: s.stats?.requestsError,
        streamsActive: s.stats?.streamsActive,
      }));
    }, 30000).unref();
  }
}

main().catch((e) => {
  console.error('[bridge] fatal:', e);
  process.exit(1);
});