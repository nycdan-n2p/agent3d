// Bridge: connects to a running Pixel Agents standalone server, keeps a compact
// agent state, streams it to the browser over SSE, and lets the "floor manager"
// launch agents and type prompts into terminals that Pixel Agents owns.
// No npm dependencies. Node 22+ (global WebSocket).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createPlayroom } from './play.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 4900);
const LEGO_CLI = path.join(__dirname, 'lego.mjs');
const PLAYROOM = path.join(__dirname, 'playroom');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- discover the pixel-agents server (port + token) ----------
function discover() {
  const dir = path.join(os.homedir(), '.pixel-agents', 'servers');
  let regs = [];
  try {
    regs = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } })
      .filter((r) => r && r.port && r.standalone)
      .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  } catch { /* none */ }
  if (process.env.PIXEL_AGENTS_PORT) {
    const p = Number(process.env.PIXEL_AGENTS_PORT);
    return { port: p, token: regs.find((r) => r.port === p)?.token || process.env.PIXEL_AGENTS_TOKEN || null };
  }
  for (const r of regs) { try { process.kill(r.pid, 0); return { port: r.port, token: r.token || null }; } catch { /* dead */ } }
  return regs[0] ? { port: regs[0].port, token: regs[0].token || null } : { port: null, token: null };
}

// ---------- state ----------
const agents = new Map(); // id -> agent
let upstream = { connected: false, port: null, privileged: false };
let token = null;

function ensure(id) {
  let a = agents.get(id);
  if (!a) {
    a = {
      id, directoryName: null, isExternal: false, parentAgentId: null, teammateName: null, teamName: null,
      palette: null, hueShift: 0, status: 'idle', awaitingInput: false, permission: false, hasTerminal: false,
      tools: {}, subagents: {}, contextTokens: 0, maxContextTokens: 0, lastEvent: Date.now(), createdAt: Date.now(), log: [],
      jsonlFile: null, ask: null,
    };
    agents.set(id, a);
  }
  return a;
}
function logEvent(a, kind, text) {
  a.log.push({ t: Date.now(), kind, text: String(text || '').slice(0, 120) });
  if (a.log.length > 40) a.log.splice(0, a.log.length - 40);
}
const sseClients = new Set();
let dirty = false;
function broadcast(obj) { const line = `data: ${JSON.stringify(obj)}\n\n`; for (const res of sseClients) res.write(line); }
function snapshot() { return { type: 'state', upstream, agents: [...agents.values()], play: play.meta() }; }
function markDirty() { dirty = true; }
setInterval(() => { if (dirty) { dirty = false; broadcast(snapshot()); } }, 50);
function fx(kind, id, extra = {}) { broadcast({ type: 'fx', kind, id, ...extra }); }
const play = createPlayroom({ buildsDir: path.join(__dirname, 'builds'), cli: LEGO_CLI, broadcast, fx, markDirty, present: (id) => agents.has(id) });

