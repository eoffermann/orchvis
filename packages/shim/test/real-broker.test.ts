/**
 * Integration against the real broker (`@orchvis/broker`'s `startBroker`, port
 * 0 on 127.0.0.1): two bundled shims (dist/shim.cjs), each a separate process
 * driven over stdio by an MCP SDK client with its own session ID, ORCHVIS_HOME
 * and cwd, talk to each other end to end.
 */
import { writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startBroker, type RunningBroker } from '@orchvis/broker';
import { spawnShim, type ShimProcess } from './support/shim-process.js';

const HOST = hostname().trim().toLowerCase();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Strips the `Unread: N` suffix tools append. */
const bodyOf = (text: string) => text.split('\n\nUnread:')[0]!;

/** Polls a tool until it succeeds; the shim connects in the background after the MCP handshake. */
async function untilOk(s: ShimProcess, name: string, args: Record<string, unknown> = {}, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await s.call(name, args);
    if (!r.isError || Date.now() > deadline) return r;
    await sleep(50);
  }
}

describe('two shims against the real broker', () => {
  let broker: RunningBroker;
  const brokerLog: string[] = [];
  let a: ShimProcess;
  let b: ShimProcess;
  const shims: ShimProcess[] = [];

  beforeAll(async () => {
    broker = await startBroker({ logSink: (line) => brokerLog.push(line) });
    expect(broker.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    // Distinct CLAUDE_CODE_SESSION_ID, ORCHVIS_HOME, temp dir and cwd for each.
    [a, b] = await Promise.all([
      spawnShim({ brokerUrl: broker.url, token: broker.shimToken, rawSessionId: `real-a-${process.pid}` }),
      spawnShim({ brokerUrl: broker.url, token: broker.shimToken, rawSessionId: `real-b-${process.pid}` }),
    ]);
    shims.push(a, b);
    expect(a.home).not.toBe(b.home);
  });

  afterAll(async () => {
    for (const s of shims) await s.close().catch(() => {});
    await broker?.close();
  });

  const idOf = (s: ShimProcess) => `${HOST}:${s.rawSessionId}`;

  it('both register, and each lists the other', async () => {
    expect((await untilOk(a, 'list_peers')).isError).toBe(false);
    expect((await untilOk(b, 'list_peers')).isError).toBe(false);

    const regA = await a.call('register', { name: 'ALPHA', focus: 'drives the real-broker test' });
    expect(regA.isError, regA.text).toBe(false);
    expect(JSON.parse(regA.text)).toMatchObject({ name: 'ALPHA', session_id: idOf(a) });
    const regB = await b.call('register', { name: 'BETA', focus: 'answers the real-broker test' });
    expect(regB.isError, regB.text).toBe(false);
    expect(JSON.parse(regB.text)).toMatchObject({ name: 'BETA', session_id: idOf(b) });

    // A learns of BETA's name through a broker `peers` push.
    let peersA: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 100; i++) {
      const r = await a.call('list_peers');
      peersA = r.text.startsWith('[') ? JSON.parse(bodyOf(r.text)) : [];
      if (peersA.some((p) => p['name'] === 'BETA')) break;
      await sleep(50);
    }
    expect(peersA.map((p) => p['name'])).toEqual(['BETA']);
    expect(peersA[0]).toMatchObject({ id: idOf(b), focus: 'answers the real-broker test', connected: true, host: HOST });

    const peersB = JSON.parse(bodyOf((await b.call('list_peers')).text)) as Array<Record<string, unknown>>;
    expect(peersB.map((p) => p['name'])).toEqual(['ALPHA']);
  });

  let firstId = '';
  let threadId = '';

  it('A sends to B: B gets exactly one channel notification and the message in its inbox', async () => {
    const before = b.channel().filter((n) => n.meta['msg_id']).length;
    const sent = await a.call('send_message', { to: 'BETA', body: 'hello from alpha', kind: 'request' });
    expect(sent.isError, sent.text).toBe(false);
    const m = /^Sent\. message_id=([0-9A-Z]{26}) thread_id=(\S+)/.exec(sent.text);
    expect(m).not.toBeNull();
    firstId = m![1]!;
    threadId = m![2]!;

    const note = await b.waitForChannel((n) => n.meta['msg_id'] === firstId);
    expect(note).toEqual({
      content: 'hello from alpha',
      meta: {
        msg_id: firstId,
        thread_id: threadId,
        sender_kind: 'peer',
        from_name: 'ALPHA',
        from_id: idOf(a),
        kind: 'request',
      },
    });
    await sleep(300);
    expect(b.channel().filter((n) => n.meta['msg_id']).length - before).toBe(1);
    // A sees nothing of its own message.
    expect(a.channel().filter((n) => n.meta['msg_id'] === firstId)).toHaveLength(0);

    // No confirm_channel was sent, so B is in poll mode and the message waits in the inbox.
    const inbox = await b.call('check_inbox');
    expect(inbox.isError).toBe(false);
    const entries = JSON.parse(bodyOf(inbox.text)) as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ msg_id: firstId, sender_kind: 'peer', body: 'hello from alpha' });
    expect((await b.call('check_inbox')).text).toBe('No unread messages.');
  });

  it('B replies and A receives it; get_thread on both sides returns both messages in order', async () => {
    const reply = await b.call('send_message', { to: 'ALPHA', body: 'got it', kind: 'response', reply_to: firstId });
    expect(reply.isError, reply.text).toBe(false);
    const replyId = /message_id=([0-9A-Z]{26})/.exec(reply.text)![1]!;
    expect(reply.text).toContain(`thread_id=${threadId}`);

    const note = await a.waitForChannel((n) => n.meta['msg_id'] === replyId);
    expect(note.content).toBe('got it');
    expect(note.meta).toMatchObject({ sender_kind: 'peer', from_name: 'BETA', from_id: idOf(b), kind: 'response', thread_id: threadId });

    for (const [s, peer] of [
      [a, 'BETA'],
      [b, 'ALPHA'],
    ] as const) {
      const thread = await s.call('get_thread', { peer });
      expect(thread.isError, thread.text).toBe(false);
      const parsed = JSON.parse(bodyOf(thread.text)) as { thread_id: string; messages: Array<Record<string, unknown>> };
      expect(parsed.thread_id).toBe(threadId);
      expect(parsed.messages.map((x) => [x['msg_id'], x['body']])).toEqual([
        [firstId, 'hello from alpha'],
        [replyId, 'got it'],
      ]);
    }
  });

  it('maps an unknown recipient to a rejected result with a plain explanation', async () => {
    const r = await a.call('send_message', { to: 'NOBODY', body: 'anyone there?' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^rejected: unknown_recipient: No session with that name or ID is known to the broker\./);
  });

  it('attachments: with WP3 not built, the upload fails with a clear tool result and nothing is sent', async () => {
    const file = join(a.tmp, 'notes.txt');
    writeFileSync(file, 'notes');
    const before = b.channel().length;
    const r = await a.call('send_message', { to: 'BETA', body: 'see attached', attachments: [{ path: file, caption: 'Notes' }] });
    expect(r.isError).toBe(true);
    // The broker has no /api/media route yet, so the upload is answered 404 before any `send`.
    expect(r.text).toMatch(/^upload_failed: the broker has no media upload endpoint, HTTP 404/);
    await sleep(300);
    expect(b.channel().length).toBe(before);
  });

  it('never logs message bodies or the shim token', () => {
    const all = brokerLog.join('\n');
    expect(all).toContain('shim_connected');
    expect(all).not.toContain('hello from alpha');
    expect(all).not.toContain(broker.shimToken);
  });

  it('a second shim with the same session ID replaces A (4409); A stops and says so', async () => {
    const a2 = await spawnShim({ brokerUrl: broker.url, token: broker.shimToken, rawSessionId: a.rawSessionId });
    shims.push(a2);
    expect((await untilOk(a2, 'list_peers')).isError).toBe(false);

    let r = await a.call('list_peers');
    for (let i = 0; i < 100 && !r.isError; i++) {
      await sleep(50);
      r = await a.call('list_peers');
    }
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^broker_unreachable: .*another shim for this session took over.*will not reconnect/);
    expect(a.stderr()).toMatch(/broker connection closed \(4409\)/);

    // A must not reconnect and evict a2 in turn.
    await sleep(2500);
    expect((await a2.call('list_peers')).isError).toBe(false);
    expect((await a.call('list_peers')).isError).toBe(true);
    expect(a.stderr().match(/connected; sent hello/g)).toHaveLength(1);

    // The session keeps its name and identity under the new shim.
    const sent = await b.call('send_message', { to: 'ALPHA', body: 'still there?' });
    expect(sent.isError, sent.text).toBe(false);
    const id = /message_id=([0-9A-Z]{26})/.exec(sent.text)![1]!;
    const note = await a2.waitForChannel((n) => n.meta['msg_id'] === id);
    expect(note.meta['from_name']).toBe('BETA');
    await sleep(200);
    expect(a.channel().some((n) => n.meta['msg_id'] === id)).toBe(false);
  });
});
