import { describe, expect, it } from 'vitest';
import { HttpErrorSchema, LoginRequestSchema, MediaUploadResponseSchema, OWNER_COOKIE, WS_CLOSE } from '../src/index.js';

describe('http constants', () => {
  it('uses close codes in the private 4000-4999 range, all distinct', () => {
    const codes = Object.values(WS_CLOSE);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) expect(code >= 4000 && code <= 4999).toBe(true);
  });

  it('uses a cookie name valid in a Set-Cookie header', () => {
    expect(OWNER_COOKIE).toMatch(/^[A-Za-z0-9_]+$/);
  });

  it('validates the login body', () => {
    expect(LoginRequestSchema.safeParse({ token: 'abc' }).success).toBe(true);
    expect(LoginRequestSchema.safeParse({ token: '' }).success).toBe(false);
    expect(LoginRequestSchema.safeParse({}).success).toBe(false);
  });

  it('validates HTTP error bodies', () => {
    expect(HttpErrorSchema.safeParse({ error: 'too_large' }).success).toBe(true);
    expect(HttpErrorSchema.safeParse({ error: 'not_found', detail: 'expired' }).success).toBe(true);
    expect(HttpErrorSchema.safeParse({ error: 'teapot' }).success).toBe(false);
  });

  it('answers an upload with a full MediaRef', () => {
    const ref = { mediaId: 'm1', mime: 'image/png', filename: 'a.png', bytes: 3, sha256: 'b'.repeat(64), caption: 'a dot', expiresAt: 1 };
    expect(MediaUploadResponseSchema.parse(ref)).toEqual(ref);
    expect(MediaUploadResponseSchema.safeParse({ ...ref, caption: '' }).success).toBe(false);
  });
});
