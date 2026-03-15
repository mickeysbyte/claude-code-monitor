'use strict';

// ─── Dependencies ────────────────────────────────────────────────────────────
const http    = require('http');
const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const { exec } = require('child_process');
const { EventEmitter } = require('events');

// ─── Config ──────────────────────────────────────────────────────────────────
const PORT          = 3500;
const CLAUDE_DIR    = path.join(os.homedir(), '.claude', 'projects');
const STATS_DIR     = path.join(os.homedir(), '.claude-monitor');
const STATS_FILE    = path.join(STATS_DIR, 'stats.json');
const MAX_ENTRIES   = 1000;
const HISTORY_SIZE  = 200;
const TAIL_INTERVAL = 500;   // ms between tail checks
const PROC_INTERVAL = 3000;  // ms between process checks
const STATS_SAVE_INTERVAL = 60000;
const COST_INPUT    = 3 / 1_000_000;   // $ per input token
const COST_OUTPUT   = 15 / 1_000_000;  // $ per output token

// ─── State ───────────────────────────────────────────────────────────────────
const emitter       = new EventEmitter();
emitter.setMaxListeners(50);

const watchedFiles  = new Map(); // filePath -> { fd, offset, buffer }
const entries       = [];        // ring buffer of last MAX_ENTRIES events
let   entryIdSeq    = 0;

let   lastActivityTime = 0;
let   sessionStartTime = 0;
let   activeProject    = '';
let   claudeProcess    = null; // { pid, cpu, mem }
let   wsClients        = new Set();
let   serverStartTime  = Date.now();

// Stats structure
function makeStats() {
  return { inputTokens: 0, outputTokens: 0, cost: 0, messages: 0 };
}
let stats = {
  today:   makeStats(),
  session: makeStats(),
  message: makeStats(),
  tokensPerMinuteHistory: [], // [{ts, input, output}]
  actionCounts: { read: 0, write: 0, bash: 0, search: 0, other: 0 },
  filesTouched: new Map(), // path -> { reads, writes, lastTs }
  recentBash: [],          // last 10 bash commands
  messageTokenHistory: [], // last 50 { input, output }
};

// ─── Persist / load stats ─────────────────────────────────────────────────────
function ensureStatsDir() {
  try { fs.mkdirSync(STATS_DIR, { recursive: true }); } catch (_) {}
}
function loadStats() {
  ensureStatsDir();
  try {
    const raw = fs.readFileSync(STATS_FILE, 'utf8');
    const saved = JSON.parse(raw);
    const todayKey = new Date().toISOString().slice(0, 10);
    if (saved.date === todayKey) {
      stats.today = saved.today || makeStats();
      stats.messageTokenHistory = saved.messageTokenHistory || [];
      stats.actionCounts = saved.actionCounts || { read: 0, write: 0, bash: 0, search: 0, other: 0 };
    }
  } catch (_) {}
}
function saveStats() {
  ensureStatsDir();
  try {
    const todayKey = new Date().toISOString().slice(0, 10);
    const payload = {
      date: todayKey,
      today: stats.today,
      messageTokenHistory: stats.messageTokenHistory.slice(-50),
      actionCounts: stats.actionCounts,
    };
    fs.writeFileSync(STATS_FILE, JSON.stringify(payload), 'utf8');
  } catch (_) {}
}
loadStats();
setInterval(saveStats, STATS_SAVE_INTERVAL);

// ─── JSONL Parsing ────────────────────────────────────────────────────────────
function categorize(obj) {
  // Returns array of { kind, data } — one obj may produce multiple events
  const results = [];

  const role = obj.type || obj.role || '';

  if (role === 'user' || obj.type === 'user') {
    // Human message
    let text = '';
    if (typeof obj.message === 'object' && obj.message) {
      const msg = obj.message;
      if (Array.isArray(msg.content)) {
        text = msg.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
      } else if (typeof msg.content === 'string') {
        text = msg.content;
      }
      if (!text && msg.role === 'user') text = '[user message]';
    }
    if (text) results.push({ kind: 'prompt', data: { text } });
    return results;
  }

  if (role === 'assistant' || obj.type === 'assistant') {
    const msg = obj.message || obj;
    const content = msg.content || obj.content || [];

    // Count tokens if present
    const usage = msg.usage || obj.usage || null;
    if (usage) {
      const inp = usage.input_tokens || 0;
      const out = usage.output_tokens || 0;
      if (inp || out) {
        stats.message.inputTokens  = inp;
        stats.message.outputTokens = out;
        stats.message.cost         = inp * COST_INPUT + out * COST_OUTPUT;
        stats.session.inputTokens  += inp;
        stats.session.outputTokens += out;
        stats.session.cost         += stats.message.cost;
        stats.session.messages     += 1;
        stats.today.inputTokens    += inp;
        stats.today.outputTokens   += out;
        stats.today.cost           += stats.message.cost;
        stats.today.messages       += 1;
        stats.messageTokenHistory.push({ ts: Date.now(), input: inp, output: out });
        if (stats.messageTokenHistory.length > 50) stats.messageTokenHistory.shift();
      }
    }

    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          results.push({ kind: 'response', data: { text: block.text } });
        } else if (block.type === 'tool_use') {
          const toolName = block.name || '';
          const inp2 = block.input || {};

          if (/read_file|view|cat/i.test(toolName)) {
            results.push({ kind: 'read', data: { path: inp2.path || inp2.file_path || inp2.filename || '' } });
            stats.actionCounts.read++;
            touchFile(inp2.path || inp2.file_path || '', 'read');
          } else if (/write|edit|create|insert|replace/i.test(toolName)) {
            const fpath = inp2.path || inp2.file_path || inp2.filename || '';
            const lines = (inp2.content || inp2.new_content || inp2.new_string || '').split('\n').length;
            results.push({ kind: 'write', data: { path: fpath, lines } });
            stats.actionCounts.write++;
            touchFile(fpath, 'write');
          } else if (/bash|shell|run_command|execute/i.test(toolName)) {
            const cmd = inp2.command || inp2.cmd || inp2.input || '';
            results.push({ kind: 'bash', data: { command: cmd } });
            stats.actionCounts.bash++;
            if (cmd) {
              stats.recentBash.unshift(cmd);
              if (stats.recentBash.length > 10) stats.recentBash.pop();
            }
          } else if (/search|grep|ripgrep/i.test(toolName)) {
            results.push({ kind: 'search', data: { query: inp2.pattern || inp2.query || inp2.regex || '', path: inp2.path || '' } });
            stats.actionCounts.search++;
          } else if (/glob|find_files|list/i.test(toolName)) {
            results.push({ kind: 'glob', data: { pattern: inp2.pattern || inp2.glob || inp2.path || '' } });
            stats.actionCounts.other++;
          } else if (/fetch|web|http|url/i.test(toolName)) {
            results.push({ kind: 'fetch', data: { url: inp2.url || inp2.uri || '' } });
            stats.actionCounts.other++;
          } else {
            results.push({ kind: 'unknown', data: { type: toolName, raw: JSON.stringify(inp2).slice(0, 100) } });
            stats.actionCounts.other++;
          }
        }
      }
    } else if (typeof content === 'string' && content) {
      results.push({ kind: 'response', data: { text: content } });
    }

    if (results.length === 0) {
      // Maybe a tool result at top level
      if (msg.stop_reason === 'tool_use' || msg.stop_reason === 'end_turn') {
        // No visible content, skip silently
      }
    }
    return results;
  }

  // Tool result rows
  if (obj.type === 'tool_result' || (Array.isArray(obj.content) && obj.tool_use_id)) {
    const text = Array.isArray(obj.content)
      ? obj.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
      : (obj.output || obj.result || '');
    results.push({ kind: 'result', data: { text, chars: text.length } });
    return results;
  }

  // Error
  if (obj.type === 'error' || obj.error) {
    const msg2 = obj.error?.message || obj.message || JSON.stringify(obj).slice(0, 200);
    results.push({ kind: 'error', data: { message: msg2 } });
    return results;
  }

  // Fallback: try to detect from message shape
  if (obj.message && typeof obj.message === 'object') {
    return categorize(obj.message);
  }

  return results;
}

function touchFile(fpath, mode) {
  if (!fpath) return;
  const existing = stats.filesTouched.get(fpath) || { reads: 0, writes: 0, lastTs: 0 };
  if (mode === 'read') existing.reads++;
  else existing.writes++;
  existing.lastTs = Date.now();
  stats.filesTouched.set(fpath, existing);
  // Trim to 20 entries by oldest
  if (stats.filesTouched.size > 20) {
    const sorted = [...stats.filesTouched.entries()].sort((a, b) => b[1].lastTs - a[1].lastTs);
    stats.filesTouched = new Map(sorted.slice(0, 20));
  }
}

