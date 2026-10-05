import { DEFAULT_LIMITS, MEDIA_CAPTION_FIELD, MEDIA_FILE_FIELD, MEDIA_PATH, type MediaRef } from '@orchvis/protocol';
import { describe, expect, it, vi } from 'vitest';
import { mediaUrl, uploadMedia } from '../src/net/media';
import { sendDraft, validateDraft, type Draft, type OverlayActions } from '../src/overlays/sendFlow';
import { T0 } from './fixtures';

function ref(id: string, patch: Partial<MediaRef> = {}): MediaRef {
  return {
    mediaId: id,
    mime: 'image/png',
    filename: 'a.png',
    bytes: 3,
    sha256: 'b'.repeat(64),
    caption: 'cap',
    expiresAt: T0 + 60_000,
    ...patch,
  };
}

/** A fetch mock that answers uploads with 201 + MediaRef, recording each multipart body. */
function uploadFetch(answers: Array<{ status: number; body: unknown }>) {
  const forms: FormData[] = [];
  const fn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(url).toBe(MEDIA_PATH);
    expect(init?.method).toBe('POST');
    expect(init?.credentials).toBe('same-origin');
    forms.push(init?.body as FormData);
    const a = answers.shift() ?? { status: 500, body: {} };
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'content-type': 'application/json' } });
  });
  return { fn: fn as unknown as typeof fetch, forms, mock: fn };
}

function actionsWith(fetchFn: typeof fetch, sendResult: string | null = 'f1') {
  const calls: string[] = [];
  const sendOwnerMessage = vi.fn((_p: Parameters<OverlayActions['sendOwnerMessage']>[0]) => {
    calls.push('send');
    return sendResult;
  });
  const actions: OverlayActions = {
    sendOwnerMessage,
    sendControl: vi.fn(() => 'c1'),
    uploadMedia: async (file, filename, caption) => {
      calls.push(`upload:${filename}`);
      return uploadMedia(file, filename, caption, fetchFn);
    },
  };
  return { actions, calls, sendOwnerMessage };
}

const file = (name: string, type = 'image/png') => new File([new Uint8Array([1, 2, 3])], name, { type });

describe('uploadMedia', () => {
  it('posts multipart file + caption and parses the 201 MediaRef', async () => {
    const f = uploadFetch([{ status: 201, body: ref('m1') }]);
    const result = await uploadMedia(file('a.png'), 'a.png', 'A chart', f.fn);
    expect(result).toEqual({ ok: true, ref: ref('m1') });
    const form = f.forms[0]!;
    expect(form.get(MEDIA_CAPTION_FIELD)).toBe('A chart');
    const part = form.get(MEDIA_FILE_FIELD) as File;
    expect(part.name).toBe('a.png');
  });

  it('reads HttpErrorSchema bodies and falls back to a status text', async () => {
    const f = uploadFetch([
      { status: 413, body: { error: 'too_large', detail: 'over 200 MB' } },
      { status: 415, body: { nonsense: true } },
    ]);
    expect(await uploadMedia(file('a.png'), 'a.png', 'c', f.fn)).toEqual({ ok: false, status: 413, error: 'too_large', detail: 'over 200 MB' });
    const second = await uploadMedia(file('a.png'), 'a.png', 'c', f.fn);
    expect(second).toMatchObject({ ok: false, status: 415, error: 'http_error' });
  });

  it('builds same-origin media GET URLs', () => {
    expect(mediaUrl('abc/def')).toBe(`${MEDIA_PATH}/abc%2Fdef`);
  });
});

describe('sendDraft: upload first, then owner_send with the IDs', () => {
  const base: Draft = { to: 'h:1', kind: 'chat', body: 'see attached', attachments: [] };

  it('requires a caption on every attachment and a body or an attachment', () => {
    expect(validateDraft({ ...base, body: '  ' }, DEFAULT_LIMITS)).toEqual(['Write a message or attach a file.']);
    const problems = validateDraft({ ...base, attachments: [{ key: 'k', file: file('a.png'), caption: ' ' }] }, DEFAULT_LIMITS);
    expect(problems).toEqual(['Add a caption for a.png.']);
    expect(validateDraft({ ...base, body: 'x'.repeat(DEFAULT_LIMITS.maxBodyBytes + 1) }, DEFAULT_LIMITS)).toHaveLength(1);
  });

  it('uploads each attachment in order, then sends one owner_send carrying their media IDs', async () => {
    const f = uploadFetch([
      { status: 201, body: ref('m1') },
      { status: 201, body: ref('m2', { mime: 'audio/ogg', filename: 'b.ogg' }) },
    ]);
    const { actions, calls, sendOwnerMessage } = actionsWith(f.fn);
    const outcome = await sendDraft(
      {
        ...base,
        attachments: [
          { key: '1', file: file('a.png'), caption: ' A chart ' },
          { key: '2', file: file('b.ogg', 'audio/ogg'), caption: 'A clip' },
        ],
      },
      DEFAULT_LIMITS,
      actions,
      T0,
    );
    expect(outcome).toEqual({ ok: true, frameId: 'f1', mediaIds: ['m1', 'm2'] });
    expect(calls).toEqual(['upload:a.png', 'upload:b.ogg', 'send']);
    expect(f.forms[0]!.get(MEDIA_CAPTION_FIELD)).toBe('A chart');
    expect(sendOwnerMessage).toHaveBeenCalledWith({ to: 'h:1', kind: 'chat', body: 'see attached', attachments: ['m1', 'm2'] });
  });

  it('does not send when an upload fails, and keeps refs so a retry does not upload twice', async () => {
    const f = uploadFetch([
      { status: 201, body: ref('m1') },
      { status: 429, body: { error: 'rate_limited' } },
      { status: 201, body: ref('m3') },
    ]);
    const { actions, calls, sendOwnerMessage } = actionsWith(f.fn);
    const draft: Draft = {
      ...base,
      attachments: [
        { key: '1', file: file('a.png'), caption: 'one' },
        { key: '2', file: file('b.png'), caption: 'two' },
      ],
    };
    const first = await sendDraft(draft, DEFAULT_LIMITS, actions, T0);
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.stage).toBe('upload');
    expect(sendOwnerMessage).not.toHaveBeenCalled();
    expect(first.attachments[0]?.ref?.mediaId).toBe('m1');
    expect(first.attachments[1]?.ref).toBeUndefined();

    const retry = await sendDraft({ ...draft, attachments: first.attachments }, DEFAULT_LIMITS, actions, T0);
    expect(retry).toEqual({ ok: true, frameId: 'f1', mediaIds: ['m1', 'm3'] });
    expect(calls).toEqual(['upload:a.png', 'upload:b.png', 'upload:b.png', 'send']);
  });

  it('re-uploads a kept ref that has expired', async () => {
    const f = uploadFetch([{ status: 201, body: ref('fresh') }]);
    const { actions } = actionsWith(f.fn);
    const outcome = await sendDraft(
      { ...base, attachments: [{ key: '1', file: file('a.png'), caption: 'c', ref: ref('stale', { expiresAt: T0 }) }] },
      DEFAULT_LIMITS,
      actions,
      T0,
    );
    expect(outcome).toMatchObject({ ok: true, mediaIds: ['fresh'] });
  });

  it('reports a send failure when the feed is offline', async () => {
    const f = uploadFetch([]);
    const { actions } = actionsWith(f.fn, null);
    const outcome = await sendDraft(base, DEFAULT_LIMITS, actions, T0);
    expect(outcome).toMatchObject({ ok: false, stage: 'send' });
  });
});
