// Bridge: connects to a running Pixel Agents standalone server, keeps a compact
// agent state, streams it to the browser over SSE, and lets the "floor manager"
// launch agents and type prompts into terminals that Pixel Agents owns.
// No npm dependencies. Node 22+ (global WebSocket).

import http from 'node:http';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
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
      dept: 'engineering', deptReason: '', deptManual: false, prompt: '', role: null,
      humanName: pickHumanName(), nickname: null,
    };
    agents.set(id, a); applyRole(a);
  }
  return a;
}
// ---------- names: every agent gets a human first name; you can rename them ----------
// Names are remembered per transcript file, so a session keeps its name across bridge restarts.
const HUMAN_NAMES = ['Maya', 'Noah', 'Lior', 'Ava', 'Eli', 'Zoe', 'Omar', 'Nina', 'Theo', 'Ruby', 'Ari', 'Lena', 'Milo', 'Iris', 'Ezra', 'Tess',
  'Jonah', 'Clara', 'Felix', 'Hana', 'Leo', 'Mira', 'Sam', 'Ivy', 'Oscar', 'Dana', 'Hugo', 'Yael', 'Max', 'Nora', 'Ben', 'Lila', 'Adam', 'Rosa', 'Kai', 'Talia'];
// Every name comes with a job. Ezra is always Security, Felix always UI / UX: the floor is a team of
// specialists, and the manager routes work to whoever has the right job. "make <name> qa" overrides it.
const NAME_ROLES = {};
for (const n of ['Ezra', 'Omar', 'Yael', 'Max', 'Hugo', 'Kai', 'Dana']) NAME_ROLES[n] = 'security';
for (const n of ['Felix', 'Iris', 'Lila', 'Rosa', 'Clara', 'Mira', 'Zoe']) NAME_ROLES[n] = 'uiux';
for (const n of ['Nora', 'Nina', 'Tess', 'Theo', 'Ruby', 'Leo', 'Ivy', 'Talia']) NAME_ROLES[n] = 'qa';
for (const n of HUMAN_NAMES) NAME_ROLES[n] ??= 'engineering';
function roleOf(a) { return a.role || NAME_ROLES[String(a.humanName || '').split(' ')[0]] || 'engineering'; }
function applyRole(a) { const d = roleOf(a); if (a.dept !== d) { a.dept = d; a.deptReason = a.role ? 'assigned by you' : `${a.humanName}'s job`; markDirty(); } }
const NAMES_FILE = path.join(__dirname, 'names.json');
let savedNames = {}; // jsonlFile -> { humanName, nickname, role }
try { savedNames = JSON.parse(fs.readFileSync(NAMES_FILE, 'utf8')) || {}; } catch { /* none yet */ }
function pickHumanName(role = null) {
  const taken = new Set([...agents.values()].flatMap((a) => [a.humanName, a.nickname]));
  const names = role ? HUMAN_NAMES.filter((n) => NAME_ROLES[n] === role) : HUMAN_NAMES;
  const free = names.filter((n) => !taken.has(n));
  const pool = free.length ? free : names;
  const n = pool[Math.floor(Math.random() * pool.length)];
  return free.length ? n : `${n} ${taken.size}`;
}
function saveName(a) {
  if (!a.jsonlFile) return;
  savedNames[a.jsonlFile] = { humanName: a.humanName, nickname: a.nickname, role: a.role || null };
  fs.writeFile(NAMES_FILE, JSON.stringify(savedNames, null, 1) + '\n', () => {});
}
function adoptSavedName(a) {
  const s = savedNames[a.jsonlFile];
  if (s) { a.humanName = s.humanName || a.humanName; a.nickname = s.nickname || null; a.role = s.role || null; } else saveName(a);
  applyRole(a);
}
function cleanName(s) { return String(s || '').replace(/[\x00-\x1f\x7f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24); }
function renameAgent(a, name) {
  const n = cleanName(name); a.nickname = n || null;
  logEvent(a, 'name', n ? `renamed to ${n}` : `name reset to ${a.humanName}`); saveName(a); markDirty();
  return agentName(a);
}
function logEvent(a, kind, text) {
  a.log.push({ t: Date.now(), kind, text: String(text || '').slice(0, 120) });
  if (a.log.length > 40) a.log.splice(0, a.log.length - 40);
}
const sseClients = new Set();
let dirty = false;
function broadcast(obj) { const line = `data: ${JSON.stringify(obj)}\n\n`; for (const res of sseClients) res.write(line); }
function snapshot() { return { type: 'state', upstream, agents: [...agents.values()], play: play.meta(), issues, beads: beadsOk }; }
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

// ---------- departments: where in the office is this agent working right now? ----------
// Each tool call (and the prompt that started the turn) is matched against the rules; the first
// department that matches wins, and the agent stays there until a different department matches.
// Editing an ordinary code file brings an agent back to Engineering.
const DEPT_NAMES = { engineering: 'Engineering', qa: 'QA', uiux: 'UI / UX', security: 'Security' };
const DEPT_RULES = [
  ['security', /\b(security|audit|vulnerab\w*|cve-?\d*|secrets?|credentials?|owasp|pentest|xss|csrf|sqli|injection|semgrep|snyk|trivy|gitleaks|bandit|security-review|security-report)\b/i],
  ['qa', /\b(tests?|testing|specs?|jest|vitest|mocha|pytest|unittest|playwright|cypress|selenium|coverage|lint|linter|eslint|ruff|flake8|tsc|typecheck|type-check|qa|e2e|regression|smoke|verify|verification|replay-qa)\b|\.(test|spec)\.[jt]sx?\b|_test\.(go|py)\b/i],
  ['uiux', /\.(css|scss|sass|less|html?|svg|vue|svelte)\b|\b(ui|ux|ui\/ux|design|designer|styling|styles?|stylesheet|layout|responsive|frontend|front-end|tailwind|figma|screenshot|mockup|wireframe|artifact|theme|dark mode|fonts?|typography|icons?|animation|three\.js|canvas)\b/i],
];
const DEPT_ALIASES = { eng: 'engineering', engineering: 'engineering', dev: 'engineering', qa: 'qa', test: 'qa', testing: 'qa', ui: 'uiux', ux: 'uiux', uiux: 'uiux', 'ui/ux': 'uiux', design: 'uiux', sec: 'security', security: 'security' };
function classifyText(text) { for (const [d, re] of DEPT_RULES) if (re.test(text || '')) return d; return null; }
function setDept(a, dept, reason = '') {
  if (!dept || a.dept === dept) return false;
  a.dept = dept; a.deptReason = reason.slice(0, 120);
  logEvent(a, 'dept', `moved to ${DEPT_NAMES[dept]}${reason ? ` (${reason})` : ''}`); markDirty(); fx('dept', a.id, { dept, reason: a.deptReason });
  return true;
}
function assignRole(a, dept, reason = 'assigned by you') { // a lasting job change, remembered with the name
  a.role = dept; const changed = setDept(a, dept, reason); saveName(a); return changed;
}
// The transcript of the current turn: the prompt that started it, the assistant's text, and the
// desktop app's wrap-up recap when there is one.
function readTail(file, max = 600000) {
  try {
    const fd = fs.openSync(file, 'r'); const size = fs.fstatSync(fd).size; const len = Math.min(size, max);
    const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, size - len); fs.closeSync(fd); return buf.toString('utf8');
  } catch { return ''; }
}
const NOISE_TAGS = /<(system-reminder|command-message|command-name|command-args|local-command-stdout|local-command-stderr|ide_[a-z_]+|pasted_content[^>]*)>[\s\S]*?<\/\1>|<(?:system-reminder|command-[a-z-]+)>[\s\S]*$/g;
function humanText(rec) {
  const c = rec.message?.content;
  const s = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text || '').join('\n') : '';
  return s.replace(NOISE_TAGS, '').replace(/\[Image:[^\]]*\]/g, '').replace(/\s{3,}/g, '\n\n').trim().slice(0, 600);
}
function turnInfo(a) {
  if (!a.jsonlFile) return null;
  const text = readTail(a.jsonlFile); if (!text) return null;
  const lines = text.split('\n'); const texts = []; let recap = ''; let prompt = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]; if (!line.includes('"type"')) continue;
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    if (isHumanTurn(rec)) { prompt = humanText(rec); break; }
    if (rec.type !== 'assistant' || rec.isSidechain) continue;
    const content = rec.message?.content; if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b.type === 'text' && b.text && b.text.trim()) texts.unshift(b.text.trim());
      if (b.type === 'tool_use' && WRAP_UP_TOOL.test(b.name) && b.input?.recap && !recap) recap = String(b.input.recap);
    }
  }
  return { prompt, texts, recap };
}
function classifyTurnStart(a) { // remember what the turn is about (shown on the agent's screen)
  setTimeout(() => { const info = turnInfo(a); if (info && info.prompt && info.prompt !== a.prompt) { a.prompt = info.prompt; markDirty(); } }, 400);
}

