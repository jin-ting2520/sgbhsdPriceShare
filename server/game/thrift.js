'use strict';

/**
 * Thrift Compact Protocol 编解码（游戏使用 Azurite/Thrift JS 的 compact 实现）
 * 描述符来自 thrift_schema.json：{ messages: {id: name}, structs: { 'msg:1': {fid:[name, spec]}, ... } }
 * spec：Thrift Type 数字，或 [15, elem] / [13, key, value] / [12, 'StructName']
 *
 * Compact 协议要点：
 *  - 字段头 1 字节：(delta<<4)|ctype，delta>15 时写 0 再写 zigzag varint 字段号
 *  - BOOL 字段的值直接编码在 ctype 中（1=true, 2=false），无独立值字节
 *  - i16/i32/i64 均为 zigzag varint；字符串 = varint 长度 + utf8
 *  - double = 8 字节小端 IEEE754
 *  - list/set = (size<=14 ? size<<4|etype : 0xF0|etype + varint size)
 *  - map = varint size + (size>0 ? kctype<<4|vctype : 无)
 */

const schema = require('./thrift_schema.json');

const T = {
  STOP: 0,
  BOOL: 2,
  BYTE: 3,
  DOUBLE: 4,
  I16: 6,
  I32: 8,
  I64: 10,
  STRING: 11,
  STRUCT: 12,
  MAP: 13,
  SET: 14,
  LIST: 15,
};

const CT = {
  STOP: 0,
  BOOL_TRUE: 1,
  BOOL_FALSE: 2,
  BYTE: 3,
  I16: 4,
  I32: 5,
  I64: 6,
  DOUBLE: 7,
  BINARY: 8,
  LIST: 9,
  SET: 10,
  MAP: 11,
  STRUCT: 12,
};

const TYPE_TO_CT = {
  [T.BOOL]: CT.BOOL_TRUE,
  [T.BYTE]: CT.BYTE,
  [T.DOUBLE]: CT.DOUBLE,
  [T.I16]: CT.I16,
  [T.I32]: CT.I32,
  [T.I64]: CT.I64,
  [T.STRING]: CT.BINARY,
  [T.STRUCT]: CT.STRUCT,
  [T.MAP]: CT.MAP,
  [T.SET]: CT.SET,
  [T.LIST]: CT.LIST,
};

const CT_TO_TYPE = {
  [CT.BYTE]: T.BYTE,
  [CT.I16]: T.I16,
  [CT.I32]: T.I32,
  [CT.I64]: T.I64,
  [CT.DOUBLE]: T.DOUBLE,
  [CT.BINARY]: T.STRING,
  [CT.LIST]: T.LIST,
  [CT.SET]: T.SET,
  [CT.MAP]: T.MAP,
  [CT.STRUCT]: T.STRUCT,
};

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

function typeCode(spec) {
  return Array.isArray(spec) ? spec[0] : spec;
}

function fieldsOf(idOrName) {
  const key = typeof idOrName === 'number' ? 'msg:' + idOrName : idOrName;
  const fields = schema.structs[key];
  if (!fields) throw new Error(`未知消息/结构: ${idOrName}`);
  return fields;
}

/* ------------------------------ 写入 ------------------------------ */

class Writer {
  constructor() {
    this.buf = Buffer.allocUnsafe(512);
    this.len = 0;
  }

  ensure(n) {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const next = Buffer.allocUnsafe(size);
    this.buf.copy(next, 0, 0, this.len);
    this.buf = next;
  }

  byte(v) {
    this.ensure(1);
    this.buf.writeUInt8(v & 0xff, this.len);
    this.len += 1;
    return this;
  }

  bytes(b) {
    this.ensure(b.length);
    b.copy(this.buf, this.len);
    this.len += b.length;
    return this;
  }

  varint(v) {
    let n = typeof v === 'bigint' ? v : BigInt(Math.trunc(v));
    if (n < 0n) n = BigInt.asUintN(64, n);
    this.ensure(10);
    while (n > 0x7fn) {
      this.buf[this.len++] = Number(n & 0x7fn) | 0x80;
      n >>= 7n;
    }
    this.buf[this.len++] = Number(n);
    return this;
  }

