import {
  localRepoKey,
  makeSessionId,
  normalizeRepoKey,
  repoNameFromKey,
  sanitizeSessionName,
  type DeliveryMode,
  type Platform,
  type RepoRef,
  type SessionId,
} from '@orchvis/protocol';
import { Rng } from './random.js';

/** One simulated host machine. */
export interface SimHost {
  /** Hostname as `os.hostname()` would report it (mixed case is allowed). */
  hostname: string;
  platform: Platform;
  /** User name, used to build plausible working directories. */
  user: string;
}

/** One simulated repository. */
export interface SimRepo {
  /** The raw remote URL as `git remote -v` would print it. */
  remote: string;
  /** The normalized key, from `normalizeRepoKey(remote)`. */
  key: string;
  /** Label, from `repoNameFromKey(key)`. */
  name: string;
}

/** Everything needed to impersonate one Claude Code session. */
export interface SimSessionSpec {
  /** Position in the scenario, stable for the whole run. */
  index: number;
  hostname: string;
  platform: Platform;
  /** The `CLAUDE_CODE_SESSION_ID` this session pretends to have. */
  claudeSessionId: string;
  /** `makeSessionId(hostname, claudeSessionId)`. */
  sessionId: SessionId;
  /** Working directory, forward slashes. */
  cwd: string;
  /** Repos sent in `hello` (the cwd repo, or a `local:` key when it has no remote). */
  repos: RepoRef[];
  /** Extra repos the session declares in `register`. */
  extraRepos: RepoRef[];
  /** `<directory name>@<hostname>`, used until `register`. */
  defaultName: string;
  /** Name the session asks for in `register`. */
  name: string;
  /** One-line focus. */
  focus: string;
  /** How this session behaves: `push` marks messages seen at once, `poll` in batches. */
  persona: DeliveryMode;
}

/** A generated population of sessions. */
export interface Scenario {
  seed: number;
  hosts: SimHost[];
  repos: SimRepo[];
  sessions: SimSessionSpec[];
}

/** Options for {@link generateScenario}. */
export interface ScenarioOptions {
  /** Number of sessions. Default 30. */
  sessions?: number;
  /** Number of host machines, mixed win32 and darwin. Default 4. */
  hosts?: number;
  /** Number of repositories with remotes. Default 6. */
  repos?: number;
  /** PRNG seed. Default 1. */
  seed?: number;
  /** Fraction of sessions with the `poll` persona. Default 0.4. */
  pollFraction?: number;
}

const HOST_NAMES = [
  'MediaRoomWindows',
  'studio-mbp',
  'BUILDBOX-01',
  'eddies-mac-mini',
  'render-node-7',
  'lab-macbook-air',
  'DEVBOX-WIN11',
  'garage-imac',
];

const USERS = ['eoffe', 'eddie', 'build', 'dev'];

const ORGS = ['acme', 'b2c', 'frndo-labs', 'Platform-Team'];

const REPO_NAMES = [
  'orchestrator',
  'web-ui',
  'broker',
  'brain-train',
  'infra',
  'render-farm',
  'docs-site',
  'mobile-app',
  'data-pipeline',
  'design-system',
  'auth-service',
  'telemetry',
];

const ROLES = ['ORCH', 'UI', 'BROKER', 'SHIM', 'INFRA', 'DOCS', 'QA', 'DATA', 'RENDER', 'PLUGIN', 'REVIEW', 'PERF'];

const FOCI = [
  'graph layout tuning against the simulator',
  'broker routing and ring buffers',
  'media upload and ranged download',
  'MCP shim tools and inbox',
  'Playwright suite for the overlays',
  'runbook and firewall rule',
  'quantize pass for the 7B checkpoint',
  'CI matrix on Windows and macOS',
  'login screen and cookie handling',
  'edge fade and pulse animation',
  'eval harness for the reward model',
  'release notes and changelog',
];

const BRANCHES = ['main', 'main', 'develop', 'ws/broker', 'ws/web', 'feat/media', 'fix/reconnect'];

/** Builds a remote URL for `org/name` in one of the shapes seen in the wild. */
function remoteFor(rng: Rng, org: string, name: string, variant: number): string {
  switch (variant % 6) {
    case 0:
      return `git@github.com:${org}/${name}.git`;
    case 1:
      return `https://github.com/${org}/${name}`;
    case 2:
      return `ssh://git@gitlab.internal:2222/${org}/${name}.git`;
    case 3:
      return `https://ci-bot:${rng.hex(12)}@Bitbucket.org/${org}/${name}.git/`;
    case 4:
      return `https://GitHub.com/${org}/${name}.git`;
    default:
      return `git@git.lan:${org}/${name}`;
  }
}

