// src/dtns-protocol.js
//
// DTNS 二进制协议（sdk.js 2.0）编解码层。
//
// 帧格式（13 字节头 + payload）：
//   [0..3]  MAGIC "DTNS"
//   [4]     version (1 | 2)
//   [5..6]  typeCode (UInt16 BE)
//   [7..8]  flags (UInt16 BE)
//   [9..12] payload length (UInt32 BE)
//
// 本模块把 sdk.js 内嵌的 Protocol 抽出来，并补齐「服务端方向」的编码/解码：
//   - decodeHttpResponse  : 桥接收 HTTP_RESPONSE（远程 -> 本地）
//   - decodeHttpRequest   : 桥接收 HTTP_REQUEST（远程 -> 本地，含 WS 升级）
//   - encodeHttpRequest   : 补对称实现
//   - encodeWebSocketData : 本地 -> 远程的 WS 数据帧
//   - encodeWebSocketClose: 本地 -> 远程的 WS 关闭帧
//
// 与 sdk.js 保持 wire 兼容，不依赖 DOM / Node 特有 API（只用 TextEncoder/TextDecoder/Uint8Array）。
'use strict';

const MAGIC = [0x44, 0x54, 0x4e, 0x53]; // "DTNS"
const VERSION = 1;
const VERSION_2 = 2;

const TYPE = {
  REGISTER_TUNNEL: 0x0001,
  UNREGISTER_TUNNEL: 0x0002,
  HEARTBEAT: 0x0003,
  HTTP_RESPONSE: 0x0004,
  TUNNEL_LIST: 0x0005,
  COMMAND_RESPONSE: 0x0006,
  STATS: 0x0007,
  SSE_DATA: 0x0008,
  SSE_END: 0x0009,
  SSE_ERROR: 0x000a,
  SSE_CLOSE: 0x000b,
  WEBSOCKET_UPGRADED: 0x000c,
  WEBSOCKET_DATA: 0x000d,
  WEBSOCKET_END: 0x000e,
  WEBSOCKET_ERROR: 0x000f,
  WEBSOCKET_CLOSE: 0x0010,
  SSE_CONNECTIONS: 0x0011,
  ERROR: 0x0012,
  STREAM_OPEN: 0x0020,
  STREAM_CHUNK: 0x0021,
  STREAM_END: 0x0022,
  STREAM_ACK: 0x0023,
  STREAM_CANCEL: 0x0024,
  CAPABILITIES: 0x0025,
  WELCOME: 0x0101,
  REGISTERED: 0x0102,
  UNREGISTERED: 0x0103,
  HEARTBEAT_ACK: 0x0104,
  HTTP_REQUEST: 0x0105,
  TUNNEL_STATUS: 0x0106,
  COMMAND: 0x0107,
  WEBSOCKET_DATA_FROM_SERVER: 0x0108,
  WEBSOCKET_CLOSE_FROM_SERVER: 0x0109,
  SSE_DATA_FROM_SERVER: 0x010a,
  SSE_END_FROM_SERVER: 0x010b,
  SSE_ERROR_FROM_SERVER: 0x010c,
  SSE_CLOSE_FROM_SERVER: 0x010d,
};

const TYPE_NAME = {};
Object.keys(TYPE).forEach((name) => { TYPE_NAME[TYPE[name]] = name.toLowerCase(); });

const FLAGS = {
  HAS_BODY: 0x0001,
  HAS_HEADERS: 0x0002,
  IS_SSE: 0x0004,
  IS_WEBSOCKET: 0x0008,
  GZIPPED: 0x0010,
  IS_BINARY: 0x0020,
};

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

function utf8(text) {
  return encoder.encode(text == null ? '' : String(text));
}

function toBytes(input) {
  if (input == null) return new Uint8Array(0);
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  if (typeof input === 'string') return utf8(input);
  return utf8(input);
}

function textOf(bytes) {
  try { return decoder.decode(toBytes(bytes)); }
  catch (e) { return ''; }
}

function concat(parts) {
  let length = 0;
  let i;
  for (i = 0; i < parts.length; i++) length += parts[i].length;
  const output = new Uint8Array(length);
  let offset = 0;
  for (i = 0; i < parts.length; i++) {
    output.set(parts[i], offset);
    offset += parts[i].length;
  }
  return output;
}

function u8(value) {
  return new Uint8Array([value & 0xff]);
}

