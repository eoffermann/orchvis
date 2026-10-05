import type {
  BrokerToUiFrame,
  ControlState,
  EdgeStats,
  Limits,
  MediaIndexEntry,
  MediaStoreUsage,
  Message,
  PayloadOf,
  SessionNode,
} from '@orchvis/protocol';

/*
 * The slice of `@orchvis/simulator` the web tests use, loaded by a dynamic
 * import that TypeScript does not follow. The simulator's source is written
 * against Node's lib only, and `tsc` with this package's DOM lib rejects
 * `src/mock-ui-feed.ts` (a Buffer passed as a Request body), so a static
 * import would break `pnpm typecheck` here. Vitest loads the real module.
 */

/** Simulator `UiState`. */
export interface UiState {
  now: number;
  limits: Limits;
  nodes: SessionNode[];
  edges: EdgeStats[];
  messages: Message[];
  media: MediaIndexEntry[];
  control: ControlState;
  mediaStore: MediaStoreUsage;
}

/** Simulator `FakeClock`. */
export interface FakeClockLike {
  now(): number;
  advanceAsync(ms: number, stepMs?: number): Promise<void>;
}

/** Simulator `MockUiFeed`. */
export interface MockUiFeed {
  url: string;
  httpUrl: string;
  world: { snapshot(): PayloadOf<BrokerToUiFrame, 'snapshot'> };
  stats: { invalidOutbound: number };
  close(): Promise<void>;
}

/** The simulator exports the tests use. */
export interface SimulatorApi {
  FakeClock: new (start?: number) => FakeClockLike;
  UiStateMirror: new () => { apply(frame: BrokerToUiFrame): void; state(): UiState };
  diffUiStates(actual: UiState, expected: UiState, now: number, tolerance?: number): string[];
  startMockUiFeed(options: {
    port?: number;
    nodes?: number;
    hosts?: number;
    repos?: number;
    seed?: number;
    clock?: FakeClockLike;
    limits?: Partial<Limits>;
    traffic?: { rate?: number; mediaRate?: number };
    ownerToken?: string;
    startTraffic?: boolean;
  }): Promise<MockUiFeed>;
}

const SIMULATOR = '@orchvis/simulator';

/** Loads the simulator package. */
export async function loadSimulator(): Promise<SimulatorApi> {
  return (await import(/* @vite-ignore */ SIMULATOR)) as SimulatorApi;
}
