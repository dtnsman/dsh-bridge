// src/discovery.js
'use strict';

const { execSync } = require('node:child_process');

/**
 * 动态扫描 DeepSeek Harness 的监听端口
 * @returns {number|null} 找到的端口，未找到返回 null
 */
function findDshPort() {
  // 非 Windows 环境直接返回 null，使用默认配置
  if (process.platform !== 'win32') return null;

  try {
    // 1. 获取所有匹配 'DeepSeek Harness' 的进程 PID
    const psCmd = `Get-Process | Where-Object { $_.ProcessName -match 'DeepSeek Harness' } | Select-Object -ExpandProperty Id`;
    // 使用同步执行，避免在重连周期中引入额外的异步复杂性
    const pidsOut = execSync(`powershell -NoProfile -Command "${psCmd}"`, { encoding: 'utf8' }).trim();
    if (!pidsOut) return null;

    const pids = pidsOut.split(/\s+/).filter(Boolean);
    if (pids.length === 0) return null;

    // 2. 获取这些 PID 对应的监听端口
    const netstatCmd = `Get-NetTCPConnection -State Listen | Where-Object { @(${pids.map(p => `'${p}'`).join(',')}) -contains $_.OwningProcess } | Select-Object -ExpandProperty LocalPort -Unique`;
    const portsOut = execSync(`powershell -NoProfile -Command "${netstatCmd}"`, { encoding: 'utf8' }).trim();
    
    if (portsOut) {
      const ports = portsOut.split(/\s+/).map(p => parseInt(p, 10)).filter(p => !isNaN(p));
      if (ports.length > 0) {
        // 按端口从大到小排序（动态端口通常分配在比较大的范围）
        return ports.sort((a, b) => b - a)[0];
      }
    }
  } catch (err) {
    // 静默失败，回退到原有配置
    console.warn('[discovery] 端口扫描失败:', err.message);
  }

  return null;
}

module.exports = { findDshPort };