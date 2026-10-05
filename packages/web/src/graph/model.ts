import { OWNER_KEY, weightAt, type MediaKind, type SessionNode } from '@orchvis/protocol';
import type { AppState, Filters } from '../store/types';
import { repoColor } from './hull';

/** Media kinds in icon order. */
export const MEDIA_KINDS: readonly MediaKind[] = ['image', 'audio', 'video', 'other'];

/** A node ready to draw. */
export interface GraphNode {
  /** Session ID. */
  id: string;
  /** The session. */
  session: SessionNode;
  /** Repo keys. */
  groups: string[];
  /** Whether it passes the top-bar filters. */
  matches: boolean;
}

/** A repo group ready to draw. */
export interface GraphGroup {
  /** Repo key. */
  key: string;
  /** Label: the repo name. */
  name: string;
  /** Stable color from the key. */
  color: string;
  /** Session IDs in the group. */
  members: string[];
  /** Whether it passes the repo filter. */
  matches: boolean;
}

/** An edge ready to draw. */
export interface GraphEdge {
  /** Thread ID. */
  threadId: string;
  /** One session ID. */
  a: string;
  /** The other session ID. */
  b: string;
  /** Decayed weight now. */
  weight: number;
  /** Unexpired media counts with a nonzero count, in icon order. */
  media: { kind: MediaKind; count: number }[];
  /** Whether both ends pass the filters. */
  matches: boolean;
}

/** Everything the graph view draws, derived from the store. */
export interface GraphModel {
  /** Nodes, sorted by ID for stable DOM order. */
  nodes: GraphNode[];
  /** Repo groups with at least one member. */
  groups: GraphGroup[];
  /** Session-to-session edges with buffered messages. */
  edges: GraphEdge[];
}

/** Whether a node passes the filters. Empty filter lists pass everything. */
export function nodeMatches(node: SessionNode, filters: Filters): boolean {
  if (filters.hosts.length > 0 && !filters.hosts.includes(node.hostname)) return false;
  if (filters.repos.length > 0 && !node.repos.some((r) => filters.repos.includes(r.key))) return false;
  return true;
}

/**
 * Derives the drawable graph from the store. Owner threads produce no edge,
 * since the Owner is not a node (Owner traffic shows as a halo instead).
 */
export function buildGraphModel(state: AppState): GraphModel {
  const { nodes, edges, messages } = state.data;
  const { filters } = state.view;
  const graphNodes: GraphNode[] = [];
  const groups = new Map<string, GraphGroup>();
  for (const session of Object.values(nodes).sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))) {
    const keys = [...new Set(session.repos.map((r) => r.key))];
    graphNodes.push({ id: session.id, session, groups: keys, matches: nodeMatches(session, filters) });
    for (const repo of session.repos) {
      let g = groups.get(repo.key);
      if (!g) {
        g = {
          key: repo.key,
          name: repo.name,
          color: repoColor(repo.key),
          members: [],
          matches: filters.repos.length === 0 || filters.repos.includes(repo.key),
        };
        groups.set(repo.key, g);
      }
      if (!g.members.includes(session.id)) g.members.push(session.id);
    }
  }
  const matchById = new Map(graphNodes.map((n) => [n.id, n.matches]));
  const graphEdges: GraphEdge[] = [];
  for (const edge of Object.values(edges)) {
    if (edge.a === OWNER_KEY || edge.b === OWNER_KEY) continue;
    if (!(edge.a in nodes) || !(edge.b in nodes)) continue;
    if ((messages[edge.threadId]?.length ?? 0) === 0) continue;
    graphEdges.push({
      threadId: edge.threadId,
      a: edge.a,
      b: edge.b,
      weight: weightAt(edge, state.now, state.data.limits.edgeTauMs),
      media: MEDIA_KINDS.filter((k) => edge.media[k] > 0).map((k) => ({ kind: k, count: edge.media[k] })),
      matches: (matchById.get(edge.a) ?? false) && (matchById.get(edge.b) ?? false),
    });
  }
  graphEdges.sort((x, y) => (x.threadId < y.threadId ? -1 : 1));
  return { nodes: graphNodes, groups: [...groups.values()].sort((x, y) => (x.key < y.key ? -1 : 1)), edges: graphEdges };
}