// ---------- reports: what an agent hands in when its turn ends ----------
const REPORTS_FILE = path.join(__dirname, 'reports.jsonl');
const reports = []; let reportSeq = 0;
try { for (const line of fs.readFileSync(REPORTS_FILE, 'utf8').split('\n')) { if (!line.trim()) continue; try { const r = JSON.parse(line); reports.push(r); reportSeq = Math.max(reportSeq, r.id || 0); } catch { /* skip */ } } } catch { /* none yet */ }
if (reports.length > 300) reports.splice(0, reports.length - 300);
const pendingReplies = new Map(); // agentId -> { text, t, issueId } : the manager relayed your words there and you want the answer

// ---------- beads: the floor manager files an issue for every task he hands out ----------
// Issues live in this folder's .beads database (the `bd` CLI). The manager creates one when he types
// a task into an agent, and closes it with the agent's report as the note when the report comes back.
const BD = process.env.BD_BIN || 'bd';
const beadsOk = fs.existsSync(path.join(__dirname, '.beads'));
function bd(args, { timeoutMs = 20000, actor = 'floor-manager' } = {}) {
  return new Promise((resolve, reject) => execFile(BD, args, { cwd: __dirname, timeout: timeoutMs, maxBuffer: 4e6, env: { ...process.env, BEADS_ACTOR: actor } },
    (err, stdout, stderr) => err ? reject(new Error(String(stderr || err.message).trim().slice(0, 300))) : resolve(String(stdout))));
}
let issues = []; let issuesAt = 0; let issuesRefreshing = null;
function refreshIssues() {
  if (!beadsOk) return Promise.resolve([]);
  if (issuesRefreshing) return issuesRefreshing;
  issuesRefreshing = bd(['list', '--status', 'open,in_progress,blocked', '--json', '--brief', '--sort', 'priority']).then((out) => {
    let list = []; try { list = JSON.parse(out) || []; } catch { list = []; }
    const next = list.map((i) => ({ id: i.id, title: i.title, status: i.status, priority: i.priority ?? 2, type: i.issue_type || 'task', assignee: i.assignee || '', updated: i.updated_at || '' }));
    const changed = JSON.stringify(next) !== JSON.stringify(issues);
    issues = next; issuesAt = Date.now();
    if (changed) { markDirty(); fx('issues', null, { count: issues.length }); }
    return issues;
  }).catch((e) => { console.log('[beads]', e.message); return issues; }).finally(() => { issuesRefreshing = null; });
  return issuesRefreshing;
}
if (beadsOk) { refreshIssues(); setInterval(refreshIssues, 20000); }
async function fileTask({ prompt, from, agent, discoveredFrom = null }) {
  if (!beadsOk) return null;
  const title = prompt.replace(/\s+/g, ' ').trim().slice(0, 90);
  const description = `Handed out by the floor manager in Agent Office.\n\nRequest: ${from}\nAgent: ${agentName(agent)}#${agent.id} (${DEPT_NAMES[agent.dept]}${agent.directoryName ? `, folder ${agent.directoryName}` : ''})`;
  try {
    const out = await bd(['create', '--title', title, '--description', description, '--type', 'task', '--priority', '2', '--assignee', agentName(agent), '--labels', `office,${agent.dept}`, ...(discoveredFrom ? ['--deps', `discovered-from:${discoveredFrom}`] : []), '--json']);
    const id = JSON.parse(out).id; if (!id) return null;
    await bd(['update', id, '--status', 'in_progress']).catch(() => {});
    refreshIssues(); return id;
  } catch (e) { console.log('[beads] create failed:', e.message); return null; }
}
async function settleTask(issueId, r) {
  if (!beadsOk || !issueId) return;
  try {
    const note = `${r.asked ? 'Agent asked a question' : 'Report'} from ${r.name} (${DEPT_NAMES[r.dept]}):\n${(r.text || r.recap).slice(0, 3000)}${r.recap && r.text ? `\n\nRecap: ${r.recap}` : ''}`;
    await bd(['note', issueId, note], { actor: r.name }); // the agent files its own note and closes its own task
    if (!r.asked) await bd(['close', issueId, '--reason', `report filed by ${r.name}`], { actor: r.name });
    refreshIssues();
  } catch (e) { console.log('[beads] settle failed:', e.message); }
}
const chatLog = []; // the conversation with the floor manager, so it survives a reload
function logChat(who, name, text, extra = {}) { chatLog.push({ t: Date.now(), who, name, text: String(text || '').slice(0, 4000), ...extra }); if (chatLog.length > 200) chatLog.shift(); }
function playing(id) { return play.isActive() && (play.meta().players || []).some((p) => p.id === id); }
function captureReport(a, attempt = 0) {
  if (!agents.has(a.id) || playing(a.id)) return;
  const info = turnInfo(a);
  const text = info ? (info.texts[info.texts.length - 1] || '') : '';
  if (!info || (!text && !info.recap)) {
    if (attempt < 3) return setTimeout(() => captureReport(a, attempt + 1), [800, 1500, 3000][attempt]);
    return; // nothing to report (no transcript yet, or a turn with no text)
  }
  const reply = pendingReplies.get(a.id); pendingReplies.delete(a.id); const hops = reply ? (reply.hops || 0) : 0;
  const r = { id: ++reportSeq, agentId: a.id, name: agentName(a), dept: a.dept, t: Date.now(), prompt: info.prompt || a.prompt || '', text: text.slice(0, 6000), recap: info.recap.slice(0, 1000), asked: !!(a.awaitingInput || a.permission), replyTo: reply ? reply.text : null };
  reports.push(r); if (reports.length > 300) reports.shift();
  fs.appendFile(REPORTS_FILE, JSON.stringify(r) + '\n', () => {});
  logEvent(a, 'report', r.asked ? 'asked a question' : `filed a ${DEPT_NAMES[a.dept]} report`);
  if (reply) { r.issueId = reply.issueId || null; logChat('agent', r.name, r.text || r.recap, { agentId: a.id, dept: a.dept, reportId: r.id, issueId: r.issueId }); settleTask(reply.issueId, r); }
  fx('report', a.id, { report: r });
  const h = !r.asked && reply && hops < MAX_HOPS && parseHandoff(r.text);
  if (h && h.dept !== a.dept) dispatchHandoff(a, r, h, hops + 1);
  else if (h) logChat('manager', 'floor manager', `${r.name} asked for a ${DEPT_NAMES[h.dept]} handoff, but that's their own job: ignored.`, { ok: false });
}

