// src/base64.js
// 二进制安全的 Base64 工具。
// 用途：
//   1. 隧道协议里 body 是 base64 编码的（pty-agent.js 的约定）
//   2. 远程用 JSON 传二进制时（图片、文件字节）
//   3. multipart 解析后的字节封装

const Base64 = {
  // Buffer <-> base64url（无 padding，URL 安全）
  b64urlEncode(buf) {
    return Buffer.from(buf).toString('base64')
      .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
  },

  b64urlDecode(str) {
    const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
    return Buffer.from(
      str.replaceAll('-', '+').replaceAll('_', '/') + pad,
      'base64',
    );
  },

  // 普通 base64（标准字母表，带 padding）
  encode(buf) {
    return Buffer.from(buf).toString('base64');
  },

  decode(str) {
    return Buffer.from(str, 'base64');
  },

  // 字符串 <-> base64（UTF-8 安全）
  encodeText(str) {
    return Buffer.from(str, 'utf8').toString('base64');
  },

  decodeText(b64) {
    return Buffer.from(b64, 'base64').toString('utf8');
  },

  // JSON <-> base64（先序列化再编码）
  encodeJson(obj) {
    return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
  },

  decodeJson(b64) {
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  },

  // 判断一个字符串是否像 base64（粗判，用于入参类型分发）
  looksLikeBase64(s) {
    if (typeof s !== 'string' || s.length === 0) return false;
    if (s.length % 4 !== 0 && s.length % 4 !== 2 && s.length % 4 !== 3) return false;
    return /^[A-Za-z0-9+/_-]+={0,2}$/.test(s);
  },
};

module.exports = { Base64 };