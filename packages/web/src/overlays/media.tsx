import { mediaKindOf, type MediaKind, type MediaRef } from '@orchvis/protocol';
import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { mediaUrl } from '../net/media';
import { Dialog } from './Dialog';
import { formatSize, formatTime } from './model';

const KIND_LABEL: Readonly<Record<MediaKind, string>> = { image: 'Image', audio: 'Audio', video: 'Video', other: 'File' };

/** Display label of a media kind. */
export function kindLabel(kind: MediaKind): string {
  return KIND_LABEL[kind];
}

/** What remains of an expired attachment: its kind and caption. */
export function Tombstone({ media }: { media: MediaRef }) {
  const kind = mediaKindOf(media.mime);
  return (
    <div className="tombstone" role="note">
      <span className="tombstone-kind">{kindLabel(kind)} expired</span>
      <span className="tombstone-caption">{media.caption}</span>
    </div>
  );
}

/** A download link for a non-previewable file. The filename is rendered as text. */
export function DownloadChip({ media }: { media: MediaRef }) {
  return (
    <a className="download-chip" href={mediaUrl(media.mediaId)} download={media.filename} title={media.caption}>
      <span className="download-chip-icon" aria-hidden="true">
        ↓
      </span>
      <span className="download-chip-name">{media.filename}</span>
      <span className="download-chip-size">{formatSize(media.bytes)}</span>
    </a>
  );
}

/** Props for {@link AttachmentView}. */
export interface AttachmentViewProps {
  media: MediaRef;
  /** Whether the store knows it has expired. */
  expired: boolean;
  /** Opens an image enlarged. */
  onEnlarge: (media: MediaRef) => void;
  /** Called when a preview has loaded and changed the list height. */
  onLoad?: () => void;
}

/**
 * One attachment inside a message: an image thumbnail that enlarges, a
 * native audio or video player, a download chip for anything else, or a
 * tombstone once expired. A load error (the broker answers 404 after
 * expiry) also turns it into a tombstone.
 */
export function AttachmentView({ media, expired, onEnlarge, onLoad }: AttachmentViewProps) {
  const [failed, setFailed] = useState(false);
  if (expired || failed) return <Tombstone media={media} />;
  const kind = mediaKindOf(media.mime);
  const src = mediaUrl(media.mediaId);
  const fail = () => setFailed(true);
  switch (kind) {
    case 'image':
      return (
        <figure className="attachment">
          <button type="button" className="thumb-button" aria-label={`Enlarge image: ${media.caption}`} onClick={() => onEnlarge(media)}>
            <img className="thumb" src={src} alt={media.caption} loading="lazy" onLoad={onLoad} onError={fail} />
          </button>
          <figcaption>{media.caption}</figcaption>
        </figure>
      );
    case 'audio':
      return (
        <figure className="attachment">
          <audio controls preload="metadata" src={src} aria-label={media.caption} onError={fail} />
          <figcaption>{media.caption}</figcaption>
        </figure>
      );
    case 'video':
      return (
        <figure className="attachment">
          <video className="attachment-video" controls preload="metadata" src={src} aria-label={media.caption} onLoadedMetadata={onLoad} onError={fail} />
          <figcaption>{media.caption}</figcaption>
        </figure>
      );
    default:
      return (
        <figure className="attachment">
          <DownloadChip media={media} />
          <figcaption>{media.caption}</figcaption>
        </figure>
      );
  }
}

/** One item a {@link MediaViewer} can show. */
export interface ViewerItem {
  media: MediaRef;
  /** Sender's display name. */
  fromName: string;
  /** Broker time of the message that carried it. */
  ts: number;
}

/** Props for {@link MediaViewer}. */
export interface MediaViewerProps {
  items: readonly ViewerItem[];
  /** Index of the item shown. */
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
}

/** Minimum horizontal travel, in CSS pixels, that counts as a swipe. */
export const SWIPE_MIN_PX = 48;

/**
 * Decides what a pointer gesture means: `next` for a leftward swipe, `prev`
 * for a rightward one, or null for a tap or a mostly vertical drag.
 */
export function swipeDirection(dx: number, dy: number, min: number = SWIPE_MIN_PX): 'next' | 'prev' | null {
  if (Math.abs(dx) < min || Math.abs(dx) <= Math.abs(dy)) return null;
  return dx < 0 ? 'next' : 'prev';
}

/**
 * The lightbox: one item large (an image, a native player, or a download
 * chip), with previous and next buttons, arrow keys and swipes between
 * items, and Esc to close.
 */
export function MediaViewer({ items, index, onIndex, onClose }: MediaViewerProps) {
  const start = useRef<{ x: number; y: number } | null>(null);
  const item = items[index];
  if (!item) return null;
  const count = items.length;
  const go = (delta: number) => {
    const next = index + delta;
    if (next >= 0 && next < count) onIndex(next);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Arrow keys on a focused player seek it; leave them alone.
    if (e.target instanceof Element && e.target.closest('audio, video')) return;
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      e.stopPropagation();
      go(1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      e.stopPropagation();
      go(-1);
    }
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    start.current = { x: e.clientX, y: e.clientY };
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const s = start.current;
    start.current = null;
    if (!s) return;
    const dir = swipeDirection(e.clientX - s.x, e.clientY - s.y);
    if (dir) go(dir === 'next' ? 1 : -1);
  };
  const { media } = item;
  const kind = mediaKindOf(media.mime);
  const src = mediaUrl(media.mediaId);
  return (
    <div className="viewer-keys" onKeyDown={onKeyDown}>
      <Dialog
        className="overlay--viewer"
        title={`${kindLabel(kind)} ${index + 1} of ${count}`}
        closeLabel="Close viewer"
        onClose={onClose}
      >
        <div
          className="viewer-stage"
          data-testid="viewer-stage"
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          onPointerCancel={() => (start.current = null)}
        >
          {kind === 'image' && <img key={media.mediaId} className="viewer-image" src={src} alt={media.caption} draggable={false} />}
          {kind === 'audio' && <audio key={media.mediaId} controls src={src} aria-label={media.caption} />}
          {kind === 'video' && <video key={media.mediaId} className="viewer-video" controls src={src} aria-label={media.caption} />}
          {kind === 'other' && <DownloadChip media={media} />}
        </div>
        <div className="viewer-footer">
          <button type="button" className="button" onClick={() => go(-1)} disabled={index === 0} aria-label="Previous item">
            ‹ Prev
          </button>
          <p className="viewer-caption">
            <span>{media.caption}</span>
            <span className="viewer-meta">
              {item.fromName} · {formatTime(item.ts)}
            </span>
          </p>
          <button type="button" className="button" onClick={() => go(1)} disabled={index >= count - 1} aria-label="Next item">
            Next ›
          </button>
        </div>
      </Dialog>
    </div>
  );
}
