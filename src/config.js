// src/config.js
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

function randomId(n) {
  return crypto.randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n);
}

// 稳定 clientId：优先级 环境变量 > 本地持久化文件 > 新生成并写盘。
// 隧道域名是 ai.dsh2.<clientId>.html.dtns.top，随机 clientId 会导致每次重启
// 换域名，用户手里的旧链接就会 404（服务端报 No tunnel registered for domain）。
function stableClientId(home) {
  if (process.env.DSH_BRIDGE_CLIENT_ID) return process.env.DSH_BRIDGE_CLIENT_ID;
  const file = path.join(home, 'dsh-bridge-client-id');
  try {
    const saved = fs.readFileSync(file, 'utf8').trim();
    if (saved) return saved;
  } catch {}
  const id = 'dsh-' + randomId(20);
  try { fs.writeFileSync(file, id, 'utf8'); } catch {}
  return id;
}

module.exports = {
  dshBaseUrl: process.env.DSH_BASE_URL || 'http://127.0.0.1:9121',
  dshHome: process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
  localPort: parseInt(process.env.DSH_BRIDGE_PORT || '10998', 10),
  // v2 隧道服务端（DTNS 二进制协议 / sdk.js 兼容）。
  // 旧的 ai.dsh.*.html.dtns.top 域名由 1.0 服务端处理，v2 使用 ai.dsh2.* 前缀。
  tunnelUrl: process.env.DSH_TUNNEL_URL || 'wss://res2.dtns.top/tunnel',
  clientId: stableClientId(process.env.DSH_HOME || path.join(os.homedir(), '.dsh')),
  cookieMaxAgeMs: 29 * 24 * 3600 * 1000,
  // 可选：DSH 重新授权后，用 launch token 换新 cookie
  launchToken: process.env.DSH_LAUNCH_TOKEN || null,
  autoDiscoverPort:true
};