function u16(value) {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value & 0xffff);
  return bytes;
}

function u32(value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value >>> 0);
  return bytes;
}

function encodeString(value) {
  const bytes = utf8(value);
  return concat([u16(bytes.length), bytes]);
}

function encodeBuffer(value) {
  const bytes = toBytes(value);
  return concat([u32(bytes.length), bytes]);
}

function encodeHeaders(headers, multiValue) {
  headers = headers || {};
  const keys = Object.keys(headers).filter((key) =>
    headers[key] !== undefined && headers[key] !== null);

  const parts = [u16(keys.length)];
  keys.forEach((key) => {
    const value = headers[key];
    const text = Array.isArray(value)
      ? value.map(String).join(multiValue ? '\n' : ',')
      : String(value);
    parts.push(encodeString(key));
    parts.push(encodeString(text));
  });
  return concat(parts);
}

function Reader(bytes) {
  this.bytes = bytes;
  this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  this.offset = 0;
}

Reader.prototype.u8 = function () {
  const value = this.view.getUint8(this.offset);
  this.offset += 1;
  return value;
};

Reader.prototype.u16 = function () {
  const value = this.view.getUint16(this.offset);
  this.offset += 2;
  return value;
};

Reader.prototype.u32 = function () {
  const value = this.view.getUint32(this.offset);
  this.offset += 4;
  return value;
};

Reader.prototype.str = function () {
  const length = this.u16();
  const value = decoder.decode(this.bytes.subarray(this.offset, this.offset + length));
  this.offset += length;
  return value;
};

Reader.prototype.buf = function () {
  const length = this.u32();
  const value = this.bytes.slice(this.offset, this.offset + length);
  this.offset += length;
  return value;
};

Reader.prototype.headers = function () {
  const count = this.u16();
  const output = {};
  for (let i = 0; i < count; i++) {
    const key = this.str();
    const value = this.str();
    output[key] = value.indexOf('\n') >= 0 ? value.split('\n') : value;
  }
  return output;
};

Reader.prototype.remaining = function () {
  return this.bytes.length - this.offset;
};

function encodeFrame(typeName, payload, version, flags) {
  const typeCode = TYPE[String(typeName).toUpperCase()];
  if (typeCode === undefined) throw new Error('Unknown DTNS frame type: ' + typeName);

  const header = new Uint8Array(13);
  header.set(MAGIC, 0);
  header[4] = version === VERSION_2 ? VERSION_2 : VERSION;
  const view = new DataView(header.buffer);
  view.setUint16(5, typeCode);
  view.setUint16(7, flags || 0);
  view.setUint32(9, payload.length);
  return concat([header, payload]);
}