const listeners = new Set(); // one-shot listeners on upstream messages (for launch waits)
function reduce(m) {
  for (const l of listeners) { try { l(m); } catch { /* ignore */ } }
  switch (m.type) {
    case 'agentDiagnostics': { for (const d of m.agents || []) { const a = agents.get(d.id); if (a && d.jsonlFile && a.jsonlFile !== d.jsonlFile) { a.jsonlFile = d.jsonlFile; adoptSavedName(a); markDirty(); refreshAsk(a); } } break; }
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
      if (was === 'active' && a.status === 'waiting') { fx('turnEnd', m.id, { asked: a.awaitingInput }); logEvent(a, 'turn', a.awaitingInput ? 'asked you a question' : 'finished its turn'); setTimeout(() => captureReport(a), 700); }
      if (a.status === 'active' && was !== 'active') { fx('turnStart', m.id); logEvent(a, 'turn', 'started working'); classifyTurnStart(a); }
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
function agentName(a) { return a.nickname || a.teammateName || a.humanName || a.directoryName || `agent ${a.id}`; }
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
  if ((m = t.match(/^(?:new|start|launch|spawn|open|hire)\s+(?:an?\s+)?(?:new\s+)?(?:(qa|security|sec|engineering|eng|dev|ui\s*\/?\s*ux|ui|ux|design|test(?:ing)?)\s+)?(?:agent|specialist|engineer|person)\s+(?:in|at|for|on)\s+(\S+)\s*[:,-]?\s*(.*)$/i))) return { kind: 'launch', role: m[1] ? DEPT_ALIASES[m[1].toLowerCase().replace(/\s+/g, '')] : null, dir: m[2], prompt: m[3].trim() };
  if ((m = t.match(/^(?:in|at)\s+(\S+)\s*[:,-]\s*(.+)$/i)) && !findAgent(m[1])) return { kind: 'launch', dir: m[1], prompt: m[2].trim() };
  if ((m = t.match(/^@([^\s:,-]+)\s*[:,-]?\s*(.+)$/))) return { kind: 'agent', name: m[1], prompt: m[2].trim() };
  if ((m = t.match(/^(?:tell|ask|have|get|let|make)\s+(?:the\s+)?(\S+?)(?:\s+agent)?\s+(?:to\s+)?(.+)$/i))) return { kind: 'agent', name: m[1].replace(/[:,]$/, ''), prompt: m[2].trim() };
  if ((m = t.match(/^(\S+?)\s*[:,]\s*(.+)$/))) return DEPT_ALIASES[m[1].toLowerCase()] ? { kind: 'any', prompt: t } : { kind: 'agent', name: m[1], prompt: m[2].trim() };
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

// Questions the floor manager can answer himself, from what he sees on the floor.
function describeAgent(a) {
  const tools = Object.values(a.tools); const cur = tools[tools.length - 1];
  const doing = a.permission ? 'waiting for your approval' : a.status === 'active' ? (cur ? `working on ${(cur.status || cur.toolName).slice(0, 60)}` : 'thinking') : a.awaitingInput ? 'waiting for your answer' : 'idle';
  return `${agentName(a)} is in ${DEPT_NAMES[a.dept]}, ${doing}.`;
}
function lastReportFor(a) { for (let i = reports.length - 1; i >= 0; i--) if (reports[i].agentId === a.id) return reports[i]; return null; }
function statusAnswer(text) {
  const t = text.trim().toLowerCase().replace(/[?!.\s]+$/, '');
  const list = [...agents.values()].filter((a) => !a.parentAgentId);
  let m;
  if (/^(tasks?|open tasks|the board|task board|what(?:'s| is) open|what(?:'s| is) on the board|todo|backlog|issues|bd ready)$/.test(t)) {
    if (!beadsOk) return 'There is no beads database in this folder, so I have no task board.';
    if (!issues.length) return 'The board is clear: no open tasks.';
    return `${issues.length} open:\n` + issues.slice(0, 12).map((i) => `${i.id} P${i.priority} ${i.status === 'in_progress' ? '◐' : '○'} ${i.title}${i.assignee ? ` (${i.assignee})` : ''}`).join('\n') + (issues.length > 12 ? `\n…and ${issues.length - 12} more` : '');
  }
  if (/^(team|the team|who does what|roles|jobs|who(?:'s| is) (?:on )?(?:qa|security|ui ?\/? ?ux|engineering))$/.test(t)) {
    if (!list.length) return 'Nobody is on the floor.';
    return Object.keys(DEPT_NAMES).map((d) => `${DEPT_NAMES[d]}: ${list.filter((a) => a.dept === d).map((a) => `${agentName(a)}${a.hasTerminal ? '' : ' (desktop)'}`).join(', ') || 'nobody'}`).join('\n');
  }
  if (/^(hi|hello|hey|yo|hallo|shalom)\b/.test(t)) return `Hi! ${list.length} on the floor. Ask me "status", "tasks", "what is <agent> doing", "what did <agent> say", or give someone a task.`;
  if (/^(status|report|reports|overview|who('s| is) (here|around|working|busy|idle|free|waiting)|what('s| is) (everyone|everybody|going on)( doing| up to)?|how('s| is) (it going|everyone|everybody))$/.test(t)) {
    if (!list.length) return 'The floor is empty: no agents are running.';
    const by = {}; for (const a of list) (by[a.dept] ??= []).push(a);
    return Object.keys(DEPT_NAMES).filter((d) => by[d]).map((d) => `${DEPT_NAMES[d]}: ${by[d].map((a) => `${agentName(a)} (${a.permission ? 'needs you' : a.status === 'active' ? 'working' : a.awaitingInput ? 'asked you' : 'idle'})`).join(', ')}`).join('\n');
  }
  if ((m = t.match(/^(?:what(?:'s| is)|how(?:'s| is))\s+(.+?)\s+(?:doing|up to|going|working on|on)$/)) || (m = t.match(/^(?:where(?:'s| is)|status of|status)\s+(.+)$/))) {
    const a = findAgent(m[1]); return a ? describeAgent(a) : `Nobody here is called "${m[1]}".`;
  }
  if ((m = t.match(/^(?:what did (.+?) (?:say|report|find|do|answer)|(?:show|read|give)(?: me)? (?:the )?(?:last |latest )?report(?: (?:from|of|by) (.+))?|(.+?)(?:'s| s) (?:last |latest )?report)$/))) {
    const name = m[1] || m[2] || m[3];
    if (!name) { const r = reports[reports.length - 1]; return r ? `Last report, from ${r.name} (${DEPT_NAMES[r.dept]}):\n${r.text || r.recap}` : 'No reports have been filed yet.'; }
    const a = findAgent(name); if (!a) return `Nobody here is called "${name}".`;
    const r = lastReportFor(a); return r ? `${r.name}'s last report (${DEPT_NAMES[r.dept]}):\n${r.text || r.recap}` : `${agentName(a)} hasn't filed a report yet.`;
  }
  return null;
}
function parseRename(text) {
  const m = text.trim().match(/^rename\s+(.+?)\s+(?:to|as)\s+(.+?)\s*[.!]?$/i) || text.trim().match(/^rename\s+(\S+)\s+(.+?)\s*[.!]?$/i);
  return m ? { name: m[1].replace(/^@/, ''), to: m[2].replace(/^["']|["']$/g, '') } : null;
}
function parseMove(text) {
  const DEPT_WORDS = 'qa|security|sec|engineering|eng|dev|ui\\s*\\/?\\s*ux|ui|ux|design|test(?:ing)?';
  const m = text.trim().match(new RegExp(`^(?:send|move|put|assign|transfer)\\s+(.+?)\\s+(?:to|into)\\s+(?:the\\s+)?(${DEPT_WORDS})(?:\\s+(?:dept|department|team|room|office))?\\s*[.!]?$`, 'i'))
    || text.trim().match(new RegExp(`^(?:make|set)\\s+(.+?)\\s+(?:an?\\s+|the\\s+)?(${DEPT_WORDS})(?:\\s+(?:agent|specialist|engineer|person|guy|dev))?\\s*[.!]?$`, 'i'))
    || text.trim().match(new RegExp(`^(.+?)\\s+(?:is|should be|will be|becomes)\\s+(?:an?\\s+|the\\s+|our\\s+)?(${DEPT_WORDS})(?:\\s+(?:agent|specialist|engineer|person|guy|dev))?\\s*[.!]?$`, 'i'));
  if (!m) return null;
  return { name: m[1], dept: DEPT_ALIASES[m[2].toLowerCase().replace(/\s+/g, '')] };
}
// ---------- specialists: who takes a task, and bringing one in when nobody with that job is free ----------
const HANDOFF_RULE = '\n\n(Office rule: when you are done, if this needs follow-up by QA, Security or UI/UX, end your final reply with one line exactly like "HANDOFF: qa — <what they should do>", using qa, security or uiux.)';
function pickSpecialist(dept, exceptId = null) {
  const pool = [...agents.values()].filter((a) => a.hasTerminal && !a.parentAgentId && a.id !== exceptId && a.dept === dept && !playing(a.id));
  pool.sort((p, q) => ((p.status === 'active' || p.permission || p.awaitingInput) - (q.status === 'active' || q.permission || q.awaitingInput)) || (q.lastEvent - p.lastEvent));
  return pool[0] || null;
}
function homeDirFor(a) { // the project folder a new specialist should join: the requester's, else the busiest terminal's, else the playroom
  const dirs = [a?.directoryName, ...[...agents.values()].filter((x) => x.hasTerminal && x.directoryName && x.directoryName !== 'playroom').sort((p, q) => q.lastEvent - p.lastEvent).map((x) => x.directoryName)];
  for (const d of dirs) { const r = d && resolveDir(d); if (r) return r; }
  return preparePlayroom();
}
async function launchSpecialist(dept, dir) {
  const id = await launchAgent(dir); const a = agents.get(id);
  a.humanName = pickHumanName(dept); a.role = dept; applyRole(a); markDirty();
  fx('managerTarget', id, { text: '' });
  const ready = await waitForPrompt(id, { acceptTrust: dir === PLAYROOM });
  await sleep(ready ? 600 : 0); return a;
}
// Type a task into an agent, file it on the board and remember that an answer is owed.
const MAX_HOPS = 1; // a task may be handed off once; the specialist finishes it
async function giveTask(a, prompt, from, { discoveredFrom = null, hops = 0 } = {}) {
  await typeInto(a.id, prompt + (hops < MAX_HOPS ? HANDOFF_RULE : '\n\n(Office rule: this is a handoff. Finish it yourself and do not hand it off again.)'));
  const issueId = await fileTask({ prompt, from, agent: a, discoveredFrom });
  pendingReplies.set(a.id, { text: from, t: Date.now(), issueId, hops });
  return issueId;
}
function parseHandoff(text) {
  const m = /HANDOFF:\s*(qa|security|uiux|ui\s*\/?\s*ux|engineering)\s*[—–:-]+\s*(.+)/i.exec(text || '');
  return m ? { dept: DEPT_ALIASES[m[1].toLowerCase().replace(/\s+/g, '')] || 'engineering', task: m[2].trim().slice(0, 1500) } : null;
}
async function dispatchHandoff(from, r, h, hops = 1) {
  if (!upstream.privileged) return;
  let target = pickSpecialist(h.dept, from.id); const launching = !target;
  const text = `${r.name} hands off to ${DEPT_NAMES[h.dept]}: ${h.task}`;
  fx('managerSay', target ? target.id : null, { text, message: launching ? `${r.name} needs ${DEPT_NAMES[h.dept]}: bringing a specialist in…` : `${r.name} is handing this to ${agentName(target)} (${DEPT_NAMES[h.dept]}).`, ok: true, action: 'handoff', pending: true });
  logChat('manager', 'floor manager', text, { ok: true, action: 'handoff' });
  try {
    if (!target) target = await launchSpecialist(h.dept, homeDirFor(from));
    const prompt = `Handoff from ${r.name} (${DEPT_NAMES[from.dept]}): ${h.task}\n\nTheir report, for context:\n${(r.text || r.recap).replace(/HANDOFF:.*$/im, '').trim().slice(0, 1500)}`;
    const issueId = await giveTask(target, prompt, text, { discoveredFrom: r.issueId, hops });
    r.handoff = { dept: h.dept, task: h.task, to: agentName(target), toId: target.id, issueId };
    const message = `${agentName(target)} (${DEPT_NAMES[h.dept]}) took the handoff from ${r.name}${issueId ? `, filed as ${issueId}` : ''}.`;
    logChat('manager', 'floor manager', message, { ok: true }); fx('managerDone', target.id, { ok: true, message, text });
  } catch (e) { const message = `Handoff failed: ${e.message}`; logChat('manager', 'floor manager', message, { ok: false }); fx('managerDone', target ? target.id : null, { ok: false, message, text }); }
}
async function managerHandle(text) {
  const playReq = parsePlay(text);
  if (playReq) return playHandle(playReq);
  const result = { ok: false, action: null, targetId: null, message: '' };
  const rename = parseRename(text);
  if (rename) {
    const a = findAgent(rename.name);
    if (!a) { result.message = `Nobody here is called "${rename.name}".`; return { result, deliver: null }; }
    const was = agentName(a); const now = renameAgent(a, rename.to);
    result.ok = true; result.action = 'rename'; result.targetId = a.id; result.message = `${was} is now ${now}.`;
    return { result, deliver: null };
  }
  const move = parseMove(text);
  if (move) {
    const a = findAgent(move.name);
    if (!a) { result.message = `Nobody here is called "${move.name}".`; return { result, deliver: null }; }
    result.ok = true; result.action = 'move'; result.targetId = a.id;
    if (!assignRole(a, move.dept)) result.message = `${agentName(a)} is already ${DEPT_NAMES[move.dept]}.`;
    else result.message = `${agentName(a)}, from now on you're ${DEPT_NAMES[move.dept]}.`;
    return { result, deliver: null };
  }
  const answer = statusAnswer(text);
  if (answer) { result.ok = true; result.action = 'answer'; result.message = answer; return { result, deliver: null }; }
  const req = parseRequest(text);
  if (req.kind === 'launch') {
    const dir = resolveDir(req.dir);
    if (!dir) { result.message = `I can't find a folder called "${req.dir}". Give me a full path or a folder under Downloads, Documents or Desktop.`; return { result, deliver: null }; }
    result.action = 'launch'; result.message = `Launching a new agent in ${path.basename(dir)}…`; result.ok = true;
    return { result, deliver: async () => {
      const id = await launchAgent(dir); fx('managerTarget', id, { text }); const ready = await waitForPrompt(id);
      let issueId = null;
      const a = agents.get(id);
      if (a && req.role) { a.humanName = pickHumanName(req.role); a.role = req.role; applyRole(a); markDirty(); }
      if (req.prompt && a) { await sleep(ready ? 600 : 0); issueId = await giveTask(a, req.prompt, text); }
      return { targetId: id, message: req.prompt ? `Handed the task to the new ${path.basename(dir)} agent${issueId ? ` and filed it as ${issueId}` : ''}.` : `New agent is up in ${path.basename(dir)}.` };
    } };
  }
  let target = null;
  if (req.kind === 'agent') {
    target = findAgent(req.name);
    if (!target) { result.message = `Nobody here is called "${req.name}". Say "new agent in <folder>: <task>" and I'll bring someone in.`; return { result, deliver: null }; }
  } else { // nobody named: the job the task needs decides who gets it
    const dept = classifyText(req.prompt) || 'engineering';
    target = pickSpecialist(dept);
    if (!target) {
      if (!upstream.privileged) { result.message = `No ${DEPT_NAMES[dept]} specialist on the floor, and the bridge is read-only so I can't bring one in.`; return { result, deliver: null }; }
      const dir = homeDirFor(null);
      result.ok = true; result.action = 'launch'; result.message = `No ${DEPT_NAMES[dept]} specialist is free. Bringing one in to ${path.basename(dir)}…`;
      return { result, deliver: async () => {
        const a = await launchSpecialist(dept, dir);
        const issueId = await giveTask(a, req.prompt, text);
        return { targetId: a.id, message: `${agentName(a)} joined as ${DEPT_NAMES[dept]} in ${path.basename(dir)} and is on it${issueId ? ` (${issueId})` : ''}.` };
      } };
    }
  }
  result.targetId = target.id;
  if (!target.hasTerminal) {
    result.message = `${agentName(target)} is a desktop session: I can walk over, but I can't type into that window. Paste it there yourself, or say "new agent in ${target.directoryName || '<folder>'}: ${req.prompt}" and I'll launch one who listens.`;
    result.action = 'nudge'; result.ok = false; return { result, deliver: null };
  }
  result.ok = true; result.action = 'type'; result.message = `On it. Telling ${agentName(target)}…`;
  return { result, deliver: async () => {
    const issueId = await giveTask(target, req.prompt, text);
    return { targetId: target.id, message: `Told ${agentName(target)} (${DEPT_NAMES[target.dept]})${issueId ? `, filed as ${issueId}` : ''}. I'll bring you the answer when they're done.` };
  } };
}

// ---------- http ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
function readBody(req) { return new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); }); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } }); }); }
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }

// ---------- access control ----------
// Loopback alone isn't a boundary: any web page can POST to it and a rebinding domain can read it.
// So: only answer our own Host and Origin, and require a per-start token (0600 file for lego.mjs,
// a meta tag in index.html for the page) on every API call and on the event stream.
const TOKEN = crypto.randomBytes(32).toString('hex');
const TOKEN_FILE = path.join(os.homedir(), '.agent-office', 'token');
fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true, mode: 0o700 });
fs.writeFileSync(TOKEN_FILE, TOKEN, { mode: 0o600 }); fs.chmodSync(TOKEN_FILE, 0o600);
const HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const ORIGINS = new Set([...HOSTS].map((h) => `http://${h}`));
const SECURITY_HEADERS = { 'Content-Security-Policy': "frame-ancestors 'none'", 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
function hasToken(req, url) {
  const t = Buffer.from(String(req.headers['x-office-token'] || (url.pathname === '/events' && url.searchParams.get('token')) || ''));
  const want = Buffer.from(TOKEN);
  return t.length === want.length && crypto.timingSafeEqual(t, want);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'); let m;
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  if (!HOSTS.has(req.headers.host)) { res.writeHead(403); return res.end('forbidden host'); }
  if (req.headers.origin && !ORIGINS.has(req.headers.origin)) { res.writeHead(403); return res.end('forbidden origin'); }
  if ((url.pathname === '/events' || url.pathname.startsWith('/api/')) && !hasToken(req, url)) return json(res, 401, { ok: false, message: 'missing or wrong office token' });
  if (req.method === 'POST' && !/^application\/json\b/i.test(req.headers['content-type'] || '')) return json(res, 415, { ok: false, message: 'send application/json' });
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
      logChat('you', 'you', text); logChat('manager', 'floor manager', result.message, { ok: result.ok, action: result.action });
      fx('managerSay', result.targetId, { text, message: result.message, ok: result.ok, action: result.action, pending: !!deliver });
      if (deliver) {
        deliver().then((r) => { logChat('manager', 'floor manager', r.message, { ok: true }); fx('managerDone', r.targetId, { ok: true, message: r.message, text }); })
          .catch((e) => { const message = `That didn't work: ${e.message}`; logChat('manager', 'floor manager', message, { ok: false }); fx('managerDone', result.targetId, { ok: false, message, text }); });
      }
    } catch (e) { json(res, 500, { ok: false, message: e.message }); }
    return;
  }
  if (url.pathname === '/api/history') return json(res, 200, { reports: reports.slice(-100), chat: chatLog.slice(-100), depts: DEPT_NAMES, issues, beads: beadsOk });
  if (url.pathname === '/api/issues') return json(res, 200, { ok: true, issues: await refreshIssues(), beads: beadsOk });
  if ((m = url.pathname.match(/^\/api\/agents\/(\d+)\/report$/)) && req.method === 'POST') { // file a report on the current turn right now
    const a = agents.get(Number(m[1])); if (!a) return json(res, 404, { ok: false, message: 'no such agent' });
    const info = turnInfo(a); captureReport(a); return json(res, 200, { ok: true, hasTranscript: !!info, prompt: info?.prompt || '', texts: info?.texts.length || 0, recap: !!info?.recap });
  }
  if ((m = url.pathname.match(/^\/api\/agents\/(\d+)\/dept$/)) && req.method === 'POST') {
    const a = agents.get(Number(m[1])); const { dept } = await readBody(req);
    if (!a || !DEPT_NAMES[dept]) return json(res, 400, { ok: false, message: 'unknown agent or department' });
    assignRole(a, dept); return json(res, 200, { ok: true });
  }
  if ((m = url.pathname.match(/^\/api\/agents\/(\d+)\/name$/)) && req.method === 'POST') {
    const a = agents.get(Number(m[1])); const { name } = await readBody(req);
    if (!a || typeof name !== 'string') return json(res, 400, { ok: false, message: 'unknown agent or missing name' });
    return json(res, 200, { ok: true, name: renameAgent(a, name) });
  }
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
    res.end(file === path.join(PUBLIC, 'index.html') ? String(data).replace('<head>', `<head>\n<meta name="office-token" content="${TOKEN}" />`) : data);
  });
});
server.listen(PORT, '127.0.0.1', () => console.log(`\n  Agent Office 3D at http://127.0.0.1:${PORT}\n`));
