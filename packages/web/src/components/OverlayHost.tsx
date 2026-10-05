import type { FeedClient } from '../net/feedClient';
import { useAppState, useStoreInstance } from '../store/useStore';

/** Props for {@link OverlayHost}. */
export interface OverlayHostProps {
  /** The feed client, for overlays that send `owner_send` or `control` frames. */
  client: FeedClient;
}

/**
 * Mount point for the WP6 overlays (node chat, thread, media browser). WP5
 * only shows what is selected; WP6 replaces the body of this component and
 * opens the overlay matching `view.selection`.
 */
export function OverlayHost(_props: OverlayHostProps) {
  const store = useStoreInstance();
  const selection = useAppState((s) => s.view.selection);
  const nodes = useAppState((s) => s.data.nodes);
  if (!selection) return null;
  let label: string;
  if (selection.kind === 'node') {
    label = `Session ${nodes[selection.id]?.name ?? selection.id}`;
  } else {
    const [a, b] = selection.threadId.split('|');
    const names = [a, b].map((id) => (id && nodes[id]?.name) ?? id ?? '?').join(' and ');
    label = selection.kind === 'edge' ? `Thread between ${names}` : `${selection.mediaKind} media between ${names}`;
  }
  return (
    <aside className="selection-chip" aria-live="polite">
      <span>{label}</span>
      <button type="button" className="button" onClick={() => store.dispatch({ type: 'select', selection: null })}>
        Close
      </button>
    </aside>
  );
}
