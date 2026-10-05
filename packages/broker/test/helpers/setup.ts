import { afterEach } from 'vitest';
import { ManualClock, startBroker, type BrokerConfigInput, type RunningBroker } from '../../src/index.js';
import { FakeShim, FakeUi } from './fake.js';

/** A broker under test, with its manual clock, captured log lines and every client opened through it. */
export interface Harness {
  broker: RunningBroker;
  clock: ManualClock;
  logs: string[];
  shim(sessionId: string, extra?: Partial<Parameters<typeof FakeShim.connect>[1]>): ReturnType<typeof FakeShim.connect>;
  ui(): ReturnType<typeof FakeUi.connect>;
}

const open: { close(): Promise<void> }[] = [];

afterEach(async () => {
  for (const c of open.splice(0).reverse()) await c.close().catch(() => {});
});

/** Starts a broker on port 0 with a manual clock. Everything is closed after each test. */
export async function harness(config: BrokerConfigInput = {}): Promise<Harness> {
  const clock = new ManualClock();
  const logs: string[] = [];
  const broker = await startBroker({ port: 0, config, clock, logSink: (l) => logs.push(l) });
  open.push(broker);
  return {
    broker,
    clock,
    logs,
    shim: async (sessionId, extra = {}) => {
      const r = await FakeShim.connect(broker, { sessionId, ...extra });
      open.push(r.shim);
      return r;
    },
    ui: async () => {
      const r = await FakeUi.connect(broker);
      open.push(r.ui);
      return r;
    },
  };
}
