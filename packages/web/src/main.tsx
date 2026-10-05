import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './components/App';
import { FeedClient } from './net/feedClient';
import { webSocketTransport, type TransportFactory } from './net/transport';
import { createStore } from './store/store';
import { StoreContext } from './store/useStore';
import './styles.css';

/** Whether this dev build should use the in-process fake feed. */
function fakeRequested(params: URLSearchParams): boolean {
  if (!import.meta.env.DEV) return false;
  return params.get('fake') === '1' || import.meta.env.VITE_ORCHVIS_FAKE === '1';
}

/** Whether this dev build should play the curated showcase scenario (`?fake=showcase`). */
function showcaseRequested(params: URLSearchParams): boolean {
  return import.meta.env.DEV && params.get('fake') === 'showcase';
}

async function boot(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const store = createStore();
  let connect: TransportFactory;
  // `import.meta.env.DEV` must be written at each call site: Vite replaces it
  // with `false` in production, and only then can Rollup drop the branch and
  // its dynamic imports. Hidden inside a helper, the chunks would still ship.
  if (import.meta.env.DEV && showcaseRequested(params)) {
    const [{ showcaseTransport }, { showcaseMediaUrl }, { setMediaUrlOverride }] = await Promise.all([
      import('./dev/showcase'),
      import('./dev/showcaseAssets'),
      import('./net/media'),
    ]);
    setMediaUrlOverride(showcaseMediaUrl);
    connect = showcaseTransport();
    console.info('[orchvis] playing the showcase scenario (synthetic data)');
  } else if (import.meta.env.DEV && fakeRequested(params)) {
    const { fakeTransport } = await import('./dev/fakeFeed');
    const sessions = Number(params.get('n') ?? '30');
    connect = fakeTransport({ sessions: Number.isFinite(sessions) && sessions > 0 ? Math.min(60, sessions) : 30 });
    console.info('[orchvis] using the dev fake feed');
  } else {
    connect = webSocketTransport();
  }
  const client = new FeedClient({ store, connect });
  const root = document.getElementById('root');
  if (!root) throw new Error('#root missing');
  createRoot(root).render(
    <StrictMode>
      <StoreContext.Provider value={store}>
        <App client={client} />
      </StoreContext.Provider>
    </StrictMode>,
  );
  client.start();
}

void boot();
