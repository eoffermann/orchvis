import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { addressKey, mediaKindOf, sanitizeText, type DeliveryMode, type Message } from '@orchvis/protocol';
import { fileSafe } from './identity.js';
import type { Logger } from './log.js';

/** Options for {@link Inbox}. */
export interface InboxOptions {
  /** Called with message IDs that just became seen; the caller sends a `seen` frame. */
  onSeen: (ids: string[]) => void;
  /** Called after any change to the unread set or the delivery mode. */
  onChange?: () => void;
  /** How many message IDs to remember for dedupe. */
  maxKnown?: number;
}

type State = { seen: false; notified: boolean; message: Message } | { seen: true };

/**
 * The unread inbox. Dedupes by message ID, because the broker redelivers every
 * unseen message after `welcome`. Seen semantics:
 *
 * - push mode: a message is seen once its channel notification is written;
 * - poll mode: a message is seen when `check_inbox` returns it, or when the
 *   session next sends on that thread.
 *
 * Switching to push marks every already-notified unread message seen, since a
 * confirmed channel means those notifications reached the session too.
 */
export class Inbox {
  private readonly states = new Map<string, State>();
  private readonly options: InboxOptions;
  private modeValue: DeliveryMode = 'poll';

  constructor(options: InboxOptions) {
    this.options = options;
  }

  /** Current delivery mode. Starts as `poll` until a probe is confirmed. */
  get mode(): DeliveryMode {
    return this.modeValue;
  }

  /** Number of unread messages. */
  get unreadCount(): number {
    let n = 0;
    for (const s of this.states.values()) if (!s.seen) n++;
    return n;
  }

  /** Unread messages, oldest first, without marking them. */
  peek(): Message[] {
    const out: Message[] = [];
    for (const s of this.states.values()) if (!s.seen) out.push(s.message);
    return out;
  }

  /**
   * Adds a delivered message. Returns `true` when it is new and should be
   * notified; `false` for a duplicate. A duplicate of a message already seen
   * here re-reports it seen, since the broker evidently missed that.
   */
  receive(message: Message): boolean {
    const known = this.states.get(message.id);
    if (known) {
      if (known.seen) this.options.onSeen([message.id]);
      return false;
    }
    this.states.set(message.id, { seen: false, notified: false, message });
    this.prune();
    this.changed();
    return true;
  }

  /** Records that a message's channel notification was written. In push mode it becomes seen. */
  notified(id: string): void {
    const s = this.states.get(id);
    if (!s || s.seen) return;
    s.notified = true;
    if (this.modeValue === 'push') this.markSeen([id]);
  }

  /** Sets the delivery mode. Switching to push marks every notified unread message seen. */
  setMode(mode: DeliveryMode): void {
    if (mode === this.modeValue) return;
    this.modeValue = mode;
    if (mode === 'push') {
      const ids: string[] = [];
      for (const [id, s] of this.states) if (!s.seen && s.notified) ids.push(id);
      if (ids.length) {
        this.markSeen(ids);
        return;
      }
    }
    this.changed();
  }

  /** Returns up to `limit` unread messages, oldest first, and marks them seen. */
  take(limit = Number.POSITIVE_INFINITY): Message[] {
    const out = this.peek().slice(0, limit);
    if (out.length) this.markSeen(out.map((m) => m.id));
    return out;
  }

  /** Marks every unread message on a thread seen; used when the session sends on it. */
  markThreadSeen(threadId: string): void {
    const ids = this.peek()
      .filter((m) => m.threadId === threadId)
      .map((m) => m.id);
    if (ids.length) this.markSeen(ids);
  }

  /** Marks messages seen and reports the ones that changed. */
  markSeen(ids: string[]): void {
    const changed: string[] = [];
    for (const id of ids) {
      const s = this.states.get(id);
      if (s && !s.seen) {
        this.states.set(id, { seen: true });
        changed.push(id);
      }
    }
    if (changed.length) {
      this.options.onSeen(changed);
      this.changed();
    }
  }

  private changed(): void {
    this.options.onChange?.();
  }

