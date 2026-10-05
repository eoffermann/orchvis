import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import type { MediaKind } from '@orchvis/protocol';
import type { Rng } from './random.js';
import { generateCaption } from './text.js';

/** A generated media file, ready to upload or to index in the mock feed. */
export interface MediaSample {
  kind: MediaKind;
  mime: string;
  filename: string;
  data: Uint8Array;
  /** Lowercase hex SHA-256 of `data`. */
  sha256: string;
  caption: string;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u32be(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  return Buffer.concat([u32be(data.length), typeAndData, u32be(crc32(typeAndData))]);
}

/** A valid RGB PNG with a seeded gradient. */
export function generatePng(rng: Rng, width = 48, height = 32): Uint8Array {
  const [r0, g0, b0] = [rng.int(0, 255), rng.int(0, 255), rng.int(0, 255)];
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      raw[o++] = (r0 + x * 4) & 0xff;
      raw[o++] = (g0 + y * 6) & 0xff;
      raw[o++] = (b0 + (x ^ y) * 3) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A valid 8-bit mono PCM WAV holding a seeded sine tone. */
export function generateWav(rng: Rng, seconds = 0.5, sampleRate = 8000): Uint8Array {
  const freq = rng.pick([220, 330, 440, 523, 660, 880]);
  const n = Math.floor(seconds * sampleRate);
  const buf = Buffer.alloc(44 + n);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + n, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate, 28); // byte rate
  buf.writeUInt16LE(1, 32); // block align
  buf.writeUInt16LE(8, 34); // bits per sample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(n, 40);
  for (let i = 0; i < n; i++) buf[44 + i] = 128 + Math.round(100 * Math.sin((2 * Math.PI * freq * i) / sampleRate));
  return buf;
}

/**
 * A small file with a valid MP4 `ftyp` header, so MIME sniffing reports
 * `video/mp4`. It is not a playable video: building a real H.264 stream is out
 * of scope for a test generator.
 */
export function generateMp4(rng: Rng): Uint8Array {
  const ftyp = Buffer.concat([
    u32be(32),
    Buffer.from('ftypisom', 'ascii'),
    u32be(0x200),
    Buffer.from('isomiso2avc1mp41', 'ascii'),
  ]);
  const payload = Buffer.alloc(rng.int(256, 1024));
  for (let i = 0; i < payload.length; i++) payload[i] = rng.int(0, 255);
  return Buffer.concat([ftyp, u32be(payload.length + 8), Buffer.from('mdat', 'ascii'), payload]);
}

/** A short plain-text log file. */
export function generateText(rng: Rng): Uint8Array {
  const lines: string[] = [];
  const n = rng.int(5, 30);
  for (let i = 0; i < n; i++) lines.push(`${i} ok ${rng.hex(8)}`);
  return Buffer.from(lines.join('\n') + '\n', 'utf8');
}

/** Hex SHA-256 of a byte array. */
export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Generates one media sample of `kind` (or a seeded random kind). */
export function generateMedia(rng: Rng, kind?: MediaKind): MediaSample {
  const k: MediaKind = kind ?? rng.weighted<MediaKind>([['image', 5], ['audio', 2], ['video', 2], ['other', 1]]);
  const tag = rng.hex(6);
  let mime: string;
  let filename: string;
  let data: Uint8Array;
  switch (k) {
    case 'image':
      mime = 'image/png';
      filename = `screenshot-${tag}.png`;
      data = generatePng(rng);
      break;
    case 'audio':
      mime = 'audio/wav';
      filename = `tone-${tag}.wav`;
      data = generateWav(rng);
      break;
    case 'video':
      mime = 'video/mp4';
      filename = `clip-${tag}.mp4`;
      data = generateMp4(rng);
      break;
    default:
      mime = 'text/plain';
      filename = `run-${tag}.log`;
      data = generateText(rng);
  }
  return { kind: k, mime, filename, data, sha256: sha256Hex(data), caption: generateCaption(rng, k) };
}
