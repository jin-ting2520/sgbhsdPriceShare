'use strict';

/**
 * 游戏 WebSocket 帧格式（net_utils.ts 逆向结果）
 * 10 字节头（大端）：flag u16(=0) | sequence u16(1..32766 循环) | msgType u16 | msgLen u32
 * 之后紧跟 thrift binary 消息体
 */

const HEADER_SIZE = 10;

function encodeFrame(msgType, sequence, body) {
  const frame = Buffer.allocUnsafe(HEADER_SIZE + body.length);
  frame.writeUInt16BE(0, 0);
  frame.writeUInt16BE(sequence, 2);
  frame.writeUInt16BE(msgType, 4);
  frame.writeUInt32BE(body.length, 6);
  body.copy(frame, HEADER_SIZE);
  return frame;
}

/** 粘包拆分：push 任意分片，返回完整帧数组 */
class FrameParser {
  constructor() {
    this.buf = Buffer.alloc(0);
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const frames = [];
    for (;;) {
      if (this.buf.length < HEADER_SIZE) break;
      const flag = this.buf.readUInt16BE(0);
      const sequence = this.buf.readUInt16BE(2);
      const msgType = this.buf.readUInt16BE(4);
      const len = this.buf.readUInt32BE(6);
      if (this.buf.length < HEADER_SIZE + len) break;
      const body = this.buf.subarray(HEADER_SIZE, HEADER_SIZE + len);
      this.buf = this.buf.subarray(HEADER_SIZE + len);
      frames.push({ flag, sequence, msgType, body });
    }
    return frames;
  }
}

module.exports = { HEADER_SIZE, encodeFrame, FrameParser };
