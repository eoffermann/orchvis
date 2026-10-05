# Workstreams

How the Orchestration Visualizer build is split between two coordinating Claude Code sessions, **OrcViz2** and **b2corcviz-98** (also called OrcViz), and their subagents. The work packages (WP0–WP9), phases (P0–P6) and verification items (V1–V8) are defined in `Orchestration Visualizer Implementation Plan.docx`. This doc only assigns them and sets the rules for working in parallel. The Owner (Eddie) chose this split on 2026-10-04.

## Streams

| Stream | Scope | Owner | Branch / worktree |
|---|---|---|---|
| S0 Contract | WP0: pnpm workspace, TypeScript config, Vitest, CI, `packages/protocol` | OrcViz2 | `ws/protocol`, `H:/b2cOrcViz-wt/protocol` |
| S1 Simulator | WP1: fake shims on the real wire protocol, plus the mock `/ws/ui` feed | OrcViz2 | `ws/sim`, `H:/b2cOrcViz-wt/sim` |
| S2 Broker | WP2 broker core and WP3 media, auth and controls | OrcViz2 | `ws/broker`, `H:/b2cOrcViz-wt/broker` |
| Spikes | V1–V8 | b2corcviz-98 | scratchpad only, no repo changes |
| S3 Shim | WP4 | b2corcviz-98 | `ws/shim`, `H:/b2cOrcViz-wt/shim` |
| S4 Plugin | WP7: plugin, SKILL, launchers, setup, poll-mode hooks | b2corcviz-98 | `ws/plugin`, `H:/b2cOrcViz-wt/plugin` |
| S5 Web | WP5 graph and WP6 overlays, with the Playwright suite | b2corcviz-98 | `ws/web`, `H:/b2cOrcViz-wt/web` |
| S6 Runbook and hardening | WP8 (OrcViz2), then WP9 jointly, split per item | both | per item |

If S3–S5 run long, b2corcviz-98 may hand WP6 to OrcViz2 once S2 is done, with notice first.

`H:/b2cOrcViz` stays on `main` and is touched only to merge. Neither owner edits the other's packages; ask the owner instead.

## Order

1. Initial commit on `main` (plan, `CLAUDE.md`, `.gitignore`), then this doc.
2. **S0.** Published early on `ws/protocol` so S1, S3 and S5 can build against the draft. b2corcviz-98 reviews before the merge, and spike results that change the contract (V2 session ID across `--resume`, V4 plugin-root variable) are folded in first. The merge to `main` is tagged `protocol-v1`, and the protocol is frozen from then on.
3. **S1–S5 in parallel** from `protocol-v1`. Each owner spawns subagents per stream for building and testing.
4. **S6.** WP8 once WP3 and WP7 are done; WP9 when everything else is.

## Interfaces

- **`packages/protocol`** is the only contract: wire envelope and frame types, `Message`, `SessionNode`, `MediaRef`, `Address`, limits, rejection codes, `normalizeRepoKey`, `edgeWeight`. Nothing shared is defined anywhere else.
- **Broker endpoints**: `/ws/shim`, `/ws/ui`, `/api/login`, `/api/media`, `/api/media/:id`, `/healthz`, `/`, as in the plan's endpoint table.
- **Broker test seam**: `packages/broker` exports `startBroker({ port: 0, config })` → `{ url, shimToken, ownerToken, close }`, published early as a stub so shim and web tests can be written against it from the start.
- **Simulator**: speaks the real wire protocol and is the test double for both sides. Broker integration tests drive simulator shims; web tests run against broker + simulator, or against the mock `/ws/ui` feed before the broker is ready.

## Spikes

V1–V4 gate WP4 and WP7. V1 (launch dialog), the push half of V2/V3, and V6 (account and policy) need Eddie to launch `claude --dangerously-load-development-channels` and confirm a dialog; b2corcviz-98 writes each as a short checklist for him. The rest b2corcviz-98 runs alone: V2/V3 with a throwaway stdio MCP server that logs its env and cwd, V4/V5 from the docs plus a local plugin test, V7 and V8 where possible. Results arrive incrementally; any that touch the contract go to OrcViz2 before the tag.

## Git rules

- Subagents work on sub-branches (`ws/broker/media`, `ws/web/overlays`, …) and merge into their stream branch.
- Only a stream's owner merges it into `main`: rebase onto `main`, `pnpm -r test` and typecheck green on the rebased branch, notify the other session with stream and sha, then `git merge --no-ff`.
- After `protocol-v1`, a protocol change goes on `proto/<topic>`, needs both owners' approval, bumps the protocol version, and updates broker, shim and web app in the same merge.
- Stage files by explicit path. No force-push or history rewrite on `main`. No AI attribution in commit messages.

## Testing

Every package ships its tests; a manual check does not close a package.

- **Unit (Vitest)**: protocol normalizer case table, weight math, schema round trips; broker routing, limits, sanitizer, eviction order; shim inbox and seen semantics, Windows path formatting.
- **Integration (Vitest)**: broker with simulator shims in one process; shim driven by an MCP SDK client over stdio against `startBroker`, asserting the exact notifications it emits.
- **Web (Playwright)**: against broker + simulator with a controllable clock for fade and expiry; a performance trace at 30 nodes.
- **End to end**: real Claude Code sessions, Windows↔Windows first (one machine), then Windows↔macOS both ways, each in push and poll mode.
- **Soak and security**: as in the plan, during S6.

## Shared resources on this machine

Coordinated by El Jefe. No GPU use. Tell El Jefe before Playwright, soak or load runs, or anything over a few GB of RAM. Port 7801 is the broker default: check it is free before binding it; tests use ephemeral ports. The b2c3d stack on :8080 is off limits.
