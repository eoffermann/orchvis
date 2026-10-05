import { addressKey, type MediaKind } from '@orchvis/protocol';
import { useMemo, useState } from 'react';
import { mediaUrl } from '../net/media';
import { useAppState } from '../store/useStore';
import type { StoreMessage } from '../store/types';
import { Dialog } from './Dialog';
import { kindLabel, MediaViewer, type ViewerItem } from './media';
import { formatCountdown, formatSize, formatTime, mediaItemsFor, nameForKey, threadKeys } from './model';

const NO_MESSAGES: readonly StoreMessage[] = [];

/** Props for {@link MediaBrowser}. */
export interface MediaBrowserProps {
  threadId: string;
  kind: MediaKind;
  onClose: () => void;
}

/**
 * The media browser: a grid of one thread's unexpired media of one kind,
 * each with caption, sender, time and an expiry countdown. Items open in a
 * lightbox with keyboard and swipe navigation, and vanish when they expire.
 */
export function MediaBrowser({ threadId, kind, onClose }: MediaBrowserProps) {
  const media = useAppState((s) => s.data.media);
  const nodes = useAppState((s) => s.data.nodes);
  const messages = useAppState((s) => s.data.messages[threadId] ?? NO_MESSAGES);
  const now = useAppState((s) => s.now);
  const [openId, setOpenId] = useState<string | null>(null);

  const items = useMemo(() => mediaItemsFor({ media }, threadId, kind, now), [media, threadId, kind, now]);
  const viewerItems: ViewerItem[] = useMemo(
    () => items.map((e) => ({ media: e.ref, fromName: nameForKey(addressKey(e.from), { nodes }, messages), ts: e.ts })),
    [items, nodes, messages],
  );
  const openIndex = openId === null ? -1 : items.findIndex((e) => e.ref.mediaId === openId);

  const keys = threadKeys(threadId) ?? [threadId, '?'];
  const [a, b] = keys.map((k) => nameForKey(k, { nodes }, messages)) as [string, string];
  const label = kindLabel(kind);

  return (
    <Dialog title={`${label} media: ${a} ⇄ ${b}`} onClose={onClose} className="overlay--media" closeLabel="Close media browser">
      {items.length === 0 ? (
        <p className="msg-empty">No unexpired {label.toLowerCase()} items on this thread.</p>
      ) : (
        <ul className="media-grid" aria-label={`${label} items`}>
          {items.map((e, i) => {
            const v = viewerItems[i] as ViewerItem;
            return (
              <li key={e.ref.mediaId} className="media-card">
                <button
                  type="button"
                  className="media-card-button"
                  aria-label={`Open ${label.toLowerCase()}: ${e.ref.caption}`}
                  onClick={() => setOpenId(e.ref.mediaId)}
                >
                  {kind === 'image' ? (
                    <img className="media-card-thumb" src={mediaUrl(e.ref.mediaId)} alt="" loading="lazy" />
                  ) : (
                    <span className="media-card-icon" aria-hidden="true">
                      {kind === 'audio' ? '♪' : kind === 'video' ? '▶' : '▤'}
                    </span>
                  )}
                </button>
                <div className="media-card-text">
                  <span className="media-card-caption">{e.ref.caption}</span>
                  <span className="media-card-meta">
                    {v.fromName} · {formatTime(e.ts)}
                  </span>
                  <span className="media-card-meta">
                    {e.ref.filename} · {formatSize(e.ref.bytes)}
                  </span>
                  <span className="media-card-expiry" aria-label={`Expires in ${formatCountdown(e.ref.expiresAt - now)}`}>
                    Expires in {formatCountdown(e.ref.expiresAt - now)}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {openIndex >= 0 && (
        <MediaViewer
          items={viewerItems}
          index={openIndex}
          onIndex={(i) => setOpenId(items[i]?.ref.mediaId ?? null)}
          onClose={() => setOpenId(null)}
        />
      )}
    </Dialog>
  );
}
