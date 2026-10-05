import { useAppState } from '../store/useStore';
import type { StoreMessage } from '../store/types';
import { Dialog } from './Dialog';
import { MessageList } from './MessageList';
import { nameForKey, threadKeys } from './model';
import type { OverlayActions } from './sendFlow';

const NO_MESSAGES: readonly StoreMessage[] = [];

/** Props for {@link ThreadOverlay}. */
export interface ThreadOverlayProps {
  threadId: string;
  actions: OverlayActions;
  onClose: () => void;
}

/**
 * The read-only thread overlay: both directions of one thread, newest at the
 * bottom, with a mute control in the header.
 */
export function ThreadOverlay({ threadId, actions, onClose }: ThreadOverlayProps) {
  const messages = useAppState((s) => s.data.messages[threadId] ?? NO_MESSAGES);
  const nodes = useAppState((s) => s.data.nodes);
  const expiredMedia = useAppState((s) => s.data.expiredMedia);
  const muted = useAppState((s) => s.data.control.mutedThreads.includes(threadId));
  const now = useAppState((s) => s.now);
  const online = useAppState((s) => s.connection === 'open' && s.synced);

  const keys = threadKeys(threadId) ?? [threadId, '?'];
  const [a, b] = keys.map((k) => nameForKey(k, { nodes }, messages)) as [string, string];
  const title = `${a} ⇄ ${b}`;

  const muteControl = (
    <button
      type="button"
      className={muted ? 'button button--warn' : 'button'}
      aria-pressed={muted}
      disabled={!online}
      onClick={() => actions.sendControl({ action: muted ? 'unmute_thread' : 'mute_thread', threadId })}
    >
      {muted ? 'Unmute thread' : 'Mute thread'}
    </button>
  );

  return (
    <Dialog title={title} actions={muteControl} onClose={onClose} className="overlay--thread" closeLabel="Close thread">
      {muted && (
        <p className="banner banner--muted" role="note">
          This thread is muted: the broker rejects new peer messages on it.
        </p>
      )}
      <MessageList
        messages={messages}
        expiredMedia={expiredMedia}
        now={now}
        label={`Messages between ${a} and ${b}`}
        emptyText="No buffered messages on this thread."
      />
    </Dialog>
  );
}
