import { useMemo } from 'react';
import type { FeedClient } from '../net/feedClient';
import { uploadMedia } from '../net/media';
import { MediaBrowser } from '../overlays/MediaBrowser';
import { NodeChatOverlay } from '../overlays/NodeChatOverlay';
import type { OverlayActions } from '../overlays/sendFlow';
import { ThreadOverlay } from '../overlays/ThreadOverlay';
import { useAppState, useStoreInstance } from '../store/useStore';

/** Props for {@link OverlayHost}. */
export interface OverlayHostProps {
  /** The feed client, for overlays that send `owner_send` or `control` frames. */
  client: Pick<FeedClient, 'sendOwnerMessage' | 'sendControl'>;
  /** Overrides the actions built from `client`, for tests. */
  actions?: OverlayActions;
}

/** The {@link OverlayActions} of a feed client plus the real media upload. */
export function clientActions(client: OverlayHostProps['client']): OverlayActions {
  return {
    sendOwnerMessage: (payload) => client.sendOwnerMessage(payload),
    sendControl: (action) => client.sendControl(action),
    uploadMedia: (file, filename, caption) => uploadMedia(file, filename, caption),
  };
}

/**
 * Opens the overlay matching `view.selection`: node chat for a node, the
 * thread overlay for an edge, the media browser for an edge media icon.
 */
export function OverlayHost({ client, actions }: OverlayHostProps) {
  const store = useStoreInstance();
  const selection = useAppState((s) => s.view.selection);
  const resolved = useMemo(() => actions ?? clientActions(client), [actions, client]);
  if (!selection) return null;
  const close = () => store.dispatch({ type: 'select', selection: null });
  switch (selection.kind) {
    case 'node':
      return <NodeChatOverlay key={selection.id} sessionId={selection.id} actions={resolved} onClose={close} />;
    case 'edge':
      return <ThreadOverlay key={selection.threadId} threadId={selection.threadId} actions={resolved} onClose={close} />;
    case 'media':
      return (
        <MediaBrowser
          key={`${selection.threadId}/${selection.mediaKind}`}
          threadId={selection.threadId}
          kind={selection.mediaKind}
          onClose={close}
        />
      );
  }
}
