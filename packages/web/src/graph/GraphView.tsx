import { useCallback, useEffect, useMemo, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import type { MediaKind } from '@orchvis/protocol';
import type { Selection } from '../store/types';
import { useAppState, useStoreInstance } from '../store/useStore';
import { hullPath, hullTop, paddedHull, type Point } from './hull';
import { GraphLayout } from './layout';
import { buildGraphModel, type GraphModel } from './model';
import { HaloSystem, PulseSystem } from './pulses';
import { useRefMap } from './useRefMap';
import { bounds, fitTransform, lerpTransform, type ViewTransform } from './viewport';
import { HALO_COLOR, PULSE_COLOR, PULSE_MEDIA_COLOR, STATUS_COLORS, displayedEdgeOpacity, edgeWidth } from './visual';

/** Visible node radius, in layout px. */
export const NODE_RADIUS = 20;

/** Minimum hit target size on screen, in CSS px. */
export const MIN_HIT_PX = 44;

/** Edge hit stroke on screen, in CSS px. */
export const EDGE_HIT_PX = 16;

/** Pointer travel, in screen px, before a press becomes a drag. */
const DRAG_THRESHOLD_PX = 6;

/** Max time between taps for a double tap, in ms. */
const DOUBLE_TAP_MS = 350;

const MEDIA_GLYPHS: Readonly<Record<MediaKind, string>> = { image: '▣', audio: '♪', video: '▶', other: '◆' };

const MEDIA_LABELS: Readonly<Record<MediaKind, string>> = { image: 'images', audio: 'audio clips', video: 'videos', other: 'files' };

/** Props for {@link GraphView}. */
export interface GraphViewProps {
  /**
   * Called whenever the Owner selects a node, an edge or a media icon, or
   * clears the selection. WP6 overlays hook in here (and read the store's
   * `view.selection`).
   */
  onSelect?: (selection: Selection | null) => void;
}

interface PressState {
  id: string;
  pointerId: number;
  startX: number;
  startY: number;
  dragging: boolean;
}

/**
 * The live session graph: repo hulls, weighted edges, nodes, pulses and media
 * icons, laid out by d3-force. React renders structure and per-state styling;
 * positions, hulls, pulses and halos are written imperatively from one
 * requestAnimationFrame loop, so steady traffic never re-renders per frame.
 *
 * All peer-provided strings (names, hostnames, repo names) are rendered as
 * React text nodes only.
 */
export function GraphView({ onSelect }: GraphViewProps) {
  const store = useStoreInstance();
  const state = useAppState((s) => s);
  const model = useMemo(() => buildGraphModel(state), [state]);
  const { selection, hoverNodeId } = state.view;

  const layoutRef = useRef<GraphLayout | null>(null);
  if (!layoutRef.current) layoutRef.current = new GraphLayout();
  const pulsesRef = useRef(new PulseSystem());
  const halosRef = useRef(new HaloSystem());
  const modelRef = useRef<GraphModel>(model);
  modelRef.current = model;

  const svgRef = useRef<SVGSVGElement | null>(null);
  const viewportRef = useRef<SVGGElement | null>(null);
  const pulseLayerRef = useRef<SVGGElement | null>(null);
  const sizeRef = useRef({ width: 0, height: 0 });
  const viewRef = useRef<ViewTransform>({ x: 0, y: 0, scale: 1 });
  const pressRef = useRef<PressState | null>(null);
  const lastTapRef = useRef<{ id: string; time: number } | null>(null);

  const nodeEls = useRefMap<SVGGElement>();
  const haloEls = useRefMap<SVGCircleElement>();
  const edgeLineEls = useRefMap<SVGLineElement>();
  const edgeHitEls = useRefMap<SVGLineElement>();
  const iconEls = useRefMap<SVGGElement>();
  const hullPathEls = useRefMap<SVGPathElement>();
  const hullLabelEls = useRefMap<SVGTextElement>();

  const select = useCallback(
    (next: Selection | null) => {
      store.dispatch({ type: 'select', selection: next });
      onSelect?.(next);
    },
    [store, onSelect],
  );

  // Keep the simulation in step with the graph and the decayed weights.
  useEffect(() => {
    layoutRef.current?.update(
      model.nodes.map((n) => ({ id: n.id, groups: n.groups })),
      model.edges.map((e) => ({ id: e.threadId, source: e.a, target: e.b, weight: e.weight })),
      performance.now(),
    );
  }, [model]);

  // Traffic events: pulses for peer messages, halos for Owner traffic.
  useEffect(
    () =>
      store.onTraffic(({ message }) => {
        const now = performance.now();
        if (message.from.kind === 'session' && message.to.kind === 'session') {
          pulsesRef.current.spawn({
            threadId: message.threadId,
            from: message.from.id,
            to: message.to.id,
            media: message.attachments.length > 0,
            start: now,
          });
        } else if (message.from.kind === 'session') {
          halosRef.current.trigger(message.from.id, now);
        } else if (message.to.kind === 'session') {
          halosRef.current.trigger(message.to.id, now);
        }
      }),
    [store],
  );

  // Track the SVG's size for auto-fit.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const measure = () => {
      const r = svg.getBoundingClientRect();
      sizeRef.current = { width: r.width, height: r.height };
      svg.setAttribute('viewBox', `0 0 ${r.width} ${r.height}`);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(svg);
    return () => ro.disconnect();
  }, []);

  // The animation loop.
  useEffect(() => {
    let raf = 0;
    let lastScale = Number.NaN;
    let lastModel: GraphModel | null = null;
    const pulseEls: SVGCircleElement[] = [];
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const now = performance.now();
      const layout = layoutRef.current;
      const viewport = viewportRef.current;
      if (!layout || !viewport) return;
      layout.tick(now);
      const m = modelRef.current;

      // Auto-fit, frozen while a node is being dragged so it stays under the finger.
      if (!pressRef.current?.dragging) {
        const target = fitTransform(bounds(layout.allNodes()), sizeRef.current.width, sizeRef.current.height);
        viewRef.current = Number.isNaN(lastScale) ? target : lerpTransform(viewRef.current, target, 0.08);
      }
      const v = viewRef.current;
      viewport.setAttribute('transform', `translate(${v.x.toFixed(2)},${v.y.toFixed(2)}) scale(${v.scale.toFixed(4)})`);
      const inv = 1 / v.scale;
      if (Math.abs(v.scale - lastScale) > 0.005 || m !== lastModel) {
        // Keep hit targets at their screen size whatever the zoom, including
        // on elements mounted since the last pass.
        lastScale = v.scale;
        lastModel = m;
        const hitR = Math.max(NODE_RADIUS + 6, (MIN_HIT_PX / 2) * inv);
        for (const el of viewport.querySelectorAll('.node-hit')) el.setAttribute('r', hitR.toFixed(1));
        for (const el of edgeHitEls.map.values()) el.setAttribute('stroke-width', (EDGE_HIT_PX * inv).toFixed(1));
      }

      for (const [id, el] of nodeEls.map) {
        const n = layout.node(id);
        if (n) el.setAttribute('transform', `translate(${n.x.toFixed(1)},${n.y.toFixed(1)})`);
      }

      for (const e of m.edges) {
        const a = layout.node(e.a);
        const b = layout.node(e.b);
        if (!a || !b) continue;
        for (const el of [edgeLineEls.map.get(e.threadId), edgeHitEls.map.get(e.threadId)]) {
          if (!el) continue;
          el.setAttribute('x1', a.x.toFixed(1));
          el.setAttribute('y1', a.y.toFixed(1));
          el.setAttribute('x2', b.x.toFixed(1));
          el.setAttribute('y2', b.y.toFixed(1));
        }
        const icon = iconEls.map.get(e.threadId);
        if (icon) {
          icon.setAttribute(
            'transform',
            `translate(${((a.x + b.x) / 2).toFixed(1)},${((a.y + b.y) / 2).toFixed(1)}) scale(${inv.toFixed(4)})`,
          );
        }
      }

      for (const g of m.groups) {
        const path = hullPathEls.map.get(g.key);
        if (!path) continue;
        const pts: Point[] = [];
        for (const id of g.members) {
          const n = layout.node(id);
          if (n) pts.push([n.x, n.y]);
        }
        const hull = paddedHull(pts);
        path.setAttribute('d', hullPath(hull));
        const top = hullTop(hull);
        const label = hullLabelEls.map.get(g.key);
        if (label && top) {
          label.setAttribute('x', top[0].toFixed(1));
          label.setAttribute('y', (top[1] - 8).toFixed(1));
        }
      }

      // Pulses: a pool of circles, reused frame to frame.
      const layer = pulseLayerRef.current;
      if (layer) {
        const active = pulsesRef.current.active(now);
        while (pulseEls.length < active.length) {
          const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
          c.setAttribute('r', '5');
          c.setAttribute('class', 'pulse');
          layer.appendChild(c);
          pulseEls.push(c);
        }
        for (let i = 0; i < pulseEls.length; i++) {
          const el = pulseEls[i] as SVGCircleElement;
          const p = active[i];
          const a = p ? layout.node(p.from) : undefined;
          const b = p ? layout.node(p.to) : undefined;
          if (!p || !a || !b) {
            el.setAttribute('visibility', 'hidden');
            continue;
          }
          const t = p.t < 0.5 ? 2 * p.t * p.t : 1 - (-2 * p.t + 2) ** 2 / 2;
          el.setAttribute('visibility', 'visible');
          el.setAttribute('cx', (a.x + (b.x - a.x) * t).toFixed(1));
          el.setAttribute('cy', (a.y + (b.y - a.y) * t).toFixed(1));
          el.setAttribute('fill', p.media ? PULSE_MEDIA_COLOR : PULSE_COLOR);
        }
      }

      const halos = halosRef.current.active(now);
      for (const [id, el] of haloEls.map) {
        const t = halos.get(id);
        if (t === undefined) {
          if (el.getAttribute('opacity') !== '0') el.setAttribute('opacity', '0');
          continue;
        }
        el.setAttribute('r', (NODE_RADIUS + 4 + 30 * t).toFixed(1));
        el.setAttribute('opacity', (0.9 * (1 - t)).toFixed(3));
      }
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      for (const el of pulseEls) el.remove();
    };
  }, [nodeEls, haloEls, edgeLineEls, edgeHitEls, iconEls, hullPathEls, hullLabelEls]);

  const toLayout = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const ctm = viewportRef.current?.getScreenCTM();
    if (!ctm) return null;
    const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  };

  const onNodePointerDown = (id: string) => (e: ReactPointerEvent<SVGGElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    pressRef.current = { id, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, dragging: false };
  };

  const onNodePointerMove = (e: ReactPointerEvent<SVGGElement>) => {
    const press = pressRef.current;
    if (!press || press.pointerId !== e.pointerId) return;
    const p = toLayout(e.clientX, e.clientY);
    if (!p) return;
    if (!press.dragging) {
      if (Math.hypot(e.clientX - press.startX, e.clientY - press.startY) < DRAG_THRESHOLD_PX) return;
      press.dragging = true;
      layoutRef.current?.dragStart(press.id, p.x, p.y);
    } else {
      layoutRef.current?.dragMove(press.id, p.x, p.y);
    }
  };

  const onNodePointerUp = (e: ReactPointerEvent<SVGGElement>) => {
    const press = pressRef.current;
    if (!press || press.pointerId !== e.pointerId) return;
    pressRef.current = null;
    const now = performance.now();
    if (press.dragging) {
      layoutRef.current?.dragEnd(now);
      return;
    }
    const last = lastTapRef.current;
    if (last && last.id === press.id && now - last.time < DOUBLE_TAP_MS) {
      // Double click / double tap releases a pinned node.
      lastTapRef.current = null;
      layoutRef.current?.release(press.id, now);
      return;
    }
    lastTapRef.current = { id: press.id, time: now };
    select({ kind: 'node', id: press.id });
  };

  const onNodePointerCancel = (e: ReactPointerEvent<SVGGElement>) => {
    const press = pressRef.current;
    if (!press || press.pointerId !== e.pointerId) return;
    pressRef.current = null;
    if (press.dragging) layoutRef.current?.dragEnd(performance.now());
  };

  const hover = (id: string | null) => (e: ReactPointerEvent) => {
    if (e.pointerType === 'mouse') store.dispatch({ type: 'hover', nodeId: id });
  };

  const focusNodes = new Set<string>();
  if (hoverNodeId) focusNodes.add(hoverNodeId);
  if (selection?.kind === 'node') focusNodes.add(selection.id);
  const selectedThread = selection && selection.kind !== 'node' ? selection.threadId : null;

  return (
    <svg ref={svgRef} className="graph" role="img" aria-label="Session graph">
      <rect className="graph-bg" x="0" y="0" width="100%" height="100%" onClick={() => select(null)} />
      <g ref={viewportRef}>
        <g className="layer-hulls">
          {model.groups.map((g) => (
            <g key={g.key} className={g.matches ? 'hull' : 'hull hull--filtered'}>
              <path ref={hullPathEls.ref(g.key)} className="hull-path" fill={g.color} stroke={g.color} />
              <text ref={hullLabelEls.ref(g.key)} className="hull-label" fill={g.color} textAnchor="middle">
                {g.name}
              </text>
            </g>
          ))}
        </g>
        <g className="layer-edges">
          {model.edges.map((e) => {
            const revealed = focusNodes.has(e.a) || focusNodes.has(e.b) || selectedThread === e.threadId;
            const opacity = e.matches ? displayedEdgeOpacity(e.weight, revealed) : 0;
            return (
              <g key={e.threadId} className={selectedThread === e.threadId ? 'edge edge--selected' : 'edge'}>
                <line ref={edgeLineEls.ref(e.threadId)} className="edge-line" strokeWidth={edgeWidth(e.weight)} opacity={opacity} />
                {e.matches && (
                  <line
                    ref={edgeHitEls.ref(e.threadId)}
                    className="edge-hit"
                    strokeWidth={EDGE_HIT_PX}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      select({ kind: 'edge', threadId: e.threadId });
                    }}
                  >
                    <title>Thread between {state.data.nodes[e.a]?.name ?? e.a} and {state.data.nodes[e.b]?.name ?? e.b}</title>
                  </line>
                )}
              </g>
            );
          })}
        </g>
        <g ref={pulseLayerRef} className="layer-pulses" />
        <g className="layer-nodes">
          {model.nodes.map((n) => {
            const s = n.session;
            const cls = ['node'];
            if (!s.connected) cls.push('node--offline');
            if (!n.matches) cls.push('node--filtered');
            if (selection?.kind === 'node' && selection.id === n.id) cls.push('node--selected');
            if (hoverNodeId === n.id) cls.push('node--hover');
            return (
              <g
                key={n.id}
                ref={nodeEls.ref(n.id)}
                className={cls.join(' ')}
                onPointerDown={n.matches ? onNodePointerDown(n.id) : undefined}
                onPointerMove={onNodePointerMove}
                onPointerUp={onNodePointerUp}
                onPointerCancel={onNodePointerCancel}
                onPointerEnter={hover(n.id)}
                onPointerLeave={hover(null)}
              >
                <title>
                  {s.name} on {s.hostname}: {s.status}, {s.delivery} mode{s.connected ? '' : ', disconnected'}
                </title>
                <circle ref={haloEls.ref(n.id)} className="node-halo" r={NODE_RADIUS} stroke={HALO_COLOR} opacity={0} />
                <circle className="node-hit" r={MIN_HIT_PX / 2 + 4} />
                <circle className="node-body" r={NODE_RADIUS} />
                <circle className="node-ring" r={NODE_RADIUS} stroke={STATUS_COLORS[s.status]} />
                <text className="node-name" y={NODE_RADIUS + 18} textAnchor="middle">
                  {s.name}
                </text>
                <text className="node-host" y={NODE_RADIUS + 34} textAnchor="middle">
                  {s.hostname}
                </text>
                {s.delivery === 'poll' && (
                  <g className="node-badge" transform={`translate(${NODE_RADIUS - 4},${-NODE_RADIUS + 4})`}>
                    <circle r={9} />
                    <text textAnchor="middle" dy="0.35em">
                      P
                    </text>
                  </g>
                )}
              </g>
            );
          })}
        </g>
        <g className="layer-media">
          {model.edges.map((e) =>
            e.media.length === 0 || !e.matches ? null : (
              <g key={e.threadId} ref={iconEls.ref(e.threadId)} className="edge-media">
                {e.media.map((m, i) => (
                  <g
                    key={m.kind}
                    className={`media-icon media-icon--${m.kind}`}
                    transform={`translate(${(i - (e.media.length - 1) / 2) * MIN_HIT_PX},0)`}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      select({ kind: 'media', threadId: e.threadId, mediaKind: m.kind });
                    }}
                  >
                    <title>
                      {m.count} {MEDIA_LABELS[m.kind]}
                    </title>
                    <rect className="media-hit" x={-MIN_HIT_PX / 2} y={-MIN_HIT_PX / 2} width={MIN_HIT_PX} height={MIN_HIT_PX} />
                    <circle className="media-badge" r={13} />
                    <text className="media-glyph" textAnchor="middle" dy="0.35em">
                      {MEDIA_GLYPHS[m.kind]}
                    </text>
                    <text className="media-count" x={12} y={-10} textAnchor="middle">
                      {m.count}
                    </text>
                  </g>
                ))}
              </g>
            ),
          )}
        </g>
      </g>
    </svg>
  );
}