  zigzag32(v) {
    const n = Number(v) | 0;
    return this.varint(BigInt((n << 1) ^ (n >> 31)));
  }

  zigzag64(v) {
    const n = typeof v === 'bigint' ? v : BigInt(Math.trunc(Number(v)));
    return this.varint((n << 1n) ^ (n >> 63n));
  }

  double(v) {
    this.ensure(8);
    this.buf.writeDoubleLE(Number(v), this.len);
    this.len += 8;
    return this;
  }

  utf8(s) {
    const b = Buffer.from(String(s), 'utf8');
    this.varint(b.length);
    this.ensure(b.length);
    b.copy(this.buf, this.len);
    this.len += b.length;
    return this;
  }

  toBuffer() {
    return this.buf.subarray(0, this.len);
  }
}

function writeValue(w, spec, v) {
  if (Array.isArray(spec)) {
    if (spec[0] === T.STRUCT) {
      writeStruct(w, fieldsOf(spec[1]), v || {});
      return;
    }
    if (spec[0] === T.LIST || spec[0] === T.SET) {
      const elem = spec[1];
      const arr = Array.isArray(v) ? v : [];
      const ct = TYPE_TO_CT[typeCode(elem)];
      if (arr.length <= 14) w.byte((arr.length << 4) | ct);
      else w.byte(0xf0 | ct).varint(arr.length);
      for (const item of arr) writeValue(w, elem, item);
      return;
    }
    if (spec[0] === T.MAP) {
      const [, kSpec, vSpec] = spec;
      const entries = v instanceof Map ? [...v.entries()] : Object.entries(v || {});
      w.varint(entries.length);
      if (entries.length > 0) {
        w.byte((TYPE_TO_CT[typeCode(kSpec)] << 4) | TYPE_TO_CT[typeCode(vSpec)]);
      }
      for (const [k, val] of entries) {
        writeValue(w, kSpec, typeof kSpec === 'number' && kSpec === T.STRING ? k : kSpec === T.I64 ? BigInt(k) : k);
        writeValue(w, vSpec, val);
      }
      return;
    }
    throw new Error(`不支持的 spec: ${JSON.stringify(spec)}`);
  }

  switch (spec) {
    case T.BOOL: w.byte(v ? CT.BOOL_TRUE : CT.BOOL_FALSE); break;
    case T.BYTE: w.byte(Number(v)); break;
    case T.DOUBLE: w.double(v); break;
    case T.I16: case T.I32: w.zigzag32(v); break;
    case T.I64: w.zigzag64(v); break;
    case T.STRING: w.utf8(v); break;
    default: throw new Error(`不支持的类型码: ${spec}`);
  }
}

function writeStruct(w, fields, obj) {
  let lastFid = 0;
  for (const [fidStr, [name, spec]] of Object.entries(fields)) {
    const v = obj[name];
    if (v === undefined || v === null) continue;
    const fid = Number(fidStr);
    const t = typeCode(spec);
    if (t === T.BOOL) {
      const ct = v ? CT.BOOL_TRUE : CT.BOOL_FALSE;
      if (fid > lastFid && fid - lastFid <= 15) w.byte(((fid - lastFid) << 4) | ct);
      else w.byte(ct).zigzag32(fid);
      lastFid = fid;
      continue;
    }
    const ct = TYPE_TO_CT[t];
    if (fid > lastFid && fid - lastFid <= 15) w.byte(((fid - lastFid) << 4) | ct);
    else w.byte(ct).zigzag32(fid);
    lastFid = fid;
    writeValue(w, spec, v);
  }
  w.byte(CT.STOP);
}

/** 编码一条消息（不含帧头），msgId 决定结构 */
function encode(msgId, obj) {
  const w = new Writer();
  writeStruct(w, fieldsOf(msgId), obj);
  return Buffer.from(w.toBuffer());
}

/* ------------------------------ 读取 ------------------------------ */

