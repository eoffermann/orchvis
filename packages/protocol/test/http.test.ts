import { describe, expect, it } from 'vitest';
import { LoginRequestSchema, OWNER_COOKIE, WS_CLOSE } from '../src/index.js';

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
});