// ---------- what does the agent want? (read from its transcript) ----------
function summarizeInput(name, input = {}) {
  if (name === 'Bash') return input.command || '';
  if (name === 'Write' || name === 'Edit' || name === 'NotebookEdit' || name === 'Read') return input.file_path || input.notebook_path || '';
  if (name === 'WebFetch' || name === 'WebSearch') return input.url || input.query || '';
  const s = JSON.stringify(input); return s.length > 220 ? s.slice(0, 219) + '…' : s;
}
const WRAP_UP_TOOL = /(^|__)wrap_up$/;
function isHumanTurn(rec) {
  if (rec.type !== 'user' || rec.isSidechain) return false;
  const c = rec.message?.content;
  if (typeof c === 'string') return true;
  return Array.isArray(c) && !c.some((b) => b.type === 'tool_result');
}
// Last tool call of the agent's current turn (null if the turn has none, or the file can't be read).
function lastToolUse(a) {
  if (!a.jsonlFile) return null;
  let text;
  try {
    const fd = fs.openSync(a.jsonlFile, 'r'); const size = fs.fstatSync(fd).size; const len = Math.min(size, 400000);
    const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, size - len); fs.closeSync(fd); text = buf.toString('utf8');
  } catch { return null; }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]; if (!line.includes('"tool_use"') && !line.includes('"user"')) continue;
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    if (isHumanTurn(rec)) return null; // reached the prompt that started this turn
    if (rec.type !== 'assistant' || rec.isSidechain) continue;
    const content = rec.message?.content; if (!Array.isArray(content)) continue;
    const uses = content.filter((b) => b.type === 'tool_use'); if (!uses.length) continue;
    return uses[uses.length - 1];
  }
  return null;
}
function askFromToolUse(found) {
  let ask;
  if (found.name === 'AskUserQuestion' && Array.isArray(found.input?.questions) && found.input.questions.length) {
    const q = found.input.questions[0];
    ask = { kind: 'question', tool: found.name, question: q.question || '', header: q.header || '', multi: !!q.multiSelect, options: (q.options || []).map((o) => ({ label: o.label, description: o.description || '' })) };
  } else if (WRAP_UP_TOOL.test(found.name) && found.input?.ask) {
    // Claude desktop app's end-of-turn box: the question lives in `ask`, the buttons in `actions`.
    const actions = Array.isArray(found.input.actions) ? found.input.actions : [];
    ask = { kind: 'question', tool: found.name, question: String(found.input.ask), header: 'next step', multi: false, recap: String(found.input.recap || ''), options: actions.map((o) => ({ label: o.label || o.action || 'ok', description: o.message || '' })) };
  } else {
    ask = { kind: 'permission', tool: found.name, summary: summarizeInput(found.name, found.input), description: found.input?.description || '' };
  }
  ask.toolUseId = found.id;
  return ask;
}
function refreshAsk(a) {
  const wants = a.permission || a.awaitingInput;
  if (!wants) { if (a.ask) { a.ask = null; markDirty(); } return; }
  const found = lastToolUse(a); if (!found) return;
  const ask = askFromToolUse(found);
  if (JSON.stringify(a.ask) !== JSON.stringify(ask)) { a.ask = ask; markDirty(); }
}
// A turn that ends with a wrap_up question (desktop app) is not a blocking prompt, so Pixel Agents
// reports a plain turn end; treat it as the agent waiting on an answer anyway.
function detectWrapUpAsk(a) {
  if (a.status !== 'waiting' || a.awaitingInput || a.permission) return false;
  const found = lastToolUse(a);
  if (!found || !WRAP_UP_TOOL.test(found.name) || !found.input?.ask) return false;
  a.awaitingInput = true; return true;
}
setInterval(() => { for (const a of agents.values()) if (a.permission || a.awaitingInput) refreshAsk(a); if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'requestDiagnostics' })); }, 2500);

