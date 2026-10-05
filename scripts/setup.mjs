// Writes this machine's orchvis shim config, <ORCHVIS_HOME or ~/.orchvis>/config.json,
// with the broker URL and the shim token. Run once per session machine.
//
//   node scripts/setup.mjs [--broker-url URL] [--token TOKEN] [--from-broker-config [PATH]] [--yes]
//
// Anything not given is prompted for; the token prompt does not echo. The token
// can also come from the ORCHVIS_TOKEN environment variable, which keeps it out
// of shell history. --from-broker-config reads the shim token from the broker's
// own config file (on the broker host). The token is never printed.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { checkNodeVersion, fail, isMain, log } from './lib/project.mjs';
import { healthz, httpBase, normalizeBrokerUrl, readShimConfig, shimConfigPath, writeShimConfig } from './lib/shim-config.mjs';

/** Parses command-line options. */
export function parseArgs(argv) {
  const opts = { brokerUrl: undefined, token: undefined, fromBrokerConfig: undefined, yes: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--broker-url' || a === '--token') {
      const v = argv[++i];
      if (!v) throw new Error(`${a} needs a value`);
      if (a === '--broker-url') opts.brokerUrl = v;
      else opts.token = v;
    } else if (a === '--from-broker-config') {
      const next = argv[i + 1];
      opts.fromBrokerConfig = next && !next.startsWith('--') ? resolve(argv[++i]) : join(homedir(), '.orchvis', 'orchvis.config.json');
    } else if (a === '--yes' || a === '-y') opts.yes = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`unknown option ${a} (try --help)`);
  }
  return opts;
}

/** Asks a question on the terminal. With `hidden`, typed characters are not echoed. */
function ask(question, { hidden = false } = {}) {
  return new Promise((resolvePromise) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      // Print the prompt, then swallow the echo of what is typed.
      rl._writeToOutput = (s) => {
        if (s.includes(question)) process.stdout.write(question);
        else if (s.includes('\n') || s.includes('\r')) process.stdout.write('\n');
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      resolvePromise(answer.trim());
    });
  });
}

/** Runs setup; resolves to a process exit code. */
export async function main(argv = process.argv.slice(2), env = process.env) {
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
  const file = shimConfigPath(env);
  const current = readShimConfig(file);
  const interactive = process.stdin.isTTY && !opts.yes;

  let brokerUrl = opts.brokerUrl ?? env.ORCHVIS_BROKER_URL;
  if (!brokerUrl && opts.fromBrokerConfig) brokerUrl = 'ws://127.0.0.1:7801';
  if (!brokerUrl) {
    if (!interactive) {
      fail('no broker URL given; pass --broker-url ws://<broker-host>:7801');
      return 1;
    }
    const hint = typeof current.brokerUrl === 'string' ? ` [${current.brokerUrl}]` : ' (e.g. ws://broker-host:7801)';
    brokerUrl = (await ask(`Broker URL${hint}: `)) || current.brokerUrl;
  }
  try {
    brokerUrl = normalizeBrokerUrl(brokerUrl);
  } catch (err) {
    fail(err.message);
    return 1;
  }

  let token = opts.token ?? env.ORCHVIS_TOKEN;
  if (!token && opts.fromBrokerConfig) {
    if (!existsSync(opts.fromBrokerConfig)) {
      fail(`${opts.fromBrokerConfig} does not exist; start the broker once first.`);
      return 1;
    }
    try {
      token = JSON.parse(readFileSync(opts.fromBrokerConfig, 'utf8')).shimToken;
    } catch {
      token = undefined;
    }
    if (!token) {
      fail(`no shimToken in ${opts.fromBrokerConfig}.`);
      return 1;
    }
  }
  if (!token) {
    if (!interactive) {
      fail('no shim token given; set ORCHVIS_TOKEN or pass --token (the prompt needs a terminal).');
      return 1;
    }
    const keep = typeof current.shimToken === 'string' && current.shimToken ? ' (Enter keeps the current one)' : '';
    token = (await ask(`Shim token${keep}, not echoed: `, { hidden: true })) || current.shimToken;
  }
  if (!token || !String(token).trim()) {
    fail('the shim token is empty. It is shimToken in orchvis.config.json on the broker host.');
    return 1;
  }

  writeShimConfig(file, { brokerUrl, shimToken: String(token).trim() });
  log(`wrote ${file} (broker ${brokerUrl}; token saved, not shown).`);

  log(`checking ${httpBase(brokerUrl)}/healthz...`);
  const h = await healthz(httpBase(brokerUrl));
  if (h) log('the broker is reachable. Start sessions with scripts/orchvis-claude.');
  else log('the broker did not answer. Check that it is running, the host and port are right, and (on a Windows broker host) the firewall allows the port. The config is saved either way.');
  return 0;
}

if (isMain(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => fail(err?.stack ?? String(err)),
  );
}
