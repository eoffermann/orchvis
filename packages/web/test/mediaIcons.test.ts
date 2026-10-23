import { describe, expect, it } from 'vitest';
import { nodeParts, type Box } from '../src/graph/footprint';
import { overlapArea } from '../src/graph/hull';
import { MEDIA_ICON_PITCH, mediaIconHalfSize, placeMediaIcons } from '../src/graph/mediaIcons';

describe('mediaIconHalfSize', () => {
  it('grows by one pitch per icon and keeps its screen size at any zoom', () => {
    const one = mediaIconHalfSize(1, 1);
    const three = mediaIconHalfSize(3, 1);
    expect(three.halfWidth - one.halfWidth).toBeCloseTo(MEDIA_ICON_PITCH, 6);
    expect(mediaIconHalfSize(2, 0.5).halfWidth).toBeCloseTo(mediaIconHalfSize(2, 1).halfWidth * 2, 6);
  });
});

describe('placeMediaIcons', () => {
  const a = { x: 0, y: 0 };
  const b = { x: 400, y: 0 };
  const size = mediaIconHalfSize(2, 1);

  it('sits at the midpoint when nothing is in the way', () => {
    const spot = placeMediaIcons(a, b, size, 1, []);
    expect(spot.x).toBeCloseTo(200, 6);
    expect(spot.y).toBeCloseTo(0, 6);
  });

  it("slides along the edge off a session's labels", () => {
    // A node just above the midpoint: its name and host lines cross the edge.
    const parts = nodeParts(200, -45, 'shim', 'mediaroomwindows');
    const spot = placeMediaIcons(a, b, size, 1, parts);
    expect(parts.some((p) => overlapArea(spot.box, p) > 0)).toBe(false);
    expect(spot.side).toBe(0);
  });

  it('steps to the side of the edge when the edge itself is covered', () => {
    const band: Box = { left: -1000, right: 1000, top: -10, bottom: 10 };
    const spot = placeMediaIcons(a, b, size, 1, [band]);
    expect(overlapArea(spot.box, band)).toBe(0);
    expect(Math.abs(spot.side)).toBeGreaterThan(0);
  });

  it('keeps its previous spot while that spot stays clear', () => {
    const first = placeMediaIcons(a, b, size, 1, nodeParts(200, -45, 'shim', 'mediaroomwindows'));
    const again = placeMediaIcons(a, b, size, 1, [], first);
    expect(again.t).toBe(first.t);
    expect(again.side).toBe(first.side);
  });

  it('takes the least covered spot when every spot is covered', () => {
    const wall: Box = { left: -1000, right: 1000, top: -1000, bottom: 1000 };
    const label: Box = { left: 150, right: 250, top: -30, bottom: 30 };
    const spot = placeMediaIcons(a, b, size, 1, [wall, label]);
    expect(overlapArea(spot.box, label)).toBe(0);
  });
});
