import { describe, expect, it } from 'vitest';
import { HaloSystem, MAX_PULSES_PER_EDGE, PULSE_DURATION_MS, PulseSystem } from '../src/graph/pulses';

const base = { threadId: 'a:1|b:2', from: 'a:1', to: 'b:2', media: false };

describe('PulseSystem', () => {
  it('caps concurrent pulses per edge at 5', () => {
    const ps = new PulseSystem();
    const started = Array.from({ length: 8 }, (_, i) => ps.spawn({ ...base, start: i }));
    expect(started.filter(Boolean)).toHaveLength(MAX_PULSES_PER_EDGE);
    expect(ps.spawn({ ...base, threadId: 'a:1|c:3', start: 8 })).toBe(true);
  });

  it('frees capacity once pulses arrive', () => {
    const ps = new PulseSystem();
    for (let i = 0; i < 5; i++) ps.spawn({ ...base, start: 0 });
    expect(ps.spawn({ ...base, start: PULSE_DURATION_MS + 1 })).toBe(true);
  });

  it('reports progress and drops finished pulses', () => {
    const ps = new PulseSystem();
    ps.spawn({ ...base, start: 1000 });
    expect(ps.active(1300)[0]?.t).toBeCloseTo(0.5);
    expect(ps.active(1000 + PULSE_DURATION_MS)).toHaveLength(0);
    expect(ps.size).toBe(0);
  });
});

describe('HaloSystem', () => {
  it('runs a halo from 0 to 1 and then forgets it', () => {
    const hs = new HaloSystem(1000);
    hs.trigger('a:1', 0);
    expect(hs.active(500).get('a:1')).toBeCloseTo(0.5);
    expect(hs.active(1000).has('a:1')).toBe(false);
  });
});
