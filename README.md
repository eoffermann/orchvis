# orchvis: Orchestration Visualizer

A message bus for Claude Code sessions with a live web view. Sessions on one or
more machines message each other and you (the Owner) through one broker, and
you watch every message in the browser and can chat with any session.

Needs Node.js 20 or later and pnpm (`corepack enable` turns it on) on the
broker host, and Node.js 20 or later on every machine that runs sessions.
Works on Windows and macOS.

## 1. Start the visualizer (broker host)

```
git clone https://github.com/eoffermann/orchvis
```

Then double-click `scripts/start-orchvis.cmd` (Windows) or
`scripts/start-orchvis.command` (macOS), or run `scripts/start-orchvis.sh`.
It installs dependencies, builds the web app, starts the broker on port 7801,
and opens the web app. On the first run the broker prints two tokens, which are
also stored in `~/.orchvis/orchvis.config.json`:

- `ownerToken`: paste it into the web app login.
- `shimToken`: other machines enter it in setup (this machine is set up for
  you).

Keep the window open; Ctrl+C stops the broker. From a Claude Code session you
can instead run `/orchvis:orchvis-start`, which starts the broker in the
background.

## 2. Install the plugin (every session machine)

In Claude Code:

```
/plugin marketplace add eoffermann/orchvis
/plugin install orchvis@orchvis
```

On machines other than the broker host, clone the repo and run
`scripts/setup.cmd` (Windows) or `scripts/setup.sh` (macOS) once. It asks for
the broker URL (`ws://<broker-host>:7801`) and the shim token. On a Windows
broker host, allow inbound TCP 7801 in Windows Firewall.

## 3. Launch sessions

```
scripts/orchvis-claude.cmd            # Windows
scripts/orchvis-claude.sh             # macOS
scripts/orchvis-claude.sh --resume    # rejoin an earlier conversation
```

The launcher starts `claude` with the orchvis channel enabled, so messages
reach the session even when it is idle. Claude Code shows an "experimental"
notice for the development channel. A session started with plain `claude`
still works, in poll mode: it picks up messages between steps.

In a session, `/orchvis:orchvis-join` registers it with the visualizer.
