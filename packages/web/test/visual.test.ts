import { DEFAULT_LIMITS, OWNER_ADDRESS, sessionAddress, threadIdFor } from '@orchvis/protocol';
import { describe, expect, it } from 'vitest';
import { buildGraphModel, nodeMatches } from '../src/graph/model';
import { EDGE_REVEAL_OPACITY, displayedEdgeOpacity, edgeOpacity, edgeWidth, formatBytes } from '../src/graph/visual';
import { fitTransform } from '../src/graph/viewport';
import { initialState, reducer } from '../src/store/reducer';
import { T0, edge, frames, message, node, snapshotFrame } from './fixtures';

describe('edge visuals', () => {
  it('fades to fully invisible and saturates', () => {
    expect(edgeOpacity(0)).toBe(0);
    expect(edgeOpacity(0.01)).toBe(0);
    expect(edgeOpacity(1)).toBeGreaterThan(0.3);
    expect(edgeOpacity(100)).toBe(0.9);
    expect(edgeWidth(0)).toBe(1.5);
    expect(edgeWidth(20)).toBe(8);
  });

  it('reveals quiet edges at 25% or more', () => {
    expect(displayedEdgeOpacity(0, true)).toBe(EDGE_REVEAL_OPACITY);
    expect(displayedEdgeOpacity(0, false)).toBe(0);
    expect(displayedEdgeOpacity(50, true)).toBe(0.9);
  });

  it('formats bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(2 * 1024 ** 3)).toBe('2.0 GB');
  });
});

describe('fitTransform', () => {
  it('centers the bounds and clamps the scale', () => {
    const t = fitTransform({ minX: -100, minY: -100, maxX: 100, maxY: 100 }, 1000, 1000);
    expect(t.x).toBeCloseTo(500);
    expect(t.y).toBeCloseTo(500);
    expect(t.scale).toBeLessThanOrEqual(1.6);
    expect(fitTransform({ minX: -1e5, minY: -1e5, maxX: 1e5, maxY: 1e5 }, 1000, 1000).scale).toBe(0.45);
  });
});

describe('buildGraphModel', () => {
  const A = 'alpha:1';
  const B = 'beta:2';
  const mk = frames();
  const repos2 = [
    { key: 'github.com/acme/app', name: 'app' },
    { key: 'github.com/acme/lib', name: 'lib' },
  ];
  const ownerMsg = { ...message(A, B), threadId: threadIdFor(sessionAddress(A), OWNER_ADDRESS), to: OWNER_ADDRESS };
  const ownerEdge = edge(A, B, 3, { threadId: ownerMsg.threadId, a: A, b: 'owner' });
  const peerMsg = message(A, B);
  const state = [
    { type: 'connection' as const, status: 'open' as const },
    {
      type: 'frame' as const,
      receivedAt: T0,
      frame: snapshotFrame(mk, {
        nodes: [node(A, { repos: repos2 }), node(B, { hostname: 'beta' })],
        edges: [edge(A, B, 2), ownerEdge, edge(A, 'gone:9', 5)],
        messages: [peerMsg, ownerMsg],
      }),
    },
    { type: 'tick' as const, localNow: T0 + DEFAULT_LIMITS.edgeTauMs },
  ].reduce(reducer, initialState(T0));

  it('puts a node in two repos in both groups and skips Owner threads', () => {
    const m = buildGraphModel(state);
    expect(m.groups.map((g) => [g.key, g.members])).toEqual([
      ['github.com/acme/app', [A, B]],
      ['github.com/acme/lib', [A]],
    ]);
    expect(m.edges).toHaveLength(1);
    expect(m.edges[0]?.weight).toBeCloseTo(2 / Math.E, 6);
  });

  it('applies repo and host filters', () => {
    expect(nodeMatches(node(B, { hostname: 'beta' }), { repos: [], hosts: ['alpha'] })).toBe(false);
    expect(nodeMatches(node(A, { repos: repos2 }), { repos: ['github.com/acme/lib'], hosts: [] })).toBe(true);
    const filtered = buildGraphModel({ ...state, view: { ...state.view, filters: { repos: ['github.com/acme/lib'], hosts: [] } } });
    expect(filtered.nodes.find((n) => n.id === B)?.matches).toBe(false);
    expect(filtered.edges[0]?.matches).toBe(false);
  });
});
