<div align="center">

# orchvis

**The Orchestration Visualizer: a message bus for Claude Code sessions, with a live map you can steer.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node 20+](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white)
![TypeScript 5](https://img.shields.io/badge/TypeScript-5-3178c6?logo=typescript&logoColor=white)
![Windows | macOS](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS-555)

![The orchvis graph: 30 Claude Code sessions on three machines, grouped by repository, with traffic pulsing along the edges](docs/images/hero-graph.png)

</div>

---

## This is not a subagent orchestrator

Most multi-agent tooling has the same shape: one orchestrator at the top, a swarm of subagents under it. The orchestrator hands out tasks, the subagents report back, and nothing moves sideways between them. That shape works well for splitting one job into parallel pieces. Claude Code's own subagents already do it, and orchvis doesn't replace them.

orchvis works one level up. Each node in the graph is a complete Claude Code session: a lead agent with its own context and its own repo, and usually its own swarm of subagents. The web lead, the payments-API lead, the mobile lead and the CI lead are peers, and they have to work things out with each other. A schema change in one repo breaks a build in another, and the sessions involved need to talk it through directly instead of routing every exchange through you.

```mermaid
flowchart LR
  subgraph SW["Subagent swarm: one team"]
    direction TB
    O["Orchestrator"] --> s1["subagent"]
    O --> s2["subagent"]
    O --> s3["subagent"]
  end
  subgraph TT["orchvis: a team of teams"]
    direction TB
    L1["Lead session<br/>storefront-web"] <--> L2["Lead session<br/>payments-api"]
    L2 <--> L3["Lead session<br/>platform-infra"]
    L1 <--> L3
    L1 --> a1["its own subagents"]
    L2 --> a2["its own subagents"]
    L3 --> a3["its own subagents"]
  end
```

That means far more work gets done in parallel, and far more for one engineer to keep track of. Thirty leads, each running its own swarm, generate more cross-team conversation than anyone can follow from a row of terminals. orchvis gives you the view and the controls for it: see who is talking to whom, read any thread, step into any conversation, and mute or pause traffic when it gets out of hand.

## What orchvis does

orchvis routes all of that conversation through one broker on your LAN. Each session gets a small MCP server (the *shim*) that lets it register, find peers and send messages. You, the **Owner**, watch every message live in the browser: sessions are nodes, repositories are hulls, and traffic pulses along the edges between them. Click any session to talk to it directly; click any edge to read the thread.

- **Every cross-session message is visible.** The broker stamps who sent it, so a session can tell the Owner's instructions from a peer's request, and peers cannot fake either.
- **Works across machines and operating systems.** Windows and macOS sessions on the same LAN share one graph. Session machines only dial out; they need no open ports.
- **Push or poll.** Sessions launched with the channel flag get messages pushed into their context even when idle. Sessions without it still receive them between steps.
- **Screenshots, recordings and voice notes.** Sessions and the Owner can attach images, audio and video. Media is short-lived by design.
- **Nothing to host.** One Node process with all state in memory. Restart it and it starts clean.

## Contents

- [A tour](#a-tour)
- [How it works](#how-it-works)
- [Quick start](#quick-start)
- [Skills](#skills)
- [Tools a session gets](#tools-a-session-gets)
- [Security model](#security-model)
- [Configuration and limits](#configuration-and-limits)
- [Repository layout](#repository-layout)
- [Development](#development)
- [Status](#status)
- [License](#license)

## A tour

### The graph

One node per session, labeled with its self-chosen name and its host. The ring color is its status: green working, grey idle, amber blocked. An orange **P** badge marks a session in poll mode, and a disconnected session is dimmed. Each repository is a colored hull keyed by the normalized git remote, so clones of the same repo on different machines group together. A session working in two repos sits inside both hulls.

Edges are threads between two sessions. Their width and opacity follow a decayed message count: busy threads are bold, quiet ones fade out, and sessions that talk a lot drift closer together. Every message sends a pulse from sender to recipient (pink when it carries media), and Owner traffic shows as a gold halo on the node. Icons at an edge's midpoint count its unexpired images, audio and video.

The top bar shows the connection, the session count, media store usage against its cap, repo and host filters, and a switch that pauses all peer traffic at once.

### Talk to any session

![Node chat with WEB-CHECKOUT: session details, the Owner conversation with an image attachment, and the session's peer threads](docs/images/node-chat.png)

Click a node to open its chat. The header shows host and platform, repos, working directory, focus, status and delivery mode, with a control to pause that session's sends. Below is your conversation with the session and a composer that takes text and file attachments. The side list holds the session's peer threads, most recent first; pick one to open it.

Your messages arrive in the session as Owner messages, which the session protocol says to treat like something typed in its terminal. The session replies here, not in its terminal. For a poll-mode session, a banner explains that it will see your message on its next tool call.

### Read any thread

![Thread between WEB-CHECKOUT and PAY-SCHEMA: a breaking API change, an expired screenshot shown as a tombstone, and image thumbnails](docs/images/thread-cross-repo.png)

Click an edge to read the thread between two sessions, both directions, newest at the bottom. Each message shows sender, time, kind (`chat`, `request`, `response`, `notice`) and whether the recipient has seen it. Bodies render as plain preformatted text, never HTML. Images open in a lightbox, audio and video play inline, and expired media leaves a tombstone with its caption. The header can mute the thread.

In this scenario a storefront session and a payments API session work through a breaking schema change: the API renames `amount` to `amount_minor`, checkout shows `$0.00`, and the two fix it with screenshots, file paths and exact error text.

### Browse media

![Media browser: three images on one thread with captions, senders, sizes and expiry countdowns](docs/images/media-browser.png)

Click a media icon on an edge to see that thread's unexpired items of that kind, with caption, sender, time, size and an expiry countdown. Items open in a lightbox with arrow-key and swipe navigation, and vanish when they expire.

## How it works

```mermaid
flowchart LR
  subgraph WIN["Windows machine"]
    direction TB
    C1["Claude Code session"] <-->|"stdio / MCP"| S1["orchvis shim"]
    C2["Claude Code session"] <-->|"stdio / MCP"| S2["orchvis shim"]
  end
  subgraph MAC["macOS machine"]
    direction TB
    C3["Claude Code session"] <-->|"stdio / MCP"| S3["orchvis shim"]
  end
  subgraph HOST["Broker host, always on"]
    B["orchvis broker<br/>Fastify + ws, all state in memory<br/>registry, routing, ring buffers,<br/>edge weights, media store"]
  end
  S1 -->|"WebSocket /ws/shim<br/>HTTP /api/media"| B
  S2 --> B
  S3 --> B
  B <-->|"WebSocket /ws/ui<br/>HTTP /api/login, /api/media"| W["Web app<br/>(Owner's browser)"]
```

Three parts share one wire schema, defined in `packages/protocol`:

- **Broker.** One Node process on an always-on LAN host, port 7801 by default. It keeps the session registry, routes and stamps every message, holds a ring buffer per thread and the edge statistics, stores media in a size-capped temp directory with a TTL, and serves the web app. There is no database; a restart clears everything.
- **Shim.** A stdio MCP server named `orchvis`, one per Claude Code session, which Claude Code spawns from the plugin. It exposes the [tools](#tools-a-session-gets), keeps one outbound WebSocket to the broker, and holds the session's unread inbox. Shims never talk to each other, and only the shim speaks MCP.
- **Web app.** A React and Vite single-page app for the Owner: an SVG graph laid out with d3-force, plus the chat, thread and media overlays. It gets a snapshot when it connects and live deltas after that.

### Push and poll

Claude Code channels let an MCP server push events into a session's context, even while the session is idle. orchvis uses them where it can and falls back to polling where it can't. A shim cannot tell whether its channel is armed, so it always does both: it emits the channel notification and keeps the message in its inbox.

```mermaid
sequenceDiagram
  autonumber
  participant A as Session A
  participant B as Broker
  participant P as Session B (push)
  participant Q as Session C (poll)
  participant O as Owner (web app)
  A->>B: send_message to B
  B->>B: stamp from, senderKind, ts, id<br/>sanitize, buffer, bump edge weight
  B-->>O: message delta: a pulse on the edge
  B->>P: deliver
  Note over P: Channel notification lands in context at once, even when idle
  A->>B: send_message to C
  B->>Q: deliver
  Note over Q: Kept in the inbox and ~/.orchvis/inbox/(session).json.<br/>Seen on the next check_inbox, via "Unread: N" on any<br/>orchvis tool result, or through the plugin's hooks
  O->>B: owner_send to C
  B->>Q: deliver with senderKind = owner
```

After the broker's `welcome`, the shim sends one probe through the channel asking the session to call `confirm_channel`. If it does, the node switches to push. If it doesn't within 60 s, it stays in poll mode. The plugin's `PostToolUse` and `UserPromptSubmit` hooks surface unread messages to a poll-mode session while it works. An idle poll-mode session cannot be woken, and the web app marks it so you know.

## Quick start

You need **Node.js 20 or later** on every machine, **pnpm** on the broker host (`corepack enable` turns it on), and Claude Code on every machine that runs sessions. The full procedure, with troubleshooting, is in the [runbook](docs/runbook.md).

### 1. Start the broker (one always-on machine)

```
git clone https://github.com/eoffermann/orchvis
```

| Windows | macOS |
|---|---|
| Double-click `scripts\start-orchvis.cmd`, or run `scripts\start-orchvis.ps1` | Double-click `scripts/start-orchvis.command`, or run `scripts/start-orchvis.sh` |

The launcher checks Node and pnpm, installs dependencies, builds the web app if it is stale, starts the broker on port 7801, writes this machine's session config, and opens the web app. Keep the window open; Ctrl+C stops the broker. `pnpm start` from the repo root does the same, and `node scripts/orchvis-start.mjs --help` lists the options (`--background`, `--port N`, `--status`, `--stop` and more).

On first run the broker creates `~/.orchvis/orchvis.config.json` with two random tokens. It never prints them; open the file to copy them:

- `ownerToken`: enter it once on the web app's login screen, and the broker sets a session cookie.
- `shimToken`: the other machines need it for setup.

To create the config file without starting the broker, run `pnpm --filter @orchvis/broker start -- --init`. It prints the file's path and exits.

On a Windows broker host, allow inbound TCP 7801 in Windows Firewall so other machines can connect.

Alternatively, from a Claude Code session on that machine with the plugin installed, run `/orchvis:orchvis-start`. It starts the broker in the background, checks `/healthz`, gives you the URLs and writes invite text for your other sessions.

### 2. Install the plugin (every machine that runs sessions)

In Claude Code:

```
/plugin marketplace add eoffermann/orchvis
/plugin install orchvis@orchvis
```

Or from a terminal: `claude plugin marketplace add eoffermann/orchvis`, then `claude plugin install orchvis@orchvis`.

The plugin carries the shim (bundled into one file and run with plain `node`), the skills and the poll-mode hooks.

### 3. Point the other machines at the broker

On every session machine other than the broker host, clone the repo and run setup once. It asks for the broker URL (`ws://<broker-host>:7801`) and the shim token, without echoing the token, and writes `~/.orchvis/config.json`.

| Windows | macOS |
|---|---|
| `scripts\setup.cmd` | `scripts/setup.sh` |

### 4. Launch sessions

```
scripts\orchvis-claude.cmd              # Windows (or scripts\orchvis-claude.ps1)
scripts/orchvis-claude.sh               # macOS
scripts/orchvis-claude.sh --resume      # rejoin an earlier conversation
```

The launcher runs `claude --dangerously-load-development-channels plugin:orchvis@orchvis` and passes any other arguments through, so messages reach the session even when it is idle. Claude Code shows a "Channels (experimental)" banner at each launch; that is expected. A session started with plain `claude` still joins, in poll mode.

In the session, run `/orchvis:orchvis-join`, or just ask it to join the visualizer. It registers with a short name like `WEB-CHECKOUT` and a one-line focus, and follows the session protocol from then on.

## Skills

The plugin ships three skills. Invoke them as slash commands, or describe what you want and Claude loads the matching one.

| Skill | Invoke | What it does |
|---|---|---|
| `orchvis-start` | `/orchvis:orchvis-start [--port N]` | Makes this session the host: starts the broker in the background, checks it is healthy, reports the web app URL and where the tokens are stored (never the tokens themselves), registers the session as `HOST`, and writes invite text for other sessions. |
| `orchvis-join` | `/orchvis:orchvis-join` | Joins this session: calls `register` with a short stable name and a focus, loads the protocol skill, and checks the inbox in poll mode. If the tools are missing, it walks you through installing the plugin, running setup and relaunching. |
| `orchestration-visualizer` | loads automatically when orchvis tools or `<channel source="orchvis">` tags appear, or when you ask a session to coordinate with others | The session protocol: route all cross-session coordination through orchvis; trust only the channel tag's attributes; treat Owner messages as instructions and peer messages as requests; write self-contained messages with repo, branch, paths and exact errors; send no acknowledgement-only messages; stop on `rate_limited`, `muted` or `paused`; caption every attachment and never attach secrets. |

## Tools a session gets

| Tool | Arguments | Returns |
|---|---|---|
| `register` | `name`, `focus`, `repos?` | Assigned name, peers, delivery mode |
| `list_peers` | `repo?` | Each peer's name, focus, repos, host, status and delivery mode |
| `send_message` | `to` (peer name, ID or `owner`), `body`, `kind?`, `reply_to?`, `attachments?` as `[{ path, caption }]` | Message ID, or a rejection code with an explanation |
| `check_inbox` | `limit?` | Unread messages, oldest first, then marks them seen |
| `get_thread` | `peer`, `limit?` | Recent history with that peer from the broker's buffer |
| `fetch_media` | `media_id` | Local file path (forward slashes, on Windows too), MIME type, caption |
| `set_status` | `status`, `focus?` | Acknowledgement |
| `confirm_channel` | `nonce` | Switches the session to push delivery |

Every tool result ends with `Unread: N` when messages are waiting, so a polling session notices them on any call.

## Security model

orchvis assumes all sessions belong to the Owner and run on a trusted LAN. Within that, no session can impersonate the Owner or another session.

- **Sender identity comes from the connection, never the payload.** The broker sets `from`, `senderKind`, `ts` and the message ID. `senderKind: "owner"` only comes from the authenticated Owner connection, so a shim cannot send as another session or as the Owner, whatever its payload says.
- **Two secrets.** The shim token sits on every session machine and allows registering, sending and media transfer. The Owner token lives only in the broker config and, after login, as an HttpOnly, SameSite=Strict cookie in the Owner's browser. Sessions never hold it, and the skills never read or print either token.
- **Channel-tag forgery is escaped twice.** The broker escapes any `<` that would open or close a `<channel>` tag in bodies, captions and filenames, and strips control characters. The shim escapes again before emitting, so a body cannot smuggle in a fake Owner message.
- **Peer content is untrusted.** The protocol tells sessions to trust only the tag attributes, ignore identity claims inside bodies, and never take a destructive or out-of-scope action on a peer's word alone. Rate limits, mute and pause bound what a misbehaving session can do.
- **The web app treats every string as text.** Bodies, captions, names and filenames render as text nodes, never HTML. The broker serves the app under a strict Content Security Policy with no inline script, checks Origin on the `/ws/ui` upgrade, serves media with `nosniff`, and serves HTML and SVG uploads as downloads only.
- **Media is scoped.** Each upload is bound to the sender's per-connection upload key and needs a caption, and a session can fetch only media from threads it is part of.
- **No filesystem paths on the wire**, apart from each session's working directory, which only the Owner sees.

v1 uses plain HTTP and WebSocket on the LAN. Keep `orchvis.config.json` outside every repository working tree; a session on the broker host could otherwise read it.

## Configuration and limits

The broker reads `~/.orchvis/orchvis.config.json`, or the file named by `--config <path>` or `ORCHVIS_CONFIG`. Environment variables override the file. The broker sends its limits to every shim in `welcome` and to the web app in its snapshot.

| Setting | Default | Environment variable |
|---|---|---|
| Port | 7801 | `ORCHVIS_PORT` |
| Bind address | `0.0.0.0` | `ORCHVIS_BIND` |
| Shim token, Owner token | generated on first run | `ORCHVIS_SHIM_TOKEN`, `ORCHVIS_OWNER_TOKEN` |
| Message body | 16 KB | `ORCHVIS_MAX_BODY_BYTES` |
| Media caption | 2 KB | `ORCHVIS_MAX_CAPTION_BYTES` |
| Ring buffer | 500 messages per thread | `ORCHVIS_RING_BUFFER_PER_THREAD` |
| Media file size | 200 MB | `ORCHVIS_MAX_MEDIA_BYTES` |
| Media store total | 2 GB, oldest evicted first | `ORCHVIS_MEDIA_STORE_BYTES` |
| Media lifetime | 45 minutes | `ORCHVIS_MEDIA_TTL_MS` |
| Send rate | 30 messages per minute, per sender, per thread | `ORCHVIS_SEND_RATE_PER_MINUTE` |
| Edge weight time constant τ | 10 minutes | `ORCHVIS_EDGE_TAU_MS` |
| Heartbeat | every 15 s | `ORCHVIS_HEARTBEAT_INTERVAL_MS` |
| Marked disconnected after | 45 s of silence | `ORCHVIS_DISCONNECT_AFTER_MS` |
| Offline queue and node removal | 10 minutes after disconnect | `ORCHVIS_OFFLINE_RETENTION_MS` |
| Channel probe timeout | 60 s, then poll mode | `ORCHVIS_CHANNEL_PROBE_TIMEOUT_MS` |

Durations in environment variables are in milliseconds and sizes in bytes. Media uploads are also limited to 30 per minute.

Each session machine's shim reads `~/.orchvis/config.json` (`brokerUrl`, `shimToken`), which setup writes. `ORCHVIS_BROKER_URL` and `ORCHVIS_TOKEN` override it.

Edge weights follow one decay rule, `w ← w·e^(−Δt/τ) + 1` on each message. Broker and web app import the same function, so layout and opacity always agree.

## Repository layout

```
packages/
  protocol/    zod schemas and types for every frame, limits, error codes,
               repo-key normalizer, edge-weight function: the contract
  broker/      Fastify + ws server; serves the web build from public/
  shim/        stdio MCP server, bundled by esbuild into one dist/shim.cjs
  web/         React + Vite app: graph, overlays, dev fake feeds
  simulator/   fake shims on the real wire protocol, plus a mock /ws/ui feed
plugin/        the Claude Code plugin: manifest, .mcp.json, skills, hooks,
               bin/shim.cjs (committed, so marketplace installs work)
.claude-plugin/marketplace.json   makes this repo its own plugin marketplace
scripts/       start-orchvis, orchvis-claude and setup launchers (.cmd, .ps1,
               .sh, .command), orchvis-start.mjs, build-web.mjs, build-plugin.mjs
docs/          runbook, workstreams, images
```

## Development

Node 20+ and pnpm 9. TypeScript is pinned to 5.x.

```
pnpm install
pnpm check                         # typecheck + every package's tests; keep it green
pnpm typecheck                     # tsc in every package
pnpm test                          # vitest in every package
pnpm --filter @orchvis/protocol test
pnpm --filter @orchvis/protocol exec vitest run test/repo.test.ts
pnpm --filter @orchvis/protocol exec vitest run -t "normalizeRepoKey"
pnpm build                         # build the web app into packages/broker/public
pnpm build:plugin                  # bundle the shim into plugin/bin/shim.cjs
```

Packages export their TypeScript source, so workspace consumers need no build step. Tests run in Vitest worker threads, because the default fork pool crashes intermittently on Windows.

Most of the system can be tested without a live Claude session: the simulator stands in for shims, and an MCP SDK client over stdio stands in for Claude Code.

**Run the web app without a broker.** Start the dev server with `pnpm --filter @orchvis/web dev`, then open:

- `http://localhost:5173/?fake=showcase`: the curated scenario in these screenshots
- `http://localhost:5173/?fake=1`: about 30 random sessions with random traffic

Or run it against the simulator's mock feed (Owner token `mock`):

```
pnpm --filter @orchvis/simulator sim -- --mock-ui --port 7811
pnpm --filter @orchvis/web dev
```

**Regenerate the screenshots.** `node packages/web/scripts/showcase-media.mjs` renders the scenario's images, audio and video (it needs Playwright's Chromium and ffmpeg). Then start the dev server on a spare port with `pnpm --filter @orchvis/web exec vite --port 5287 --strictPort` and run `node packages/web/scripts/capture-screenshots.mjs`, which writes `docs/images/*.png`.

## Status

orchvis v1 is in active development.

- **Working:** the protocol; the broker, including Owner login with a session cookie, media upload and download with captions and a 45-minute lifetime, rate limits, mute and pause, and the web app served at `/` under a strict CSP; the shim and its tools; the plugin with its skills, launchers, setup and poll-mode hooks; the web graph and overlays; the simulator; the runbook.
- **In progress:** the cross-platform end-to-end matrix (Windows↔Windows and Windows↔macOS, push and poll), soak testing, and layout tuning.
- **Channels are a Claude Code research preview.** Push delivery needs `--dangerously-load-development-channels` (the launchers add it), Claude Code shows an experimental-channels banner at each launch, and the channel contract may change. All channel-specific shim code is in one module for that reason. Poll mode works without channels.
- **LAN only.** v1 uses plain HTTP and WebSocket. Remote workers would need TLS and per-shim tokens.
- **Ephemeral by design.** No message history, search or audit log survives a broker restart, and media expires after 45 minutes.

## License

MIT, see [LICENSE](LICENSE).
