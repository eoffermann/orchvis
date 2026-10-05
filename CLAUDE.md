# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Current state

The source of truth is `Orchestration Visualizer Implementation Plan.docx` (dated 2026-10-04). Read it before starting any work package. Its "Settled decisions" table is fixed input: do not reopen those decisions without the Owner (Eddie). Who owns which work package, the branch and worktree rules, and the merge rules are in `docs/workstreams.md`.

## Commands

Node 20+ and pnpm 9. TypeScript is pinned to 5.x; do not take the 7.x upgrade pnpm suggests.

```
pnpm install
pnpm typecheck                     # tsc in every package
pnpm test                          # vitest run in every package
pnpm check                         # both; must be green before a merge to main
pnpm --filter @orchvis/protocol test
pnpm --filter @orchvis/protocol exec vitest run test/repo.test.ts
pnpm --filter @orchvis/protocol exec vitest run -t "normalizeRepoKey"
```

Packages export their TypeScript source (`"exports": "./src/index.ts"`), so workspace consumers need no build step; Vite, esbuild and Vitest compile it directly.

Every package needs a `vitest.config.ts` that spreads `sharedTest` from the root `vitest.shared.ts` into its `test` block. That runs tests in worker threads: the default fork pool crashes intermittently on Windows (exit `0xC0000409`). `vitest.setup.ts` fails any run that is not in a worker thread.

## What this is

The Orchestration Visualizer (`orchvis`) is a message bus for Claude Code sessions with a live web view. It has three components sharing one wire schema:

- **Broker**: one Node process on an always-on LAN host. Fastify for HTTP, `ws` for WebSocket, all state in memory, no database. Holds the session registry, routes and stamps messages, keeps per-thread ring buffers and edge statistics, stores media in a TTL'd, size-capped temp dir, and serves the web app. A restart clears everything, by design.
- **Shim**: a stdio MCP server named `orchvis`, one per Claude Code session, spawned by Claude Code. Exposes the MCP tools, declares the experimental `claude/channel` capability, keeps one outbound WebSocket to the broker and a local unread inbox. Shims never talk to each other.
- **Web app**: React + Vite SPA for the Owner. SVG graph laid out with d3-force (sessions as nodes, repo hulls, edges weighted by decayed traffic), plus node-chat, thread and media-browser overlays.

Only the shim speaks MCP. The broker speaks WebSocket (`/ws/shim`, `/ws/ui`) and HTTP to both shims and browser.

## Planned layout and stack

TypeScript 5 strict with TSDoc on every exported symbol, pnpm workspaces, zod, Vitest, Playwright, esbuild for the shim.

```
packages/protocol/   zod schemas, types, limits, error codes, repo-key normalizer, edge-weight function
packages/broker/     Fastify + ws; serves web build from public/
packages/shim/       MCP stdio server, bundled to a single dist/shim.cjs
packages/web/        React app
packages/simulator/  fake shims speaking the real wire protocol
plugin/              Claude Code plugin: .claude-plugin/plugin.json, .mcp.json, skills/orchestration-visualizer/SKILL.md, hooks/, bin/shim.cjs (copied at build)
scripts/             orchvis-claude launchers (.ps1, .cmd, .sh), setup
docs/                runbook, protocol reference
```

The shim is bundled to one `.cjs` so `.mcp.json` runs `node <absolute path>` directly, avoiding npx and the `cmd /c` wrapper native Windows would need.

## Invariants that span components

- **`packages/protocol` is the contract.** Shared types, constants, limits and the edge-weight function live only there. After WP0 it is frozen: any change bumps the protocol version and updates broker, shim and web app in the same change.
- **Sender identity comes from the connection, never the payload.** The broker sets `from`, `senderKind`, `ts` and the ULID `id`. `senderKind: 'owner'` is only possible on the authenticated Owner connection. Sessions never hold the Owner token.
- **Channel-tag forgery.** The broker escapes any `<` that begins a channel open/close tag in bodies, captions and filenames, and strips control characters; the shim escapes again before emitting.
- **No filesystem paths on the wire.** Paths exist only inside a shim, on its own machine. Fetched media paths are returned with forward slashes (`C:/Users/...` on Windows).
- **Repo grouping uses the normalized git remote**, never the clone path (`git@host:org/repo` → `host/org/repo`; strip protocol, credentials, port, trailing `.git` and `/`; lowercase host). No remote → `local:<hostname>:<dirname>`.
- **Session ID** is `${hostname lowercased}:${CLAUDE_CODE_SESSION_ID}`; fall back to a process-lifetime UUID if the env var is absent.
- **Edge weight** `w ← w·e^(−Δt/τ) + 1` (τ = 10 min). Broker and web app import the same function so layout and opacity agree; the client also decays on a 1 s timer.
- **Channel `meta` keys** must be letters, digits and underscores only, with string values; Claude Code silently drops other keys.
- **Shim stdout carries MCP only.** All shim logs go to stderr. The shim completes the MCP handshake before connecting the WebSocket (backoff 1 s → 30 s with jitter) and exits when stdin closes.
- **All channel-specific shim code stays in one module**, since the channel contract is a research preview and may change.
- **Delivery modes**: the shim always emits a channel notification and also keeps the inbox, because it cannot tell whether the channel is armed. A `confirm_channel` probe after `welcome` sets push; no call within 60 s means poll. Poll-mode sessions get messages via `check_inbox`, the `Unread: N` suffix on every tool result, and hooks reading `~/.orchvis/inbox/<session-id>.json`.
- **Untrusted text in the web app**: render message bodies and captions as text nodes only, never HTML. Serve HTML/SVG uploads as downloads, media with `nosniff`, a CSP without inline script, and check Origin on the `/ws/ui` upgrade.
- **Broker logging**: structured lines on stdout for connections, rejections and evictions. Never log message bodies or tokens.

Default limits (body 16 KB, 500 msgs/thread ring buffer, 200 MB/file, 2 GB media store, 45 min media TTL, 30 msg/min per sender per thread, port 7801, etc.) live in `orchvis.config.json` beside the broker, are overridable by env vars, and are sent to shims in `welcome`. Keep that config file outside every repo working tree.

## Work packages and process

The plan defines WP0–WP9 and phases P0–P6, each with a "done when" gate. Rules from the plan:

- WP0 (scaffold, CI, protocol) merges first, then is frozen. After that, backend (WP1–WP4) and frontend (WP5–WP6) can proceed in parallel.
- Each package owns its own directory.
- Every package ships tests with its code; a manual check alone does not close a package.
- Verification spikes V1–V4 (channel preview status, `CLAUDE_CODE_SESSION_ID` presence and `--resume` behavior, shim cwd, plugin-root variable in `.mcp.json`) gate WP4 and WP7. Run them before code depends on those assumptions.

Testing is designed to need no live Claude session: the simulator and an MCP SDK client over stdio stand in for both ends. Web app tests use Playwright against broker + simulator with a controllable clock. End-to-end runs cover Windows↔macOS and Windows↔Windows, each in push and poll mode.

## Platform notes

Targets are native Windows (launched from PowerShell or cmd) and macOS; no WSL. Push delivery requires launching with `claude --dangerously-load-development-channels plugin:orchvis@<marketplace>`, wrapped by the `scripts/orchvis-claude` launchers. The broker host needs a Windows Firewall inbound rule for its port.