const listeners = new Set(); // one-shot listeners on upstream messages (for launch waits)
function reduce(m) {
  for (const l of listeners) { try { l(m); } catch { /* ignore */ } }
  switch (m.type) {
    case 'agentDiagnostics': { for (const d of m.agents || []) { const a = agents.get(d.id); if (a && d.jsonlFile && a.jsonlFile !== d.jsonlFile) { a.jsonlFile = d.jsonlFile; refreshAsk(a); } } break; }
    case 'existingAgents': {
      const meta = m.agentMeta || {}, dirs = m.directoryNames || {}, ext = m.externalAgents || {};
      for (const id of m.agents || []) {
        const a = ensure(id);
        a.directoryName = dirs[id] ?? a.directoryName;
        a.isExternal = !!ext[id];
        if (meta[id]) { a.palette = meta[id].palette ?? a.palette; a.hueShift = meta[id].hueShift ?? a.hueShift; }
      }
      markDirty(); break;
    }
    case 'agentCreated': {
      const a = ensure(m.id);
      a.directoryName = m.directoryName ?? a.directoryName;
      a.isExternal = !!m.isExternal;
      a.parentAgentId = m.parentAgentId ?? null;
      a.teammateName = m.teammateName ?? null;
      a.teamName = m.teamName ?? null;
      a.palette = m.palette ?? a.palette; a.hueShift = m.hueShift ?? a.hueShift;
      markDirty(); fx('agentCreated', m.id); break;
    }
    case 'agentClosed': agents.delete(m.id); detachTerminal(m.id); markDirty(); fx('agentClosed', m.id); break;
    case 'terminalSessionOpened': { const a = ensure(m.agentId); a.hasTerminal = true; attachTerminal(m.agentId); markDirty(); break; }
    case 'terminalSessionClosed': { const a = ensure(m.agentId); a.hasTerminal = false; detachTerminal(m.agentId); markDirty(); break; }
    case 'agentStatus': {
      const a = ensure(m.id);
      const was = a.status;
      a.status = m.status === 'active' ? 'active' : 'waiting';
      a.awaitingInput = !!m.awaitingInput;
      a.permission = false; // a status change means the prompt was resolved
      a.lastEvent = Date.now();
      const wrapUpAsk = detectWrapUpAsk(a);
      refreshAsk(a); markDirty();
      if (was === 'active' && a.status === 'waiting') { fx('turnEnd', m.id, { asked: a.awaitingInput }); logEvent(a, 'turn', a.awaitingInput ? 'asked you a question' : 'finished its turn'); }
      if (a.status === 'active' && was !== 'active') { fx('turnStart', m.id); logEvent(a, 'turn', 'started working'); }
      break;
    }
    case 'agentToolStart': {
      const a = ensure(m.id);
      a.tools[m.toolId] = { toolName: m.toolName || 'Tool', status: m.status || '', runInBackground: !!m.runInBackground, startedAt: Date.now() };
      a.status = 'active'; a.lastEvent = Date.now();
      if (m.permissionActive) a.permission = true;
      logEvent(a, 'tool', m.status || m.toolName);
      markDirty(); fx('toolStart', m.id, { toolName: m.toolName, status: m.status });
      break;
    }
    case 'agentToolDone': {
      const a = ensure(m.id); const t = a.tools[m.toolId];
      delete a.tools[m.toolId]; a.lastEvent = Date.now(); markDirty();
      fx('toolDone', m.id, { toolName: t?.toolName }); break;
    }
    case 'agentToolsClear': { const a = ensure(m.id); a.tools = {}; a.subagents = {}; a.permission = false; refreshAsk(a); markDirty(); break; }
    case 'agentToolPermission': { const a = ensure(m.id); if (!a.permission) logEvent(a, 'permission', 'waiting for your approval'); a.permission = true; refreshAsk(a); markDirty(); fx('permission', m.id); break; }
    case 'agentToolPermissionClear': { const a = ensure(m.id); a.permission = false; refreshAsk(a); markDirty(); break; }
    case 'agentTeamInfo': {
      const a = ensure(m.id); a.teamName = m.teamName ?? a.teamName; a.teammateName = m.agentName ?? a.teammateName;
      a.parentAgentId = m.leadAgentId ?? a.parentAgentId; markDirty(); break;
    }
    case 'agentContextUsage': { const a = ensure(m.id); a.contextTokens = m.contextTokens || 0; a.maxContextTokens = m.maxContextTokens || 0; markDirty(); break; }
    case 'subagentStart': {
      const a = ensure(m.id); const key = m.toolId || m.parentToolId;
      a.subagents[key] = { parentToolId: m.parentToolId, toolName: m.toolName || 'subagent', tool: null, startedAt: Date.now() };
      logEvent(a, 'subagent', `spawned sub-agent: ${m.toolName || 'subagent'}`); markDirty(); fx('subagentStart', m.id); break;
    }
    case 'subagentEnd': case 'subagentClear': {
      const a = ensure(m.id);
      for (const k of Object.keys(a.subagents)) if (k === m.toolId || a.subagents[k].parentToolId === m.parentToolId) delete a.subagents[k];
      markDirty(); break;
    }
    case 'subagentToolStart': {
      const a = ensure(m.id); const s = a.subagents[m.parentToolId] || Object.values(a.subagents).find((x) => x.parentToolId === m.parentToolId);
      if (s) s.tool = m.toolName || m.status || 'tool'; markDirty(); break;
    }
    case 'subagentToolDone': {
      const a = ensure(m.id); const s = a.subagents[m.parentToolId] || Object.values(a.subagents).find((x) => x.parentToolId === m.parentToolId);
      if (s) s.tool = null; markDirty(); break;
    }
    default: break;
  }
}

