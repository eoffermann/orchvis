import type { MediaRef } from '@orchvis/protocol';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { FeedData, StoreMessage } from '../store/types';
import { AttachmentView, MediaViewer } from './media';
import { formatTime, isMediaExpired, isNearBottom } from './model';

/** Props for {@link MessageList}. */
export interface MessageListProps {
  /** Messages, oldest first. */
  messages: readonly StoreMessage[];
  /** For expiry checks. */
  expiredMedia: FeedData['expiredMedia'];
  /** Broker-clock now. */
  now: number;
  /** Accessible name of the list. */
  label: string;
  /** Shown when there are no messages. */
  emptyText: string;
}

/** Seen-state text for a message, or null when none applies (messages to the Owner). */
export function seenLabel(m: StoreMessage): string | null {
  if (m.to.kind === 'owner') return null;
  return m.seenAt === undefined ? 'Not seen yet' : `Seen ${formatTime(m.seenAt)}`;
}

/** One message. Every piece of peer-supplied text is a React text node. */
function MessageItem({
  m,
  expiredMedia,
  now,
  onEnlarge,
  onMediaLoad,
}: {
  m: StoreMessage;
  expiredMedia: FeedData['expiredMedia'];
  now: number;
  onEnlarge: (media: MediaRef) => void;
  onMediaLoad: () => void;
}) {
  const seen = seenLabel(m);
  const cls = ['msg', `msg--${m.senderKind}`];
  return (
    <li className={cls.join(' ')} data-message-id={m.id}>
      <div className="msg-meta">
        <span className="msg-from">{m.fromName}</span>
        <time className="msg-time" dateTime={new Date(m.ts).toISOString()}>
          {formatTime(m.ts)}
        </time>
        <span className={`msg-kind msg-kind--${m.kind}`}>{m.kind}</span>
        {seen && <span className={m.seenAt === undefined ? 'msg-seen msg-seen--no' : 'msg-seen'}>{seen}</span>}
      </div>
      {m.body !== '' && <pre className="msg-body">{m.body}</pre>}
      {m.attachments.length > 0 && (
        <div className="msg-attachments">
          {m.attachments.map((a) => (
            <AttachmentView
              key={a.mediaId}
              media={a}
              expired={isMediaExpired(a, { expiredMedia }, now)}
              onEnlarge={onEnlarge}
              onLoad={onMediaLoad}
            />
          ))}
        </div>
      )}
    </li>
  );
}

/**
 * A scrollable message list, newest at the bottom. It follows new messages
 * while the Owner is at the bottom; once they scroll up it stays put and
 * shows a jump-to-latest button instead.
 */
export function MessageList({ messages, expiredMedia, now, label, emptyText }: MessageListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const [following, setFollowing] = useState(true);
  const [unread, setUnread] = useState(0);
  const [enlarged, setEnlarged] = useState<{ media: MediaRef; fromName: string; ts: number } | null>(null);
  const lastId = messages.length > 0 ? (messages[messages.length - 1] as StoreMessage).id : null;
  const prevLastId = useRef<string | null>(null);

  const scrollToEnd = useCallback(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  useLayoutEffect(() => {
    const prev = prevLastId.current;
    prevLastId.current = lastId;
    if (lastId === null || lastId === prev) return;
    if (followingRef.current) scrollToEnd();
    else setUnread((n) => n + 1);
  }, [lastId, scrollToEnd]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const near = isNearBottom(el);
    followingRef.current = near;
    setFollowing(near);
    if (near) setUnread(0);
  };

  const jump = () => {
    followingRef.current = true;
    setFollowing(true);
    setUnread(0);
    scrollToEnd();
  };

  const onMediaLoad = useCallback(() => {
    if (followingRef.current) scrollToEnd();
  }, [scrollToEnd]);

  const onEnlarge = (media: MediaRef) => {
    const owner = messages.find((m) => m.attachments.some((a) => a.mediaId === media.mediaId));
    setEnlarged({ media, fromName: owner?.fromName ?? '', ts: owner?.ts ?? 0 });
  };

  return (
    <div className="msg-list-wrap">
      <div ref={listRef} className="msg-list" role="log" aria-label={label} aria-live="polite" tabIndex={0} onScroll={onScroll} data-testid="msg-list">
        {messages.length === 0 ? (
          <p className="msg-empty">{emptyText}</p>
        ) : (
          <ol className="msg-items">
            {messages.map((m) => (
              <MessageItem key={m.id} m={m} expiredMedia={expiredMedia} now={now} onEnlarge={onEnlarge} onMediaLoad={onMediaLoad} />
            ))}
          </ol>
        )}
      </div>
      {!following && (
        <button type="button" className="button jump-latest" onClick={jump}>
          {unread > 0 ? `Jump to latest (${unread} new)` : 'Jump to latest'}
        </button>
      )}
      {enlarged && !isMediaExpired(enlarged.media, { expiredMedia }, now) && <MediaViewer items={[enlarged]} index={0} onIndex={() => undefined} onClose={() => setEnlarged(null)} />}
    </div>
  );
}