/**
 * Generates a reproducible population of sessions across hosts and repos.
 * Guarantees, whenever the counts allow: both win32 and darwin hosts, at least
 * one session in two repos, and exactly one session in a directory with no
 * remote (a `local:` repo key).
 */
export function generateScenario(options: ScenarioOptions = {}): Scenario {
  const sessionCount = Math.max(1, options.sessions ?? 30);
  const hostCount = Math.max(1, Math.min(options.hosts ?? 4, HOST_NAMES.length * 4));
  const repoCount = Math.max(1, Math.min(options.repos ?? 6, REPO_NAMES.length * ORGS.length));
  const seed = options.seed ?? 1;
  const pollFraction = options.pollFraction ?? 0.4;
  const rng = new Rng(seed).fork('scenario');

  const hostNames = rng.shuffle(HOST_NAMES);
  const hosts: SimHost[] = [];
  for (let i = 0; i < hostCount; i++) {
    const base = hostNames[i % hostNames.length] as string;
    hosts.push({
      hostname: i < hostNames.length ? base : `${base}-${Math.floor(i / hostNames.length) + 1}`,
      platform: i % 2 === 0 ? 'win32' : 'darwin',
      user: rng.pick(USERS),
    });
  }

  const repos: SimRepo[] = [];
  const seenKeys = new Set<string>();
  for (let attempt = 0; repos.length < repoCount && attempt < repoCount * 20; attempt++) {
    const org = rng.pick(ORGS);
    const name = rng.pick(REPO_NAMES);
    const remote = remoteFor(rng, org, name, rng.int(0, 5));
    const key = normalizeRepoKey(remote);
    if (!key || seenKeys.has(key)) continue;
    seenKeys.add(key);
    repos.push({ remote, key, name: repoNameFromKey(key) });
  }

  const usedNames = new Set<string>();
  const sessions: SimSessionSpec[] = [];
  for (let index = 0; index < sessionCount; index++) {
    const host = hosts[index % hosts.length] as SimHost;
    const claudeSessionId = rng.uuid();
    const sessionId = makeSessionId(host.hostname, claudeSessionId);
    const isLocal = sessionCount > 1 && index === sessionCount - 1;
    const primary = repos[index % repos.length] as SimRepo;
    const dirName = isLocal ? `scratch-${rng.hex(4)}` : primary.name;
    const cwd =
      host.platform === 'win32'
        ? `${rng.pick(['C:/Users/' + host.user + '/src', 'H:/work', 'D:/repos'])}/${dirName}`
        : `/Users/${host.user}/${rng.pick(['code', 'src', 'Projects'])}/${dirName}`;
    const repoRefs: RepoRef[] = isLocal
      ? [{ key: localRepoKey(host.hostname, dirName), name: dirName }]
      : [{ key: primary.key, name: primary.name, branch: rng.pick(BRANCHES) }];
    const extraRepos: RepoRef[] = [];
    const wantsSecond = !isLocal && repos.length > 1 && (index === 0 || rng.chance(0.2));
    if (wantsSecond) {
      const others = repos.filter((r) => r.key !== primary.key);
      const second = rng.pick(others);
      extraRepos.push({ key: second.key, name: second.name });
    }
    let name = `${rng.pick(ROLES)}-${(index % 9) + 1}`;
    for (let n = 2; usedNames.has(name); n++) name = `${name.replace(/-\d+$/, '')}-${n}`;
    usedNames.add(name);
    sessions.push({
      index,
      hostname: host.hostname,
      platform: host.platform,
      claudeSessionId,
      sessionId,
      cwd,
      repos: repoRefs,
      extraRepos,
      defaultName: sanitizeSessionName(`${dirName}@${host.hostname}`),
      name,
      focus: rng.pick(FOCI),
      persona: rng.chance(pollFraction) ? 'poll' : 'push',
    });
  }

  return { seed, hosts, repos, sessions };
}

/** All repos a session ends up in: its `hello` repos plus those it adds in `register`. */
export function allRepos(spec: SimSessionSpec): RepoRef[] {
  const out = [...spec.repos];
  for (const r of spec.extraRepos) if (!out.some((o) => o.key === r.key)) out.push(r);
  return out;
}

/** Pool of focus lines, for status changes. */
export const SAMPLE_FOCI: readonly string[] = FOCI;
