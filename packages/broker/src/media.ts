import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileTypeFromBuffer, supportedMimeTypes } from 'file-type';
import {
  sanitizeText,
  type Address,
  type MediaIndexEntry,
  type MediaKind,
  type MediaRef,
  type MediaStoreUsage,
  type SessionId,
} from '@orchvis/protocol';

/** Who uploaded a media item: a session ID, or the Owner. */
export type MediaUploader = { kind: 'session'; id: SessionId } | { kind: 'owner' };

/** Where a media item was attached. Set once; media is single use. */
export interface MediaAttachment {
  threadId: string;
  messageId: string;
  from: Address;
  /** Broker clock time of the message that carried it. */
  ts: number;
}

/** One file in the media store. */
export interface StoredMedia {
  /** The reference handed to the uploader and copied into the message. */
  ref: MediaRef;
  kind: MediaKind;
  uploader: MediaUploader;
  /** Broker clock time the upload completed. */
  storedAt: number;
  /** Absolute path of the file on disk. Never sent on the wire. */
  path: string;
  /** Set when a message carried it. */
  attachment: MediaAttachment | undefined;
}

/** Bytes of the file head kept for sniffing. */
export const SNIFF_HEAD_BYTES = 64 * 1024;

/**
 * Default media directory: `<os temp>/orchvis-media-<pid>-<random>`. The
 * random part keeps brokers apart when several run in one process, including
 * in different worker threads, which share the pid.
 */
export function defaultMediaDir(): string {
  return join(tmpdir(), `orchvis-media-${process.pid}-${randomBytes(6).toString('hex')}`);
}

/** Generates a media ID: `m` plus 24 random base64url characters. Unguessable, so IDs never enumerate. */
export function newMediaId(): string {
  return `m${randomBytes(18).toString('base64url')}`;
}

/**
 * The broker's media store: files in one per-process temp directory, plus the
 * in-memory index of them. Pure bookkeeping and synchronous file deletion;
 * the broker core decides what to expire and evict and broadcasts it, and the
 * HTTP layer streams uploads into {@link MediaStore.pathFor}.
 *
 * Invariant: outside an upload in progress, the directory holds exactly one
 * file per entry, named by its media ID.
 */
export class MediaStore {
  private readonly entries = new Map<string, StoredMedia>();
  private totalBytes = 0;
  private closed = false;

