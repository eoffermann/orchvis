---
name: orchvis-start
description: Start the Orchestration Visualizer (orchvis) broker and web app on this machine and make this session the host. Use when the user asks to start, launch, bring up, host, or run the orchestration visualizer or orchvis broker, or to set up a network of coordinating Claude Code sessions.
argument-hint: "[--port N]"
---

# Start the Orchestration Visualizer on this machine

You are the host session. You start the broker in the background, confirm it is
healthy, give the user the web app URL, and produce the invite text for other
sessions. You cannot arm push delivery for other sessions; each one needs a
relaunch by the user.

## Secrets rule (read first)

The broker has two tokens: the shim token (for sessions) and the Owner token
(for the web app login). Never print, echo, read into the conversation, paste,
or send either token anywhere: not in your replies, not in `send_message`, not
in commands you run. Do not `cat`, Read or grep `~/.orchvis/orchvis.config.json`,
`~/.orchvis/config.json` or `~/.orchvis/broker.log`. Only tell the user where
the tokens are stored so they can copy them themselves.

## Steps

1. **Find the orchvis checkout.** The broker runs from a clone of the orchvis
   repository (https://github.com/eoffermann/orchvis), not from the plugin. Use
   the first that exists:
   - the current project, if its root `package.json` has `"name": "orchvis"`
     and it has `packages/broker`;
   - `~/orchvis`.
   If neither exists, ask the user before cloning:
   `git clone https://github.com/eoffermann/orchvis ~/orchvis`.

2. **Start it.** Run, from any directory, with a Bash timeout of 10 minutes
   (the first run installs dependencies and builds the web app):

   ```
   node "<checkout>/scripts/orchvis-start.mjs" --background --no-open $ARGUMENTS
   ```

   The script checks Node 20+ and pnpm, runs `pnpm install` if needed, builds
   the web app if stale, starts the broker detached (logging to
   `~/.orchvis/broker.log`), waits for `/healthz`, and writes this machine's
   `~/.orchvis/config.json` if it is missing, so local sessions can connect.
   If a broker is already healthy on the port, it reports that and stops.

   If it fails, relay its message. Common causes: Node older than 20 (install
   Node 20+), pnpm missing (`corepack enable`, or `npm install -g pnpm`), the
   port already in use (another broker, or pass `--port N`).

3. **Report to the user.** Take these from the script's output:
   - the web app URL on this machine and the LAN URL for other machines;
   - that the Owner token for the web app login is stored in
     `~/.orchvis/orchvis.config.json` (`ownerToken`), and that on the very
     first run it was also printed once to `~/.orchvis/broker.log`;
   - that other machines need the shim token (`shimToken` in that same file)
     and should run `scripts/setup` from the orchvis repo with the LAN URL;
   - on Windows, that other machines need an inbound firewall rule for the port.

4. **Register the host.** If the orchvis tools are available
   (`register`, or `mcp__plugin_orchvis_orchvis__register`), call `register`
   with name `HOST` and focus "orchvis host", then load the
   orchestration-visualizer skill. If they are not available, tell the user
   to run `/reload-plugins` or relaunch this session with the
   `scripts/orchvis-claude` launcher and `--resume`.

5. **Invite other sessions.** Give the user this text (and send it to
   sessions you can already reach), with the real LAN host and port filled in.
   It never contains a token.

   ```
   The Orchestration Visualizer is running at http://<broker-host>:7801.
   1. If the orchvis tools are available, call register with a short name and
      your focus, then load the orchestration-visualizer skill.
   2. If they are not, tell your user: "Relaunch this session with
      orchvis-claude --resume to join the visualizer."
   From now on, coordinate with other sessions through the orchvis tools only.
   ```

6. **Verify.** Once sessions have joined, call `list_peers` and report who
   joined and in which delivery mode (push or poll).

To stop the broker later: `node "<checkout>/scripts/orchvis-start.mjs" --stop`.
To check it: `node "<checkout>/scripts/orchvis-start.mjs" --status`.
