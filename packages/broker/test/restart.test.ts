/**
 * P6 gate: "10 sessions survive a broker restart". Ten simulator shims on the
 * real wire protocol exchange traffic, the broker stops, a new one starts on
 * the same port with the same tokens, and the shims find it by themselves.
 * The shims' backoff runs on a FakeClock, so the test controls how long the
 * broker is down in simulated time and never waits out real backoff.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { WS_CLOSE, type BrokerToShimFrame, type FrameOf } from '@orchvis/protocol';
import { FakeClock, diffUiStates, startShimFleet, type ShimFleet, type SimShim } from '@orchvis/simulator';
import { ManualClock, generateToken, startBroker, type RunningBroker } from '../src/index.js';
import { FakeUi, uiHeaders } from './helpers/fake.js';
import { MirrorUi } from './helpers/mirror-ui.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Real-time guard for every wait in this file. */
const WAIT_MS = 15_000;

async function until(what: string, cond: () => boolean, step?: () => void): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    step?.();
    await sleep(10);
  }
}

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

async function broker(port: number, shimToken: string, ownerToken: string, logs: string[]): Promise<RunningBroker> {
  const b = await startBroker({ port, config: { shimToken, ownerToken }, clock: new ManualClock(), logSink: (l) => logs.push(l) });
  cleanup.push(() => b.close());
  return b;
}

function events(logs: string[], event: string): Record<string, unknown>[] {
  return logs.map((l) => JSON.parse(l) as Record<string, unknown>).filter((e) => e['event'] === event);
}

type Deliver = FrameOf<BrokerToShimFrame, 'deliver'>;

/**
 * One round of traffic: every shim sends to the next one by name and to the
 * Owner; the Owner sends to every shim. Asserts each message is acknowledged
 * and delivered, and returns the message IDs.
 */
async function round(shims: SimShim[], ui: MirrorUi, tag: string): Promise<string[]> {
  const ids: string[] = [];
  const peerSends = shims.map(async (s, i) => {
    const to = shims[(i + 1) % shims.length] as SimShim;
    const r = await s.send({ to: to.name as string, body: `${tag}: ${s.name} to ${to.name}` });
    expect(r, `${s.name} -> ${to.name}`).toMatchObject({ ok: true });
    if (!r.ok) return;
    ids.push(r.messageId);
    const d: Deliver = await to.next('deliver', (f) => f.payload.message.id === r.messageId);
    expect(d.payload.message).toMatchObject({ from: { kind: 'session', id: s.sessionId }, fromName: s.name, senderKind: 'peer' });
  });
  const ownerSends = shims.map(async (s) => {
    const r = await s.send({ to: 'owner', body: `${tag}: ${s.name} to the Owner` });
    expect(r).toMatchObject({ ok: true });
    if (r.ok) ids.push(r.messageId);
  });
  const fromOwner = shims.map(async (s) => {
    const answer = await ui.request('owner_send', { to: s.sessionId, kind: 'chat', body: `${tag}: Owner to ${s.name}`, attachments: [] });
    expect(answer.type, `owner_send to ${s.name}`).toBe('sent');
    if (answer.type !== 'sent') return;
    ids.push(answer.payload.messageId);
    const d: Deliver = await s.next('deliver', (f) => f.payload.message.id === answer.payload.messageId);
    expect(d.payload.message).toMatchObject({ from: { kind: 'owner' }, senderKind: 'owner' });
  });
  await Promise.all([...peerSends, ...ownerSends, ...fromOwner]);
  await ui.sync();
  return ids;
}