class Reader {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
  }

  need(n) {
    if (this.pos + n > this.buf.length) throw new Error('thrift 数据不完整');
  }

  byte() {
    this.need(1);
    return this.buf.readUInt8(this.pos++);
  }

  bytes(n) {
    this.need(n);
    const b = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return b;
  }

  varint() {
    let shift = 0n;
    let result = 0n;
    for (let i = 0; i < 10; i++) {
      const b = this.byte();
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result;
      shift += 7n;
    }
    throw new Error('varint 过长');
  }

  zigzag() {
    const n = this.varint();
    return (n >> 1n) ^ -(n & 1n);
  }

  int() {
    const n = this.zigzag();
    return n <= MAX_SAFE && n >= -MAX_SAFE ? Number(n) : n.toString();
  }

  double() {
    this.need(8);
    const v = this.buf.readDoubleLE(this.pos);
    this.pos += 8;
    return v;
  }

  utf8() {
    const len = Number(this.varint());
    if (len < 0) throw new Error('thrift 字符串长度非法');
    return this.bytes(len).toString('utf8');
  }
}

function readValue(r, spec) {
  if (Array.isArray(spec)) {
    if (spec[0] === T.STRUCT) return readStruct(r, fieldsOf(spec[1]));
    if (spec[0] === T.LIST || spec[0] === T.SET) {
      const elem = spec[1];
      const head = r.byte();
      let size = head >>> 4;
      if (size === 15) size = Number(r.varint());
      const arr = [];
      for (let i = 0; i < size; i++) arr.push(readValue(r, elem));
      return arr;
    }
    if (spec[0] === T.MAP) {
      const [, kSpec, vSpec] = spec;
      const size = Number(r.varint());
      if (size > 0) r.byte();
      const out = {};
      for (let i = 0; i < size; i++) {
        const k = readValue(r, kSpec);
        out[String(k)] = readValue(r, vSpec);
      }
      return out;
    }
    throw new Error(`不支持的 spec: ${JSON.stringify(spec)}`);
  }

  switch (spec) {
    case T.BOOL: return r.byte() === CT.BOOL_TRUE;
    case T.BYTE: return r.byte();
    case T.DOUBLE: return r.double();
    case T.I16: case T.I32: case T.I64: return r.int();
    case T.STRING: return r.utf8();
    default: throw new Error(`不支持的类型码: ${spec}`);
  }
}

function readStruct(r, fields) {
  const out = {};
  let lastFid = 0;
  let pendingBool = null;
  for (;;) {
    const head = r.byte();
    const ct = head & 0x0f;
    if (ct === CT.STOP) break;
    let fid;
    const delta = head >>> 4;
    if (delta === 0) fid = Number(r.zigzag());
    else fid = lastFid + delta;
    lastFid = fid;

    if (ct === CT.BOOL_TRUE || ct === CT.BOOL_FALSE) {
      const field = fields[fid];
      if (field) out[field[0]] = ct === CT.BOOL_TRUE;
      continue;
    }

    const type = CT_TO_TYPE[ct];
    if (type === undefined) throw new Error(`未知 compact 类型 ${ct}`);
    const field = fields[fid];
    if (!field) {
      skipValue(r, ct);
      continue;
    }
    out[field[0]] = readValue(r, field[1]);
  }
  return out;
}

/** 仅按线格式跳过未知字段 */
function skipValue(r, ct) {
  switch (ct) {
    case CT.BYTE: r.byte(); break;
    case CT.I16: case CT.I32: case CT.I64: r.zigzag(); break;
    case CT.DOUBLE: r.double(); break;
    case CT.BINARY: r.utf8(); break;
    case CT.LIST: case CT.SET: {
      const head = r.byte();
      let size = head >>> 4;
      if (size === 15) size = Number(r.varint());
      const elemCt = head & 0x0f;
      for (let i = 0; i < size; i++) skipValue(r, elemCt);
      break;
    }
    case CT.MAP: {
      const size = Number(r.varint());
      if (size === 0) break;
      const types = r.byte();
      const kCt = types >>> 4;
      const vCt = types & 0x0f;
      for (let i = 0; i < size; i++) { skipValue(r, kCt); skipValue(r, vCt); }
      break;
    }
    case CT.BOOL_TRUE: case CT.BOOL_FALSE: break;
    default: throw new Error(`无法跳过未知字段类型 ${ct}`);
  }
}

/** 解码一条消息体（不含帧头） */
function decode(msgId, body) {
  return readStruct(new Reader(body), fieldsOf(msgId));
}

module.exports = { T, CT, encode, decode, schema };