  /**
   * Creates the store and wipes `dir`, so nothing from an earlier process
   * survives.
   *
   * @param dir - Directory for this broker's files. Wiped now and on {@link MediaStore.wipe}.
   * @param capBytes - `mediaStoreBytes`: total size beyond which the oldest files are evicted.
   */
  constructor(
    readonly dir: string,
    readonly capBytes: number,
  ) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    mkdirSync(dir, { recursive: true });
  }

  /** Whether {@link MediaStore.wipe} has run; uploads finishing after it are discarded. */
  get isClosed(): boolean {
    return this.closed;
  }

  /** Path a new upload with this ID is written to. */
  pathFor(mediaId: string): string {
    return join(this.dir, mediaId);
  }

  /** Adds a fully written file. */
  add(entry: StoredMedia): void {
    this.entries.set(entry.ref.mediaId, entry);
    this.totalBytes += entry.ref.bytes;
  }

  /** An entry by ID, expired or not, until it is removed. */
  get(mediaId: string): StoredMedia | undefined {
    return this.entries.get(mediaId);
  }

  /** Removes an entry and deletes its file. Returns the entry, or undefined if unknown. */
  remove(mediaId: string): StoredMedia | undefined {
    const entry = this.entries.get(mediaId);
    if (!entry) return undefined;
    this.entries.delete(mediaId);
    this.totalBytes -= entry.ref.bytes;
    deleteQuietly(entry.path);
    return entry;
  }

  /** Entries whose TTL has run out at `now`, oldest first. */
  expiredAt(now: number): StoredMedia[] {
    return [...this.entries.values()].filter((e) => e.ref.expiresAt <= now);
  }

  /**
   * Entries to evict, oldest first, so the total fits the cap again. Entries
   * in `keep` are never chosen.
   */
  evictionVictims(keep?: string): StoredMedia[] {
    const out: StoredMedia[] = [];
    let total = this.totalBytes;
    for (const e of this.entries.values()) {
      if (total <= this.capBytes) break;
      if (e.ref.mediaId === keep) continue;
      out.push(e);
      total -= e.ref.bytes;
    }
    return out;
  }

  /** Number of files held, attached or not. */
  get files(): number {
    return this.entries.size;
  }

  /** Bytes held, attached or not. */
  get bytes(): number {
    return this.totalBytes;
  }

  /**
   * Usage as reported to the web app: attached media only. Every change to
   * it is carried by a `media` delta (`add` on attach, `expire` on expiry or
   * eviction), so a snapshot always equals the replayed deltas. Unattached
   * uploads have no thread and no delta, so they count toward the cap and
   * eviction ({@link MediaStore.bytes}) but are not shown.
   */
  usage(): MediaStoreUsage {
    let bytes = 0;
    let files = 0;
    for (const e of this.entries.values()) {
      if (!e.attachment) continue;
      bytes += e.ref.bytes;
      files++;
    }
    return { bytes, capBytes: this.capBytes, files };
  }

  /** Index entries for every attached, unremoved item, in upload order. */
  index(): MediaIndexEntry[] {
    const out: MediaIndexEntry[] = [];
    for (const e of this.entries.values()) {
      const entry = indexEntry(e);
      if (entry) out.push(entry);
    }
    return out;
  }

  /** Every entry's ID, size and expiry, in upload order, for tests that compare the index with the directory. */
  list(): { mediaId: string; bytes: number; expiresAt: number; attached: boolean }[] {
    return [...this.entries.values()].map((e) => ({
      mediaId: e.ref.mediaId,
      bytes: e.ref.bytes,
      expiresAt: e.ref.expiresAt,
      attached: e.attachment !== undefined,
    }));
  }

  /** File names currently in the directory, for tests that check for orphans. */
  listDir(): string[] {
    try {
      return readdirSync(this.dir).sort();
    } catch {
      return [];
    }
  }

  /** Forgets every entry and deletes the directory. Called on clean shutdown. */
  wipe(): void {
    this.closed = true;
    this.entries.clear();
    this.totalBytes = 0;
    try {
      rmSync(this.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // A file still open by an in-flight download can block removal on Windows; the next start wipes it.
    }
  }
}

/** The media browser entry for an attached item, or undefined when it is not attached. */
export function indexEntry(e: StoredMedia): MediaIndexEntry | undefined {
  if (!e.attachment) return undefined;
  return {
    ref: { ...e.ref },
    kind: e.kind,
    threadId: e.attachment.threadId,
    messageId: e.attachment.messageId,
    from: { ...e.attachment.from },
    ts: e.attachment.ts,
  };
}

/** Deletes a file, ignoring a file that is already gone. */
export function deleteQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone, or held open; nothing more to do.
  }
}

// ---------------------------------------------------------------- names

const MAX_FILENAME = 255;

/**
 * Cleans an uploaded filename: keeps only the last path component (either
 * slash), sanitizes it like any untrusted text, trims it, and caps it at 255
 * characters keeping the extension. Empty results become `file`.
 */
export function sanitizeFilename(raw: string | undefined): string {
  const base = (raw ?? '').split(/[\\/]/).pop() ?? '';
  let name = sanitizeText(base).trim();
  if (name === '.' || name === '..') name = '';
  if (name.length > MAX_FILENAME) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : '';
    name = name.slice(0, MAX_FILENAME - ext.length) + ext;
  }
  return name || 'file';
}

/**
 * A `Content-Disposition` value: an ASCII fallback name with anything outside
 * letters, digits, dot, dash, underscore and space replaced, plus the full
 * name in RFC 5987 form.
 */
export function contentDisposition(type: 'inline' | 'attachment', filename: string): string {
  const fallback = filename.replace(/[^A-Za-z0-9._ -]/g, '_') || 'file';
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

// ---------------------------------------------------------------- types

/** Types the broker serves inline. Everything else, HTML and SVG included, is an attachment download. */
const INLINE_EXACT = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'text/plain']);