  /** Forgets the oldest seen IDs beyond the dedupe window. Unread ones are kept. */
  private prune(): void {
    const max = this.options.maxKnown ?? 5000;
    if (this.states.size <= max) return;
    for (const [id, s] of this.states) {
      if (this.states.size <= max) break;
      if (s.seen) this.states.delete(id);
    }
  }
}

/** One unread message as written to the mirror file and returned by tools. */
export interface InboxEntry {
  msg_id: string;
  thread_id: string;
  sender_kind: string;
  from_name: string;
  from_id: string;
  kind: string;
  reply_to?: string;
  /** Broker clock, as an ISO timestamp. */
  ts: string;
  /** Sanitized body. */
  body: string;
  attachments: Array<{ media_id: string; kind: string; mime: string; filename: string; bytes: number; caption: string }>;
}

/** Renders a message for tool results and the mirror file, sanitizing all free text. */
export function toEntry(message: Message): InboxEntry {
  const entry: InboxEntry = {
    msg_id: message.id,
    thread_id: message.threadId,
    sender_kind: message.senderKind,
    from_name: sanitizeText(message.fromName),
    from_id: addressKey(message.from),
    kind: message.kind,
    ts: new Date(message.ts).toISOString(),
    body: sanitizeText(message.body),
    attachments: message.attachments.map((a) => ({
      media_id: a.mediaId,
      kind: mediaKindOf(a.mime),
      mime: a.mime,
      filename: sanitizeText(a.filename),
      bytes: a.bytes,
      caption: sanitizeText(a.caption),
    })),
  };
  if (message.replyTo) entry.reply_to = message.replyTo;
  return entry;
}

/** Contents of `~/.orchvis/inbox/<raw session id>.json`, read by the poll-mode hooks. */
export interface InboxMirror {
  /** Format version of this file. */
  version: 1;
  /** Canonical session ID. */
  sessionId: string;
  /** Raw `CLAUDE_CODE_SESSION_ID` (or fallback UUID); also the file's base name. */
  rawSessionId: string;
  /** Session name as assigned by the broker. */
  name: string;
  delivery: DeliveryMode;
  /** When the file was written, ISO timestamp. */
  updatedAt: string;
  /** Unread messages, oldest first. */
  unread: InboxEntry[];
}

/** Path of the inbox mirror file for a raw session ID. */
export function inboxMirrorPath(home: string, rawSessionId: string): string {
  return join(home, 'inbox', `${fileSafe(rawSessionId)}.json`);
}

/**
 * Writes the inbox mirror atomically (temp file, then rename), one write at a
 * time; a burst of changes collapses into one write of the latest state.
 */
export class InboxMirrorWriter {
  private pending: InboxMirror | undefined;
  private running: Promise<void> | undefined;
  private readonly path: string;
  private readonly log: Logger;

  constructor(path: string, log: Logger) {
    this.path = path;
    this.log = log;
  }

  /** Schedules a write of `state`. Resolves when it (or a later state) is on disk. */
  write(state: InboxMirror): Promise<void> {
    this.pending = state;
    this.running ??= this.drain().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /** Waits for pending writes, then deletes the file. */
  async remove(): Promise<void> {
    await this.running;
    await rm(this.path, { force: true }).catch(() => {});
  }

  private async drain(): Promise<void> {
    while (this.pending) {
      const state = this.pending;
      this.pending = undefined;
      try {
        await writeAtomic(this.path, `${JSON.stringify(state, null, 2)}\n`);
      } catch (err) {
        this.log.warn(`could not write inbox mirror ${this.path}: ${(err as Error).message}`);
      }
    }
  }
}

/**
 * Writes a file atomically: a temp file beside it, then a rename. On Windows a
 * rename over a file another process has open fails with EPERM or EBUSY, so it
 * is retried briefly.
 */
export async function writeAtomic(path: string, data: string): Promise<void> {
  const dir = join(path, '..');
  await mkdir(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, data, 'utf8');
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, path);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 10 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) {
        await rm(tmp, { force: true }).catch(() => {});
        throw err;
      }
      await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
    }
  }
}
