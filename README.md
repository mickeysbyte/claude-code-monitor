# Claude Code Monitor

Real-time activity dashboard for Claude Code

<!-- screenshot placeholder -->

## Overview

Claude Code Monitor is a self-contained, single-file Node.js dashboard that monitors Claude Code sessions in real-time via WebSocket. It watches the JSONL log files that Claude Code writes to `~/.claude/projects/`, parses activity as it happens, and streams it to a browser-based dashboard.

The dashboard shows a live feed of prompts, responses, file operations, bash commands, token usage, and cumulative costs — all in a dark terminal aesthetic. Designed to run as a background service on a Raspberry Pi, but works on any Linux or macOS system with Node.js.

## Features

- Live activity feed of Claude Code sessions as they happen
- Token tracking (input and output) with running cost estimates
- Per-message, per-session, and per-day token and cost aggregates
- Claude process monitoring (PID, CPU, memory)
- Auto-scrolling feed with toggle to pause and review history
- WebSocket with automatic reconnection — survives network blips
- Stats persist across restarts via `~/.claude-monitor/stats.json`
- Systemd user service for automatic start on login
- Single `server.js` file, no build step required
- Works on Raspberry Pi and any Linux/macOS host

## Requirements

- Node.js 18 or later
- Claude Code CLI installed and in use (generates the JSONL logs being monitored)
- A systemd-based Linux distro (for the service installer) — manual launch works on macOS too

## Quick Start

### Automated install (Linux with systemd)

```bash
git clone https://github.com/mickeysbyte/claude-code-monitor.git
cd claude-code-monitor
bash install.sh
```

The installer will:
1. Run `npm install --production`
2. Create `~/.claude-monitor/` for stats storage
3. Install and enable a systemd user service
4. Print the local and network URLs

Then open `http://localhost:3500` in a browser.

### Manual launch

```bash
git clone https://github.com/mickeysbyte/claude-code-monitor.git
cd claude-code-monitor
npm install
node server.js
```

Open `http://localhost:3500`.

## Default Port

The server listens on port **3500**. To change it, edit the `PORT` constant near the top of `server.js`.

## How It Works

Claude Code writes structured JSONL log files to `~/.claude/projects/` as you work. Claude Code Monitor polls those files for new lines, parses each JSON entry, classifies it by type (user prompt, assistant response, tool use, tool result, token summary, etc.), and pushes it to all connected browser clients over a WebSocket connection.

The browser dashboard renders the stream in a scrollable, auto-updating feed. Token counts and cost estimates are computed from the `usage` fields present in assistant messages.

## Configuration

| Setting | Default | Description |
|---|---|---|
| Port | `3500` | HTTP and WebSocket port |
| Stats directory | `~/.claude-monitor/` | Where `stats.json` is stored |
| History size | `200` entries | Events kept in memory for new connections |
| Tail interval | `500 ms` | How often log files are polled for new lines |
| Process interval | `3000 ms` | How often the Claude process stats are refreshed |

Stats are written to `~/.claude-monitor/stats.json` every 60 seconds and on server shutdown, so daily totals survive restarts.

## Service Management

After running `install.sh`, the service is managed with standard systemd user commands:

```bash
systemctl --user status claude-monitor
systemctl --user restart claude-monitor
systemctl --user stop claude-monitor
journalctl --user -u claude-monitor -f
```

## License

MIT — see [LICENSE](LICENSE)