// ---------- upstream websocket ----------
let ws = null;
function connectUpstream() {
  const d = discover();
  upstream.port = d.port; token = d.token; upstream.privileged = !!token;
  if (!d.port) { console.log('[bridge] no pixel-agents server found; retrying in 3s'); markDirty(); return setTimeout(connectUpstream, 3000); }
  const url = `ws://127.0.0.1:${d.port}/ws${token ? `?token=${encodeURIComponent(token)}` : ''}`;
  console.log(`[bridge] connecting to ws://127.0.0.1:${d.port}/ws (${token ? 'privileged' : 'read-only'})`);
  try { ws = new WebSocket(url); } catch (e) { console.log('[bridge] ws error', e.message); return setTimeout(connectUpstream, 3000); }
  ws.onopen = () => { upstream.connected = true; ws.send(JSON.stringify({ type: 'webviewReady' })); ws.send(JSON.stringify({ type: 'requestDiagnostics' })); console.log('[bridge] connected'); markDirty(); };
  ws.onmessage = (ev) => { try { reduce(JSON.parse(ev.data)); } catch { /* ignore */ } };
  ws.onclose = () => { upstream.connected = false; agents.clear(); for (const id of [...terminals.keys()]) detachTerminal(id); markDirty(); console.log('[bridge] disconnected; reconnecting'); setTimeout(connectUpstream, 2000); };
  ws.onerror = () => { /* onclose follows */ };
}
connectUpstream();
function sendUpstream(obj) { if (ws && ws.readyState === 1) { ws.send(JSON.stringify(obj)); return true; } return false; }

