import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PLUGIN = fileURLToPath(new URL('..', import.meta.url));
const REPO = join(PLUGIN, '..');

function json(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'));
}

describe('plugin manifests', () => {
  it('plugin.json names the plugin orchvis with a version and description', () => {
    const p = json(join(PLUGIN, '.claude-plugin', 'plugin.json'));
    expect(p.name).toBe('orchvis');
    expect(p.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(typeof p.description).toBe('string');
  });

  it('.mcp.json runs bin/shim.cjs under the plugin root with node', () => {
    const m = json(join(PLUGIN, '.mcp.json'));
    expect(m.mcpServers.orchvis).toEqual({ command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/bin/shim.cjs'] });
  });

  it('hooks.json wires the inbox hook to UserPromptSubmit and PostToolUse, quoted', () => {
    const h = json(join(PLUGIN, 'hooks', 'hooks.json'));
    for (const event of ['UserPromptSubmit', 'PostToolUse']) {
      const commands = h.hooks[event].flatMap((g: any) => g.hooks.map((x: any) => x));
      expect(commands).toHaveLength(1);
      expect(commands[0].type).toBe('command');
      expect(commands[0].command).toBe('node "${CLAUDE_PLUGIN_ROOT}/bin/inbox-hook.cjs"');
    }
    expect(existsSync(join(PLUGIN, 'bin', 'inbox-hook.cjs'))).toBe(true);
  });

  it('marketplace.json at the repo root serves ./plugin as orchvis', () => {
    const m = json(join(REPO, '.claude-plugin', 'marketplace.json'));
    expect(m.name).toBe('orchvis');
    expect(typeof m.owner?.name).toBe('string');
    expect(m.plugins).toHaveLength(1);
    expect(m.plugins[0]).toMatchObject({ name: 'orchvis', source: './plugin' });
    // Version lives in plugin.json only; setting it in both is flagged by `claude plugin validate`.
    expect(m.plugins[0].version).toBeUndefined();
  });
});

const SKILLS = join(PLUGIN, 'skills');

/** Parses simple `key: value` YAML frontmatter. */
function frontmatter(text: string): Record<string, string> | undefined {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (!m) return undefined;
  const out: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]!] = kv[2]!;
  }
  return out;
}

describe('skills', () => {
  const names = readdirSync(SKILLS);

  it('ships the protocol, start and join skills', () => {
    expect(names.sort()).toEqual(['orchestration-visualizer', 'orchvis-join', 'orchvis-start']);
  });

  for (const name of names) {
    it(`${name}/SKILL.md has frontmatter with its name and a description, and fits the line budget`, () => {
      const text = readFileSync(join(SKILLS, name, 'SKILL.md'), 'utf8');
      const fm = frontmatter(text);
      expect(fm).toBeDefined();
      expect(fm!.name).toBe(name);
      expect(fm!.description!.length).toBeGreaterThan(40);
      expect(fm!.description!.length).toBeLessThanOrEqual(1024);
      const body = text.replace(/^---[\s\S]*?\n---\r?\n/, '');
      expect(body.split('\n').length).toBeLessThanOrEqual(150);
    });
  }

  it('the protocol skill triggers on channel tags, tool names and coordination requests', () => {
    const d = frontmatter(readFileSync(join(SKILLS, 'orchestration-visualizer', 'SKILL.md'), 'utf8'))!.description!;
    expect(d).toContain('<channel source="orchvis">');
    for (const tool of ['register', 'list_peers', 'send_message', 'check_inbox', 'get_thread', 'fetch_media', 'set_status', 'confirm_channel']) {
      expect(d).toContain(tool);
    }
    expect(d).toMatch(/coordinate/);
  });

  it('no skill tells the session to print a token', () => {
    for (const name of names) {
      const text = readFileSync(join(SKILLS, name, 'SKILL.md'), 'utf8');
      expect(text).not.toMatch(/cat\s+[^\n]*orchvis\.config\.json/);
    }
  });
});
