import { useEffect } from 'react';
import { GraphView } from '../graph/GraphView';
import type { FeedClient } from '../net/feedClient';
import type { Selection } from '../store/types';
import { useAppState, useStoreInstance } from '../store/useStore';
import { LoginScreen } from './LoginScreen';
import { OverlayHost } from './OverlayHost';
import { TopBar } from './TopBar';

/** Interval of the client-side edge decay timer, in ms. */
export const DECAY_TICK_MS = 1_000;

/** Props for {@link App}. */
export interface AppProps {
  /** The feed client, already started. */
  client: FeedClient;
  /** Selection callback, the seam for WP6 overlays and tests. */
  onSelect?: (selection: Selection | null) => void;
}

/** The app shell: login when signed out, otherwise top bar, graph and overlays. */
export function App({ client, onSelect }: AppProps) {
  const store = useStoreInstance();
  const connection = useAppState((s) => s.connection);

  // Client-side decay: advance the broker-clock estimate once a second so
  // edges fade smoothly between messages.
  useEffect(() => {
    const id = setInterval(() => store.dispatch({ type: 'tick', localNow: Date.now() }), DECAY_TICK_MS);
    return () => clearInterval(id);
  }, [store]);

  if (connection === 'unauthorized') {
    return <LoginScreen onLoggedIn={() => client.start()} onRetry={() => client.start()} />;
  }
  return (
    <div className="app">
      <TopBar sendControl={(action) => client.sendControl(action)} />
      <main className="stage">
        <GraphView {...(onSelect ? { onSelect } : {})} />
        <OverlayHost client={client} />
      </main>
    </div>
  );
}
