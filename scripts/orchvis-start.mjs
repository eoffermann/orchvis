// Starts the orchvis broker on this machine and opens the web app.
//
// Used by the double-clickable launchers (start-orchvis.cmd/.ps1/.command/.sh)
// and by the orchvis-start skill. Steps: check Node and pnpm, install
// dependencies if needed, build the web app if stale, start the broker, wait
// for /healthz, write this machine's shim config if it has none, open the
// browser.
//
//   node scripts/orchvis-start.mjs [options]
//     --background     start the broker detached, log to ~/.orchvis/broker.log, and return
//     --no-open        do not open the browser
//     --no-build       skip the web build check
//     --port N         broker port (sets ORCHVIS_PORT for the broker)
//     --config PATH    broker config file (passed to the broker as --config)
//     --status         report whether a broker answers, then exit
//     --stop           stop a broker started with --background, then exit
//     --help
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, hostname, networkInterfaces } from 'node:os';
import { join, resolve } from 'node:path';
import { main as buildWeb } from './build-web.mjs';
import { DEFAULT_PORT, REPO_ROOT, checkNodeVersion, fail, isMain, log, orchvisHome, pnpmVersion, runPnpm } from './lib/project.mjs';
import { hasShimConfig, healthz, readShimConfig, shimConfigPath, writeShimConfig } from './lib/shim-config.mjs';

const HEALTH_TIMEOUT_MS = 60_000;

/** Parses command-line options. */
export function parseArgs(argv) {
  const opts = { background: false, open: true, build: true, port: undefined, config: undefined, status: false, stop: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--background') opts.background = true;
    else if (a === '--no-open') opts.open = false;
    else if (a === '--no-build') opts.build = false;
    else if (a === '--status') opts.status = true;
    else if (a === '--stop') opts.stop = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--port' || a === '--config') {
      const v = argv[++i];
      if (!v) throw new Error(`${a} needs a value`);
      if (a === '--port') {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`--port must be 1-65535, got "${v}"`);
        opts.port = n;
      } else opts.config = resolve(v);
    } else throw new Error(`unknown option ${a} (try --help)`);
  }
  return opts;
}

