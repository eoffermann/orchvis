---
name: orchvis-join
description: Join this Claude Code session to a running Orchestration Visualizer (orchvis). Use when the user or an invite asks this session to join the visualizer, connect to orchvis, register with the broker, or start coordinating with other sessions through orchvis.
---

# Join the Orchestration Visualizer

## If the orchvis tools are available

The tools are named `register`, `list_peers`, `send_message`, `check_inbox`
and so on, shown as `mcp__plugin_orchvis_orchvis__<tool>`.

1. Call `register` with a short, stable name for this session (for example
   `ORCH-UI` or `API`; letters, digits, `. _ @ -`) and a one-line focus.
2. Load the orchestration-visualizer skill and follow it from now on.
3. If `register` reports delivery `poll`, call `check_inbox` now, then follow
   the skill's polling rules. If a probe asks you to call `confirm_channel`,
   do so.
4. If a tool returns `broker_unreachable` or says no broker URL or token is
   configured, tell the user which (the message names the URL or file), and
   point them to the setup step below. Keep working on the local task.

## If the orchvis tools are not available

Tell the user how to set this machine up. Do it once per machine; never ask
for or handle the shim token yourself.

1. **Install Node 20 or later** (https://nodejs.org) if `node --version`
   shows an older version or fails.
2. **Install the plugin.** In any Claude Code session:

   ```
   /plugin marketplace add eoffermann/orchvis
   /plugin install orchvis@orchvis
   ```

   or from a terminal: `claude plugin marketplace add eoffermann/orchvis`
   then `claude plugin install orchvis@orchvis`.
3. **Point it at the broker.** Clone the repo
   (`git clone https://github.com/eoffermann/orchvis`) and run its setup
   script, which asks for the broker URL and the shim token without echoing
   the token and writes `~/.orchvis/config.json`:
   - Windows: `scripts\setup.cmd`
   - macOS: `scripts/setup.sh`
   The person running the broker finds the shim token in
   `~/.orchvis/orchvis.config.json` on the broker host. On the broker host
   itself, `scripts/start-orchvis` writes this file automatically.
4. **Relaunch this session with push delivery** using the launcher in the
   repo, which adds the channel flag and passes other arguments through:
   - Windows: `scripts\orchvis-claude.cmd --resume`
   - macOS: `scripts/orchvis-claude.sh --resume`
   Claude Code shows an "experimental" notice for the development channel;
   that is expected. `--resume` brings this conversation back.

If the user only wants poll mode (no relaunch), installing the plugin and
running `/reload-plugins` is enough; messages then arrive through
`check_inbox`, the `Unread: N` suffix on tool results, and the inbox hooks.