// ---------- terminals (only for agents pixel-agents launched) ----------
const terminals = new Map(); // id -> { ws, buf, ready }
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>]|\x1b\[\?[0-9;]*[hl]/g;
function stripAnsi(s) { return s.replace(ANSI, '').replace(/\r/g, ''); }
function attachTerminal(id) {
  if (terminals.has(id) || !token || !upstream.port) return;
  const t = { ws: null, buf: '', ready: false };
  terminals.set(id, t);
  const url = `ws://127.0.0.1:${upstream.port}/terminal/${id}?token=${encodeURIComponent(token)}`;
  try { t.ws = new WebSocket(url); } catch { terminals.delete(id); return; }
  t.ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'replay') { t.buf = m.data || ''; t.ready = true; }
    else if (m.type === 'output') { t.buf += m.data || ''; if (t.buf.length > 64000) t.buf = t.buf.slice(-48000); }
  };
  t.ws.onclose = () => { if (terminals.get(id) === t) terminals.delete(id); };
  t.ws.onerror = () => { /* onclose follows */ };
}
function detachTerminal(id) { const t = terminals.get(id); if (t) { try { t.ws?.close(); } catch { /* ignore */ } terminals.delete(id); } }
function terminalText(id) {
  const t = terminals.get(id); if (!t) return null;
  const text = stripAnsi(t.buf);
  return text.split('\n').map((l) => l.replace(/\s+$/, '')).filter((l, i, arr) => l || (arr[i - 1] && arr[i - 1].trim())).slice(-40).join('\n');
}
async function typeInto(id, text, enter = true) {
  const t = terminals.get(id);
  if (!t || !t.ws || t.ws.readyState !== 1) throw new Error('no terminal for that agent');
  t.ws.send(JSON.stringify({ type: 'input', data: text }));
  if (enter) { await sleep(250); t.ws.send(JSON.stringify({ type: 'input', data: '\r' })); }
}
// Wait until a freshly launched session shows its input box. Startup dialogs ("Try the new
// fullscreen renderer?" and the like) also draw a ❯, and a prompt typed into one is lost,
// so those get dismissed with Esc. The folder-trust dialog is accepted only when asked to.
async function waitForPrompt(id, { timeoutMs = 30000, acceptTrust = false } = {}) {
  const start = Date.now(); let trusted = false;
  while (Date.now() - start < timeoutMs) {
    const t = terminals.get(id);
    if (t && t.ready) {
      const tail = stripAnsi(t.buf).slice(-3000);
      if (/trust (?:this folder|the files)/i.test(tail)) {
        if (!acceptTrust || trusted) return false;
        trusted = true; t.buf = ''; await typeInto(id, '\r', false); await sleep(1500); continue;
      }
      if (/Esc\s*to\s*cancel/i.test(tail)) { t.buf = ''; await typeInto(id, '\u001b', false); await sleep(1200); continue; }
      if (/for shortcuts/i.test(tail) || /❯\s*Try "/.test(tail) || /^\s*[›❯>]\s*$/m.test(tail)) return true;
    }
    await sleep(400);
  }
  return false;
}

// ---------- floor manager ----------
const SEARCH_DIRS = ['Downloads', 'Documents', 'Desktop', 'code', 'projects', 'src', 'dev', ''].map((d) => path.join(os.homedir(), d));
function resolveDir(name) {
  if (!name) return null;
  let n = name.replace(/^["']|["']$/g, '').replace(/[:,.]$/, '');
  if (n.startsWith('~')) n = path.join(os.homedir(), n.slice(1));
  if (path.isAbsolute(n)) return fs.existsSync(n) ? n : null;
  for (const base of SEARCH_DIRS) { const p = path.join(base, n); try { if (fs.statSync(p).isDirectory()) return p; } catch { /* next */ } }
  // fuzzy: case-insensitive prefix in search dirs
  for (const base of SEARCH_DIRS) {
    try { const hit = fs.readdirSync(base).find((f) => f.toLowerCase().startsWith(n.toLowerCase()) && fs.statSync(path.join(base, f)).isDirectory()); if (hit) return path.join(base, hit); } catch { /* next */ }
  }
  return null;
}
function agentName(a) { return a.teammateName || a.directoryName || `agent ${a.id}`; }
function findAgent(name) {
  const n = name.toLowerCase().replace(/^@/, '');
  const list = [...agents.values()];
  const exact = list.filter((a) => agentName(a).toLowerCase() === n || String(a.id) === n || `agent ${a.id}` === n);
  const loose = list.filter((a) => agentName(a).toLowerCase().includes(n) || n.includes(agentName(a).toLowerCase()));
  const pool = exact.length ? exact : loose;
  if (!pool.length) return null;
  // prefer one we can type into, then the most recently active
  pool.sort((p, q) => (q.hasTerminal - p.hasTerminal) || (q.lastEvent - p.lastEvent));
  return pool[0];
}
function parseRequest(text) {
  const t = text.trim();
  let m;
  if ((m = t.match(/^(?:new|start|launch|spawn|open)\s+(?:an?\s+)?(?:new\s+)?agent\s+(?:in|at|for|on)\s+(\S+)\s*[:,-]?\s*(.*)$/i))) return { kind: 'launch', dir: m[1], prompt: m[2].trim() };
  if ((m = t.match(/^(?:in|at)\s+(\S+)\s*[:,-]\s*(.+)$/i)) && !findAgent(m[1])) return { kind: 'launch', dir: m[1], prompt: m[2].trim() };
  if ((m = t.match(/^@(\S+)\s*[:,-]?\s*(.+)$/))) return { kind: 'agent', name: m[1], prompt: m[2].trim() };
  if ((m = t.match(/^(?:tell|ask|have|get|let|make)\s+(?:the\s+)?(\S+?)(?:\s+agent)?\s+(?:to\s+)?(.+)$/i))) return { kind: 'agent', name: m[1].replace(/[:,]$/, ''), prompt: m[2].trim() };
  if ((m = t.match(/^(\S+?)\s*[:,]\s*(.+)$/))) return { kind: 'agent', name: m[1], prompt: m[2].trim() };
  // mention anywhere
  for (const a of agents.values()) { const n = agentName(a).toLowerCase(); if (n.length > 2 && t.toLowerCase().includes(n)) return { kind: 'agent', name: n, prompt: t }; }
  return { kind: 'any', prompt: t };
}
async function launchAgent(dir) {
  if (!upstream.privileged) throw new Error('bridge is read-only: no token found in ~/.pixel-agents/servers');
  const base = path.basename(dir);
  const created = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { listeners.delete(l); reject(new Error('pixel-agents did not report a new agent')); }, 8000);
    const l = (m) => { if (m.type === 'agentCreated' && !m.isExternal && (m.directoryName === base || !m.directoryName)) { clearTimeout(timer); listeners.delete(l); resolve(m.id); } };
    listeners.add(l);
  });
  if (!sendUpstream({ type: 'launchAgent', directoryPath: dir })) throw new Error('not connected to pixel-agents');
  const id = await created;
  const a = ensure(id); a.hasTerminal = true;
  // terminalSessionOpened arrives right after; make sure we attach
  const t0 = Date.now(); while (!terminals.has(id) && Date.now() - t0 < 3000) { attachTerminal(id); await sleep(200); }
  return id;
}
// ---------- playtime ----------
function parsePlay(text) {
  const t = text.trim();
  if (/^(?:stop|end|finish|quit)\s+(?:the\s+)?(?:playing|play|playtime|game|lego)\b|^(?:playtime(?:'s| is)? over|back to work)\b/i.test(t)) return { kind: 'stop' };
  const m = t.match(/^(?:ok(?:ay)?[,!]?\s+)?(?:let'?s\s+|go\s+|time\s+to\s+)?(?:play(?:time)?|lego)\b[\s:,!.-]*(.*)$/i);
  if (!m) return null;
  let rest = m[1], launch = 0, minutes = 15, k;
  if ((k = rest.match(/\bwith\s+(\d+)(?:\s+(?:new|fresh|more|extra))?(?:\s+(?:agents?|players?|friends?))?/i))) { launch = Math.min(6, Number(k[1])); rest = rest.replace(k[0], ' '); }
  if ((k = rest.match(/\b(?:for\s+)?(\d+)\s*(?:m|mins?|minutes?)\b/i))) { minutes = Math.min(60, Math.max(3, Number(k[1]))); rest = rest.replace(k[0], ' '); }
  const theme = rest.replace(/^[\s:,!.-]+|[\s:,!.-]+$/g, '').replace(/\s{2,}/g, ' ').slice(0, 200);
  return { kind: 'start', theme, launch, minutes };
}
// a folder for fresh players, pre-approved to run the lego command and nothing else new
function preparePlayroom() {
  fs.mkdirSync(path.join(PLAYROOM, '.claude'), { recursive: true });
  const settings = { permissions: { allow: [`Bash(node ${LEGO_CLI}:*)`] } };
  fs.writeFileSync(path.join(PLAYROOM, '.claude', 'settings.json'), JSON.stringify(settings, null, 2) + '\n');
  return PLAYROOM;
}
function playHandle(req) {
  const result = { ok: false, action: 'play', targetId: null, message: '' };
  if (req.kind === 'stop') {
    if (!play.isActive()) { result.message = "Nobody's playing right now."; return { result, deliver: null }; }
    play.end('stopped by you'); result.ok = true; result.message = 'Playtime is over. Back to work, everyone.';
    return { result, deliver: async () => ({ targetId: null, message: 'Board is saved. Back to work.' }) };
  }
  if (play.isActive()) { result.message = `They're already building ${play.describe()}. Say "stop playing" to end it.`; return { result, deliver: null }; }
  if (!upstream.privileged) { result.message = "I can't hand out LEGO: the bridge is read-only (no pixel-agents token found)."; return { result, deliver: null }; }
  const idle = [...agents.values()].filter((a) => a.hasTerminal && !a.parentAgentId && a.status !== 'active' && !a.permission && !a.awaitingInput);
  if (!idle.length && !req.launch) {
    result.message = 'Nobody idle can play: I can only hand LEGO to agents I can type into, and none of them is free. Say "play with 3" and I\'ll bring in fresh players.';
    return { result, deliver: null };
  }
  const n = idle.length + req.launch;
  result.ok = true; result.message = `Playtime! ${n} player${n === 1 ? ' gets' : 's get'} a box of LEGO${req.theme ? `: ${req.theme}` : ''}.`;
  return {
    result,
    deliver: async () => {
      const ids = idle.map((a) => a.id);
      if (req.launch) {
        const dir = preparePlayroom(); const fresh = [];
        for (let i = 0; i < req.launch; i++) fresh.push(await launchAgent(dir));
        await Promise.all(fresh.map((id) => waitForPrompt(id, { acceptTrust: true }))); // we made the playroom, so trusting it is safe
        ids.push(...fresh);
      }
      const players = ids.filter((id) => agents.has(id)).map((id) => ({ id, name: `${agentName(agents.get(id))}#${id}` }));
      if (!players.length) throw new Error('everyone left before the game started');
      play.start({ theme: req.theme, minutes: req.minutes, players });
      for (const p of players) { await typeInto(p.id, play.invite(p.id)); await sleep(300); }
      return { targetId: null, message: `Handed out the LEGO to ${players.length}. They have ${req.minutes} minutes.` };
    },
  };
}

async function managerHandle(text) {
  const playReq = parsePlay(text);
  if (playReq) return playHandle(playReq);
  const req = parseRequest(text);
  const result = { ok: false, action: null, targetId: null, message: '' };
  if (req.kind === 'launch') {
    const dir = resolveDir(req.dir);
    if (!dir) { result.message = `I can't find a folder called "${req.dir}". Give me a full path or a folder under Downloads, Documents or Desktop.`; return { result, deliver: null }; }
    result.action = 'launch'; result.message = `Launching a new agent in ${path.basename(dir)}…`; result.ok = true;
    return { result, deliver: async () => { const id = await launchAgent(dir); fx('managerTarget', id, { text }); const ready = await waitForPrompt(id); if (req.prompt) { await sleep(ready ? 600 : 0); await typeInto(id, req.prompt); } return { targetId: id, message: req.prompt ? `Handed the task to the new ${path.basename(dir)} agent.` : `New agent is up in ${path.basename(dir)}.` }; } };
  }
  let target = null;
  if (req.kind === 'agent') {
    target = findAgent(req.name);
    if (!target) { result.message = `Nobody here is called "${req.name}". Say "new agent in <folder>: <task>" and I'll bring someone in.`; return { result, deliver: null }; }
  } else {
    const pool = [...agents.values()].filter((a) => a.hasTerminal).sort((p, q) => (p.status === 'active') - (q.status === 'active') || q.lastEvent - p.lastEvent);
    target = pool[0] || null;
    if (!target) { result.message = `Nobody on the floor can take dictation yet: your desktop sessions have no terminal I can type into. Say "new agent in <folder>: <task>" and I'll launch one.`; return { result, deliver: null }; }
  }
  result.targetId = target.id;
  if (!target.hasTerminal) {
    result.message = `${agentName(target)} is a desktop session: I can walk over, but I can't type into that window. Paste it there yourself, or say "new agent in ${target.directoryName || '<folder>'}: ${req.prompt}" and I'll launch one who listens.`;
    result.action = 'nudge'; result.ok = false; return { result, deliver: null };
  }
  result.ok = true; result.action = 'type'; result.message = `On it. Telling ${agentName(target)}…`;
  return { result, deliver: async () => { await typeInto(target.id, req.prompt); return { targetId: target.id, message: `Told ${agentName(target)}. They're on it.` }; } };
}

// ---------- http ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
function readBody(req) { return new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); }); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } }); }); }
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    res.write(`data: ${JSON.stringify(play.boardMsg())}\n\n`);
    sseClients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
    return;
  }
  if (url.pathname === '/api/state') return json(res, 200, snapshot());
  if (url.pathname === '/api/manager' && req.method === 'POST') {
    const { text } = await readBody(req);
    if (!text || typeof text !== 'string') return json(res, 400, { ok: false, message: 'say something' });
    try {
      const { result, deliver } = await managerHandle(text.slice(0, 4000));
      json(res, 200, result);
      fx('managerSay', result.targetId, { text, message: result.message, ok: result.ok, action: result.action });
      if (deliver) {
        deliver().then((r) => fx('managerDone', r.targetId, { ok: true, message: r.message, text }))
          .catch((e) => fx('managerDone', result.targetId, { ok: false, message: `That didn't work: ${e.message}`, text }));
      }
    } catch (e) { json(res, 500, { ok: false, message: e.message }); }
    return;
  }
  let m;
  if ((m = url.pathname.match(/^\/api\/lego\/(\w+)$/)) && req.method === 'POST') {
    try { return json(res, 200, await play.api(m[1], await readBody(req))); } catch (e) { return json(res, 500, { ok: false, text: e.message }); }
  }
  if ((m = url.pathname.match(/^\/api\/agents\/(\d+)\/terminal$/))) {
    const id = Number(m[1]); const a = agents.get(id);
    return json(res, 200, { hasTerminal: !!a?.hasTerminal, text: terminalText(id) });
  }
  if ((m = url.pathname.match(/^\/api\/agents\/(\d+)\/input$/)) && req.method === 'POST') {
    const id = Number(m[1]); const { data, enter } = await readBody(req);
    try { await typeInto(id, String(data ?? ''), enter !== false); return json(res, 200, { ok: true }); } catch (e) { return json(res, 400, { ok: false, message: e.message }); }
  }
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  p = path.normalize(p).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(PUBLIC, p);
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});
server.listen(PORT, '127.0.0.1', () => console.log(`\n  Agent Office 3D at http://127.0.0.1:${PORT}\n`));
