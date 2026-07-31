import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { BridgeError } from './errors.js';
import { atomicWrite } from './state.js';

export interface CursorPayload {
  v: 1;
  taskId: string;
  section: string;
  offset: number;
  digest: string;
}

export class CursorCodec {
  private constructor(private readonly key: Buffer) {}

  static async create(stateDir: string): Promise<CursorCodec> {
    const file = path.join(stateDir, 'cursor.key');
    let key: Buffer;
    try {
      key = Buffer.from((await readFile(file, 'utf8')).trim(), 'base64url');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      key = randomBytes(32);
      await atomicWrite(file, `${key.toString('base64url')}\n`);
    }
    if (key.length !== 32) throw new BridgeError('internal_error', 'Invalid cursor signing key');
    return new CursorCodec(key);
  }

  encode(payload: CursorPayload): string {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = createHmac('sha256', this.key).update(body).digest('base64url');
    return `${body}.${signature}`;
  }

  decode(cursor: string): CursorPayload {
    const [body, signature, extra] = cursor.split('.');
    if (!body || !signature || extra) throw new BridgeError('invalid_request', 'Invalid cursor');
    const expected = createHmac('sha256', this.key).update(body).digest();
    const actual = Buffer.from(signature, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new BridgeError('invalid_request', 'Invalid cursor signature');
    }
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as CursorPayload;
    if (payload.v !== 1 || !Number.isSafeInteger(payload.offset) || payload.offset < 0) {
      throw new BridgeError('invalid_request', 'Invalid cursor payload');
    }
    return payload;
  }
}

export function paginateText(
  codec: CursorCodec,
  taskId: string,
  section: string,
  value: string,
  digest: string,
  maxBytes: number,
  cursor?: string,
): { value: string; nextCursor?: string; truncated: boolean } {
  let offset = 0;
  if (cursor) {
    const payload = codec.decode(cursor);
    if (payload.taskId !== taskId || payload.section !== section || payload.digest !== digest) {
      throw new BridgeError('invalid_request', 'Cursor does not match current task section');
    }
    offset = payload.offset;
  }
  const bytes = Buffer.from(value);
  if (offset > bytes.length)
    throw new BridgeError('invalid_request', 'Cursor offset is out of range');
  let end = Math.min(bytes.length, offset + maxBytes);
  if (end < bytes.length) {
    while (end > offset && (bytes[end]! & 0xc0) === 0x80) end -= 1;
    if (end === offset) {
      throw new BridgeError('output_limit_exceeded', 'Page is too small for one UTF-8 code point');
    }
  }
  const nextCursor =
    end < bytes.length ? codec.encode({ v: 1, taskId, section, offset: end, digest }) : undefined;
  return {
    value: bytes.subarray(offset, end).toString('utf8'),
    ...(nextCursor ? { nextCursor } : {}),
    truncated: end < bytes.length,
  };
}
