import {
  MAX_ATTACHMENTS,
  utf8Bytes,
  type ControlAction,
  type Limits,
  type MediaRef,
  type MessageKind,
  type PayloadOf,
  type UiToBrokerFrame,
} from '@orchvis/protocol';
import type { UploadResult } from '../net/media';

/** What the overlays need from the outside world. Injected so tests can mock it. */
export interface OverlayActions {
  /** Sends `owner_send`. Returns the frame ID, or null when not connected. */
  sendOwnerMessage(payload: PayloadOf<UiToBrokerFrame, 'owner_send'>): string | null;
  /** Sends a `control` frame. Returns the frame ID, or null when not connected. */
  sendControl(action: ControlAction): string | null;
  /** Uploads one file with its caption as the Owner. */
  uploadMedia(file: Blob, filename: string, caption: string): Promise<UploadResult>;
}

/** One file attached to a draft. */
export interface DraftAttachment {
  /** Local key for React lists. */
  key: string;
  /** The file chosen by the Owner. */
  file: File;
  /** Required caption, stating what the media shows or says. */
  caption: string;
  /** Set once uploaded, so a retry after a failed send does not upload twice. */
  ref?: MediaRef;
}

/** A draft Owner message. */
export interface Draft {
  to: string;
  kind: MessageKind;
  body: string;
  attachments: readonly DraftAttachment[];
}

/**
 * Problems that stop a draft from being sent, as plain sentences. Empty when
 * the draft can go.
 */
export function validateDraft(draft: Draft, limits: Pick<Limits, 'maxBodyBytes' | 'maxCaptionBytes' | 'maxMediaBytes'>): string[] {
  const problems: string[] = [];
  if (draft.body.trim() === '' && draft.attachments.length === 0) problems.push('Write a message or attach a file.');
  if (utf8Bytes(draft.body) > limits.maxBodyBytes) problems.push(`The message is over ${limits.maxBodyBytes} bytes.`);
  if (draft.attachments.length > MAX_ATTACHMENTS) problems.push(`At most ${MAX_ATTACHMENTS} attachments per message.`);
  for (const a of draft.attachments) {
    if (a.caption.trim() === '') problems.push(`Add a caption for ${a.file.name}.`);
    else if (utf8Bytes(a.caption) > limits.maxCaptionBytes) problems.push(`The caption for ${a.file.name} is too long.`);
    if (!a.ref && a.file.size > limits.maxMediaBytes) problems.push(`${a.file.name} is over the file size limit.`);
  }
  return problems;
}

/** Result of {@link sendDraft}. */
export type SendOutcome =
  | { ok: true; frameId: string; mediaIds: string[] }
  | {
      ok: false;
      stage: 'validate' | 'upload' | 'send';
      /** Plain-text reason for display. */
      detail: string;
      /** The draft's attachments, with refs recorded for those already uploaded. */
      attachments: DraftAttachment[];
    };

/**
 * Sends a draft the way the plan prescribes: each attachment is uploaded to
 * the media endpoint first (in order, reusing any ref from an earlier attempt
 * that has not expired), then one `owner_send` carries the media IDs. Media
 * IDs are single use, so a ref is reused only for a retry of the same draft.
 */
export async function sendDraft(
  draft: Draft,
  limits: Pick<Limits, 'maxBodyBytes' | 'maxCaptionBytes' | 'maxMediaBytes'>,
  actions: OverlayActions,
  now: number,
  onProgress?: (done: number, total: number) => void,
): Promise<SendOutcome> {
  const attachments = draft.attachments.map((a) => ({ ...a }));
  const problems = validateDraft(draft, limits);
  if (problems.length > 0) return { ok: false, stage: 'validate', detail: problems.join(' '), attachments };
  for (let i = 0; i < attachments.length; i++) {
    const a = attachments[i] as DraftAttachment;
    onProgress?.(i, attachments.length);
    if (a.ref && a.ref.expiresAt > now) continue;
    delete a.ref;
    const result = await actions.uploadMedia(a.file, a.file.name, a.caption.trim());
    if (!result.ok) {
      return { ok: false, stage: 'upload', detail: `Upload of ${a.file.name} failed: ${result.detail}`, attachments };
    }
    a.ref = result.ref;
  }
  onProgress?.(attachments.length, attachments.length);
  const mediaIds = attachments.map((a) => (a.ref as MediaRef).mediaId);
  const frameId = actions.sendOwnerMessage({ to: draft.to, kind: draft.kind, body: draft.body, attachments: mediaIds });
  if (frameId === null) {
    return { ok: false, stage: 'send', detail: 'Not connected to the broker. The message was not sent.', attachments };
  }
  return { ok: true, frameId, mediaIds };
}
