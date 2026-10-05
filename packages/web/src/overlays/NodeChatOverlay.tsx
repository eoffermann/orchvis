import { useAppState, useStoreInstance } from '../store/useStore';
import type { StoreMessage } from '../store/types';
import { Composer } from './Composer';
import { Dialog } from './Dialog';
import { MessageList } from './MessageList';
import { describeNode, formatTime, ownerThreadId, peerThreadsOf } from './model';
import type { OverlayActions } from './sendFlow';

const NO_MESSAGES: readonly StoreMessage[] = [];

/** Props for {@link NodeChatOverlay}. */
export interface NodeChatOverlayProps {
  sessionId: string;
  actions: OverlayActions;
  onClose: () => void;
}

/**
 * The node chat overlay: the session's details and a pause control, the
 * live Owner thread with it, a composer, and its peer threads by last
 * activity. Polling sessions get a banner, since they only see a message on
 * their next tool call.
 */
export function NodeChatOverlay({ sessionId, actions, onClose }: NodeChatOverlayProps) {
  const store = useStoreInstance();
  const node = useAppState((s) => s.data.nodes[sessionId]);
  const threadId = ownerThreadId(sessionId);
  const messages = useAppState((s) => s.data.messages[threadId] ?? NO_MESSAGES);
  const nodes = useAppState((s) => s.data.nodes);
  const edges = useAppState((s) => s.data.edges);
  const allMessages = useAppState((s) => s.data.messages);
  const expiredMedia = useAppState((s) => s.data.expiredMedia);
  const paused = useAppState((s) => s.data.control.pausedSessions.includes(sessionId));
  const pausedAll = useAppState((s) => s.data.control.pausedAll);
  const limits = useAppState((s) => s.data.limits);
  const now = useAppState((s) => s.now);
  const lastRejection = useAppState((s) => s.data.lastRejection);
  const online = useAppState((s) => s.connection === 'open' && s.synced);

  if (!node) return null;
  const { status, delivery } = describeNode(node);
  const peers = peerThreadsOf(sessionId, { nodes, edges, messages: allMessages });

  const pauseControl = (
    <button
      type="button"
      className={paused ? 'button button--warn' : 'button'}
      aria-pressed={paused}
      disabled={!online}
      onClick={() => actions.sendControl({ action: paused ? 'resume_session' : 'pause_session', sessionId })}
      title="Pause this session's peer sends. Owner messages still go through."
    >
      {paused ? "Resume this session's sends" : "Pause this session's sends"}
    </button>
  );

  return (
    <Dialog title={node.name} actions={pauseControl} onClose={onClose} className="overlay--chat" closeLabel={`Close chat with ${node.name}`}>
      <dl className="node-meta">
        <div>
          <dt>Host</dt>
          <dd>
            {node.hostname} ({node.platform})
          </dd>
        </div>
        <div>
          <dt>Repos</dt>
          <dd>{node.repos.length > 0 ? node.repos.map((r) => r.name).join(', ') : 'none'}</dd>
        </div>
        <div>
          <dt>Directory</dt>
          <dd className="mono">{node.cwd || 'unknown'}</dd>
        </div>
        <div>
          <dt>Focus</dt>
          <dd>{node.focus || 'not set'}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd className={`status status--${status}`}>{status}</dd>
        </div>
        <div>
          <dt>Delivery</dt>
          <dd>{delivery}</dd>
        </div>
        {(paused || pausedAll) && (
          <div>
            <dt>Controls</dt>
            <dd>{paused ? 'Sends paused for this session' : 'All peer traffic paused'}</dd>
          </div>
        )}
      </dl>
      <div className="chat-body">
        <section className="chat-main" aria-label={`Owner thread with ${node.name}`}>
          {node.delivery === 'poll' && (
            <p className="banner" role="note">
              This session polls its inbox: it will see your message on its next tool call.
              {node.status === 'idle' ? ' It is idle now, so it may not see it until it is prompted.' : ''}
            </p>
          )}
          {!node.connected && (
            <p className="banner banner--muted" role="note">
              This session is disconnected. Messages are queued until it reconnects.
            </p>
          )}
          <MessageList
            messages={messages}
            expiredMedia={expiredMedia}
            now={now}
            label={`Messages between you and ${node.name}`}
            emptyText="No messages with this session yet."
          />
          <Composer to={sessionId} toName={node.name} limits={limits} now={now} lastRejection={lastRejection} online={online} actions={actions} />
        </section>
        <nav className="chat-side" aria-label={`Peer threads of ${node.name}`}>
          <h3 className="side-title">Peer threads</h3>
          {peers.length === 0 ? (
            <p className="muted">No peer threads.</p>
          ) : (
            <ul className="side-list">
              {peers.map((p) => (
                <li key={p.threadId}>
                  <button
                    type="button"
                    className="side-item"
                    onClick={() => store.dispatch({ type: 'select', selection: { kind: 'edge', threadId: p.threadId } })}
                  >
                    <span className="side-item-name">{p.peerName}</span>
                    <span className="side-item-meta">
                      {p.total} msgs · {formatTime(p.lastMessageAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </nav>
      </div>
    </Dialog>
  );
}