describe('broker restart recovery (P6)', () => {
  it('10 sessions reconnect by themselves with the same ID and name, traffic resumes both ways, and the web app logs in again', async () => {
    const shimToken = generateToken();
    const ownerToken = generateToken();
    const logs1: string[] = [];
    const logs2: string[] = [];
    const first = await broker(0, shimToken, ownerToken, logs1);
    const port = Number(new URL(first.url).port);
    const shimClock = new FakeClock();
    const fleet: ShimFleet = await startShimFleet({
      url: `ws://127.0.0.1:${port}/ws/shim`,
      token: shimToken,
      sessions: 10,
      hosts: 3,
      repos: 4,
      seed: 42,
      clock: shimClock,
      autoTraffic: false,
    });
    cleanup.push(() => fleet.close());
    const shims = fleet.shims;
    const specs = fleet.scenario.sessions;

    const ui1 = await MirrorUi.connect(first);
    const before = await round(shims, ui1, 'before');
    expect(before).toHaveLength(30);
    const identities = shims.map((s) => ({ id: s.sessionId, name: s.name }));
    expect(identities.map((x) => x.name)).toEqual(specs.map((s) => s.name));
    expect(identities.map((x) => x.id)).toEqual(specs.map((s) => s.sessionId));

    // ---- stop the broker ----
    const realStart = performance.now();
    await first.close();
    expect((await ui1.closed).code).toBe(WS_CLOSE.shuttingDown);
    await until('every shim to notice the broker is gone', () => shims.every((s) => !s.isReady));
    const scheduledBefore = shims.reduce((n, s) => n + s.stats.reconnectsScheduled, 0);

    // Three simulated seconds of downtime: backoff attempts against a closed port fail and back off further.
    for (let simMs = 0; simMs < 3_000; simMs += 250) {
      shimClock.advance(250);
      await sleep(5);
    }
    expect(shims.every((s) => !s.isReady)).toBe(true);

    // ---- start a new broker on the same port with the same tokens ----
    const second = await broker(port, shimToken, ownerToken, logs2);
    expect(second.url).toBe(first.url);

    // The web app's old session died with the old broker: 4401, then a fresh login works.
    expect(await FakeUi.tryConnect(second, uiHeaders(second, ui1.cookie))).toBe(WS_CLOSE.unauthorized);
    const ui2 = await MirrorUi.connect(second);
    expect(ui2.mirror.state().nodes).toEqual([]);

    // Advance the shims' clock until every one has reconnected and re-registered.
    let simulatedMs = 0;
    await until(
      'every shim to reconnect and re-register',
      () => shims.every((s, i) => s.isReady && s.name === specs[i]?.name),
      () => {
        shimClock.advance(100);
        simulatedMs += 100;
      },
    );
    const realMs = performance.now() - realStart;
    await until('the web app to see all 10 nodes registered', () => {
      const nodes = ui2.mirror.state().nodes;
      return nodes.length === 10 && nodes.every((n) => n.connected && specs.some((s) => s.name === n.name));
    });
    process.stderr.write(
      `[restart] 10 shims back after ${simulatedMs + 3_000} ms simulated downtime+backoff, ${Math.round(realMs)} ms real; ` +
        `${shims.reduce((n, s) => n + s.stats.reconnectsScheduled, 0) - scheduledBefore} reconnect attempts scheduled\n`,
    );

    // Same IDs and names as before the restart.
    expect(shims.map((s) => ({ id: s.sessionId, name: s.name }))).toEqual(identities);
    const nodes = ui2.mirror.state().nodes;
    expect(nodes.map((n) => [n.id, n.name]).sort()).toEqual(identities.map((x) => [x.id, x.name]).sort());
    for (const s of shims) expect(s.stats.connects).toBeGreaterThanOrEqual(2);

    // Each shim said hello again with its own session ID, then re-sent its last register.
    const connected = events(logs2, 'shim_connected');
    expect(new Set(connected.map((e) => e['sessionId']))).toEqual(new Set(identities.map((x) => x.id)));
    const registered = events(logs2, 'session_registered');
    expect(new Map(registered.map((e) => [e['sessionId'], e['name']]))).toEqual(new Map(identities.map((x) => [x.id, x.name])));
    expect(events(logs2, 'session_aliased')).toEqual([]);

    // Traffic resumes in both directions.
    const after = await round(shims, ui2, 'after');
    expect(after).toHaveLength(30);
    expect(fleet.stats().invalidInbound).toBe(0);

    // A web client connecting now gets a snapshot equal to what the reconnected one built from deltas.
    const fresh = await MirrorUi.connect(second);
    cleanup.push(() => fresh.close());
    cleanup.push(() => ui2.close());
    const now = fresh.mirror.state().now;
    expect(diffUiStates(ui2.mirror.state(), fresh.mirror.state(), now)).toEqual([]);
    expect(fresh.mirror.state().messages.map((m) => m.id).sort()).toEqual([...after].sort());
    expect(second.stats()).toMatchObject({ nodes: 10, connectedNodes: 10, aliases: 0, shimLinks: 10, uploadKeys: 10 });
    expect(ui1.invalid).toEqual([]);
    expect(ui2.invalid).toEqual([]);
  }, 40_000);
});
