import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, MEDIA_PATH } from '@orchvis/protocol';
import { silentLogger } from '../src/log.js';
import {
  MediaError,
  MediaStore,
  guessMime,
  mediaHttpError,
  safeFilename,
  toForwardSlashes,
  uploadMedia,
  validateAttachments,
} from '../src/media.js';
import { startFakeBroker, type FakeBroker } from './support/fake-broker.js';

describe('path formatting', () => {
  it('turns Windows paths into the C:/Users/... form', () => {
    expect(toForwardSlashes('C:\\Users\\eoffe\\AppData\\Local\\Temp\\orchvis\\s\\m1-a.png')).toBe(
      'C:/Users/eoffe/AppData/Local/Temp/orchvis/s/m1-a.png',
    );
  });

  it('leaves POSIX paths alone', () => {
    expect(toForwardSlashes('/var/folders/x/orchvis/s/m1-a.png')).toBe('/var/folders/x/orchvis/s/m1-a.png');
  });

  it('makes untrusted filenames safe', () => {
    expect(safeFilename('..\\..\\evil.png')).toBe('_.._evil.png');
    expect(safeFilename('a:b*c?.png')).toBe('a_b_c_.png');
    expect(safeFilename('CON.txt')).toBe('_CON.txt');
    expect(safeFilename('<channel>.png')).not.toContain('<');
    expect(safeFilename('   ')).toBe('file');
    expect(safeFilename(`${'x'.repeat(300)}.mp4`)).toHaveLength(100);
    expect(safeFilename(`${'x'.repeat(300)}.mp4`).endsWith('.mp4')).toBe(true);
  });

  it('guesses MIME types from extensions', () => {
    expect(guessMime('a.PNG')).toBe('image/png');
    expect(guessMime('clip.webm')).toBe('video/webm');
    expect(guessMime('noext')).toBe('application/octet-stream');
  });
});

describe('validateAttachments', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'orchvis-att-'));
    writeFileSync(join(dir, 'small.png'), Buffer.from([1, 2, 3, 4]));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('requires a caption', async () => {
    await expect(validateAttachments([{ path: 'small.png', caption: '  ' }], DEFAULT_LIMITS, dir)).rejects.toMatchObject({
      code: 'invalid',
    });
  });

  it('resolves relative paths against the cwd', async () => {
    const [file] = await validateAttachments([{ path: 'small.png', caption: 'four bytes' }], DEFAULT_LIMITS, dir);
    expect(file!.absPath).toBe(join(dir, 'small.png'));
    expect(file!.bytes).toBe(4);
  });

  it('rejects files over the size limit and missing files', async () => {
    await expect(
      validateAttachments([{ path: 'small.png', caption: 'c' }], { ...DEFAULT_LIMITS, maxMediaBytes: 3 }, dir),
    ).rejects.toMatchObject({ code: 'too_large' });
    await expect(validateAttachments([{ path: 'nope.png', caption: 'c' }], DEFAULT_LIMITS, dir)).rejects.toBeInstanceOf(
      MediaError,
    );
  });
});