// ─── File Tailing ─────────────────────────────────────────────────────────────
function processLine(line, filePath) {
  line = line.trim();
  if (!line) return;
  let obj;
  try { obj = JSON.parse(line); } catch (_) { return; }

  const evts = categorize(obj);
  for (const evt of evts) {
    const entry = {
      id: ++entryIdSeq,
      ts: Date.now(),
      kind: evt.kind,
      data: evt.data,
      filePath,
    };
    entries.push(entry);
    if (entries.length > MAX_ENTRIES) entries.shift();
    lastActivityTime = Date.now();
    if (!sessionStartTime) sessionStartTime = Date.now();

    // Update active project from file path
    const rel = path.relative(CLAUDE_DIR, filePath);
    const parts = rel.split(path.sep);
    if (parts.length > 0) activeProject = parts[0].replace(/-/g, '/');

    emitter.emit('entry', entry);
    broadcast({ type: 'entry', entry });
  }
  // Broadcast stats after each line
  broadcastStats();
}

function tailFile(filePath) {
  if (watchedFiles.has(filePath)) return;

  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch (_) { return; }

  // Seek to end on first open (only tail new data)
  let offset;
  try {
    const st = fs.fstatSync(fd);
    offset = st.size;
  } catch (_) { offset = 0; }

  const state = { fd, offset, leftover: '' };
  watchedFiles.set(filePath, state);

  function poll() {
    if (!watchedFiles.has(filePath)) return;
    const st2 = { size: 0 };
    try {
      const s = fs.fstatSync(state.fd);
      st2.size = s.size;
    } catch (_) {
      watchedFiles.delete(filePath);
      try { fs.closeSync(state.fd); } catch (__) {}
      return;
    }

    if (st2.size > state.offset) {
      const toRead = st2.size - state.offset;
      const buf = Buffer.allocUnsafe(toRead);
      let bytesRead = 0;
      try {
        bytesRead = fs.readSync(state.fd, buf, 0, toRead, state.offset);
      } catch (_) { return; }
      state.offset += bytesRead;

      const chunk = state.leftover + buf.slice(0, bytesRead).toString('utf8');
      const lines = chunk.split('\n');
      state.leftover = lines.pop(); // incomplete last line
      for (const ln of lines) processLine(ln, filePath);
    }

    setTimeout(poll, TAIL_INTERVAL);
  }

  setTimeout(poll, TAIL_INTERVAL);
}

function scanForJsonlFiles(dir) {
  try {
    const entries2 = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries2) {
      if (ent.isDirectory()) {
        scanForJsonlFiles(path.join(dir, ent.name));
      } else if (ent.name.endsWith('.jsonl')) {
        tailFile(path.join(dir, ent.name));
      }
    }
  } catch (_) {}
}

function watchDirectory() {
  // Scan existing files
  scanForJsonlFiles(CLAUDE_DIR);

  // Poll for new files every 5 seconds
  setInterval(() => {
    scanForJsonlFiles(CLAUDE_DIR);
  }, 5000);
}

// Try to watch directory, handle it not existing
try {
  if (!fs.existsSync(CLAUDE_DIR)) {
    // Check every 10s
    const dirWatcher = setInterval(() => {
      if (fs.existsSync(CLAUDE_DIR)) {
        clearInterval(dirWatcher);
        watchDirectory();
      }
    }, 10000);
  } else {
    watchDirectory();
  }
} catch (_) {}

// ─── Process Monitoring ───────────────────────────────────────────────────────
function checkClaudeProcess() {
  exec('ps aux', (err, stdout) => {
    if (err) { claudeProcess = null; return; }
    const lines = stdout.split('\n');
    for (const line of lines) {
      if (/claude/i.test(line) && !/grep|monitor|server\.js/i.test(line)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 11) {
          claudeProcess = {
            pid: parts[1],
            cpu: parseFloat(parts[2]) || 0,
            mem: parseFloat(parts[3]) || 0,
          };
          return;
        }
      }
    }
    claudeProcess = null;
  });
}
checkClaudeProcess();
setInterval(checkClaudeProcess, PROC_INTERVAL);
setInterval(() => broadcastStats(), PROC_INTERVAL);

// ─── WebSocket Broadcast ──────────────────────────────────────────────────────
function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of wsClients) {
    try { if (ws.readyState === 1) ws.send(data); } catch (_) {}
  }
}

function buildStatsSnapshot() {
  const now = Date.now();
  const isActive = claudeProcess !== null ||
    (lastActivityTime > 0 && now - lastActivityTime < 30_000);

  // Tokens per minute: count tokens in last 60s
  const cutoff = now - 60_000;
  const recent = stats.messageTokenHistory.filter(m => m.ts > cutoff);
  const tpmIn  = recent.reduce((a, m) => a + m.input,  0);
  const tpmOut = recent.reduce((a, m) => a + m.output, 0);
  const tpm    = tpmIn + tpmOut;

  const filesTouchedArr = [...stats.filesTouched.entries()]
    .sort((a, b) => b[1].lastTs - a[1].lastTs)
    .slice(0, 20)
    .map(([p, v]) => ({ path: p, reads: v.reads, writes: v.writes }));

  return {
    type: 'stats',
    isActive,
    sessionStartTime,
    lastActivityTime,
    activeProject,
    claudeProcess,
    serverUptime: now - serverStartTime,
    watchedFileCount: watchedFiles.size,
    wsClientCount: wsClients.size,
    entryCount: entries.length,
    tpm,
    stats: {
      message: stats.message,
      session: stats.session,
      today: stats.today,
    },
    actionCounts: stats.actionCounts,
    filesTouched: filesTouchedArr,
    recentBash: stats.recentBash.slice(0, 10),
    messageTokenHistory: stats.messageTokenHistory.slice(-50),
  };
}

