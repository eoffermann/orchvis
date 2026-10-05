import { describe, expect, it } from 'vitest';
import { backoffDelay, explainRejection } from '../src/broker.js';
import { TOOL_NAMES, ToolError, callTool, listTools, withUnread, type ShimApi } from '../src/tools.js';

function api(overrides: Partial<ShimApi> = {}, unread = 0): ShimApi {
  const ok = async () => 'ok';
  return {
    unreadCount: () => unread,
    register: ok,
    listPeers: ok,
    sendMessage: ok,
    checkInbox: ok,
    getThread: ok,
    fetchMedia: ok,
    setStatus: ok,
    confirmChannel: ok,
    ...overrides,
  };
}

describe('tool listing', () => {
  it('lists exactly the plan tools with object input schemas', () => {
    expect(TOOL_NAMES).toEqual([
      'register',
      'list_peers',
      'send_message',
      'check_inbox',
      'get_thread',
      'fetch_media',
      'set_status',
      'confirm_channel',
    ]);
    for (const tool of listTools()) {
      expect(tool.inputSchema['type']).toBe('object');
      expect(tool.inputSchema).not.toHaveProperty('$schema');
    }
    const send = listTools().find((t) => t.name === 'send_message')!;
    expect(send.inputSchema['required']).toEqual(['to', 'body']);
  });
});

describe('callTool', () => {
  it('appends Unread: N only when N > 0', async () => {
    expect(withUnread('x', 0)).toBe('x');
    expect(withUnread('x', 2)).toBe('x\n\nUnread: 2');
    const r = await callTool(api({}, 3), 'check_inbox', {});
    expect(r.content[0]!.text).toBe('ok\n\nUnread: 3');
  });

  it('reports invalid arguments as an error result', async () => {
    const r = await callTool(api(), 'register', { name: 'bad name!', focus: 'f' });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/^invalid_arguments: name/);
  });

  it('rejects the reserved owner name', async () => {
    const r = await callTool(api(), 'register', { name: 'Owner', focus: 'f' });
    expect(r.isError).toBe(true);
  });

  it('maps ToolError codes and keeps the Unread suffix on errors', async () => {
    const r = await callTool(
      api({ sendMessage: async () => { throw new ToolError('broker_unreachable', 'at ws://x'); } }, 1),
      'send_message',
      { to: 'A', body: 'b' },
    );
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toBe('broker_unreachable: at ws://x\n\nUnread: 1');
  });

  it('rejects unknown tools', async () => {
    expect((await callTool(api(), 'nope', {})).isError).toBe(true);
  });
});

describe('broker helpers', () => {
  it('backs off exponentially from 1 s to 30 s with jitter in [half, full]', () => {
    expect(backoffDelay(0, 1000, 30_000, () => 0)).toBe(500);
    expect(backoffDelay(0, 1000, 30_000, () => 1)).toBe(1000);
    expect(backoffDelay(3, 1000, 30_000, () => 1)).toBe(8000);
    expect(backoffDelay(10, 1000, 30_000, () => 1)).toBe(30_000);
    expect(backoffDelay(50, 1000, 30_000, () => 0)).toBe(15_000);
  });

  it('explains rejections in plain words', () => {
    expect(explainRejection({ code: 'muted', detail: '' })).toMatch(/^muted: The Owner has muted this thread/);
    expect(explainRejection({ code: 'invalid', detail: 'why' })).toMatch(/\(why\)$/);
  });
});
