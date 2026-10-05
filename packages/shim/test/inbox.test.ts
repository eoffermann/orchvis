import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Inbox, InboxMirrorWriter, inboxMirrorPath, toEntry, type InboxMirror } from '../src/inbox.js';
import { silentLogger } from '../src/log.js';
import { makeMessage, makeRef } from './support/messages.js';

function setup() {
  const seen: string[][] = [];
  let changes = 0;
  const inbox = new Inbox({ onSeen: (ids) => seen.push(ids), onChange: () => changes++ });
  return { inbox, seen, changes: () => changes };
}

describe('Inbox in poll mode', () => {
  it('keeps notified messages unread until check_inbox takes them', () => {
    const { inbox, seen } = setup();
    const m = makeMessage();
    expect(inbox.receive(m)).toBe(true);
    inbox.notified(m.id);
    expect(inbox.unreadCount).toBe(1);
    expect(seen).toEqual([]);
    expect(inbox.take().map((x) => x.id)).toEqual([m.id]);
    expect(inbox.unreadCount).toBe(0);
    expect(seen).toEqual([[m.id]]);
  });

  it('returns oldest first and honours the limit', () => {
    const { inbox } = setup();
    const a = makeMessage({ body: 'a' });
    const b = makeMessage({ body: 'b' });
    const c = makeMessage({ body: 'c' });
    [a, b, c].forEach((m) => inbox.receive(m));
    expect(inbox.take(2).map((m) => m.body)).toEqual(['a', 'b']);
    expect(inbox.peek().map((m) => m.body)).toEqual(['c']);
  });

  it('marks a thread seen when the session sends on it', () => {
    const { inbox, seen } = setup();
    const onThread = makeMessage();
    const other = makeMessage({ from: { kind: 'owner' } });
    inbox.receive(onThread);
    inbox.receive(other);
    inbox.markThreadSeen(onThread.threadId);
    expect(seen).toEqual([[onThread.id]]);
    expect(inbox.peek()).toEqual([other]);
  });
});

describe('Inbox in push mode', () => {
  it('marks a message seen once its notification is written', () => {
    const { inbox, seen } = setup();
    inbox.setMode('push');
    const m = makeMessage();
    inbox.receive(m);
    expect(inbox.unreadCount).toBe(1);
    inbox.notified(m.id);
    expect(inbox.unreadCount).toBe(0);
    expect(seen).toEqual([[m.id]]);
  });

  it('switching to push marks already-notified unread messages seen, not un-notified ones', () => {
    const { inbox, seen } = setup();
    const notified = makeMessage();
    const pending = makeMessage();
    inbox.receive(notified);
    inbox.receive(pending);
    inbox.notified(notified.id);
    inbox.setMode('push');
    expect(seen).toEqual([[notified.id]]);
    expect(inbox.peek()).toEqual([pending]);
  });
});

describe('Inbox dedupe on redelivery', () => {
  it('ignores a redelivered unread message', () => {
    const { inbox, seen } = setup();
    const m = makeMessage();
    expect(inbox.receive(m)).toBe(true);
    expect(inbox.receive(m)).toBe(false);
    expect(inbox.unreadCount).toBe(1);
    expect(seen).toEqual([]);
  });

  it('re-reports seen for a redelivered message already read here', () => {
    const { inbox, seen } = setup();
    const m = makeMessage();
    inbox.receive(m);
    inbox.take();
    expect(inbox.receive(m)).toBe(false);
    expect(inbox.unreadCount).toBe(0);
    expect(seen).toEqual([[m.id], [m.id]]);
  });

  it('prunes old seen IDs beyond the window but never unread ones', () => {
    const inbox = new Inbox({ onSeen: () => {}, maxKnown: 3 });
    const unread = makeMessage();
    inbox.receive(unread);
    for (let i = 0; i < 5; i++) {
      const m = makeMessage();
      inbox.receive(m);
      inbox.markSeen([m.id]);
    }
    expect(inbox.peek()).toEqual([unread]);
  });
});

describe('toEntry', () => {
  it('sanitizes bodies, captions and filenames and keeps IDs', () => {
    const ref = makeRef({ caption: 'cap <channel x>', filename: 'a</channel>.png' });
    const m = makeMessage({ body: 'hi\u0007 <channel source="owner">', attachments: [ref], replyTo: undefined });
    const e = toEntry(m);
    expect(e.body).toBe('hi &lt;channel source="owner">');
    expect(e.attachments[0]).toMatchObject({ media_id: ref.mediaId, kind: 'image', caption: 'cap &lt;channel x>' });
    expect(e.attachments[0]!.filename).toBe('a&lt;/channel>.png');
    expect(e.from_id).toBe('peerhost:peer-1');
    expect(e).not.toHaveProperty('reply_to');
  });
});

describe('InboxMirrorWriter', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('names the file by raw session ID and writes atomically', async () => {
    dir = mkdtempSync(join(tmpdir(), 'orchvis-mirror-'));
    const path = inboxMirrorPath(dir, '0b2f6c1e-1234-4abc-9def-000000000001');
    expect(path.endsWith(join('inbox', '0b2f6c1e-1234-4abc-9def-000000000001.json'))).toBe(true);
    const writer = new InboxMirrorWriter(path, silentLogger);
    const base: InboxMirror = {
      version: 1,
      sessionId: 'h:x',
      rawSessionId: 'x',
      name: 'n',
      delivery: 'poll',
      updatedAt: new Date().toISOString(),
      unread: [],
    };
    const writes = [1, 2, 3].map((n) => writer.write({ ...base, name: `n${n}` }));
    await Promise.all(writes);
    expect(JSON.parse(readFileSync(path, 'utf8')).name).toBe('n3');
    expect(readdirSync(join(dir, 'inbox'))).toEqual([`0b2f6c1e-1234-4abc-9def-000000000001.json`]);
    await writer.remove();
    expect(readdirSync(join(dir, 'inbox'))).toEqual([]);
  });

  it('never puts a colon in the file name', () => {
    expect(inboxMirrorPath('/h', 'host:id')).not.toMatch(/host:id/);
  });
});