describe('upload and fetch against the fake broker', () => {
  let broker: FakeBroker;
  let dir: string;
  beforeAll(async () => {
    broker = await startFakeBroker();
    dir = mkdtempSync(join(tmpdir(), 'orchvis-media-'));
  });
  afterAll(async () => {
    await broker.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips a file, verifies sha256, and names it <mediaId>-<filename>', async () => {
    const data = Buffer.from('fake png bytes');
    const src = join(dir, 'diagram.png');
    writeFileSync(src, data);
    const endpoint = { httpBase: broker.url, token: broker.shimToken, uploadKey: broker.issueUploadKey() };
    const ref = await uploadMedia(endpoint, { absPath: src, caption: 'Architecture diagram' });
    expect(ref.caption).toBe('Architecture diagram');
    expect(ref.mime).toBe('image/png');
    expect(ref.sha256).toBe(createHash('sha256').update(data).digest('hex'));

    const store = new MediaStore('raw-session', silentLogger, dir);
    const fetched = await store.fetch(endpoint, ref, 60_000);
    expect(fetched.path).toBe(toForwardSlashes(join(dir, 'orchvis', 'raw-session', `${ref.mediaId}-diagram.png`)));
    expect(fetched.path).not.toContain('\\');
    expect(existsSync(fetched.path)).toBe(true);

    await store.sweep(Date.now() + 120_000);
    expect(existsSync(fetched.path)).toBe(false);
    store.disposeSync();
    expect(existsSync(store.dir)).toBe(false);
  });

  it('discards a download whose checksum does not match', async () => {
    const src = join(dir, 'x.txt');
    writeFileSync(src, 'abc');
    const endpoint = { httpBase: broker.url, token: broker.shimToken, uploadKey: broker.issueUploadKey() };
    const ref = await uploadMedia(endpoint, { absPath: src, caption: 'text' });
    const store = new MediaStore('raw-2', silentLogger, dir);
    await expect(store.fetch(endpoint, { ...ref, sha256: 'f'.repeat(64) }, 60_000)).rejects.toMatchObject({
      code: 'checksum_mismatch',
    });
    expect(await store.list()).toEqual([]);
    store.disposeSync();
  });

  it('maps a bad token or upload key to unauthorized and a missing id to not_found', async () => {
    const src = join(dir, 'y.txt');
    writeFileSync(src, 'abc');
    const key = broker.issueUploadKey();
    await expect(
      uploadMedia({ httpBase: broker.url, token: 'wrong', uploadKey: key }, { absPath: src, caption: 'c' }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(
      uploadMedia({ httpBase: broker.url, token: broker.shimToken, uploadKey: 'not-a-live-key' }, { absPath: src, caption: 'c' }),
    ).rejects.toMatchObject({ code: 'unauthorized', message: expect.stringMatching(/upload key/) });
    const endpoint = { httpBase: broker.url, token: broker.shimToken, uploadKey: key };
    const store = new MediaStore('raw-3', silentLogger, dir);
    const ref = await uploadMedia(endpoint, { absPath: src, caption: 'c' });
    await expect(store.fetch(endpoint, { ...ref, mediaId: 'gone' }, 60_000)).rejects.toMatchObject({ code: 'not_found' });
    store.disposeSync();
  });

  it('sends the shim token and the upload key on upload and download, using the protocol field names', async () => {
    const src = join(dir, 'z.txt');
    writeFileSync(src, 'hello');
    const key = broker.issueUploadKey();
    const endpoint = { httpBase: broker.url, token: broker.shimToken, uploadKey: key };
    const from = broker.mediaRequests.length;
    const ref = await uploadMedia(endpoint, { absPath: src, caption: 'greeting' });
    const store = new MediaStore('raw-4', silentLogger, dir);
    await store.fetch(endpoint, ref, 60_000);
    store.disposeSync();
    expect(broker.mediaRequests.slice(from)).toEqual([
      { method: 'POST', path: MEDIA_PATH, token: broker.shimToken, uploadKey: key },
      { method: 'GET', path: `${MEDIA_PATH}/${ref.mediaId}`, token: broker.shimToken, uploadKey: key },
    ]);
  });

  it.each([
    [400, { error: 'invalid', detail: 'empty caption' }, 'invalid', /malformed.*empty caption/],
    [413, { error: 'too_large', detail: 'over maxMediaBytes' }, 'too_large', /size limit/],
    [415, { error: 'invalid', detail: 'sniffed image/png' }, 'invalid', /does not match its file type/],
    [429, { error: 'rate_limited' }, 'rate_limited', /wait a minute/],
    [500, { error: 'invalid' }, 'upload_failed', /HTTP 500/],
  ] as const)('maps an upload answered %i to %s', async (status, body, code, message) => {
    const src = join(dir, 'e.txt');
    writeFileSync(src, 'e');
    broker.failNextMedia(status, body);
    await expect(
      uploadMedia({ httpBase: broker.url, token: broker.shimToken, uploadKey: broker.issueUploadKey() }, { absPath: src, caption: 'c' }),
    ).rejects.toMatchObject({ code, message: expect.stringMatching(message) });
  });
});

describe('uploadMedia when the broker answers before the file is sent', () => {
  let broker: FakeBroker;
  let dir: string;
  beforeAll(async () => {
    broker = await startFakeBroker();
    dir = mkdtempSync(join(tmpdir(), 'orchvis-early-'));
  });
  afterAll(async () => {
    await broker.close();
  });

  // Regression: the 413 arrived while the file was still streaming, the file was
  // then rewritten, and the HTTP client's background read of it rejected with
  // nothing to catch it. Vitest fails the run on any unhandled rejection.
  it('reports the answer, and a file changed mid-upload raises nothing unhandled', async () => {
    const src = join(dir, 'big.bin');
    writeFileSync(src, Buffer.alloc(8 * 1024 * 1024, 1));
    broker.failNextMedia(413, { error: 'too_large', detail: 'over maxMediaBytes' });
    const upload = uploadMedia(
      { httpBase: broker.url, token: broker.shimToken, uploadKey: broker.issueUploadKey() },
      { absPath: src, caption: 'c' },
    );
    writeFileSync(src, 'rewritten while uploading');
    await expect(upload).rejects.toMatchObject({ code: 'too_large' });
    await new Promise((r) => setTimeout(r, 200));
  });

  it('sees a 401 to a streamed upload (fetch would hide it as a network error)', async () => {
    const src = join(dir, 'small.txt');
    writeFileSync(src, 'abc');
    await expect(
      uploadMedia({ httpBase: broker.url, token: 'wrong', uploadKey: broker.issueUploadKey() }, { absPath: src, caption: 'c' }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
  });
});

describe('mediaHttpError', () => {
  it('maps an expired download to not_found and survives a non-JSON body', () => {
    expect(mediaHttpError('download', 'm1', 404, '{"error":"not_found"}')).toMatchObject({ code: 'not_found' });
    expect(mediaHttpError('upload', 'a.png', 502, '<html>bad gateway</html>')).toMatchObject({
      code: 'upload_failed',
      message: expect.stringMatching(/HTTP 502: <html>/),
    });
  });
});