function broadcastStats() {
  broadcast(buildStatsSnapshot());
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Claude Code Monitor</title>
<style>
/* ── Reset & Base ── */
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;overflow:hidden;color:#c0c0d0;font-family:'Courier New',Courier,monospace;font-size:13px}

/* ── Animated Gradient Background ── */
body{background:#060818;position:relative}
body::before{content:'';position:fixed;inset:0;z-index:-2;background:linear-gradient(135deg,#060d1f 0%,#0a0620 35%,#060f1a 65%,#08121e 100%);animation:bg-shift 18s ease infinite alternate}
body::after{content:'';position:fixed;inset:0;z-index:-1;background:radial-gradient(ellipse at 20% 50%,rgba(0,80,160,0.12) 0%,transparent 60%),radial-gradient(ellipse at 80% 20%,rgba(80,0,140,0.10) 0%,transparent 55%),radial-gradient(ellipse at 60% 80%,rgba(0,100,120,0.08) 0%,transparent 50%);animation:bg-glow 12s ease-in-out infinite alternate;pointer-events:none}
@keyframes bg-shift{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}
@keyframes bg-glow{0%{opacity:0.6}50%{opacity:1}100%{opacity:0.7}}

::-webkit-scrollbar{width:5px;height:5px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.08);border-radius:3px}
::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,0.15)}

/* ── Layout ── */
#app{display:flex;flex-direction:column;height:100vh}
#header{flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;padding:0 16px;height:48px;background:rgba(6,12,32,0.85);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border-bottom:1px solid rgba(255,255,255,0.07);gap:10px;min-width:0;position:relative;z-index:10}
#header::after{content:'';position:absolute;inset:0;background:repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,0,0,0.03) 2px,rgba(0,0,0,0.03) 4px);pointer-events:none;opacity:0.5}
#main{flex:1;min-height:0;display:grid;grid-template-columns:62% 38%;gap:0;overflow:hidden}
#footer{flex:0 0 30px;display:flex;align-items:center;padding:0 14px;background:rgba(4,6,16,0.9);backdrop-filter:blur(8px);border-top:1px solid rgba(255,255,255,0.05);gap:0;min-width:0;overflow:hidden}

/* ── Header ── */
.hdr-left{display:flex;align-items:center;gap:8px;min-width:0;flex:0 0 auto}
.hdr-center{display:flex;align-items:center;gap:8px;min-width:0;flex:1;justify-content:center;overflow:hidden}
.hdr-right{display:flex;align-items:center;gap:10px;min-width:0;flex:0 0 auto}
.site-title{color:#00ff87;font-weight:bold;letter-spacing:2.5px;font-size:13px;white-space:nowrap;text-shadow:0 0 12px rgba(0,255,135,0.4)}

/* Enhanced pulse dot */
.status-dot{width:9px;height:9px;border-radius:50%;background:#333;flex-shrink:0;transition:background 0.5s,box-shadow 0.5s}
.status-dot.active{background:#00ff87;box-shadow:0 0 6px #00ff87,0 0 14px rgba(0,255,135,0.5);animation:pulse-dot 2s ease-in-out infinite}
@keyframes pulse-dot{
  0%,100%{box-shadow:0 0 4px #00ff87,0 0 10px rgba(0,255,135,0.4)}
  50%{box-shadow:0 0 10px #00ff87,0 0 22px rgba(0,255,135,0.7),0 0 40px rgba(0,255,135,0.2)}
}

.session-info{color:#5a6a8a;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:340px}
.session-timer{color:#00c8f0;font-size:12px;white-space:nowrap;font-weight:bold}
.live-clock{color:#4a5a7a;font-size:11px;white-space:nowrap}
.epm-counter{color:#a0b0c0;font-size:11px;white-space:nowrap;display:flex;align-items:center;gap:4px}
.epm-val{color:#00c8f0;font-weight:bold}

.ws-pill{display:flex;align-items:center;gap:4px;padding:3px 10px;border-radius:12px;font-size:11px;border:1px solid;white-space:nowrap;transition:all 0.3s}
.ws-pill.connected{color:#00ff87;border-color:rgba(0,255,135,0.25);background:rgba(0,255,135,0.08)}
.ws-pill.reconnecting{color:#ffaa00;border-color:rgba(255,170,0,0.25);background:rgba(255,170,0,0.08)}
.ws-pill.disconnected{color:#ff4455;border-color:rgba(255,68,85,0.25);background:rgba(255,68,85,0.08)}

/* ── Glassmorphism Panels ── */
.panel{
  background:rgba(10,14,30,0.6);
  backdrop-filter:blur(10px);
  -webkit-backdrop-filter:blur(10px);
  border-right:1px solid rgba(255,255,255,0.06);
  display:flex;flex-direction:column;min-height:0;overflow:hidden;
  transition:border-color 0.3s
}
.panel-title{
  display:flex;align-items:center;gap:6px;padding:7px 12px;
  background:rgba(255,255,255,0.03);
  border-bottom:1px solid rgba(255,255,255,0.06);
  color:#5a7090;font-size:11px;letter-spacing:1.5px;flex-shrink:0;text-transform:uppercase;
  font-weight:600
}

/* Panel border pulse when new event arrives */
@keyframes panel-pulse{
  0%{border-color:rgba(255,255,255,0.06)}
  50%{border-color:rgba(0,200,240,0.3)}
  100%{border-color:rgba(255,255,255,0.06)}
}
.panel.new-event{animation:panel-pulse 0.8s ease-out}

/* ── Feed ── */
#feed-panel{position:relative}
#feed-scroll{flex:1;overflow-y:auto;overflow-x:hidden;padding:4px 0;min-height:0}
#feed-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:#2a3a5a;gap:10px;font-size:13px}
#feed-empty svg{color:#1a2a3a}

/* Feed entries with colored left border per type */
.feed-entry{
  display:flex;align-items:flex-start;gap:8px;
  padding:5px 10px 5px 12px;
  border-bottom:1px solid rgba(255,255,255,0.03);
  border-left:3px solid transparent;
  cursor:pointer;
  transition:background 0.2s,border-left-color 0.2s;
  animation:slide-in 0.28s cubic-bezier(0.22,1,0.36,1);
  min-width:0
}
.feed-entry:hover{background:rgba(255,255,255,0.04);border-left-color:rgba(255,255,255,0.15) !important}
.feed-entry.expanded{background:rgba(255,255,255,0.05)}

/* Per-type left border colors */
.feed-entry.kind-prompt  {border-left-color:rgba(255,0,200,0.55)}
.feed-entry.kind-response{border-left-color:rgba(0,180,255,0.45)}
.feed-entry.kind-read    {border-left-color:rgba(0,210,100,0.45)}
.feed-entry.kind-write   {border-left-color:rgba(0,210,100,0.45)}
.feed-entry.kind-bash    {border-left-color:rgba(255,140,0,0.55)}
.feed-entry.kind-search  {border-left-color:rgba(140,100,255,0.45)}
.feed-entry.kind-glob    {border-left-color:rgba(140,100,255,0.45)}
.feed-entry.kind-fetch   {border-left-color:rgba(0,188,212,0.45)}
.feed-entry.kind-result  {border-left-color:rgba(80,80,120,0.4)}
.feed-entry.kind-error   {border-left-color:rgba(255,50,70,0.6)}
.feed-entry.kind-unknown {border-left-color:rgba(100,100,100,0.3)}

@keyframes slide-in{
  from{opacity:0;transform:translateX(-8px)}
  to{opacity:1;transform:translateX(0)}
}
.fe-ts{color:#2a3a5a;font-size:11px;flex-shrink:0;width:62px;padding-top:2px;white-space:nowrap}
.fe-icon{flex-shrink:0;width:16px;height:16px;margin-top:2px}
.fe-content{flex:1;min-width:0;line-height:1.45}
.fe-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;transition:opacity 0.2s}
.fe-expand{display:none;margin-top:5px;padding:7px 10px;background:rgba(0,0,0,0.3);border-radius:5px;white-space:pre-wrap;word-break:break-all;font-size:12px;border-left:2px solid rgba(255,255,255,0.1);max-height:300px;overflow-y:auto;overflow-x:auto;backdrop-filter:blur(4px)}
.feed-entry.expanded .fe-expand{display:block}
.fe-toggle{font-size:10px;color:#2a3a5a;margin-left:6px;flex-shrink:0;margin-top:4px;transition:color 0.2s}
.feed-entry:hover .fe-toggle{color:#5a7090}

/* Colors */
.c-prompt  {color:#ff44cc}
.c-response{color:#00c8f0}
.c-read    {color:#00e87a}
.c-write   {color:#00cc60}
.c-bash    {color:#ff9a00}
.c-search  {color:#c084fc}
.c-glob    {color:#c084fc}
.c-fetch   {color:#00bcd4}
.c-result  {color:#4a5a7a}
.c-error   {color:#ff4455}
.c-unknown {color:#6a7a9a}

/* Filter tabs */
#filter-tabs{display:flex;gap:0;padding:0 8px;background:rgba(0,0,0,0.2);border-bottom:1px solid rgba(255,255,255,0.05);flex-shrink:0;overflow-x:auto}
.filter-tab{display:flex;align-items:center;gap:5px;padding:5px 12px;font-size:11px;color:#4a5a7a;cursor:pointer;border-bottom:2px solid transparent;transition:color 0.2s,border-color 0.2s;white-space:nowrap;position:relative;font-family:inherit;background:none;border-top:none;border-left:none;border-right:none}
.filter-tab:hover{color:#8a9aba}
.filter-tab.active{color:#00c8f0;border-bottom-color:#00c8f0}
.filter-tab.active::after{content:'';position:absolute;bottom:-1px;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,#00c8f0,transparent);animation:tab-sweep 0.35s ease-out}
@keyframes tab-sweep{from{transform:scaleX(0)}to{transform:scaleX(1)}}
.tab-badge{display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;padding:0 4px;border-radius:8px;font-size:9px;background:rgba(255,255,255,0.07);color:#6a7a9a;font-weight:bold;transition:background 0.2s,color 0.2s}
.filter-tab.active .tab-badge{background:rgba(0,200,240,0.2);color:#00c8f0}

/* auto-scroll toggle */
#scroll-toggle{position:absolute;top:8px;right:10px;background:rgba(10,14,30,0.8);backdrop-filter:blur(6px);border:1px solid rgba(255,255,255,0.1);color:#4a5a7a;padding:4px 10px;border-radius:6px;cursor:pointer;font-size:11px;font-family:inherit;display:flex;align-items:center;gap:4px;z-index:10;transition:all 0.2s}
#scroll-toggle:hover{color:#a0b0c0;border-color:rgba(255,255,255,0.2)}
#scroll-toggle.paused{color:#ffaa00;border-color:rgba(255,170,0,0.3)}
#new-activity-banner{display:none;position:absolute;bottom:10px;left:50%;transform:translateX(-50%);background:rgba(10,20,50,0.9);backdrop-filter:blur(8px);border:1px solid rgba(0,200,240,0.3);color:#00c8f0;padding:5px 16px;border-radius:14px;font-size:11px;cursor:pointer;z-index:10;align-items:center;gap:5px;white-space:nowrap;box-shadow:0 4px 16px rgba(0,0,0,0.4)}
#new-activity-banner.visible{display:flex}

/* ── Sidebar ── */
#sidebar{display:flex;flex-direction:column;overflow:hidden;border-right:none;overflow-y:auto}

/* Token panel */
#token-panel{flex:0 0 auto}
.token-table{width:100%;border-collapse:collapse}
.token-table th{color:#3a4a6a;font-weight:600;text-align:right;padding:4px 10px;font-size:10px;letter-spacing:0.5px}
.token-table th:first-child{text-align:left}
.token-table td{padding:4px 10px;font-size:12px;text-align:right}
.token-table td:first-child{text-align:left;color:#5a7090}
.token-val{transition:background 0.5s,color 0.5s,transform 0.15s}
.token-val.flash{background:rgba(0,255,135,0.12);color:#00ff87;transform:scale(1.05)}
#token-chart-wrap{padding:6px 10px 8px}
#token-chart{width:100%;height:60px;display:block}

/* Agent panel */
#agent-panel{flex:0 0 auto}
.agent-status-line{display:flex;align-items:center;gap:8px;padding:8px 12px;font-size:14px}
.agent-status-text{font-size:13px;transition:color 0.3s}
.action-bar-wrap{padding:0 12px 6px}
.action-bar{display:flex;height:8px;border-radius:4px;overflow:hidden;gap:1px;background:rgba(255,255,255,0.03)}
.action-seg{height:100%;transition:flex 0.5s}
.action-legend{display:flex;gap:10px;padding:4px 12px 8px;flex-wrap:wrap}
.action-legend-item{display:flex;align-items:center;gap:4px;font-size:10px;color:#4a5a7a}
.legend-swatch{width:8px;height:8px;border-radius:2px;flex-shrink:0}
.files-list{max-height:120px;overflow-y:auto;padding:0 12px 6px}
.file-item{display:flex;align-items:center;gap:6px;padding:3px 0;border-bottom:1px solid rgba(255,255,255,0.04);font-size:11px;min-width:0;transition:background 0.2s}
.file-item-path{color:#5a7090;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
.file-item-counts{display:flex;gap:4px;flex-shrink:0}
.file-count{font-size:10px;display:flex;align-items:center;gap:2px}
.bash-list{max-height:120px;overflow-y:auto;padding:0 12px 8px}
.bash-item{display:flex;align-items:center;gap:6px;padding:3px 0 3px 8px;border-left:2px solid rgba(255,140,0,0.3);border-bottom:1px solid rgba(255,255,255,0.03);font-size:11px;color:#cc8844;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:default;min-width:0;transition:background 0.2s}
.bash-item svg{flex-shrink:0;color:#ff9a00}

/* System panel */
#sys-panel{flex:0 0 auto}
.sys-row{display:flex;align-items:center;gap:6px;padding:4px 12px;font-size:12px;min-width:0;transition:background 0.2s}
.sys-row:hover{background:rgba(255,255,255,0.02)}
.sys-label{color:#3a4a6a;flex-shrink:0;width:110px;font-size:11px}
.sys-val{color:#8a9aba;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;transition:color 0.3s}
.sys-val.green{color:#00ff87}
.sys-val.red{color:#ff4455}

/* ── Footer ── */
.footer-item{display:flex;align-items:center;gap:4px;color:#3a4a6a;font-size:11px;padding:0 10px;white-space:nowrap;flex-shrink:0}
.footer-item svg{color:#2a3a5a}
.footer-divider{width:1px;height:14px;background:rgba(255,255,255,0.05);flex-shrink:0}
.footer-val{color:#5a7090;transition:color 0.3s}

/* ── Entrance animations ── */
@keyframes fade-up{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
#header{animation:fade-up 0.4s ease-out 0s both}
#feed-panel{animation:fade-up 0.4s ease-out 0.1s both}
#sidebar{animation:fade-up 0.4s ease-out 0.2s both}
#footer{animation:fade-up 0.4s ease-out 0.3s both}

/* ── General transitions ── */
button,a,[role="button"]{transition:all 0.2s ease}

@media(max-width:900px){
  #main{grid-template-columns:1fr}
  #sidebar{display:none}
}
</style>
</head>
<body>
<div id="app">

<!-- ═══ HIDDEN SVG SPRITE SHEET ═══ -->
<svg style="display:none" xmlns="http://www.w3.org/2000/svg">
  <!-- prompt: play arrow -->
  <symbol id="icon-prompt" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <polygon points="3,2 13,8 3,14" fill="currentColor" stroke="none"/>
  </symbol>
  <!-- response: left arrow -->
  <symbol id="icon-response" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <line x1="13" y1="8" x2="3" y2="8"/>
    <polyline points="7,4 3,8 7,12"/>
  </symbol>
  <!-- read: open book -->
  <symbol id="icon-read" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M8 3C6 3 4 3.5 3 4.5V13C4 12 6 11.5 8 11.5S12 12 13 13V4.5C12 3.5 10 3 8 3Z"/>
    <line x1="8" y1="3" x2="8" y2="11.5"/>
  </symbol>
  <!-- write: pencil -->
  <symbol id="icon-write" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M11.5 2.5L13.5 4.5L6 12 3 13 4 10Z"/>
    <line x1="9.5" y1="4.5" x2="11.5" y2="6.5"/>
  </symbol>
  <!-- bash: lightning bolt -->
  <symbol id="icon-bash" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="10,2 6,8 9,8 6,14"/>
  </symbol>
  <!-- search: magnifying glass -->
  <symbol id="icon-search" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="6.5" cy="6.5" r="4"/>
    <line x1="10" y1="10" x2="13.5" y2="13.5"/>
  </symbol>
  <!-- folder -->
  <symbol id="icon-folder" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M2 5C2 4.4 2.4 4 3 4H6.5L8 5.5H13C13.6 5.5 14 5.9 14 6.5V12C14 12.6 13.6 13 13 13H3C2.4 13 2 12.6 2 12V5Z"/>
  </symbol>
  <!-- fetch: globe -->
  <symbol id="icon-fetch" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="8" cy="8" r="5.5"/>
    <path d="M2.5 8 C4 6 5 5 8 5 S12 6 13.5 8 C12 10 11 11 8 11 S4 10 2.5 8Z"/>
    <line x1="8" y1="2.5" x2="8" y2="13.5"/>
  </symbol>
  <!-- result: return arrow -->
  <symbol id="icon-result" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="5,10 3,13 6,13"/>
    <path d="M13 3H7C5 3 3 5 3 7V13"/>
  </symbol>
  <!-- error: x in circle -->
  <symbol id="icon-error" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="8" cy="8" r="5.5"/>
    <line x1="5.5" y1="5.5" x2="10.5" y2="10.5"/>
    <line x1="10.5" y1="5.5" x2="5.5" y2="10.5"/>
  </symbol>
  <!-- unknown: question mark -->
  <symbol id="icon-unknown" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M6 5.5C6 4.4 6.9 3.5 8 3.5S10 4.4 10 5.5C10 7 8 7.5 8 9"/>
    <circle cx="8" cy="11.5" r="0.8" fill="currentColor" stroke="none"/>
  </symbol>
  <!-- tokens: stacked coins -->
  <symbol id="icon-tokens" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <ellipse cx="8" cy="5" rx="5" ry="2"/>
    <path d="M3 5V8C3 9.1 5.2 10 8 10S13 9.1 13 8V5"/>
    <path d="M3 8V11C3 12.1 5.2 13 8 13S13 12.1 13 11V8"/>
  </symbol>
  <!-- gear -->
  <symbol id="icon-gear" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="8" cy="8" r="2.5"/>
    <path d="M8 2V3.5M8 12.5V14M2 8H3.5M12.5 8H14M3.8 3.8L4.9 4.9M11.1 11.1L12.2 12.2M12.2 3.8L11.1 4.9M4.9 11.1L3.8 12.2"/>
  </symbol>
  <!-- monitor: screen -->
  <symbol id="icon-monitor" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <rect x="2" y="2" width="12" height="9" rx="1.5"/>
    <line x1="6" y1="13.5" x2="10" y2="13.5"/>
    <line x1="8" y1="11" x2="8" y2="13.5"/>
  </symbol>
  <!-- clock -->
  <symbol id="icon-clock" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="8" cy="8" r="5.5"/>
    <polyline points="8,5 8,8 10.5,9.5"/>
  </symbol>
  <!-- pulse: heartbeat line -->
  <symbol id="icon-pulse" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="1,8 4,8 5.5,4 7.5,12 9.5,6 11,8 15,8"/>
  </symbol>
  <!-- pause: two bars -->
  <symbol id="icon-pause" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <line x1="6" y1="3" x2="6" y2="13"/>
    <line x1="10" y1="3" x2="10" y2="13"/>
  </symbol>
  <!-- arrow-down: chevron -->
  <symbol id="icon-arrow-down" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="4,6 8,11 12,6"/>
  </symbol>
  <!-- connect: chain links -->
  <symbol id="icon-connect" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M6.5 9.5L9.5 6.5"/>
    <path d="M4 8L3 9C2 10 2 11.5 3 12.5L3.5 13C4.5 14 6 14 7 13L8 12C9 11 9 9.5 8 8.5"/>
    <path d="M12 8L13 7C14 6 14 4.5 13 3.5L12.5 3C11.5 2 10 2 9 3L8 4C7 5 7 6.5 8 7.5"/>
  </symbol>
  <!-- disconnect: broken chain -->
  <symbol id="icon-disconnect" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M4 8L3 9C2 10 2 11.5 3 12.5L3.5 13C4.5 14 6 14 7 13L8 12C9 11 9 9.5 8 8.5"/>
    <path d="M12 8L13 7C14 6 14 4.5 13 3.5L12.5 3C11.5 2 10 2 9 3L8 4C7 5 7 6.5 8 7.5"/>
    <line x1="6" y1="6" x2="5" y2="5"/>
    <line x1="10" y1="10" x2="11" y2="11"/>
  </symbol>
  <!-- chart: bar chart -->
  <symbol id="icon-chart" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <line x1="2" y1="13" x2="14" y2="13"/>
    <rect x="3" y="9" width="2.5" height="4" fill="currentColor" stroke="none" rx="0.5"/>
    <rect x="6.75" y="5" width="2.5" height="8" fill="currentColor" stroke="none" rx="0.5"/>
    <rect x="10.5" y="7" width="2.5" height="6" fill="currentColor" stroke="none" rx="0.5"/>
  </symbol>
  <!-- cpu: chip -->
  <symbol id="icon-cpu" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <rect x="4" y="4" width="8" height="8" rx="1"/>
    <line x1="6" y1="2" x2="6" y2="4"/><line x1="8" y1="2" x2="8" y2="4"/><line x1="10" y1="2" x2="10" y2="4"/>
    <line x1="6" y1="12" x2="6" y2="14"/><line x1="8" y1="12" x2="8" y2="14"/><line x1="10" y1="12" x2="10" y2="14"/>
    <line x1="2" y1="6" x2="4" y2="6"/><line x1="2" y1="8" x2="4" y2="8"/><line x1="2" y1="10" x2="4" y2="10"/>
    <line x1="12" y1="6" x2="14" y2="6"/><line x1="12" y1="8" x2="14" y2="8"/><line x1="12" y1="10" x2="14" y2="10"/>
  </symbol>
  <!-- memory: ram stick -->
  <symbol id="icon-memory" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <rect x="2" y="5" width="12" height="6" rx="1"/>
    <line x1="5" y1="5" x2="5" y2="11"/>
    <line x1="8" y1="5" x2="8" y2="11"/>
    <line x1="11" y1="5" x2="11" y2="11"/>
    <line x1="4" y1="11" x2="4" y2="13"/>
    <line x1="12" y1="11" x2="12" y2="13"/>
  </symbol>
  <!-- check: checkmark -->
  <symbol id="icon-check" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="3,8 6.5,11.5 13,5"/>
  </symbol>
  <!-- idle: hourglass -->
  <symbol id="icon-idle" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M5 2H11L8 6.5L11 11H5L8 6.5Z"/>
    <line x1="4" y1="2" x2="12" y2="2"/>
    <line x1="4" y1="14" x2="12" y2="14"/>
    <path d="M5 14H11L8 10Z" fill="currentColor" stroke="none"/>
  </symbol>
  <!-- expand: plus in square -->
  <symbol id="icon-expand" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/>
    <line x1="8" y1="5.5" x2="8" y2="10.5"/>
    <line x1="5.5" y1="8" x2="10.5" y2="8"/>
  </symbol>
  <!-- collapse: minus in square -->
  <symbol id="icon-collapse" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/>
    <line x1="5.5" y1="8" x2="10.5" y2="8"/>
  </symbol>
</svg>

<!-- ═══ HEADER ═══ -->
<header id="header">
  <div class="hdr-left">
    <svg width="16" height="16" class="c-prompt"><use href="#icon-pulse"/></svg>
    <span class="site-title">CLAUDE CODE MONITOR</span>
    <span class="status-dot" id="status-dot"></span>
  </div>
  <div class="hdr-center">
    <svg width="14" height="14" style="color:#555;flex-shrink:0"><use href="#icon-clock"/></svg>
    <span class="session-timer" id="session-timer">00:00:00</span>
    <span class="session-info" id="active-project" title="">—</span>
  </div>
  <div class="hdr-right">
    <span class="epm-counter">
      <svg width="11" height="11" style="color:#3a5a7a"><use href="#icon-pulse"/></svg>
      <span class="epm-val" id="epm-val">0</span>/min
    </span>
    <span class="ws-pill disconnected" id="ws-pill">
      <svg width="12" height="12"><use href="#icon-disconnect"/></svg>
      <span id="ws-status-text">Disconnected</span>
    </span>
    <span class="live-clock" id="live-clock"></span>
  </div>
</header>

<!-- ═══ MAIN ═══ -->
<div id="main">

  <!-- ── Feed Panel ── -->
  <div class="panel" id="feed-panel">
    <div class="panel-title">
      <svg width="13" height="13"><use href="#icon-pulse"/></svg>
      ACTIVITY FEED
    </div>
    <div id="filter-tabs">
      <button class="filter-tab active" data-filter="all" onclick="setFilter('all')">ALL <span class="tab-badge" id="badge-all">0</span></button>
      <button class="filter-tab" data-filter="tools" onclick="setFilter('tools')">TOOLS <span class="tab-badge" id="badge-tools">0</span></button>
      <button class="filter-tab" data-filter="prompts" onclick="setFilter('prompts')">PROMPTS <span class="tab-badge" id="badge-prompts">0</span></button>
      <button class="filter-tab" data-filter="results" onclick="setFilter('results')">RESULTS <span class="tab-badge" id="badge-results">0</span></button>
    </div>
    <button id="scroll-toggle" onclick="toggleScroll()">
      <svg width="12" height="12"><use href="#icon-pause"/></svg>
      <span id="scroll-toggle-label">Pause</span>
    </button>
    <div id="feed-scroll">
      <div id="feed-empty">
        <svg width="32" height="32"><use href="#icon-idle"/></svg>
        Waiting for Claude Code activity...
      </div>
    </div>
    <div id="new-activity-banner" onclick="scrollToBottom()">
      <svg width="13" height="13"><use href="#icon-arrow-down"/></svg>
      New activity below
    </div>
  </div>

  <!-- ── Sidebar ── -->
  <div class="panel" id="sidebar" style="border-right:none">

    <!-- Token Usage -->
    <div id="token-panel">
      <div class="panel-title">
        <svg width="13" height="13"><use href="#icon-tokens"/></svg>
        TOKEN USAGE
      </div>
      <table class="token-table" style="padding:4px 0">
        <thead>
          <tr>
            <th></th>
            <th>THIS MSG</th>
            <th>SESSION</th>
            <th>TODAY</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><svg width="11" height="11" style="color:#00ff41;vertical-align:middle"><use href="#icon-prompt"/></svg> Input</td>
            <td><span class="token-val" id="t-msg-in">0</span></td>
            <td><span class="token-val" id="t-ses-in">0</span></td>
            <td><span class="token-val" id="t-day-in">0</span></td>
          </tr>
          <tr>
            <td><svg width="11" height="11" style="color:#00d4ff;vertical-align:middle"><use href="#icon-response"/></svg> Output</td>
            <td><span class="token-val" id="t-msg-out">0</span></td>
            <td><span class="token-val" id="t-ses-out">0</span></td>
            <td><span class="token-val" id="t-day-out">0</span></td>
          </tr>
          <tr>
            <td><svg width="11" height="11" style="color:#ffaa00;vertical-align:middle"><use href="#icon-tokens"/></svg> Cost</td>
            <td><span class="token-val" id="t-msg-cost">$0.000000</span></td>
            <td><span class="token-val" id="t-ses-cost">$0.000000</span></td>
            <td><span class="token-val" id="t-day-cost">$0.000000</span></td>
          </tr>
        </tbody>
      </table>
      <div id="token-chart-wrap">
        <canvas id="token-chart"></canvas>
      </div>
    </div>

    <!-- Agent Status -->
    <div id="agent-panel">
      <div class="panel-title">
        <svg width="13" height="13"><use href="#icon-gear"/></svg>
        AGENT STATUS
      </div>
      <div class="agent-status-line">
        <svg width="18" height="18" id="agent-icon"><use href="#icon-idle"/></svg>
        <span class="agent-status-text" id="agent-status-text" style="color:#444">Idle</span>
      </div>
      <div class="action-bar-wrap">
        <div class="action-bar" id="action-bar">
          <div class="action-seg" id="seg-read"   style="background:#ffaa00;flex:0"></div>
          <div class="action-seg" id="seg-write"  style="background:#ff8800;flex:0"></div>
          <div class="action-seg" id="seg-bash"   style="background:#ff00ff;flex:0"></div>
          <div class="action-seg" id="seg-search" style="background:#b388ff;flex:0"></div>
          <div class="action-seg" id="seg-other"  style="background:#555;flex:0"></div>
        </div>
      </div>
      <div class="action-legend" id="action-legend">
        <div class="action-legend-item"><div class="legend-swatch" style="background:#ffaa00"></div>Read <span id="lg-read">0</span></div>
        <div class="action-legend-item"><div class="legend-swatch" style="background:#ff8800"></div>Write <span id="lg-write">0</span></div>
        <div class="action-legend-item"><div class="legend-swatch" style="background:#ff00ff"></div>Bash <span id="lg-bash">0</span></div>
        <div class="action-legend-item"><div class="legend-swatch" style="background:#b388ff"></div>Search <span id="lg-search">0</span></div>
        <div class="action-legend-item"><div class="legend-swatch" style="background:#555"></div>Other <span id="lg-other">0</span></div>
      </div>
      <div class="panel-title" style="font-size:10px;padding:4px 12px">
        <svg width="11" height="11"><use href="#icon-read"/></svg>
        FILES TOUCHED
      </div>
      <div class="files-list" id="files-list"></div>
      <div class="panel-title" style="font-size:10px;padding:4px 12px;margin-top:2px">
        <svg width="11" height="11"><use href="#icon-bash"/></svg>
        RECENT COMMANDS
      </div>
      <div class="bash-list" id="bash-list"></div>
    </div>

    <!-- System -->
    <div id="sys-panel">
      <div class="panel-title">
        <svg width="13" height="13"><use href="#icon-monitor"/></svg>
        SYSTEM
      </div>
      <div class="sys-row">
        <span class="sys-label"><svg width="11" height="11" style="vertical-align:middle;margin-right:3px"><use href="#icon-check"/></svg>Process</span>
        <span class="sys-val" id="sys-process">Checking...</span>
      </div>
      <div class="sys-row">
        <span class="sys-label"><svg width="11" height="11" style="vertical-align:middle;margin-right:3px"><use href="#icon-cpu"/></svg>CPU</span>
        <span class="sys-val" id="sys-cpu">—</span>
      </div>
      <div class="sys-row">
        <span class="sys-label"><svg width="11" height="11" style="vertical-align:middle;margin-right:3px"><use href="#icon-memory"/></svg>Memory</span>
        <span class="sys-val" id="sys-mem">—</span>
      </div>
      <div class="sys-row">
        <span class="sys-label"><svg width="11" height="11" style="vertical-align:middle;margin-right:3px"><use href="#icon-clock"/></svg>Uptime</span>
        <span class="sys-val" id="sys-uptime">—</span>
      </div>
      <div class="sys-row">
        <span class="sys-label"><svg width="11" height="11" style="vertical-align:middle;margin-right:3px"><use href="#icon-folder"/></svg>Watching</span>
        <span class="sys-val" id="sys-watching">0 files</span>
      </div>
      <div class="sys-row">
        <span class="sys-label"><svg width="11" height="11" style="vertical-align:middle;margin-right:3px"><use href="#icon-connect"/></svg>Clients</span>
        <span class="sys-val" id="sys-clients">0</span>
      </div>
      <div class="sys-row">
        <span class="sys-label"><svg width="11" height="11" style="vertical-align:middle;margin-right:3px"><use href="#icon-clock"/></svg>Last event</span>
        <span class="sys-val" id="sys-last">Never</span>
      </div>
    </div>

  </div><!-- /#sidebar -->
</div><!-- /#main -->

<!-- ═══ FOOTER ═══ -->
<footer id="footer">
  <div class="footer-item">
    <svg width="11" height="11"><use href="#icon-prompt"/></svg>
    <span id="ft-msgs" class="footer-val">0</span>&nbsp;msgs
  </div>
  <div class="footer-divider"></div>
  <div class="footer-item">
    <svg width="11" height="11"><use href="#icon-tokens"/></svg>
    <span id="ft-tpm" class="footer-val">0</span>&nbsp;tok/min
  </div>
  <div class="footer-divider"></div>
  <div class="footer-item">
    <svg width="11" height="11" style="color:#ffaa00"><use href="#icon-tokens"/></svg>
    <span id="ft-cost" class="footer-val">$0.000000</span>&nbsp;today
  </div>
  <div class="footer-divider"></div>
  <div class="footer-item">
    <svg width="11" height="11"><use href="#icon-pulse"/></svg>
    <span id="ft-entries" class="footer-val">0</span>&nbsp;entries
  </div>
  <div class="footer-divider"></div>
  <div class="footer-item">
    <svg width="11" height="11" id="ft-ws-icon"><use href="#icon-disconnect"/></svg>
    <span id="ft-ws" class="footer-val">Disconnected</span>
  </div>
</footer>

</div><!-- /#app -->

<script>
// ── WebSocket with reconnection ──
let ws, reconnectDelay = 1000, maxDelay = 30000;
let wsState = 'disconnected';

function setWsState(state) {
  wsState = state;
  const pill = document.getElementById('ws-pill');
  const txt  = document.getElementById('ws-status-text');
  const ftWs = document.getElementById('ft-ws');
  const ftIcon = document.getElementById('ft-ws-icon').querySelector('use');
  pill.className = 'ws-pill ' + state;
  if (state === 'connected') {
    txt.textContent = 'Connected'; ftWs.textContent = 'Connected';
    ftIcon.setAttribute('href', '#icon-connect');
    pill.querySelector('use').setAttribute('href', '#icon-connect');
  } else if (state === 'reconnecting') {
    txt.textContent = 'Reconnecting'; ftWs.textContent = 'Reconnecting';
    ftIcon.setAttribute('href', '#icon-disconnect');
    pill.querySelector('use').setAttribute('href', '#icon-disconnect');
  } else {
    txt.textContent = 'Disconnected'; ftWs.textContent = 'Disconnected';
    ftIcon.setAttribute('href', '#icon-disconnect');
    pill.querySelector('use').setAttribute('href', '#icon-disconnect');
  }
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(proto + '://' + location.host + '/ws');
  setWsState('reconnecting');

  ws.onopen = () => {
    setWsState('connected');
    reconnectDelay = 1000;
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch(_) { return; }
    if (msg.type === 'history') {
      for (const e of msg.entries) addEntry(e);
    } else if (msg.type === 'entry') {
      addEntry(msg.entry);
    } else if (msg.type === 'stats') {
      applyStats(msg);
    }
  };
  ws.onclose = () => {
    setWsState('disconnected');
    setTimeout(() => { setWsState('reconnecting'); connect(); }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, maxDelay);
  };
  ws.onerror = () => ws.close();
}
connect();

// ── Feed ──
let autoScroll = true;
let pendingNew = 0;
let activeFilter = 'all';
const feedScroll = document.getElementById('feed-scroll');
const feedEmpty  = document.getElementById('feed-empty');
const banner     = document.getElementById('new-activity-banner');

// Tab badge counts
const tabCounts = { all: 0, tools: 0, prompts: 0, results: 0 };
function kindToFilter(kind) {
  if (kind === 'prompt') return 'prompts';
  if (kind === 'result') return 'results';
  if (['read','write','bash','search','glob','fetch'].includes(kind)) return 'tools';
  return null;
}
function updateBadges() {
  document.getElementById('badge-all').textContent     = tabCounts.all > 999 ? '999+' : tabCounts.all;
  document.getElementById('badge-tools').textContent   = tabCounts.tools > 999 ? '999+' : tabCounts.tools;
  document.getElementById('badge-prompts').textContent = tabCounts.prompts > 999 ? '999+' : tabCounts.prompts;
  document.getElementById('badge-results').textContent = tabCounts.results > 999 ? '999+' : tabCounts.results;
}
function setFilter(f) {
  activeFilter = f;
  document.querySelectorAll('.filter-tab').forEach(t => t.classList.toggle('active', t.dataset.filter === f));
  document.querySelectorAll('.feed-entry').forEach(el => {
    el.style.display = entryMatchesFilter(el.dataset.kind, f) ? '' : 'none';
  });
}
function entryMatchesFilter(kind, f) {
  if (f === 'all') return true;
  if (f === 'prompts') return kind === 'prompt';
  if (f === 'results') return kind === 'result';
  if (f === 'tools')   return ['read','write','bash','search','glob','fetch'].includes(kind);
  return true;
}

// Events-per-minute tracking
const epmTimestamps = [];
function recordEpm() {
  const now = Date.now();
  epmTimestamps.push(now);
  // purge older than 60s
  while (epmTimestamps.length && epmTimestamps[0] < now - 60000) epmTimestamps.shift();
  document.getElementById('epm-val').textContent = epmTimestamps.length;
}

function toggleScroll() {
  autoScroll = !autoScroll;
  const btn = document.getElementById('scroll-toggle');
  const lbl = document.getElementById('scroll-toggle-label');
  if (autoScroll) {
    btn.classList.remove('paused');
    lbl.textContent = 'Pause';
    btn.querySelector('use').setAttribute('href', '#icon-pause');
    scrollToBottom();
    pendingNew = 0;
    banner.classList.remove('visible');
  } else {
    btn.classList.add('paused');
    lbl.textContent = 'Resume';
    btn.querySelector('use').setAttribute('href', '#icon-expand');
  }
}

function scrollToBottom() {
  feedScroll.scrollTop = feedScroll.scrollHeight;
  pendingNew = 0;
  banner.classList.remove('visible');
}

const KIND_META = {
  prompt:   { cls: 'c-prompt',   icon: 'icon-prompt'   },
  response: { cls: 'c-response', icon: 'icon-response'  },
  read:     { cls: 'c-read',     icon: 'icon-read'      },
  write:    { cls: 'c-write',    icon: 'icon-write'     },
  bash:     { cls: 'c-bash',     icon: 'icon-bash'      },
  search:   { cls: 'c-search',   icon: 'icon-search'    },
  glob:     { cls: 'c-glob',     icon: 'icon-folder'    },
  fetch:    { cls: 'c-fetch',    icon: 'icon-fetch'     },
  result:   { cls: 'c-result',   icon: 'icon-result'    },
  error:    { cls: 'c-error',    icon: 'icon-error'     },
  unknown:  { cls: 'c-unknown',  icon: 'icon-unknown'   },
};

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-GB', { hour12: false });
}

function entryText(e) {
  const d = e.data;
  switch (e.kind) {
    case 'prompt':   return d.text || '';
    case 'response': return (d.text || '').slice(0, 300);
    case 'read':     return 'Read: ' + (d.path || '');
    case 'write':    return 'Write: ' + (d.path || '') + (d.lines ? ' (' + d.lines + ' lines)' : '');
    case 'bash':     return 'Bash: ' + (d.command || '').slice(0, 150);
    case 'search':   return 'Search: ' + (d.query || '') + (d.path ? ' in ' + d.path : '');
    case 'glob':     return 'Glob: ' + (d.pattern || '');
    case 'fetch':    return 'Fetch: ' + (d.url || '');
    case 'result':   return 'Result: ' + (d.chars || 0) + ' chars';
    case 'error':    return 'Error: ' + (d.message || '');
    case 'unknown':  return (d.type || 'unknown') + ': ' + (d.raw || '');
    default: return JSON.stringify(d).slice(0, 80);
  }
}

function entryFullText(e) {
  const d = e.data;
  switch (e.kind) {
    case 'response': return d.text || '';
    case 'result':   return d.text || '';
    default: return entryText(e);
  }
}

let entryCount = 0;
const MAX_DOM = 1000;

function addEntry(e) {
  if (feedEmpty.style.display !== 'none') feedEmpty.style.display = 'none';

  // Badge counts
  tabCounts.all++;
  const fc = kindToFilter(e.kind);
  if (fc) tabCounts[fc]++;
  updateBadges();

  // EPM
  recordEpm();

  const meta = KIND_META[e.kind] || KIND_META.unknown;
  const short = entryText(e);
  const full  = entryFullText(e);
  const hasMore = full.length > 300 && (e.kind === 'response' || e.kind === 'result');

  const row = document.createElement('div');
  row.className = 'feed-entry kind-' + e.kind;
  row.dataset.id   = e.id;
  row.dataset.kind = e.kind;

  // Hide if doesn't match current filter
  if (!entryMatchesFilter(e.kind, activeFilter)) row.style.display = 'none';

  row.innerHTML =
    '<span class="fe-ts">' + fmtTime(e.ts) + '</span>' +
    '<svg width="16" height="16" class="fe-icon ' + meta.cls + '"><use href="#' + meta.icon + '"/></svg>' +
    '<div class="fe-content">' +
      '<div class="fe-text ' + meta.cls + '">' + esc(short) + '</div>' +
      (hasMore ? '<div class="fe-expand ' + meta.cls + '">' + esc(full) + '</div>' : '') +
    '</div>' +
    (hasMore ? '<svg width="14" height="14" class="fe-toggle"><use href="#icon-expand"/></svg>' : '');

  row.addEventListener('click', function() {
    if (hasMore) {
      const expanded = row.classList.toggle('expanded');
      row.querySelector('.fe-toggle use').setAttribute('href', expanded ? '#icon-collapse' : '#icon-expand');
    } else if (full.length > 0) {
      row.classList.toggle('expanded');
      if (!row.querySelector('.fe-expand')) {
        const div = document.createElement('div');
        div.className = 'fe-expand ' + meta.cls;
        div.textContent = full;
        row.querySelector('.fe-content').appendChild(div);
      }
    }
  });

  feedScroll.appendChild(row);
  entryCount++;

  // Pulse the feed panel border
  const fp = document.getElementById('feed-panel');
  fp.classList.remove('new-event');
  void fp.offsetWidth; // reflow to restart animation
  fp.classList.add('new-event');
  setTimeout(() => fp.classList.remove('new-event'), 800);

  // Trim DOM
  while (entryCount > MAX_DOM) {
    const first = feedScroll.querySelector('.feed-entry');
    if (first) { first.remove(); entryCount--; } else break;
  }

  if (autoScroll) {
    scrollToBottom();
  } else {
    pendingNew++;
    banner.classList.add('visible');
  }

  document.getElementById('ft-entries').textContent = entryCount;
}

function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

// ── Stats ──
let lastStats = null;
let sessionStart = 0;

function applyStats(s) {
  lastStats = s;
  if (s.sessionStartTime && !sessionStart) sessionStart = s.sessionStartTime;
  if (s.sessionStartTime) sessionStart = s.sessionStartTime;

  // Active dot
  const dot = document.getElementById('status-dot');
  dot.classList.toggle('active', !!s.isActive);

  // Project
  const proj = document.getElementById('active-project');
  proj.textContent = s.activeProject || '—';
  proj.title = s.activeProject || '';

  // Token table
  function setTV(id, val) {
    const el = document.getElementById(id);
    if (!el) return;
    const old = el.textContent;
    const nv = String(val);
    if (old !== nv) {
      el.textContent = nv;
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 600);
    }
  }
  const st = s.stats;
  setTV('t-msg-in',   fmt(st.message.inputTokens));
  setTV('t-msg-out',  fmt(st.message.outputTokens));
  setTV('t-msg-cost', '$' + st.message.cost.toFixed(6));
  setTV('t-ses-in',   fmt(st.session.inputTokens));
  setTV('t-ses-out',  fmt(st.session.outputTokens));
  setTV('t-ses-cost', '$' + st.session.cost.toFixed(6));
  setTV('t-day-in',   fmt(st.today.inputTokens));
  setTV('t-day-out',  fmt(st.today.outputTokens));
  setTV('t-day-cost', '$' + st.today.cost.toFixed(6));

  // Footer
  document.getElementById('ft-msgs').textContent = fmt(st.today.messages);
  document.getElementById('ft-tpm').textContent  = fmt(s.tpm);
  document.getElementById('ft-cost').textContent = '$' + st.today.cost.toFixed(6);

  // Agent status
  updateAgentStatus(s);

  // Action bar
  const ac = s.actionCounts;
  const total = (ac.read||0)+(ac.write||0)+(ac.bash||0)+(ac.search||0)+(ac.other||0) || 1;
  ['read','write','bash','search','other'].forEach(k => {
    const el = document.getElementById('seg-'+k);
    if (el) el.style.flex = (ac[k]||0)/total;
  });
  document.getElementById('lg-read').textContent   = ac.read||0;
  document.getElementById('lg-write').textContent  = ac.write||0;
  document.getElementById('lg-bash').textContent   = ac.bash||0;
  document.getElementById('lg-search').textContent = ac.search||0;
  document.getElementById('lg-other').textContent  = ac.other||0;

  // Files touched
  const fl = document.getElementById('files-list');
  fl.innerHTML = '';
  for (const f of (s.filesTouched||[])) {
    const name = f.path.split('/').pop() || f.path;
    const div = document.createElement('div');
    div.className = 'file-item';
    div.title = f.path;
    div.innerHTML =
      '<span class="file-item-path">' + esc(name) + '</span>' +
      '<span class="file-item-counts">' +
        (f.reads  ? '<span class="file-count c-read"><svg width="10" height="10"><use href="#icon-read"/></svg>' + f.reads + '</span>' : '') +
        (f.writes ? '<span class="file-count c-write"><svg width="10" height="10"><use href="#icon-write"/></svg>' + f.writes + '</span>' : '') +
      '</span>';
    fl.appendChild(div);
  }

  // Bash list
  const bl = document.getElementById('bash-list');
  bl.innerHTML = '';
  for (const cmd of (s.recentBash||[])) {
    const div = document.createElement('div');
    div.className = 'bash-item';
    div.title = cmd;
    div.innerHTML = '<svg width="11" height="11"><use href="#icon-bash"/></svg>' + esc(cmd.slice(0, 80));
    bl.appendChild(div);
  }

  // System
  const proc = s.claudeProcess;
  const sysProcEl = document.getElementById('sys-process');
  const sysCpu = document.getElementById('sys-cpu');
  const sysMem = document.getElementById('sys-mem');
  if (proc) {
    sysProcEl.className = 'sys-val green';
    sysProcEl.innerHTML = '<svg width="11" height="11" style="vertical-align:middle"><use href="#icon-check"/></svg> Running (PID ' + proc.pid + ')';
    sysCpu.textContent = proc.cpu + '%';
    sysMem.textContent = proc.mem + '%';
  } else {
    sysProcEl.className = 'sys-val red';
    sysProcEl.innerHTML = '<svg width="11" height="11" style="vertical-align:middle"><use href="#icon-error"/></svg> No active process';
    sysCpu.textContent = '—';
    sysMem.textContent = '—';
  }
  document.getElementById('sys-uptime').textContent   = fmtDuration(s.serverUptime);
  document.getElementById('sys-watching').textContent = (s.watchedFileCount||0) + ' files';
  document.getElementById('sys-clients').textContent  = s.wsClientCount||0;
  const lastEl = document.getElementById('sys-last');
  if (s.lastActivityTime) {
    const ago = Math.floor((Date.now() - s.lastActivityTime) / 1000);
    lastEl.textContent = ago < 60 ? ago + 's ago' : Math.floor(ago/60) + 'm ago';
  } else {
    lastEl.textContent = 'Never';
  }

  // Token chart
  drawChart(s.messageTokenHistory || []);
}

function updateAgentStatus(s) {
  // Find most recent entry kind from the last 30s
  const now = Date.now();
  let lastKind = null;
  let lastTs = 0;
  // We don't have individual entry timestamps here, use lastActivityTime
  if (s.lastActivityTime && now - s.lastActivityTime < 30000) {
    // Try to guess from last entry in DOM
    const entries2 = feedScroll.querySelectorAll('.feed-entry');
    if (entries2.length > 0) {
      const last = entries2[entries2.length - 1];
      // Determine kind from classes
      const icon = last.querySelector('.fe-icon');
      if (icon) {
        const use = icon.querySelector('use');
        if (use) {
          const href = use.getAttribute('href') || '';
          if (href.includes('prompt'))   lastKind = 'prompt';
          else if (href.includes('response')) lastKind = 'response';
          else if (href.includes('read'))     lastKind = 'read';
          else if (href.includes('write'))    lastKind = 'write';
          else if (href.includes('bash'))     lastKind = 'bash';
          else if (href.includes('search'))   lastKind = 'search';
          else if (href.includes('folder'))   lastKind = 'glob';
          else if (href.includes('fetch'))    lastKind = 'fetch';
          else if (href.includes('result'))   lastKind = 'result';
          else if (href.includes('error'))    lastKind = 'error';
        }
      }
    }
  }

  const statusMap = {
    prompt:   { text: 'Processing prompt...', color: '#00ff41', icon: 'icon-prompt'   },
    response: { text: 'Generating response...', color: '#00d4ff', icon: 'icon-response' },
    read:     { text: 'Reading file...',        color: '#ffaa00', icon: 'icon-read'    },
    write:    { text: 'Writing code...',        color: '#ff8800', icon: 'icon-write'   },
    bash:     { text: 'Running command...',     color: '#ff00ff', icon: 'icon-bash'    },
    search:   { text: 'Searching...',           color: '#b388ff', icon: 'icon-search'  },
    glob:     { text: 'Searching files...',     color: '#b388ff', icon: 'icon-folder'  },
    fetch:    { text: 'Fetching URL...',        color: '#00bcd4', icon: 'icon-fetch'   },
    result:   { text: 'Tool completed',         color: '#666',    icon: 'icon-result'  },
    error:    { text: 'Error occurred',         color: '#ff3333', icon: 'icon-error'   },
  };
  const idle = { text: 'Idle', color: '#444', icon: 'icon-idle' };
  const m = statusMap[lastKind] || idle;

  document.getElementById('agent-status-text').textContent = m.text;
  document.getElementById('agent-status-text').style.color = m.color;
  document.getElementById('agent-icon').querySelector('use').setAttribute('href', '#' + m.icon);
  document.getElementById('agent-icon').style.color = m.color;
}

// ── Chart ──
function drawChart(history) {
  const canvas = document.getElementById('token-chart');
  const wrap   = document.getElementById('token-chart-wrap');
  canvas.width  = wrap.clientWidth || 200;
  canvas.height = 60;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (!history || history.length === 0) {
    ctx.fillStyle = '#222';
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('No data', canvas.width / 2, 34);
    return;
  }

  const data = history.slice(-50);
  const maxVal = Math.max(...data.map(d => (d.input||0) + (d.output||0)), 1);
  const bw = (canvas.width - 10) / Math.max(data.length, 1);
  const ch = canvas.height - 14;

  // Grid
  ctx.strokeStyle = '#1a1a2e';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = Math.round(2 + ch * (1 - i/4));
    ctx.beginPath(); ctx.moveTo(5, y); ctx.lineTo(canvas.width - 5, y); ctx.stroke();
  }

  // Bars
  data.forEach((d, i) => {
    const inp = (d.input||0);
    const out = (d.output||0);
    const total = inp + out;
    const barH = ch * total / maxVal;
    const inpH = barH * (inp / (total||1));
    const outH = barH - inpH;
    const x = 5 + i * bw;
    const barW = Math.max(bw - 1, 1);

    // input (bottom)
    ctx.fillStyle = '#00ff4188';
    ctx.fillRect(x, 2 + ch - barH, barW, inpH);
    // output (top)
    ctx.fillStyle = '#00d4ff88';
    ctx.fillRect(x, 2 + ch - barH + inpH, barW, outH);
  });

  // Labels
  ctx.fillStyle = '#333';
  ctx.font = '9px monospace';
  ctx.textAlign = 'left';
  ctx.fillText('0', 5, canvas.height - 2);
  ctx.textAlign = 'right';
  ctx.fillText(fmtK(maxVal), canvas.width - 5, 12);
}

// ── Clock / timers ──
function fmtDuration(ms) {
  if (!ms || ms < 0) return '00:00:00';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return pad(h) + ':' + pad(m) + ':' + pad(sec);
}
function pad(n) { return n < 10 ? '0'+n : String(n); }
function fmt(n)  { return (n||0).toLocaleString(); }
function fmtK(n) { return n >= 1000 ? (n/1000).toFixed(1)+'k' : String(n); }

setInterval(() => {
  // Live clock
  document.getElementById('live-clock').textContent = new Date().toLocaleString('en-GB', { hour12: false });

  // Session timer
  if (sessionStart) {
    const elapsed = Date.now() - sessionStart;
    document.getElementById('session-timer').textContent = fmtDuration(elapsed);
  }

  // Re-draw last-event timer
  if (lastStats && lastStats.lastActivityTime) {
    const ago = Math.floor((Date.now() - lastStats.lastActivityTime) / 1000);
    const el = document.getElementById('sys-last');
    if (el) el.textContent = ago < 60 ? ago + 's ago' : Math.floor(ago/60) + 'm ago';
  }

  // Update EPM display (purge old timestamps)
  const now2 = Date.now();
  while (epmTimestamps.length && epmTimestamps[0] < now2 - 60000) epmTimestamps.shift();
  document.getElementById('epm-val').textContent = epmTimestamps.length;
}, 1000);
</script>
</body>
</html>`;

// ─── WebSocket Upgrade ────────────────────────────────────────────────────────
// Minimal WebSocket server (using 'ws' npm module)
let WebSocketServer;
try {
  WebSocketServer = require('ws').Server;
} catch (e) {
  console.error('ws module not found. Run: npm install');
  process.exit(1);
}

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  wsClients.add(ws);

  // Send history
  const hist = entries.slice(-HISTORY_SIZE);
  try {
    ws.send(JSON.stringify({ type: 'history', entries: hist }));
  } catch (_) {}

  // Send current stats
  try {
    ws.send(JSON.stringify(buildStatsSnapshot()));
  } catch (_) {}

  ws.on('close', () => wsClients.delete(ws));
  ws.on('error', () => wsClients.delete(ws));
});

server.listen(PORT, () => {
  console.log('[claude-monitor] Server listening on http://0.0.0.0:' + PORT);
  console.log('[claude-monitor] Watching: ' + CLAUDE_DIR);
  console.log('[claude-monitor] Stats: ' + STATS_FILE);
});

// ─── Graceful Shutdown ────────────────────────────────────────────────────────
function shutdown(sig) {
  console.log('[claude-monitor] Received ' + sig + ', shutting down...');
  saveStats();

  // Close all file descriptors
  for (const [, state] of watchedFiles) {
    try { fs.closeSync(state.fd); } catch (_) {}
  }
  watchedFiles.clear();

  // Close WebSocket clients
  for (const ws of wsClients) {
    try { ws.close(); } catch (_) {}
  }

  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  console.error('[claude-monitor] Uncaught exception:', err.message);
  // Don't crash — log and continue
});
process.on('unhandledRejection', (reason) => {
  console.error('[claude-monitor] Unhandled rejection:', reason);
});
