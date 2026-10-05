import { inflateSync } from 'node:zlib';
import {
  HelloFrame,
  RepoRefSchema,
  SessionIdSchema,
  SessionNameSchema,
  UlidSchema,
  normalizeRepoKey,
} from '@orchvis/protocol';
import { describe, expect, it } from 'vitest';
import {
  allRepos,
  createUlidFactory,
  FakeClock,
  generateMedia,
  generateScenario,
  Rng,
  runScript,
  TrafficEngine,
  type SendIntent,
  type TrafficSink,
} from '../src/index.js';

describe('Rng and FakeClock', () => {
  it('reproduces a sequence from a seed, and forks independently', () => {
    const a = new Rng(7);
    const b = new Rng(7);
    const xs = Array.from({ length: 20 }, () => a.next());
    expect(Array.from({ length: 20 }, () => b.next())).toEqual(xs);
    expect(new Rng(8).next()).not.toBe(xs[0]);
    expect(new Rng(7).fork('x').next()).toBe(new Rng(7).fork('x').next());
    expect(new Rng(7).fork('x').next()).not.toBe(new Rng(7).fork('y').next());
  });

  it('fires timers in time order, ties in schedule order', () => {
    const clock = new FakeClock(1000);
    const order: string[] = [];
    clock.setTimeout(() => order.push('b@20'), 20);
    clock.setTimeout(() => order.push('a@10'), 10);
    const h = clock.setTimeout(() => order.push('never'), 15);
    clock.setTimeout(() => {
      order.push(`c@20 now=${clock.now()}`);
      clock.setTimeout(() => order.push('d@25'), 5);
    }, 20);
    clock.clearTimeout(h);
    clock.advance(30);
    expect(order).toEqual(['a@10', 'b@20', 'c@20 now=1020', 'd@25']);
    expect(clock.now()).toBe(1030);
  });

  it('makes valid, monotonic ULIDs', () => {
    const clock = new FakeClock();
    const next = createUlidFactory(clock, new Rng(1));
    const ids = [next(), next(), next()];
    clock.advance(1);
    ids.push(next());
    for (const id of ids) expect(UlidSchema.safeParse(id).success).toBe(true);
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('generateScenario', () => {
  const s = generateScenario({ sessions: 30, hosts: 4, repos: 6, seed: 1 });

  it('builds valid identities across mixed win32 and darwin hosts', () => {
    expect(s.sessions).toHaveLength(30);
    expect(new Set(s.hosts.map((h) => h.platform))).toEqual(new Set(['win32', 'darwin']));
    expect(new Set(s.sessions.map((x) => x.sessionId)).size).toBe(30);
    expect(new Set(s.sessions.map((x) => x.name)).size).toBe(30);
    for (const x of s.sessions) {
      expect(SessionIdSchema.safeParse(x.sessionId).success).toBe(true);
      expect(SessionNameSchema.safeParse(x.name).success).toBe(true);
      expect(SessionNameSchema.safeParse(x.defaultName).success).toBe(true);
      expect(x.sessionId.split(':')[0]).toBe(x.hostname.toLowerCase());
      const hello = HelloFrame.safeParse({
        v: 1, type: 'hello', id: 'h', ts: 0,
        payload: { token: 't', sessionId: x.sessionId, hostname: x.hostname, platform: x.platform, cwd: x.cwd, repos: x.repos, defaultName: x.defaultName, shimVersion: 's', protocolVersion: 1 },
      });
      expect(hello.success).toBe(true);
    }
    expect(new Set(s.sessions.map((x) => x.persona))).toEqual(new Set(['push', 'poll']));
  });

  it('uses valid normalized repo keys, puts a session in two repos, and one in a local: repo', () => {
    for (const r of s.repos) {
      expect(normalizeRepoKey(r.remote)).toBe(r.key);
      expect(r.key).toBe(r.key.trim());
      expect(r.key).not.toMatch(/\.git$|\/$|@|:\/\//);
    }
    expect(new Set(s.repos.map((r) => r.key)).size).toBe(6);
    for (const x of s.sessions) for (const r of allRepos(x)) expect(RepoRefSchema.safeParse(r).success).toBe(true);
    expect(s.sessions.some((x) => allRepos(x).length === 2)).toBe(true);
    const local = s.sessions.filter((x) => x.repos.some((r) => r.key.startsWith('local:')));
    expect(local).toHaveLength(1);
    expect(local[0]?.repos[0]?.key).toBe(`local:${local[0]?.hostname.toLowerCase()}:${local[0]?.cwd.split('/').at(-1)}`);
  });

  it('is reproducible from its seed', () => {
    expect(generateScenario({ sessions: 30, hosts: 4, repos: 6, seed: 1 })).toEqual(s);
    expect(generateScenario({ sessions: 30, hosts: 4, repos: 6, seed: 2 })).not.toEqual(s);
  });
});

describe('generateMedia', () => {
  it('makes real PNG and WAV files and an MP4 header, with correct hashes', () => {
    const rng = new Rng(3);
    const png = generateMedia(rng, 'image');
    expect([...png.data.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const buf = Buffer.from(png.data);
    const idatLen = buf.readUInt32BE(33);
    expect(buf.toString('ascii', 37, 41)).toBe('IDAT');
    expect(inflateSync(buf.subarray(41, 41 + idatLen)).length).toBe((48 * 3 + 1) * 32);
    const wav = generateMedia(rng, 'audio');
    expect(Buffer.from(wav.data).toString('ascii', 0, 4)).toBe('RIFF');
    expect(Buffer.from(wav.data).toString('ascii', 8, 12)).toBe('WAVE');
    const mp4 = generateMedia(rng, 'video');
    expect(Buffer.from(mp4.data).toString('ascii', 4, 8)).toBe('ftyp');
    expect(mp4.mime).toBe('video/mp4');
    for (const m of [png, wav, mp4]) {
      expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(m.caption.length).toBeGreaterThan(0);
    }
  });
});

/** A sink that records what the engine asks for. */
function recorder() {
  const log: string[] = [];
  let n = 0;
  const sink: TrafficSink = {
    send: (i: SendIntent) => {
      log.push(`send ${i.from}->${i.to} ${i.kind} reply=${i.replyTo ?? '-'} media=${i.media.length} ${i.body.slice(0, 20)}`);
      return `msg${++n}`;
    },
    status: (i, c) => log.push(`status ${i} ${JSON.stringify(c)}`),
    disconnect: (i, d) => log.push(`disconnect ${i} ${Math.round(d)}`),
  };
  return { log, sink };
}

describe('TrafficEngine', () => {
  const sessions = generateScenario({ sessions: 30, seed: 4 }).sessions;

  const run = (seed: number) => {
    const clock = new FakeClock();
    const { log, sink } = recorder();
    const engine = new TrafficEngine(clock, new Rng(seed), sessions, sink, { mediaRate: 0.1 });
    engine.start();
    clock.advance(20 * 60_000);
    engine.stop();
    return { log, engine, clock };
  };

  it('is deterministic per seed and covers every kind of traffic', () => {
    const a = run(5);
    expect(run(5).log).toEqual(a.log);
    expect(run(6).log).not.toEqual(a.log);
    expect(a.engine.pairs).toHaveLength(60);
    expect(a.log.some((l) => l.startsWith('status'))).toBe(true);
    expect(a.log.some((l) => l.startsWith('disconnect'))).toBe(true);
    expect(a.log.some((l) => l.includes('->owner'))).toBe(true);
    expect(a.log.some((l) => / media=[12] /.test(l))).toBe(true);
    expect(a.clock.pending()).toBe(0);
  });

  it('answers requests with replyTo and always answers the Owner', () => {
    const clock = new FakeClock();
    const { log, sink } = recorder();
    const engine = new TrafficEngine(clock, new Rng(1), sessions, sink, { rate: 0, ownerRatePerHour: 0, statusMeanMs: 0, disconnectMeanMs: 0, replyRate: 1 });
    engine.start();
    engine.onDelivered(2, 5, 'REQ1', 'request');
    engine.onDelivered(3, 'owner', 'OWN1', 'chat');
    engine.onDelivered(4, 5, 'CHAT1', 'chat');
    clock.advance(5 * 60_000);
    expect(log.filter((l) => l.startsWith('send'))).toHaveLength(2);
    expect(log.some((l) => l.startsWith('send 2->5 response reply=REQ1'))).toBe(true);
    expect(log.some((l) => l.startsWith('send 3->owner chat reply=OWN1'))).toBe(true);
  });

  it('runs scripted steps at their times, chaining replies to earlier steps', async () => {
    const clock = new FakeClock(0);
    const times: number[] = [];
    const { log, sink } = recorder();
    const timed: TrafficSink = {
      ...sink,
      send: (i) => {
        times.push(clock.now());
        return sink.send(i);
      },
    };
    const script = runScript(clock, new Rng(1), timed, [
      { at: 1000, action: { type: 'send', from: 0, to: 1, kind: 'request', body: 'q' } },
      { at: 5000, action: { type: 'send', from: 1, to: 0, replyToStep: 0, body: 'a' } },
      { at: 6000, action: { type: 'status', session: 1, change: { status: 'blocked' } } },
      { at: 7000, action: { type: 'disconnect', session: 0, downMs: 3000 } },
      { at: 8000, action: { type: 'send', from: 0, to: 'owner', media: ['image'], body: 'see' } },
    ]);
    clock.advance(10_000);
    await script.done;
    expect(times).toEqual([1000, 5000, 8000]);
    expect(log).toEqual([
      'send 0->1 request reply=- media=0 q',
      'send 1->0 response reply=msg1 media=0 a',
      'status 1 {"status":"blocked"}',
      'disconnect 0 3000',
      'send 0->owner chat reply=- media=1 see',
    ]);
    expect(script.messageIds.get(0)).toBe('msg1');
  });
});