function decodeFrame(input) {
  const bytes = toBytes(input);
  if (bytes.length < 13) throw new Error('DTNS frame too short: ' + bytes.length);

  for (let i = 0; i < 4; i++) {
    if (bytes[i] !== MAGIC[i]) throw new Error('Invalid DTNS magic');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = bytes[4];
  const typeCode = view.getUint16(5);
  const flags = view.getUint16(7);
  const length = view.getUint32(9);

  if (bytes.length < 13 + length) {
    throw new Error('DTNS frame truncated: need ' + (13 + length) + ', got ' + bytes.length);
  }

  return {
    version,
    typeCode,
    type: TYPE_NAME[typeCode] || 'unknown_0x' + typeCode.toString(16),
    flags,
    payload: bytes.slice(13, 13 + length),
    byteLength: bytes.length,
  };
}

// ==================== client -> server ====================

function encodeRegisterTunnel(fields) {
  const tunnel = fields.tunnel || fields;
  const payload = concat([
    encodeString(fields.clientId || ''),
    encodeString(tunnel.id || ''),
    encodeString(tunnel.domain || ''),
    u8((tunnel.localPort || 80) & 0xff),
    encodeString(tunnel.localHost || '127.0.0.1'),
    encodeString(tunnel.protocol || 'http'),
    encodeString(tunnel.description || ''),
  ]);
  return encodeFrame('register_tunnel', payload, VERSION, 0);
}

function encodeUnregisterTunnel(fields) {
  const payload = concat([
    encodeString(fields.clientId || ''),
    encodeString(fields.domain || ''),
  ]);
  return encodeFrame('unregister_tunnel', payload, VERSION, 0);
}

function encodeCapabilities(fields) {
  let flags = 0;
  if (fields.stream) flags |= 0x01;
  if (fields.multiValueHeaders) flags |= 0x02;
  const payload = concat([encodeString(fields.clientId || ''), u8(flags)]);
  return encodeFrame('capabilities', payload, VERSION, 0);
}

function encodeHeartbeat(fields) {
  const stats = fields.stats || {};
  const payload = concat([
    encodeString(fields.clientId || ''),
    encodeString(fields.timestamp || new Date().toISOString()),
    u32(stats.tunnelCount || 0),
    u32(stats.registeredCount || 0),
    u32(stats.sseConnections || 0),
    u32(stats.totalRequests || 0),
    u32(stats.totalErrors || 0),
  ]);
  return encodeFrame('heartbeat', payload, VERSION, 0);
}

function encodeHttpResponse(fields, version) {
  const v = version >= VERSION_2 ? VERSION_2 : VERSION;
  let status = Number(fields.status);
  if (!(status >= 100 && status <= 599)) status = 200;

  const body = toBytes(fields.body);
  const headers = fields.headers || {};
  let payloadFlags = 0;
  if (fields.isSSE) payloadFlags |= 0x01;
  if (fields.isWebSocket) payloadFlags |= 0x02;
  if (fields.error) payloadFlags |= 0x04;

  const payload = concat([
    encodeString(fields.requestId || ''),
    encodeString(fields.domain || ''),
    v >= VERSION_2 ? u16(status) : u8(status),
    encodeHeaders(headers, true),
    encodeBuffer(body),
    u8(payloadFlags),
    encodeString(fields.sseRequestId || ''),
    encodeString(fields.wsRequestId || ''),
    encodeString(fields.error || ''),
  ]);

  let frameFlags = 0;
  if (body.length) frameFlags |= FLAGS.HAS_BODY;
  if (Object.keys(headers).length) frameFlags |= FLAGS.HAS_HEADERS;
  if (fields.isSSE) frameFlags |= FLAGS.IS_SSE;
  if (fields.isWebSocket) frameFlags |= FLAGS.IS_WEBSOCKET;

  return encodeFrame('http_response', payload, v, frameFlags);
}

function encodeHttpRequest(fields, version) {
  const v = version >= VERSION_2 ? VERSION_2 : VERSION;
  const body = toBytes(fields.body);
  const headers = fields.headers || {};
  let flags = 0;
  if (fields.isSSE) flags |= 0x01;
  if (fields.isWebSocket) flags |= 0x02;

  const payload = concat([
    encodeString(fields.requestId || ''),
    encodeString(fields.domain || ''),
    encodeString(fields.method || 'GET'),
    encodeString(fields.url || '/'),
    encodeHeaders(headers, true),
    encodeBuffer(body),
    encodeString(fields.remoteAddress || ''),
    encodeString(fields.timestamp || new Date().toISOString()),
    u8(flags),
    encodeString(fields.sseRequestId || ''),
    encodeString(fields.wsRequestId || ''),
  ]);

  let frameFlags = 0;
  if (body.length) frameFlags |= FLAGS.HAS_BODY;
  if (Object.keys(headers).length) frameFlags |= FLAGS.HAS_HEADERS;
  if (fields.isSSE) frameFlags |= FLAGS.IS_SSE;
  if (fields.isWebSocket) frameFlags |= FLAGS.IS_WEBSOCKET;

  return encodeFrame('http_request', payload, v, frameFlags);
}

// ==================== STREAM 系列（v2 服务端承载 HTTP 往返）====================
//
// 严格对齐服务端实现（E:\dtns.http-proxy\server\protocol.js）：
//
//   上行 STREAM_OPEN   : streamId requestId direction method url status(u16) headers
//   上行 STREAM_CHUNK  : streamId data(encodeBuffer)
//   上行 STREAM_END    : streamId
//   下行 STREAM_OPEN   : 同上行（status + headers 在这里，direction="down"）
//   下行 STREAM_CHUNK  : streamId data(encodeBuffer)   ← 响应体走这里
//   下行 STREAM_END    : streamId                      ← 仅结束标记
//   STREAM_CANCEL      : streamId reason
//   STREAM_ACK         : streamId credit(u32)          ← 服务端回给客户端的流控

function encodeStreamOpen(fields) {
  const status = Number(fields.status);
  const payload = concat([
    encodeString(fields.streamId || ''),
    encodeString(fields.requestId || ''),
    encodeString(fields.direction || fields.kind || 'up'),
    encodeString(fields.method || 'GET'),
    encodeString(fields.url || '/'),
    u16(status >= 100 && status <= 599 ? status : 200),
    encodeHeaders(fields.headers || {}, true),
  ]);
  let frameFlags = 0;
  if (Object.keys(fields.headers || {}).length) frameFlags |= FLAGS.HAS_HEADERS;
  return encodeFrame('stream_open', payload, VERSION, frameFlags);
}

function encodeStreamChunk(fields) {
  const data = toBytes(fields.data);
  const payload = concat([
    encodeString(fields.streamId || ''),
    encodeBuffer(data),
  ]);
  return encodeFrame('stream_chunk', payload, VERSION, data.length ? FLAGS.HAS_BODY : 0);
}

function encodeStreamEnd(fields) {
  const payload = encodeString(fields.streamId || '');
  return encodeFrame('stream_end', payload, VERSION, 0);
}

function encodeStreamAck(fields) {
  const payload = concat([
    encodeString(fields.streamId || ''),
    u32(fields.credit || 0),
  ]);
  return encodeFrame('stream_ack', payload, VERSION, 0);
}

function encodeStreamCancel(fields) {
  const payload = concat([
    encodeString(fields.streamId || ''),
    encodeString(fields.reason || ''),
  ]);
  return encodeFrame('stream_cancel', payload, VERSION, 0);
}

function encodeWebSocketData(fields) {
  const data = toBytes(fields.data);
  const payload = concat([
    encodeString(fields.wsRequestId || ''),
    encodeBuffer(data),
    encodeString(fields.timestamp || new Date().toISOString()),
  ]);
  const flags = fields.binary ? FLAGS.IS_BINARY : 0;
  return encodeFrame('websocket_data', payload, VERSION, flags);
}

function encodeWebSocketClose(fields) {
  let code = fields.code === undefined ? 1000 : Number(fields.code);
  if (!isFinite(code)) code = 1000;
  const payload = concat([
    encodeString(fields.wsRequestId || ''),
    u8(code & 0xff),
    encodeString(fields.reason || ''),
    encodeString(fields.timestamp || new Date().toISOString()),
  ]);
  return encodeFrame('websocket_close', payload, VERSION, 0);
}

// ==================== server -> client ====================

function decodeWelcome(payload) {
  const reader = new Reader(payload);
  const clientId = reader.str();
  const timestamp = reader.str();
  const message = reader.str();
  const protocolVersion = reader.remaining() > 0 ? reader.u8() : VERSION;
  return { type: 'welcome', clientId, timestamp, message, protocolVersion };
}

function decodeRegistered(payload) {
  const reader = new Reader(payload);
  const domain = reader.str();
  const success = reader.u8() === 1;
  const error = reader.str();
  const message = reader.str();
  return { type: 'registered', domain, success, error: error || null, message };
}

function decodeHttpRequest(payload) {
  const reader = new Reader(payload);
  const requestId = reader.str();
  const domain = reader.str();
  const method = reader.str();
  const url = reader.str();
  const headers = reader.headers();
  const body = reader.buf();
  const remoteAddress = reader.str();
  const timestamp = reader.str();
  const flags = reader.u8();
  const sseRequestId = reader.str();
  const wsRequestId = reader.str();

  return {
    type: 'http_request',
    requestId,
    domain,
    method,
    url,
    headers,
    body,
    remoteAddress,
    timestamp,
    isSSE: !!(flags & 0x01),
    isWebSocket: !!(flags & 0x02),
    sseRequestId: sseRequestId || null,
    wsRequestId: wsRequestId || null,
  };
}

function decodeHttpResponse(payload, version) {
  const reader = new Reader(payload);
  const requestId = reader.str();
  const domain = reader.str();
  const status = version >= VERSION_2 ? reader.u16() : reader.u8();
  const headers = reader.headers();
  const body = reader.buf();
  const payloadFlags = reader.u8();
  const sseRequestId = reader.str();
  const wsRequestId = reader.str();
  const error = reader.str();

  return {
    type: 'http_response',
    requestId,
    domain,
    status,
    headers,
    body,
    isSSE: !!(payloadFlags & 0x01),
    isWebSocket: !!(payloadFlags & 0x02),
    hasError: !!(payloadFlags & 0x04),
    sseRequestId: sseRequestId || null,
    wsRequestId: wsRequestId || null,
    error: error || null,
  };
}

function decodeStreamOpen(payload) {
  const reader = new Reader(payload);
  const streamId = reader.str();
  const requestId = reader.str();
  const direction = reader.str();
  const method = reader.str();
  const url = reader.str();
  const status = reader.remaining() >= 2 ? reader.u16() : 200;
  const headers = reader.remaining() > 0 ? reader.headers() : {};
  return { type: 'stream_open', streamId, requestId, direction, method, url, status, headers };
}

function decodeStreamChunk(payload) {
  const reader = new Reader(payload);
  const streamId = reader.str();
  const data = reader.remaining() > 0 ? reader.buf() : new Uint8Array(0);
  return { type: 'stream_chunk', streamId, data };
}

function decodeStreamEnd(payload) {
  const reader = new Reader(payload);
  const streamId = reader.str();
  return { type: 'stream_end', streamId };
}

function decodeStreamAck(payload) {
  const reader = new Reader(payload);
  const streamId = reader.str();
  const credit = reader.remaining() >= 4 ? reader.u32() : 0;
  return { type: 'stream_ack', streamId, credit };
}

function decodeStreamCancel(payload) {
  const reader = new Reader(payload);
  const streamId = reader.str();
  const reason = reader.remaining() > 0 ? reader.str() : '';
  return { type: 'stream_cancel', streamId, reason };
}

function decodeWebSocketData(payload, flags) {
  const reader = new Reader(payload);
  const wsRequestId = reader.str();
  const data = reader.buf();
  const timestamp = reader.str();
  return {
    type: 'websocket_data',
    wsRequestId,
    data,
    isBinary: !!(flags & FLAGS.IS_BINARY),
    timestamp,
  };
}

function decodeWebSocketClose(payload) {
  const reader = new Reader(payload);
  const wsRequestId = reader.str();
  const code = reader.u8();
  const reason = reader.str();
  const timestamp = reader.str();
  return { type: 'websocket_close', wsRequestId, code, reason, timestamp };
}

function decodeMessage(frame) {
  switch (frame.type) {
    case 'welcome':
      return decodeWelcome(frame.payload);
    case 'registered':
      return decodeRegistered(frame.payload);
    case 'http_request':
      return decodeHttpRequest(frame.payload);
    case 'http_response':
      return decodeHttpResponse(frame.payload, frame.version);
    case 'stream_open':
      return decodeStreamOpen(frame.payload);
    case 'stream_chunk':
      return decodeStreamChunk(frame.payload);
    case 'stream_end':
      return decodeStreamEnd(frame.payload);
    case 'stream_ack':
      return decodeStreamAck(frame.payload);
    case 'stream_cancel':
      return decodeStreamCancel(frame.payload);
    case 'heartbeat_ack':
      return { type: 'heartbeat_ack' };
    case 'websocket_data':
    case 'websocket_data_from_server':
      return decodeWebSocketData(frame.payload, frame.flags);
    case 'websocket_close':
    case 'websocket_close_from_server':
      return decodeWebSocketClose(frame.payload);
    default:
      return { type: frame.type, payload: frame.payload };
  }
}

module.exports = {
  MAGIC,
  VERSION,
  VERSION_2,
  TYPE,
  TYPE_NAME,
  FLAGS,
  utf8,
  textOf,
  toBytes,
  encodeFrame,
  decodeFrame,
  decodeMessage,
  encodeRegisterTunnel,
  encodeUnregisterTunnel,
  encodeCapabilities,
  encodeHeartbeat,
  encodeHttpRequest,
  encodeHttpResponse,
  encodeStreamOpen,
  encodeStreamChunk,
  encodeStreamEnd,
  encodeStreamAck,
  encodeStreamCancel,
  encodeWebSocketData,
  encodeWebSocketClose,
  decodeStreamOpen,
  decodeStreamChunk,
  decodeStreamEnd,
  decodeStreamAck,
  decodeStreamCancel,
  decodeWebSocketData,
  decodeWebSocketClose,
  decodeWelcome,
  decodeRegistered,
  decodeHttpRequest,
  decodeHttpResponse,
};
