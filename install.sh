#!/bin/bash
set -e

echo "=== Claude Code Live Monitor — Installer ==="
echo ""

cd "$(dirname "$0")"

echo "[1/6] Installing dependencies..."
npm install --production

echo "[2/6] Creating stats directory..."
mkdir -p ~/.claude-monitor

echo "[3/6] Installing systemd user service..."
mkdir -p ~/.config/systemd/user
cp claude-monitor.service ~/.config/systemd/user/

echo "[4/6] Reloading systemd daemon..."
systemctl --user daemon-reload

echo "[5/6] Enabling and starting service..."
systemctl --user enable claude-monitor.service
systemctl --user start claude-monitor.service

echo "[6/6] Detecting network address..."
PI_IP=$(hostname -I | awk '{print $1}')

echo ""
echo "========================================"
echo "  Claude Code Monitor is running!"
echo "  Local:   http://localhost:3500"
echo "  Network: http://${PI_IP}:3500"
echo "========================================"
echo ""
echo "Service commands:"
echo "  systemctl --user status claude-monitor"
echo "  systemctl --user restart claude-monitor"
echo "  journalctl --user -u claude-monitor -f"
