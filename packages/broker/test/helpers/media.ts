import { readdirSync } from 'node:fs';
import {
  MEDIA_CAPTION_FIELD,
  MEDIA_FILE_FIELD,
  MEDIA_PATH,
  SHIM_TOKEN_HEADER,
  UPLOAD_KEY_HEADER,
  type BrokerToShimFrame,
  type FrameOf,
  type MediaRef,
} from '@orchvis/protocol';
import { Rng, generatePng } from '@orchvis/simulator';
import type { RunningBroker } from '../../src/index.js';

/** Credentials for a media request: shim token plus upload key, an Owner cookie, or nothing. */
export interface Creds {
  token?: string;
  key?: string;
  cookie?: string;
}

/** One file part. */
export interface FilePart {
  data: Uint8Array;
  mime: string;
  filename?: string;
}

/** The shim credentials for a welcomed connection. */
export function shimCreds(broker: RunningBroker, welcome: FrameOf<BrokerToShimFrame, 'welcome'>): Creds {
  return { token: broker.shimToken, key: welcome.payload.uploadKey };
}

/** Request headers for a set of credentials. */
export function credHeaders(creds: Creds): Record<string, string> {
  const h: Record<string, string> = {};
  if (creds.token !== undefined) h[SHIM_TOKEN_HEADER] = creds.token;
  if (creds.key !== undefined) h[UPLOAD_KEY_HEADER] = creds.key;
  if (creds.cookie !== undefined) h.cookie = creds.cookie;
  return h;
}

/** Result of {@link upload}: the status and parsed JSON body. */
export interface UploadResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Posts a multipart upload. `files` may hold zero, one or several parts;
 * `caption` undefined leaves the caption field out.
 */
export async function upload(broker: RunningBroker, creds: Creds, files: FilePart[], caption: string | undefined): Promise<UploadResult> {
  const form = new FormData();
  for (const f of files) form.append(MEDIA_FILE_FIELD, new Blob([f.data as Uint8Array<ArrayBuffer>], { type: f.mime }), f.filename ?? 'file.bin');
  if (caption !== undefined) form.append(MEDIA_CAPTION_FIELD, caption);
  const res = await fetch(`${broker.url}${MEDIA_PATH}`, { method: 'POST', headers: credHeaders(creds), body: form });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

/** Uploads and expects 201, returning the MediaRef. */
export async function uploadOk(broker: RunningBroker, creds: Creds, file: FilePart, caption = 'a test image'): Promise<MediaRef> {
  const r = await upload(broker, creds, [file], caption);
  if (r.status !== 201) throw new Error(`upload failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as unknown as MediaRef;
}

/** GETs a media item. */
export function download(broker: RunningBroker, mediaId: string, creds: Creds, range?: string): Promise<Response> {
  const headers = credHeaders(creds);
  if (range !== undefined) headers.range = range;
  return fetch(`${broker.url}${MEDIA_PATH}/${encodeURIComponent(mediaId)}`, { headers });
}

let seed = 1;
/** A small valid PNG, different each call. */
export function png(): FilePart {
  return { data: generatePng(new Rng(seed++), 8, 8), mime: 'image/png', filename: 'shot.png' };
}

/** Files in the broker's media directory, sorted. */
export function dirFiles(broker: RunningBroker): string[] {
  try {
    return readdirSync(broker.mediaDir).sort();
  } catch {
    return [];
  }
}
