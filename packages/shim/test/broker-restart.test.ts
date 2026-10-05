/**
 * Broker restart with the real shim (WP9, P6 gate): two bundled shims over
 * stdio, driven by MCP SDK clients, talk through a broker that is then stopped
 * and replaced by a new one on the same port with the same tokens. Each shim
 * must reconnect on its own backoff, keep its session ID and registered name,
 * probe the channel again, and carry traffic both ways.
 *
 * The shim's backoff runs on real time (1 s first delay, with jitter), so the
 * broker is restarted at once to keep the wait near one backoff step.
 */
import { hostname } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateToken, startBroker, type RunningBroker } from '@orchvis/broker';
import { spawnShim, type ShimProcess } from './support/shim-process.js';

const HOST = hostname().trim().toLowerCase();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const bodyOf = (text: string) => text.split('\n\nUnread:')[0]!;

async function untilOk(s: ShimProcess, name: string, args: Record<string, unknown> = {}, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await s.call(name, args);
    if (!r.isError || Date.now() > deadline) return r;
    await sleep(50);
  }
}

/** Polls `list_peers` on `s` until `pred` holds for the parsed list. */
async function peersUntil(s: ShimProcess, pred: (peers: Array<Record<string, unknown>>) => boolean, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await s.call('list_peers');
    const peers = !r.isError && r.text.startsWith('[') ? (JSON.parse(bodyOf(r.text)) as Array<Record<string, unknown>>) : [];
    if (pred(peers)) return peers;
    if (Date.now() > deadline) throw new Error(`peers never matched; last: ${r.text}\nstderr:\n${s.stderr()}`);
    await sleep(50);
  }
}

describe('real shims across a broker restart', () => {
  const shimToken = generateToken();
  const ownerToken = generateToken();
  const logs2: string[] = [];
  let first: RunningBroker;
  let second: RunningBroker | undefined;
  let a: ShimProcess;
  let b: ShimProcess;

  beforeAll(async () => {
    first = await startBroker({ config: { shimToken, ownerToken }, logSink: () => {} });
    [a, b] = await Promise.all([
      spawnShim({ brokerUrl: first.url, token: shimToken, rawSessionId: `restart-a-${process.pid}` }),
      spawnShim({ brokerUrl: first.url, token: shimToken, rawSessionId: `restart-b-${process.pid}` }),
    ]);
  });

  afterAll(async () => {
    for (const s of [a, b]) await s?.close().catch(() => {});
    await first?.close();
    await second?.close();
  });

  const idOf = (s: ShimProcess) => `${HOST}:${s.rawSessionId}`;

  async function exchange(tag: string): Promise<void> {
    const sent = await a.call('send_message', { to: 'RESTART-B', body: `${tag} from A` });
    expect(sent.isError, sent.text).toBe(false);
    const id = /message_id=([0-9A-Z]{26})/.exec(sent.text)![1]!;
    const note = await b.waitForChannel((n) => n.meta['msg_id'] === id);
    expect(note.meta).toMatchObject({ from_name: 'RESTART-A', from_id: idOf(a), sender_kind: 'peer' });

    const reply = await b.call('send_message', { to: 'RESTART-A', body: `${tag} from B`, reply_to: id });
    expect(reply.isError, reply.text).toBe(false);
    const replyId = /message_id=([0-9A-Z]{26})/.exec(reply.text)![1]!;
    const back = await a.waitForChannel((n) => n.meta['msg_id'] === replyId);
    expect(back.meta).toMatchObject({ from_name: 'RESTART-B', from_id: idOf(b), reply_to: id });
  }

  it('reconnects by itself with the same session ID and name, re-probes, and carries traffic both ways', async () => {
    expect((await untilOk(a, 'register', { name: 'RESTART-A', focus: 'restart test, side A' })).isError).toBe(false);
    expect((await untilOk(b, 'register', { name: 'RESTART-B', focus: 'restart test, side B' })).isError).toBe(false);
    await peersUntil(a, (p) => p.some((x) => x['name'] === 'RESTART-B'));
    await exchange('before');
    const probesBefore = a.channel().filter((n) => n.meta['kind'] === 'probe').length;

    const port = Number(new URL(first.url).port);
    const started = performance.now();
    await first.close();
    second = await startBroker({ port, config: { shimToken, ownerToken }, logSink: (l) => logs2.push(l) });
    expect(second.url).toBe(first.url);

    // Each side sees the other again, under the same ID and name, connected.
    await peersUntil(a, (p) => p.some((x) => x['name'] === 'RESTART-B' && x['id'] === idOf(b) && x['connected'] === true));
    await peersUntil(b, (p) => p.some((x) => x['name'] === 'RESTART-A' && x['id'] === idOf(a) && x['connected'] === true));
    const backMs = Math.round(performance.now() - started);
    process.stderr.write(`[broker-restart] both real shims re-registered ${backMs} ms after the broker stopped\n`);

    const events = logs2.map((l) => JSON.parse(l) as Record<string, unknown>);
    const registered = events.filter((e) => e['event'] === 'session_registered').map((e) => [e['sessionId'], e['name']]);
    expect(registered).toEqual(expect.arrayContaining([[idOf(a), 'RESTART-A'], [idOf(b), 'RESTART-B']]));
    expect(events.filter((e) => e['event'] === 'session_aliased')).toEqual([]);

    // A new welcome means a new delivery probe; confirming it switches the session to push on the new broker.
    const probe = await a.waitForChannel((n) => n.meta['kind'] === 'probe', { from: 0 });
    expect(a.channel().filter((n) => n.meta['kind'] === 'probe').length).toBeGreaterThan(probesBefore);
    const latest = a.channel().filter((n) => n.meta['kind'] === 'probe').at(-1) ?? probe;
    const confirmed = await a.call('confirm_channel', { nonce: latest.meta['nonce'] });
    expect(confirmed.isError, confirmed.text).toBe(false);
    await peersUntil(b, (p) => p.some((x) => x['name'] === 'RESTART-A' && x['delivery'] === 'push'));

    await exchange('after');
  }, 45_000);
});
