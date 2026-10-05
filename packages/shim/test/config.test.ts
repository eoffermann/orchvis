import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { brokerUrls, loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'orchvis-cfg-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const write = (data: unknown) => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'config.json'), typeof data === 'string' ? data : JSON.stringify(data));
  };

  it('reads brokerUrl and shimToken from the file', () => {
    write({ brokerUrl: 'http://broker.lan:7801', shimToken: 'file-token' });
    const c = loadConfig({ ORCHVIS_HOME: home });
    expect(c.problem).toBeUndefined();
    expect(c.shimToken).toBe('file-token');
    expect(c.wsUrl).toBe('ws://broker.lan:7801/ws/shim');
    expect(c.httpBase).toBe('http://broker.lan:7801');
  });

  it('lets environment variables override the file', () => {
    write({ brokerUrl: 'http://file:1', shimToken: 'file-token' });
    const c = loadConfig({ ORCHVIS_HOME: home, ORCHVIS_BROKER_URL: 'ws://env:2', ORCHVIS_TOKEN: 'env-token' });
    expect(c.wsUrl).toBe('ws://env:2/ws/shim');
    expect(c.shimToken).toBe('env-token');
  });

  it('works from the environment alone, even with a broken file', () => {
    write('{not json');
    const c = loadConfig({ ORCHVIS_HOME: home, ORCHVIS_BROKER_URL: 'env:2', ORCHVIS_TOKEN: 't' });
    expect(c.problem).toBeUndefined();
  });

  it('reports what is missing without throwing', () => {
    expect(loadConfig({ ORCHVIS_HOME: home }).problem).toMatch(/no broker URL/);
    expect(loadConfig({ ORCHVIS_HOME: home, ORCHVIS_BROKER_URL: 'h:1' }).problem).toMatch(/no shim token/);
    write('{not json');
    expect(loadConfig({ ORCHVIS_HOME: home }).problem).toMatch(/not a valid|could not read/);
  });
});

describe('brokerUrls', () => {
  it('derives ws and http URLs from any accepted form', () => {
    expect(brokerUrls('http://h:7801/')).toEqual({ wsUrl: 'ws://h:7801/ws/shim', httpBase: 'http://h:7801' });
    expect(brokerUrls('ws://h:7801/ws/shim')).toEqual({ wsUrl: 'ws://h:7801/ws/shim', httpBase: 'http://h:7801' });
    expect(brokerUrls('https://h')).toEqual({ wsUrl: 'wss://h/ws/shim', httpBase: 'https://h' });
    expect(brokerUrls('10.0.0.5:7801').wsUrl).toBe('ws://10.0.0.5:7801/ws/shim');
    expect(() => brokerUrls('ftp://h')).toThrow();
  });
});
