import { MAX_ATTACHMENTS, type Limits, type MessageKind } from '@orchvis/protocol';
import { useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from 'react';
import type { Rejection } from '../store/types';
import { formatSize } from './model';
import { sendDraft, validateDraft, type DraftAttachment, type OverlayActions } from './sendFlow';

/** Props for {@link Composer}. */
export interface ComposerProps {
  /** Recipient session ID. */
  to: string;
  /** Recipient display name, for labels. */
  toName: string;
  limits: Limits;
  /** Broker-clock now, for reusing uploads that have not expired. */
  now: number;
  /** Last rejection from the broker, matched against the frame this composer sent. */
  lastRejection: Rejection | null;
  /** Whether the feed is connected and synced. */
  online: boolean;
  actions: OverlayActions;
}

const KINDS: readonly MessageKind[] = ['chat', 'request', 'notice', 'response'];

let attachmentCounter = 0;

/**
 * The Owner's message composer. Enter sends (Shift+Enter is a newline).
 * Attachments each need a caption; on send they upload to the media
 * endpoint first, then one `owner_send` carries their IDs.
 */
export function Composer({ to, toName, limits, now, lastRejection, online, actions }: ComposerProps) {
  const [body, setBody] = useState('');
  const [kind, setKind] = useState<MessageKind>('chat');
  const [attachments, setAttachments] = useState<DraftAttachment[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sentFrame, setSentFrame] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const bodyId = useId();
  const fileId = useId();

  // A rejection for the frame we sent is shown here.
  useEffect(() => {
    if (sentFrame && lastRejection && lastRejection.re === sentFrame) {
      setError(`The broker rejected the message (${lastRejection.code}). ${lastRejection.detail}`);
      setSentFrame(null);
    }
  }, [lastRejection, sentFrame]);

  const draft = { to, kind, body, attachments };
  const problems = validateDraft(draft, limits);
  const canSend = online && busy === null && problems.length === 0;

  const submit = async () => {
    if (busy !== null) return;
    if (!online) {
      setError('Not connected to the broker.');
      return;
    }
    if (problems.length > 0) {
      setError(problems.join(' '));
      return;
    }
    setError(null);
    setBusy(attachments.length > 0 ? 'Uploading' : 'Sending');
    const outcome = await sendDraft(draft, limits, actions, now, (done, total) => {
      if (total > 0) setBusy(done < total ? `Uploading ${done + 1} of ${total}` : 'Sending');
    });
    setBusy(null);
    if (outcome.ok) {
      setBody('');
      setAttachments([]);
      setSentFrame(outcome.frameId);
    } else {
      setAttachments(outcome.attachments);
      setError(outcome.detail);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void submit();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  const onFiles = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length === 0) return;
    setAttachments((prev) => {
      const room = Math.max(0, MAX_ATTACHMENTS - prev.length);
      if (files.length > room) setError(`At most ${MAX_ATTACHMENTS} attachments per message.`);
      return [...prev, ...files.slice(0, room).map((file) => ({ key: `att${++attachmentCounter}`, file, caption: '' }))];
    });
  };

  // An uploaded ref carries the caption it was uploaded with, so editing the
  // caption drops the ref and the file uploads again on the next send.
  const setCaption = (key: string, caption: string) =>
    setAttachments((prev) => prev.map((a) => (a.key === key ? withoutRef({ ...a, caption }) : a)));

  return (
    <form className="composer" onSubmit={onSubmit} aria-label={`Message ${toName}`}>
      {attachments.length > 0 && (
        <ul className="composer-attachments" aria-label="Attachments">
          {attachments.map((a) => (
            <li key={a.key} className="composer-attachment">
              <span className="composer-attachment-name">
                {a.file.name} <span className="muted">({formatSize(a.file.size)})</span>
              </span>
              <input
                className="text-input"
                type="text"
                placeholder="Caption (required): what it shows or says"
                aria-label={`Caption for ${a.file.name}`}
                aria-required="true"
                aria-invalid={a.caption.trim() === ''}
                value={a.caption}
                onChange={(e) => setCaption(a.key, e.target.value)}
              />
              <button
                type="button"
                className="button icon-button"
                aria-label={`Remove ${a.file.name}`}
                onClick={() => setAttachments((prev) => prev.filter((x) => x.key !== a.key))}
              >
                <span aria-hidden="true">×</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="composer-row">
        <label className="visually-hidden" htmlFor={bodyId}>
          Message to {toName}
        </label>
        <textarea
          id={bodyId}
          className="composer-input"
          rows={2}
          placeholder={`Message ${toName} (Enter to send, Shift+Enter for a new line)`}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
      <div className="composer-row composer-controls">
        <label className="visually-hidden" htmlFor={`${fileId}-kind`}>
          Message kind
        </label>
        <select id={`${fileId}-kind`} className="select" value={kind} onChange={(e) => setKind(e.target.value as MessageKind)}>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <input ref={fileRef} id={fileId} className="visually-hidden" type="file" multiple onChange={onFiles} tabIndex={-1} aria-hidden="true" />
        <button type="button" className="button" onClick={() => fileRef.current?.click()} disabled={attachments.length >= MAX_ATTACHMENTS}>
          Attach file
        </button>
        <span className="spacer" />
        {busy && (
          <span className="muted" role="status">
            {busy}
          </span>
        )}
        <button type="submit" className="button button--primary" disabled={!canSend}>
          Send
        </button>
      </div>
      {error && (
        <p className="composer-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

function withoutRef(a: DraftAttachment): DraftAttachment {
  const { ref: _ref, ...rest } = a;
  return rest;
}