/** Whether a stored MIME type is served inline rather than as an attachment. */
export function servedInline(mime: string): boolean {
  const m = mime.toLowerCase();
  return INLINE_EXACT.has(m) || m.startsWith('audio/') || m.startsWith('video/');
}

const MIME_TOKEN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

const ALIASES: Readonly<Record<string, string>> = {
  'audio/x-wav': 'audio/wav',
  'audio/wave': 'audio/wav',
  'audio/vnd.wave': 'audio/wav',
  'audio/x-pn-wav': 'audio/wav',
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'audio/mp3': 'audio/mpeg',
  'audio/x-mp3': 'audio/mpeg',
  'audio/x-flac': 'audio/flac',
  'audio/m4a': 'audio/mp4',
  'audio/x-m4a': 'audio/mp4',
  'video/x-m4v': 'video/mp4',
  'application/x-zip-compressed': 'application/zip',
};

/** Containers that cannot be told apart by their magic numbers (audio vs video track, and so on). */
const CONTAINER_GROUPS: readonly (readonly string[])[] = [
  ['video/mp4', 'audio/mp4', 'video/quicktime', 'video/3gpp', 'audio/3gpp'],
  ['video/webm', 'audio/webm', 'video/x-matroska', 'audio/x-matroska', 'video/matroska', 'audio/matroska'],
  ['audio/ogg', 'video/ogg', 'application/ogg', 'audio/opus'],
];

/** Lowercase, parameters stripped, common aliases folded. */
export function canonicalMime(mime: string): string {
  const base = (mime.split(';')[0] ?? '').trim().toLowerCase();
  return ALIASES[base] ?? base;
}

function compatible(sniffed: string, declared: string): boolean {
  if (sniffed === declared) return true;
  return CONTAINER_GROUPS.some((g) => g.includes(sniffed) && g.includes(declared));
}

const SNIFFABLE = new Set<string>([...supportedMimeTypes].map((m) => canonicalMime(m)));

function needsMagic(mime: string): boolean {
  if (mime === 'image/svg+xml') return false;
  const top = mime.split('/')[0];
  return top === 'image' || top === 'audio' || top === 'video' || SNIFFABLE.has(mime);
}

function looksLikeText(head: Uint8Array): boolean {
  if (head.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: true });
    return true;
  } catch {
    return false;
  }
}

/** Result of {@link sniffMime}: the MIME type to store, or a mismatch. */
export type SniffResult = { ok: true; mime: string } | { ok: false; reason: string };

const OCTET = 'application/octet-stream';

/**
 * Checks a file's first bytes against its declared type and picks the type
 * to store.
 *
 * - Magic number found: it must match the declared type (aliases folded,
 *   ambiguous containers such as MP4 audio vs video allowed). A declared
 *   `application/octet-stream` takes the sniffed type.
 * - No magic number: a declared image, audio or video type, or any type the
 *   sniffer knows, is a mismatch. Text content is stored as declared.
 *   Unknown binary is accepted only when declared `application/octet-stream`.
 */
export async function sniffMime(head: Uint8Array, declaredRaw: string): Promise<SniffResult> {
  const declared = canonicalMime(declaredRaw || OCTET);
  if (!MIME_TOKEN.test(declared) || declared.length > 255) return { ok: false, reason: 'declared type is not a valid MIME type' };
  const found = head.byteLength > 0 ? await fileTypeFromBuffer(head) : undefined;
  if (found) {
    const sniffed = canonicalMime(found.mime);
    if (declared === OCTET) return { ok: true, mime: sniffed };
    if (compatible(sniffed, declared)) return { ok: true, mime: declared };
    return { ok: false, reason: `content is ${sniffed}, declared ${declared}` };
  }
  if (needsMagic(declared)) return { ok: false, reason: `content does not match declared ${declared}` };
  if (looksLikeText(head)) return { ok: true, mime: declared };
  if (declared === OCTET) return { ok: true, mime: OCTET };
  return { ok: false, reason: `binary content declared as ${declared}` };
}