/** The broker config path, by the broker's own rule: --config, ORCHVIS_CONFIG, ~/.orchvis/orchvis.config.json. */
export function brokerConfigPath(opts, env = process.env) {
  return opts.config ?? (env.ORCHVIS_CONFIG ? resolve(env.ORCHVIS_CONFIG) : join(homedir(), '.orchvis', 'orchvis.config.json'));
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Port and loopback-reachable host for the broker, by the broker's precedence: env over file over default. */
export function brokerAddress(opts, env = process.env) {
  const file = readJson(brokerConfigPath(opts, env)) ?? {};
  const port = opts.port ?? (env.ORCHVIS_PORT ? Number(env.ORCHVIS_PORT) : undefined) ?? file.port ?? DEFAULT_PORT;
  const bind = env.ORCHVIS_BIND || file.bind || '0.0.0.0';
  const host = bind === '0.0.0.0' || bind === '::' ? '127.0.0.1' : bind;
  return { port, bind, host, base: `http://${host.includes(':') ? `[${host}]` : host}:${port}` };
}

/** Paths of the background-mode log and pid files. */
export function runFiles(env = process.env) {
  const home = orchvisHome(env);
  return { home, logFile: join(home, 'broker.log'), pidFile: join(home, 'broker.pid') };
}

/** A LAN IPv4 address of this machine, if any. */
function lanAddress() {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return undefined;
}

/**
 * How to run the broker: its package's `start` script is `tsx src/cli.ts`, so
 * run tsx's CLI with this Node directly (no pnpm or shell in between, so the
 * PID and signals belong to the broker). Falls back to `pnpm start` if the
 * script changes shape.
 */
export function brokerCommand(extraArgs) {
  const brokerDir = join(REPO_ROOT, 'packages', 'broker');
  const pkgPath = join(brokerDir, 'package.json');
  const start = readJson(pkgPath)?.scripts?.start ?? '';
  const m = /^tsx\s+(\S+)$/.exec(start.trim());
  if (m) {
    try {
      const tsxCli = createRequire(pkgPath).resolve('tsx/cli');
      return { command: process.execPath, args: [tsxCli, m[1], ...extraArgs], cwd: brokerDir, shell: false };
    } catch {
      // fall through to pnpm
    }
  }
  return { command: 'pnpm', args: ['--filter', '@orchvis/broker', 'start', ...extraArgs], cwd: REPO_ROOT, shell: process.platform === 'win32' };
}

/** Stamp this launcher writes after a successful install: the lockfile's hash. */
function installStampPath(root) {
  return join(root, 'node_modules', '.orchvis-install-stamp');
}

function lockHash(root) {
  const lock = join(root, 'pnpm-lock.yaml');
  return existsSync(lock) ? createHash('sha256').update(readFileSync(lock)).digest('hex') : 'no-lockfile';
}

/**
 * Whether `pnpm install` is needed: no install yet, or the lockfile changed
 * since the last install this launcher ran (an install by hand runs once more,
 * which is quick when nothing changed).
 */
export function needsInstall(root = REPO_ROOT) {
  if (!existsSync(join(root, 'packages', 'broker', 'node_modules'))) return true;
  try {
    return readFileSync(installStampPath(root), 'utf8').trim() !== lockHash(root);
  } catch {
    return true;
  }
}

/** Records that dependencies match the current lockfile. */
export function markInstalled(root = REPO_ROOT) {
  try {
    writeFileSync(installStampPath(root), `${lockHash(root)}\n`);
  } catch {
    // Only costs a redundant install next time.
  }
}

/** Last lines of the broker log, with any token values hidden. */
export function logTail(file, lines = 15) {
  try {
    return readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .slice(-lines - 1)
      .map((l) => (/token/i.test(l) ? l.replace(/(token[^:]*:\s*)\S+/gi, '$1[hidden]') : l))
      .join('\n');
  } catch {
    return '(no log)';
  }
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd.exe', ['/d', '/s', '/c', `start "" "${url}"`], { windowsVerbatimArguments: true, detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else {
      spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
    log(`opened ${url} in your browser.`);
  } catch {
    log(`open ${url} in your browser.`);
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

async function stopBroker(opts) {
  const { pidFile } = runFiles();
  const { base } = brokerAddress(opts);
  const pid = Number(existsSync(pidFile) ? readFileSync(pidFile, 'utf8').trim() : NaN);
  if (!Number.isInteger(pid) || !isAlive(pid)) {
    rmSync(pidFile, { force: true });
    if (await healthz(base)) fail(`a broker answers at ${base}, but it was not started with --background here. Stop it in its own window (Ctrl+C).`);
    else log('no broker is running.');
    return;
  }
  log(`stopping broker (pid ${pid})...`);
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else process.kill(pid, 'SIGTERM');
  for (let i = 0; i < 20 && isAlive(pid); i++) await new Promise((r) => setTimeout(r, 250));
  rmSync(pidFile, { force: true });
  log(isAlive(pid) ? `broker (pid ${pid}) did not exit; stop it manually.` : 'broker stopped.');
}

/** Writes this machine's shim config from the broker config when it has none. Never prints the token. */
function ensureLocalShimConfig(opts, host, port) {
  const file = shimConfigPath();
  const brokerUrl = `ws://${host.includes(':') ? `[${host}]` : host}:${port}`;
  if (hasShimConfig(file)) {
    const current = readShimConfig(file).brokerUrl;
    log(`sessions on this machine use ${file} (broker ${current}).`);
    if (current !== brokerUrl) log(`  note: that is not ${brokerUrl}; run scripts/setup to change it if this broker is the one you want.`);
    return;
  }
  const shimToken = process.env.ORCHVIS_SHIM_TOKEN || readJson(brokerConfigPath(opts))?.shimToken;
  if (!shimToken) {
    log(`no shim token found in the broker config; run scripts/setup to write ${file}.`);
    return;
  }
  writeShimConfig(file, { brokerUrl, shimToken });
  log(`wrote ${file} (broker ${brokerUrl} and the shim token), so sessions on this machine can connect.`);
}

function printSummary(opts, address, firstRun) {
  const configPath = brokerConfigPath(opts);
  const lan = lanAddress();
  const lines = [
    '',
    'orchvis is running.',
    `  Web app on this machine:  http://localhost:${address.port}/`,
    `  For other machines:       http://${hostname()}:${address.port}/${lan ? `  (or http://${lan}:${address.port}/)` : ''}`,
    `  Tokens are stored in:     ${configPath}`,
    '    ownerToken: paste it into the web app login.',
    "    shimToken:  other machines enter it in scripts/setup (this machine's sessions are already set up).",
  ];
  if (firstRun) {
    lines.push(
      opts.background
        ? `  First run: the broker also printed both tokens once to ${runFiles().logFile}.`
        : '  First run: the broker printed both tokens above. Copy them now; they are not shown again.',
    );
  }
  if (process.platform === 'win32') {
    lines.push(`  Other machines need an inbound Windows Firewall rule for TCP port ${address.port}.`);
  }
  lines.push(
    '  Start Claude Code sessions with scripts/orchvis-claude (add --resume to rejoin a conversation).',
    opts.background ? '  Stop the broker with: node scripts/orchvis-start.mjs --stop' : '  Press Ctrl+C in this window to stop the broker.',
    '',
  );
  process.stdout.write(`${lines.join('\n')}\n`);
}

/** Runs the launcher; resolves to a process exit code. */
export async function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
    checkNodeVersion();
  } catch (err) {
    fail(err.message);
    return 1;
  }
  if (opts.help) {
    process.stdout.write(`${readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n')}\n`);
    return 0;
  }
  if (opts.stop) {
    await stopBroker(opts);
    return process.exitCode ?? 0;
  }
  const address = brokerAddress(opts);
  if (opts.status) {
    const h = await healthz(address.base);
    log(h ? `broker is up at ${address.base}: ${JSON.stringify(h)}` : `no broker answers at ${address.base}.`);
    return h ? 0 : 1;
  }

  log(`orchvis checkout: ${REPO_ROOT}`);
  log(`Node ${process.versions.node}; checking pnpm...`);
  const pnpm = pnpmVersion();
  if (!pnpm) {
    fail('pnpm was not found. Enable it with `corepack enable` (ships with Node; may need an administrator or sudo shell), or run `npm install -g pnpm`, then try again.');
    return 1;
  }
  log(`pnpm ${pnpm}.`);

  if (needsInstall()) {
    log('installing dependencies with pnpm install (first run: about a minute)...');
    const t0 = Date.now();
    const r = runPnpm(['install']);
    if (r.status !== 0) {
      fail('pnpm install failed; see the output above.');
      return 1;
    }
    markInstalled();
    log(`dependencies installed in ${((Date.now() - t0) / 1000).toFixed(1)} s.`);
  } else {
    log('dependencies are installed.');
  }

  if (opts.build && buildWeb(['--if-stale']) !== 0) return 1;

  log(`checking for a broker already running at ${address.base}...`);
  if (await healthz(address.base)) {
    log(`a broker is already running at ${address.base}.`);
    ensureLocalShimConfig(opts, address.host, address.port);
    printSummary(opts, address, false);
    if (opts.open) openBrowser(`http://localhost:${address.port}/`);
    return 0;
  }

  const configPath = brokerConfigPath(opts);
  const firstRun = !existsSync(configPath);
  const env = { ...process.env };
  if (opts.port) env.ORCHVIS_PORT = String(opts.port);
  const cmd = brokerCommand(opts.config ? ['--config', opts.config] : []);
  const { home, logFile, pidFile } = runFiles();

  let child;
  let exited;
  if (opts.background) {
    mkdirSync(home, { recursive: true });
    const fd = openSync(logFile, 'a');
    writeFileSync(fd, `\n---- ${new Date().toISOString()} orchvis-start --background ----\n`);
    log(`starting the broker in the background on port ${address.port}; log: ${logFile}`);
    child = spawn(cmd.command, cmd.args, { cwd: cmd.cwd, env, shell: cmd.shell, detached: true, windowsHide: true, stdio: ['ignore', fd, fd] });
    closeSync(fd);
    writeFileSync(pidFile, `${child.pid}\n`);
  } else {
    log(`starting the broker on port ${address.port}...`);
    child = spawn(cmd.command, cmd.args, { cwd: cmd.cwd, env, shell: cmd.shell, stdio: 'inherit' });
  }
  exited = new Promise((r) => child.on('exit', (code, signal) => r(code ?? (signal ? 1 : 0))));
  child.on('error', (err) => fail(`could not start the broker: ${err.message}`));

  log(`waiting for ${address.base}/healthz (up to ${HEALTH_TIMEOUT_MS / 1000} s)...`);
  const t0 = Date.now();
  let healthy = false;
  let earlyExit;
  exited.then((code) => {
    earlyExit = code;
  });
  let lastNote = Date.now();
  while (Date.now() - t0 < HEALTH_TIMEOUT_MS && earlyExit === undefined) {
    if (await healthz(address.base, 1000)) {
      healthy = true;
      break;
    }
    if (Date.now() - lastNote >= 5000) {
      log(`still waiting for the broker (${((Date.now() - t0) / 1000).toFixed(0)} s)...`);
      lastNote = Date.now();
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!healthy) {
    if (earlyExit !== undefined) fail(`the broker exited (code ${earlyExit}) before it became healthy.`);
    else fail(`the broker did not answer /healthz within ${HEALTH_TIMEOUT_MS / 1000} s.`);
    if (opts.background) {
      process.stderr.write(`last lines of ${logFile}:\n${logTail(logFile)}\n`);
      if (earlyExit === undefined) await stopBroker(opts);
      rmSync(pidFile, { force: true });
    } else if (earlyExit === undefined) child.kill();
    return 1;
  }
  log(`broker is healthy (${((Date.now() - t0) / 1000).toFixed(1)} s).`);
  ensureLocalShimConfig(opts, address.host, address.port);
  printSummary(opts, address, firstRun);
  if (opts.open) openBrowser(`http://localhost:${address.port}/`);

  if (opts.background) {
    child.unref();
    return 0;
  }
  // Foreground: Ctrl+C reaches the broker through the shared console; wait for it to exit.
  process.on('SIGINT', () => {});
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  return await exited;
}

if (isMain(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      fail(err?.stack ?? String(err));
    },
  );
}
