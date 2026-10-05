# orchvis runbook

How to run the Orchestration Visualizer across machines, bring a network of sessions up from a host session, recover from failures, and diagnose problems. For installing the plugin and the first local run, see the [README quick start](../README.md); this runbook does not repeat those steps.

## Contents

- [Topology and files](#topology-and-files)
- [Broker host](#broker-host)
- [Session machines](#session-machines)
- [Bringing the network up from a host session](#bringing-the-network-up-from-a-host-session)
- [Delivery modes](#delivery-modes)
- [Broker restart](#broker-restart)
- [Rotating tokens](#rotating-tokens)
- [Troubleshooting](#troubleshooting)
- [Known behavior of Claude Code channels](#known-behavior-of-claude-code-channels)

## Topology and files

One broker runs on an always-on machine on the LAN. Every Claude Code session runs its own shim (the `orchvis` MCP server from the plugin), which dials out to the broker over WebSocket. Session machines need no inbound ports; only the broker host does.

| What | Where | Holds |
|---|---|---|
| Broker port | broker host, TCP 7801 by default | HTTP and WebSocket: `/ws/shim`, `/ws/ui`, `/api/*`, `/healthz`, the web app |
| Broker config | broker host, `~/.orchvis/orchvis.config.json` (or `--config`, or `ORCHVIS_CONFIG`) | port, bind address, **shim token, Owner token**, limits |
| Shim config | every session machine, `~/.orchvis/config.json` | broker URL, **shim token** |
| Inbox mirror | every session machine, `~/.orchvis/inbox/<Claude session id>.json` (the raw `CLAUDE_CODE_SESSION_ID`, without the host prefix) | unread messages, for the poll-mode hooks |
| Broker log | broker host, `~/.orchvis/broker.log`, only when started with `--background` | structured lines; never message bodies, captions, filenames or tokens |
| Media store | broker host, a per-process directory under the OS temp dir | uploads, deleted on expiry and wiped on start and clean shutdown |

Keep both config files outside every repository working tree. Never paste them into a chat, an issue or a session: they hold the tokens. The broker never prints a token, and neither do the setup scripts.

The shim token lets a machine register sessions, send messages and transfer media. The Owner token logs the web app in and is the only way to send messages stamped `sender_kind="owner"`. Sessions never hold the Owner token.

## Broker host

Requirements: Node 20 or later, pnpm 9, a clone of this repository, and `pnpm install` at its root.

1. **Create the config** (first time only):

   ```
   pnpm --filter @orchvis/broker start -- --init
   ```

   It prints the config path and `created` or `exists`, then exits without binding a port. Open the file yourself to copy the tokens; nothing prints them.

2. **Open the port.** On Windows, in an elevated PowerShell:

   ```powershell
   New-NetFirewallRule -DisplayName "orchvis broker" -Direction Inbound -Protocol TCP -LocalPort 7801 -Action Allow -Profile Private
   ```

   Use your port if you changed it. Keep `-Profile Private` so the broker is not exposed on public networks, and make sure the LAN connection is classed as Private (Settings → Network → the connection → Network profile type). On macOS, allow incoming connections for `node` when the application firewall asks, or add it under System Settings → Network → Firewall → Options.

3. **Start the broker.** The one-step launcher (`pnpm start`, or double-click `scripts/start-orchvis.*`) checks Node and pnpm, installs and builds when needed, starts the broker, waits for `/healthz`, writes this machine's shim config if it has none, and opens the web app. Useful options, passed after `pnpm start --`:

   | Option | Effect |
   |---|---|
   | `--background` | run the broker detached, logging to `~/.orchvis/broker.log` |
   | `--status` | report whether a broker answers, then exit |
   | `--stop` | stop a broker started with `--background` |
   | `--port N` | broker port |
   | `--config PATH` | broker config file |
   | `--no-open`, `--no-build` | skip opening the browser, skip the web build check |

   To run the broker alone in the foreground: `pnpm build`, then `pnpm --filter @orchvis/broker start`. It refuses to start if the port is taken.

4. **Check it** from another machine: `curl http://<broker-host>:7801/healthz` returns `{"ok":true,...}` with node and media counts. If it times out there but works on the broker host, it is the firewall.

Settings in the config file can be overridden per run with environment variables: `ORCHVIS_PORT`, `ORCHVIS_BIND`, `ORCHVIS_SHIM_TOKEN`, `ORCHVIS_OWNER_TOKEN`, and one per limit (`ORCHVIS_MAX_BODY_BYTES`, `ORCHVIS_MEDIA_TTL_MS`, ...; `--help` lists them all). The defaults are in the README's limits table.

## Session machines

On every machine that runs Claude Code sessions:

1. Install Node 20 or later and the plugin (see the README).
2. Write the shim config: run `scripts/setup.cmd`, `scripts/setup.ps1` or `scripts/setup.sh` (all three run `scripts/setup.mjs`) with the broker's URL:

   ```
   scripts/setup.sh --broker-url http://<broker-host>:7801
   ```

   It prompts for the shim token without echoing it. To script it, put the token in the `ORCHVIS_TOKEN` environment variable instead, which keeps it out of shell history. On the broker host itself, `--from-broker-config` reads the token straight from the broker's config. Setup checks `/healthz` and never prints the token.
3. Sessions started after this pick the config up. A session that was already running needs `/reload-plugins` or a restart (see [Known behavior](#known-behavior-of-claude-code-channels)).

## Bringing the network up from a host session

A host session can bring the network up, but it cannot arm push delivery on other sessions: each one needs a relaunch with the channel flag, done by the user at that session's terminal.

1. **Prepare each machine once:** the plugin, Node, and the shim config, as above.
2. **Start the broker** from the host session with the `orchvis-start` skill ("start the orchestration visualizer"). It starts the broker, checks `/healthz`, gives the Owner the web app URL, registers the host session, and produces the invite text. The canonical invite text is in [`plugin/skills/orchvis-start/SKILL.md`](../plugin/skills/orchvis-start/SKILL.md), step 5; it never contains a token.
3. **Invite** the other sessions with that text, over whatever path already reaches them. A session that already has the plugin loaded joins at once in poll mode, through the `orchvis-join` skill.
4. **Upgrade to push:** relaunch each session with `scripts/orchvis-claude.ps1`, `.cmd` or `.sh`, adding `--resume` to keep the conversation. These wrap `claude --dangerously-load-development-channels plugin:orchvis@orchvis` and pass every other argument through; set `ORCHVIS_MARKETPLACE` if you installed the plugin from a marketplace with another name. After the relaunch, the channel probe switches the node to push within a minute.
5. **Verify:** `list_peers` from the host session, and the web app, both show every node and its delivery mode.

## Delivery modes

| Mode | When | How messages arrive |
|---|---|---|
| push | the session was launched with the channel flag and answered the probe | a `<channel source="orchvis" ...>` event, at once, even when the session is idle |
| poll | anything else, including a session that ignored the probe for 60 s | `check_inbox`; an `Unread: N` line on every orchvis tool result; the plugin hooks, which add unread messages as context on each prompt and after each tool call |

A polling session that is idle cannot be woken: it sees messages on its next prompt or tool call. The web app marks such nodes. Calling `register` again re-runs the probe.

The hooks print nothing in push mode (the channel already delivered), right after `check_inbox`, and for messages they have already shown. A silent hook is normally one of those cases, not a fault.

## Broker restart

Everything the broker holds is in memory, by design: a restart loses the registry, every thread and its history, edge weights, controls and all media. The config file, and so both tokens, survive.

What happens on restart, with nothing for you to do:

- **Shims** reconnect with backoff (1 s growing to 30 s, with jitter), resend `hello` and their last `register`, and reappear in the graph under the same session IDs and names. Messages that were queued for disconnected sessions are gone.
- **The web app** reconnects, is refused with close code 4401 because its login session died with the broker, and shows the login page. Log in again with the Owner token.
- **Media references** in old messages no longer resolve; downloads answer `404 not_found`.

Restart the broker from the same config file. A broker started with a new config file has new tokens, and every machine then needs setup again.

This behavior is tested: `packages/broker/test/restart.test.ts` (10 simulated sessions and a web client) and `packages/shim/test/broker-restart.test.ts` (two real shims over stdio).

To soak a build before relying on it, run the opt-in real-time soak: `ORCHVIS_SOAK=1 pnpm --filter @orchvis/broker soak` (PowerShell: `$env:ORCHVIS_SOAK='1'; pnpm --filter @orchvis/broker soak`). It runs 10 simulated sessions with media churn against a local broker on an ephemeral port for 60 minutes (`ORCHVIS_SOAK_MINUTES` to change), prints a progress line every 30 s, and exits non-zero if the media directory exceeds its cap, a file is orphaned, a structure grows, the heap trends up, or the snapshot disagrees with the replayed deltas.

## Rotating tokens

1. Stop the broker.
2. In the broker config, delete the `shimToken` field, the `ownerToken` field, or both.
3. Run `pnpm --filter @orchvis/broker start -- --init` (or start the broker): it generates the missing tokens and writes them back.
4. After a new shim token: run setup again on every session machine. Shims holding the old token stop with "token rejected by broker; fix ~/.orchvis/config.json" and do not retry until the config is fixed and the session restarts the shim (`/reload-plugins` or a relaunch).
5. After a new Owner token: log the web app in again.

## Troubleshooting

### WebSocket close codes

The broker accepts every WebSocket upgrade and then closes with a code, because a browser cannot see the HTTP status of a refused upgrade. The codes are `WS_CLOSE` in `packages/protocol/src/http.ts`.

| Code | Endpoint | Meaning | What to do |
|---|---|---|---|
| 4400 | `/ws/shim` | `hello` rejected or never sent; the `rejected` frame before it says why | `unauthorized`: the shim token is wrong; rerun setup. `invalid`: protocol version mismatch or a malformed hello; update the plugin and the broker to the same version. |
| 4401 | `/ws/ui` | no valid Owner login session | log in again (normal after a broker restart or logout) |
| 4403 | `/ws/ui` | the Origin header does not match the broker | open the web app at the broker's own URL, not through another host name or port; in development, proxy `/api` and `/ws` through Vite |
| 4408 | `/ws/shim` | no traffic within the disconnect window (45 s by default) | usually sleep or a network drop; the shim reconnects by itself |
| 4409 | `/ws/shim` | a newer shim with the same session ID took over | the same session is open twice (for example resumed in a second terminal); the older shim stays down by design, so close the duplicate |
| 4503 | both | the broker is shutting down | clients reconnect with backoff |

Any other close is treated as transient and retried.

### Send rejections

A rejected `send_message` returns the code and a plain explanation. The codes are `RejectCode` in `packages/protocol/src/errors.ts`.

| Code | Meaning |
|---|---|
| `unknown_recipient` | no session with that name or ID; check `list_peers` |
| `recipient_gone` | the recipient was disconnected for longer than 10 minutes and was removed |
| `too_large` | body over 16 KB, or an attachment over its limit |
| `rate_limited` | over 30 messages per minute to one recipient; stop and continue local work |
| `muted`, `paused` | the Owner muted the thread or paused traffic; Owner messages are never blocked |
| `invalid` | malformed, a message to oneself, or an attachment that is unknown, expired, already used, or uploaded by someone else |
| `unauthorized` | the connection is not authenticated |

### HTTP errors

Every broker HTTP error has the body `{"error": <code>, "detail"?: <text>}`.

| Status | `error` | Typical cause |
|---|---|---|
| 400 | `invalid` | malformed login body; upload missing `file` or `caption`, empty caption, or two files |
| 401 | `unauthorized` | wrong Owner token at login; missing or wrong shim token, upload key or Owner cookie on `/api/media` |
| 404 | `not_found` | media expired (45 minutes by default), never existed, or belongs to a thread the requesting session is not in |
| 413 | `too_large` | file over 200 MB or caption over 2 KB (defaults) |
| 415 | `invalid` | the file's content does not match its declared type |
| 429 | `rate_limited` | over 30 uploads per minute from one session, or too many failed logins from one address |

HTML, SVG and other non-media files are served as downloads, never displayed in the browser.

### Other problems

| Symptom | Cause and fix |
|---|---|
| Tools return `broker_unreachable` with a URL | the broker is down, the URL in `~/.orchvis/config.json` is wrong, or the firewall blocks the port: check `curl <url>/healthz` from that machine |
| The orchvis tools are missing in a session | the session was started with `--strict-mcp-config`, which also drops plugin MCP servers; or the plugin was installed mid-session and needs `/reload-plugins` |
| Tool names look like `mcp__plugin_orchvis_orchvis__register` | expected: plugin MCP tools are namespaced `mcp__plugin_<plugin>_<server>__<tool>` |
| A session never switches to push | it was not launched with the channel flag, or it runs headless (`claude -p`), where channel events are not surfaced; relaunch interactively with `orchvis-claude` |
| The broker will not start: port in use | another broker or program holds the port; `pnpm start -- --status` reports whether a broker answers there |
| A session shows up twice, or under an unexpected ID | the shim takes identity only from `CLAUDE_CODE_SESSION_ID` plus the hostname; a resumed session keeps its ID even from another directory. Ignore other `CLAUDE_*` variables, which can be inherited from a parent process. |
| Repo grouping looks wrong | sessions are grouped by normalized git remote of the repo containing the launch directory; a directory with no remote groups under `local:<host>:<dir>` |
| Tests crash with exit code 0xC0000409 on Windows | a package is running Vitest in the fork pool; every package's `vitest.config.ts` must spread `sharedTest` from `vitest.shared.ts`, and `vitest.setup.ts` fails runs that do not |

## Known behavior of Claude Code channels

Verified on Claude Code 2.1.289 on Windows, October 2026. Channels are a research preview, so recheck after upgrading Claude Code.

- Launching with `--dangerously-load-development-channels` shows a "Channels (experimental)" banner and no blocking dialog.
- The banner may also say "no MCP server configured with that name" even though the server loads and delivers. It is cosmetic.
- An event sent to an idle session starts a turn by itself. Events sent while the session is busy arrive in order, as separate tags, in that turn.
- `meta` keys that are not plain identifiers (letters, digits, underscore) are dropped silently.
- `CLAUDE_CODE_SESSION_ID` is present in the plugin MCP server's environment and survives `--resume`; the server's working directory is the directory Claude Code was launched from.
- Headless sessions (`claude -p`) do not surface channel events; they can still use orchvis in poll mode.
