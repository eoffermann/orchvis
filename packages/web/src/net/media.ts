import {
  HttpErrorSchema,
  MEDIA_CAPTION_FIELD,
  MEDIA_FILE_FIELD,
  MEDIA_PATH,
  MediaUploadResponseSchema,
  type MediaRef,
} from '@orchvis/protocol';

/**
 * Same-origin URL of one media item, `GET ${MEDIA_PATH}/:id`. The Owner
 * cookie rides along automatically, so it works directly as an `<img>`,
 * `<audio>` or `<video>` source and as a download link. The broker answers
 * `404 not_found` once the item has expired.
 */
export function mediaUrl(mediaId: string): string {
  return `${MEDIA_PATH}/${encodeURIComponent(mediaId)}`;
}

/** Outcome of {@link uploadMedia}. */
export type UploadResult =
  | { ok: true; ref: MediaRef }
  | {
      ok: false;
      /** HTTP status, or 0 when the broker could not be reached. */
      status: number;
      /** Broker error code from the {@link HttpErrorSchema} body, or a client-side reason. */
      error: string;
      /** Plain-text detail for display. Render as a text node. */
      detail: string;
    };

const STATUS_TEXT: Readonly<Record<number, string>> = {
  400: 'The broker refused the upload as malformed.',
  401: 'The Owner session has expired. Sign in again.',
  413: 'The file or caption is over the size limit.',
  415: 'The file content does not match its declared type.',
  429: 'Too many uploads. Wait a moment and try again.',
};

/**
 * Uploads one file with its required caption as the Owner:
 * `POST MEDIA_PATH`, multipart with {@link MEDIA_FILE_FIELD} and
 * {@link MEDIA_CAPTION_FIELD}, authenticated by the same-origin Owner cookie.
 * Success is `201` with a {@link MediaRef}; its `mediaId` is single use and
 * rides in one `owner_send`.
 */
export async function uploadMedia(file: Blob, filename: string, caption: string, fetchFn: typeof fetch = fetch): Promise<UploadResult> {
  const form = new FormData();
  form.append(MEDIA_CAPTION_FIELD, caption);
  form.append(MEDIA_FILE_FIELD, file, filename);
  let res: Response;
  try {
    res = await fetchFn(MEDIA_PATH, { method: 'POST', credentials: 'same-origin', body: form });
  } catch {
    return { ok: false, status: 0, error: 'unreachable', detail: 'Cannot reach the broker.' };
  }
  let body: unknown = undefined;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  if (res.status === 201 || res.ok) {
    const parsed = MediaUploadResponseSchema.safeParse(body);
    if (parsed.success) return { ok: true, ref: parsed.data };
    return { ok: false, status: res.status, error: 'invalid_response', detail: 'The broker sent an unexpected upload response.' };
  }
  const err = HttpErrorSchema.safeParse(body);
  const fallback = STATUS_TEXT[res.status] ?? `Upload failed (HTTP ${res.status}).`;
  if (err.success) {
    return { ok: false, status: res.status, error: err.data.error, detail: err.data.detail ?? fallback };
  }
  return { ok: false, status: res.status, error: 'http_error', detail: fallback };
}
