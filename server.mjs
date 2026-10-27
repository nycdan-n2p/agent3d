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
// one at a time: serial(lock, fn) runs fn after everything queued on the same lock has finished
const serial = (lock, fn) => { const run = lock.tail.then(fn, fn); lock.tail = run.catch(() => {}); return run; };

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
  'Jonah', 'Clara', 'Felix', 'Hana', 'Leo', 'Mira', 'Sam', 'Ivy', 'Oscar', 'Dana', 'Hugo', 'Yael', 'Max', 'Nora', 'Ben', 'Lila', 'Adam', 'Rosa', 'Kai', 'Talia',
  'Vera', 'Remy', 'Sol', 'Juno'];
// Every name comes with a job. Ezra is always Security, Felix always UI / UX: the floor is a team of
// specialists, and the manager routes work to whoever has the right job. "make <name> qa" overrides it.
const NAME_ROLES = {};
for (const n of ['Ezra', 'Omar', 'Yael', 'Max', 'Hugo', 'Kai', 'Dana']) NAME_ROLES[n] = 'security';
for (const n of ['Felix', 'Iris', 'Lila', 'Rosa', 'Clara', 'Mira', 'Zoe']) NAME_ROLES[n] = 'uiux';
for (const n of ['Nora', 'Nina', 'Tess', 'Theo', 'Ruby', 'Leo', 'Ivy', 'Talia']) NAME_ROLES[n] = 'qa';
// Jonah, Adam and Ben are planners: the manager takes a big request to one of them, and they break
// it into parts the specialists do in parallel. A planner sits in Engineering.
for (const n of ['Jonah', 'Adam', 'Ben']) NAME_ROLES[n] = 'planner';
// Vera, Remy, Sol and Juno are video producers: they sit in UI / UX and make films with the
// lemo-opuscar skill, asking for the whole brief in one go and splitting production between helpers.
for (const n of ['Vera', 'Remy', 'Sol', 'Juno']) NAME_ROLES[n] = 'video';
for (const n of HUMAN_NAMES) NAME_ROLES[n] ??= 'engineering';
function roleOf(a) { return a.role || NAME_ROLES[String(a.humanName || '').split(' ')[0]] || 'engineering'; }
function deptOfRole(r) { return r === 'planner' ? 'engineering' : r === 'video' ? 'uiux' : r; }
function isVideo(a) { return roleOf(a) === 'video'; }
function isPlanner(a) { return roleOf(a) === 'planner'; }
function applyRole(a) { const r = roleOf(a); const d = deptOfRole(r); if (a.dept !== d) { a.dept = d; a.deptReason = a.role ? 'assigned by you' : r === 'planner' ? `${a.humanName} is a planner` : r === 'video' ? `${a.humanName} is a video producer` : `${a.humanName}'s job`; markDirty(); } }
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
function snapshot() { return { type: 'state', upstream, agents: [...agents.values()].map((a) => ({ ...a, project: projectKeyOf(a) })), play: play.meta(), issues, beads: beadsOk, queue: queueMeta(), projects: projectsList(), home: { name: path.basename(PROJECT), root: PROJECT } }; }
function markDirty() { dirty = true; try { saveQueue(); } catch { /* before the queue is set up */ } }
setInterval(() => { if (dirty) { dirty = false; broadcast(snapshot()); } }, 50);
function fx(kind, id, extra = {}) { broadcast({ type: 'fx', kind, id, ...extra }); }
const play = createPlayroom({ buildsDir: path.join(__dirname, 'builds'), cli: LEGO_CLI, broadcast, fx, markDirty, present: (id) => agents.has(id) });
play.onShelved((r) => { // a finished build went to the gallery on its own, after the reveal
  const message = `Moved "${r.title}" (${r.bricks} bricks) to the gallery shelf. ${r.total} build${r.total === 1 ? '' : 's'} on display; the play table is clear.`;
  logChat('manager', 'floor manager', message, { ok: true, action: 'play' });
  fx('legoShelved', null, { title: r.title, bricks: r.bricks, total: r.total, auto: true });
});

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
  const lines = text.split('\n'); const resolved = new Set(); // tool_use ids that already got their tool_result
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]; if (!line.includes('"tool_use"') && !line.includes('"user"')) continue;
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    if (isHumanTurn(rec)) return null; // reached the prompt that started this turn
    if (rec.type === 'user' && Array.isArray(rec.message?.content)) { for (const b of rec.message.content) if (b.type === 'tool_result' && b.tool_use_id) resolved.add(b.tool_use_id); continue; }
    if (rec.type !== 'assistant' || rec.isSidechain) continue;
    const content = rec.message?.content; if (!Array.isArray(content)) continue;
    const uses = content.filter((b) => b.type === 'tool_use'); if (!uses.length) continue;
    const last = uses[uses.length - 1]; return { ...last, resolved: resolved.has(last.id) };
  }
  return null;
}
function askFromToolUse(found) {
  let ask;
  if (found.name === 'AskUserQuestion' && Array.isArray(found.input?.questions) && found.input.questions.length) {
    const qs = found.input.questions.map((q) => ({ question: q.question || '', header: q.header || '', multi: !!q.multiSelect, options: (q.options || []).map((o) => ({ label: o.label, description: o.description || '' })) }));
    ask = { kind: 'question', tool: found.name, ...qs[0], questions: qs }; // `questions` has them all; the first stays on top for the small screen
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
function refreshAsk(a, { settle = false } = {}) {
  const wants = a.permission || a.awaitingInput;
  if (!wants) { if (a.ask) { a.ask = null; markDirty(); } a.askSince = 0; return; }
  if (!a.askSince) a.askSince = Date.now();
  const found = lastToolUse(a);
  // Pixel Agents says "waiting for input" after every turn that ends at the prompt. Only a tool call
  // still without its result (a permission prompt or AskUserQuestion) or a wrap-up question is a real
  // ask; anything else is an idle agent, so stop showing it as waiting on you.
  const real = found && (!found.resolved || (WRAP_UP_TOOL.test(found.name) && found.input?.ask));
  if (!real) {
    if (settle && !a.permission && a.jsonlFile && Date.now() - a.askSince > 2500) { a.awaitingInput = false; a.ask = null; a.askSince = 0; markDirty(); }
    return;
  }
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
setInterval(() => { for (const a of agents.values()) if (a.permission || a.awaitingInput) refreshAsk(a, { settle: true }); if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'requestDiagnostics' })); }, 2500);

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
// Video work goes to a video producer (a UI / UX job of its own): films, promos, explainers, animations.
const VIDEO_RE = /\b(videos?|films?|short film|movie|promo|trailer|teaser|reel|explainer|animation|animated|motion graphics|storyboard|lemo[- ]?opuscar)\b/i;
function jobForText(text) { return VIDEO_RE.test(text || '') ? 'video' : classifyText(text); }
const DEPT_ALIASES = { eng: 'engineering', engineering: 'engineering', dev: 'engineering', qa: 'qa', test: 'qa', testing: 'qa', ui: 'uiux', ux: 'uiux', uiux: 'uiux', 'ui/ux': 'uiux', design: 'uiux', sec: 'security', security: 'security' };
const JOB_ALIASES = { ...DEPT_ALIASES, planner: 'planner', planning: 'planner', plan: 'planner', video: 'video', film: 'video', producer: 'video' };
const JOB_NAMES = { ...DEPT_NAMES, planner: 'Planning', video: 'Video (UI / UX)' };
function classifyText(text) { for (const [d, re] of DEPT_RULES) if (re.test(text || '')) return d; return null; }
function setDept(a, dept, reason = '') {
  if (!dept || a.dept === dept) return false;
  a.dept = dept; a.deptReason = reason.slice(0, 120);
  logEvent(a, 'dept', `moved to ${DEPT_NAMES[dept]}${reason ? ` (${reason})` : ''}`); markDirty(); fx('dept', a.id, { dept, reason: a.deptReason });
  return true;
}
function assignRole(a, job, reason = 'assigned by you') { // a lasting job change, remembered with the name
  const was = roleOf(a); a.role = job; const changed = setDept(a, deptOfRole(job), reason) || was !== job; saveName(a); markDirty(); return changed;
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
  const lines = text.split('\n'); const texts = []; const files = []; let recap = ''; let prompt = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]; if (!line.includes('"type"')) continue;
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    if (isHumanTurn(rec)) { prompt = humanText(rec); break; }
    if (rec.type !== 'assistant' || rec.isSidechain) continue;
    const content = rec.message?.content; if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b.type === 'text' && b.text && b.text.trim()) texts.unshift(b.text.trim());
      if (b.type === 'tool_use' && WRAP_UP_TOOL.test(b.name) && b.input?.recap && !recap) recap = String(b.input.recap);
      if (b.type === 'tool_use' && /^(Write|Edit|MultiEdit)$/.test(b.name) && typeof b.input?.file_path === 'string' && SCREEN_EXT.test(b.input.file_path)) files.push(b.input.file_path);
    }
  }
  return { prompt, texts, recap, files };
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
function bd(args, { timeoutMs = 20000, actor = 'floor-manager', cwd = __dirname } = {}) {
  return new Promise((resolve, reject) => execFile(BD, args, { cwd, timeout: timeoutMs, maxBuffer: 4e6, env: { ...process.env, BEADS_ACTOR: actor } },
    (err, stdout, stderr) => err ? reject(new Error(String(stderr || err.message).trim().slice(0, 300))) : resolve(String(stdout))));
}
let issues = []; let issuesAt = 0; let issuesRefreshing = null;
// The open board of the beads database in `cwd`: this repo's by default, another project's for its tab.
function listIssues(cwd) {
  return Promise.all([bd(['list', '--status', 'open,in_progress,blocked', '--json', '--brief', '--sort', 'priority'], { cwd }), bd(['blocked', '--json'], { cwd }).catch(() => '[]')]).then(([out, blockedOut]) => {
    let list = []; try { list = JSON.parse(out) || []; } catch { list = []; }
    let blocked = []; try { blocked = JSON.parse(blockedOut) || []; } catch { blocked = []; }
    const blockedBy = new Map(blocked.map((b) => [b.id, (b.blocked_by || b.blockers || b.dependencies || []).map((d) => typeof d === 'string' ? d : d.id || d.depends_on_id || '').filter(Boolean)]));
    return list.map((i) => ({ id: i.id, title: i.title, status: i.status, priority: i.priority ?? 2, type: i.issue_type || 'task', assignee: i.assignee || '', updated: i.updated_at || '', labels: i.labels || [], blockedBy: blockedBy.get(i.id) || null }));
  });
}
const projectIssues = new Map(); // root -> { at, issues, beads, pending } : other projects' boards, refreshed on demand
function issuesFor(root) {
  if (root === PROJECT || root === __dirname) return refreshIssues().then((list) => ({ issues: list, beads: beadsOk }));
  const beads = fs.existsSync(path.join(root, '.beads'));
  if (!beads) return Promise.resolve({ issues: [], beads: false });
  let e = projectIssues.get(root);
  if (e && (e.pending || Date.now() - e.at < 15000)) return e.pending || Promise.resolve({ issues: e.issues, beads: true });
  e = { at: 0, issues: e ? e.issues : [], beads: true, pending: null }; projectIssues.set(root, e);
  e.pending = listIssues(root).then((list) => { e.issues = list; return { issues: list, beads: true }; })
    .catch((err) => { console.log('[beads]', path.basename(root), err.message); return { issues: e.issues, beads: true }; })
    .finally(() => { e.at = Date.now(); e.pending = null; });
  return e.pending;
}
function refreshIssues() {
  if (!beadsOk) return Promise.resolve([]);
  if (issuesRefreshing) return issuesRefreshing;
  issuesRefreshing = listIssues(__dirname).then((next) => {
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
async function settleTask(issueId, r, { close = true } = {}) {
  if (!beadsOk || !issueId) return;
  try {
    const note = `${r.asked ? 'Agent asked a question' : 'Report'} from ${r.name} (${DEPT_NAMES[r.dept]})${r.branch ? ` on branch ${r.branch}` : ''}:\n${(r.text || r.recap).slice(0, 3000)}${r.recap && r.text ? `\n\nRecap: ${r.recap}` : ''}`;
    await bd(['note', issueId, note], { actor: r.name }); // the agent files its own note and closes its own task
    if (!r.asked && close) await bd(['close', issueId, '--reason', `report filed by ${r.name}`], { actor: r.name });
    refreshIssues();
  } catch (e) { console.log('[beads] settle failed:', e.message); }
}
const chatLog = []; // the conversation with the floor manager, so it survives a reload
function logChat(who, name, text, extra = {}) { chatLog.push({ t: Date.now(), who, name, text: String(text || '').slice(0, 4000), ...extra }); if (chatLog.length > 200) chatLog.shift(); }
function playing(id) { return play.isActive() && (play.meta().players || []).some((p) => p.id === id); }
// The questions in a reply, for the answer-all form: numbered or bulleted items that ask something,
// else every sentence that ends in a question mark. Two or more and the office opens the big form.
function extractQuestions(text) {
  const clean = (s) => s.replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim();
  const lines = String(text || '').split('\n'); const items = []; let cur = null;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const m = line.match(/^\s*(?:\d+[.)]|[-*•]|[a-z][.)])\s+(.*)$/i);
    if (m) { cur = { text: m[1] }; items.push(cur); }
    else if (!line.trim()) cur = null;
    else if (cur) cur.text += ' ' + line.trim();
  }
  let qs = items.map((i) => clean(i.text)).filter((t) => /\?/.test(t));
  if (qs.length < 2) qs = (String(text || '').match(/[^.!?\n]{12,}\?/g) || []).map(clean);
  return [...new Set(qs)].slice(0, 20).map((q) => q.slice(0, 400));
}
function captureReport(a, attempt = 0) {
  if (!agents.has(a.id) || playing(a.id)) return;
  const info = turnInfo(a);
  const text = info ? (info.texts[info.texts.length - 1] || '') : '';
  if (!info || (!text && !info.recap)) {
    if (attempt < 3) return setTimeout(() => captureReport(a, attempt + 1), [800, 1500, 3000][attempt]);
    return; // nothing to report (no transcript yet, or a turn with no text)
  }
  const reply = pendingReplies.get(a.id); pendingReplies.delete(a.id); const hops = reply ? (reply.hops || 0) : 0;
  const r = { id: ++reportSeq, agentId: a.id, name: agentName(a), dept: a.dept, project: projectKeyOf(a), t: Date.now(), prompt: info.prompt || a.prompt || '', text: text.slice(0, 6000), recap: info.recap.slice(0, 1000), asked: !!(a.awaitingInput || a.permission), replyTo: reply ? reply.text : null, questions: extractQuestions(text) };
  r.screens = collectScreens(info, text, r.id);
  reports.push(r); if (reports.length > 300) reports.shift();
  fs.appendFile(REPORTS_FILE, JSON.stringify(r) + '\n', () => {});
  logEvent(a, 'report', r.asked ? 'asked a question' : `filed a ${DEPT_NAMES[a.dept]} report`);
  if (reply) {
    r.issueId = reply.issueId || null; const w = reply.issueId && queue.workers.get(reply.issueId);
    const mine = w && w.agentId === a.id;
    const toReview = mine && !r.asked && reviewWanted(w, a);
    if (mine) { r.branch = w.branch; if (!r.asked && !toReview) { w.done = true; markDirty(); setTimeout(dispatchQueue, 2000); } }
    logChat('agent', r.name, r.text || r.recap, { agentId: a.id, dept: a.dept, reportId: r.id, issueId: r.issueId });
    if (toReview) settleTask(reply.issueId, r, { close: false }).then(() => startReview(a, r, w).catch((e) => { console.log('[review]', e.message); finishWithoutReview(reply.issueId, r, w, e.message); }));
    else settleTask(reply.issueId, r).then(() => { if (!r.asked) planProgress(reply.issueId, r); });
  }
  fx('report', a.id, { report: r });
  if (reply && reply.review) { if (r.asked) pendingReplies.set(a.id, reply); else handleReviewReport(a, r, reply.review).catch((e) => console.log('[review]', e.message)); return; }
  if (reply && reply.plan) { if (r.asked) pendingReplies.set(a.id, reply); else handlePlanReport(a, r, reply.plan).catch((e) => console.log('[plan]', e.message)); return; }
  if (reply && reply.desk) { if (r.asked) pendingReplies.set(a.id, reply); else handleDeskReport(a, r, reply.desk).catch((e) => console.log('[desk]', e.message)); return; }
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
    // arrives after agentClosed when we close a pty agent: don't bring it back as a ghost
    case 'terminalSessionClosed': { const a = agents.get(m.agentId); if (a) a.hasTerminal = false; detachTerminal(m.agentId); markDirty(); break; }
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
  ws.onopen = () => { upstream.connected = true; upstreamSince = Date.now(); ws.send(JSON.stringify({ type: 'webviewReady' })); ws.send(JSON.stringify({ type: 'requestDiagnostics' })); console.log('[bridge] connected'); markDirty(); };
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
  if ((m = t.match(/^(?:new|start|launch|spawn|open|hire)\s+(?:an?\s+)?(?:new\s+)?(?:(qa|security|sec|engineering|eng|dev|ui\s*\/?\s*ux|ui|ux|design|test(?:ing)?|video|film)\s+)?(?:agent|specialist|engineer|person|producer)\s+(?:in|at|for|on)\s+(\S+)\s*[:,-]?\s*([\s\S]*)$/i))) return { kind: 'launch', role: m[1] ? JOB_ALIASES[m[1].toLowerCase().replace(/\s+/g, '')] : null, dir: m[2], prompt: m[3].trim() };
  if ((m = t.match(/^(?:in|at)\s+(\S+)\s*[:,-]\s*([\s\S]+)$/i)) && !findAgent(m[1])) return { kind: 'launch', dir: m[1], prompt: m[2].trim() };
  if ((m = t.match(/^@([^\s:,-]+)\s*[:,-]?\s*([\s\S]+)$/))) return { kind: 'agent', name: m[1], prompt: m[2].trim() };
  if ((m = t.match(/^(?:tell|ask|have|get|let|make)\s+(?:the\s+)?(\S+?)(?:\s+agent)?\s+(?:to\s+)?([\s\S]+)$/i))) return { kind: 'agent', name: m[1].replace(/[:,]$/, ''), prompt: m[2].trim() };
  if ((m = t.match(/^(?:plan|project|big task|break (?:this |it )?down|split(?: this| it)?(?: up)?)\s*[:,-]\s*([\s\S]+)$/i))) return { kind: 'any', plan: true, prompt: m[1].trim() };
  if ((m = t.match(/^(\S+?)\s*[:,]\s*([\s\S]+)$/))) return DEPT_ALIASES[m[1].toLowerCase()] ? { kind: 'any', prompt: t } : { kind: 'agent', name: m[1], prompt: m[2].trim() };
  // mention anywhere (whole word, so "same" is not Sam)
  for (const a of agents.values()) { const n = agentName(a).toLowerCase(); if (n.length > 2 && new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(t)) return { kind: 'agent', name: n, prompt: t }; }
  return { kind: 'any', prompt: t };
}
const launchLock = { tail: Promise.resolve() }; // a new agent is matched by folder name, so launches can't overlap
function launchAgent(dir) { return serial(launchLock, () => launchAgentNow(dir)); }
async function launchAgentNow(dir) {
  if (!upstream.privileged) throw new Error('bridge is read-only: no token found in ~/.pixel-agents/servers');
  applyPolicy(dir); // what the office policy pre-approves never prompts in this folder
  const base = path.basename(dir);
  const created = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { listeners.delete(l); reject(new Error('pixel-agents did not report a new agent')); }, 8000);
    const l = (m) => { if (m.type === 'agentCreated' && !m.isExternal && (m.directoryName === base || !m.directoryName)) { clearTimeout(timer); listeners.delete(l); resolve(m.id); } };
    listeners.add(l);
  });
  if (!sendUpstream({ type: 'launchAgent', directoryPath: dir })) throw new Error('not connected to pixel-agents');
  const id = await created;
  const a = ensure(id); a.hasTerminal = true; a.hiredAt = Date.now();
  // terminalSessionOpened arrives right after; make sure we attach
  const t0 = Date.now(); while (!terminals.has(id) && Date.now() - t0 < 3000) { attachTerminal(id); await sleep(200); }
  return id;
}
// ---------- playtime ----------
function parsePlay(text) {
  const t = text.trim();
  if (/^(?:please\s+)?(?:shelve|shelf|display|keep|archive)\s+(?:(?:the|that)\s+)?(?:lego|build|board|model)\b|^(?:please\s+)?shelve\s+it\b|^(?:please\s+)?(?:put|move)\s+(?:it|(?:the|that)\s+(?:lego|build|model))\s+(?:in|into|on|to)\s+the\s+(?:gallery|shelf|shelves)\b|^(?:to\s+the\s+)?gallery[!.]?$/i.test(t)) return { kind: 'shelve' };
  if (/^(?:please\s+)?(?:take\s+apart|tear\s+down|break\s+up|clear(?:\s+away)?|tidy(?:\s+up)?|pack\s+(?:up|away)|put\s+away|dismantle)\s+(?:the\s+|that\s+)?(?:lego|build|board|play\s*table)\b/i.test(t)) return { kind: 'clear' };
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
  if (req.kind === 'shelve') {
    if (play.isActive()) { result.message = `They're still building ${play.describe()}. Say "stop playing" first, then I'll shelve it.`; return { result, deliver: null }; }
    const r = play.shelve();
    if (!r.ok) { result.message = r.reason === 'empty' ? 'There is nothing on the play table to shelve.' : `Couldn't shelve it: ${r.reason}.`; return { result, deliver: null }; }
    result.ok = true; result.message = `Put "${r.title}" (${r.bricks} bricks) on the gallery shelf. ${r.total} build${r.total === 1 ? '' : 's'} on display; the play table is clear.`;
    fx('legoShelved', null, { title: r.title, bricks: r.bricks, total: r.total, auto: false });
    return { result, deliver: null };
  }
  if (req.kind === 'clear') {
    if (play.isActive()) { result.message = `They're still building ${play.describe()}. Say "stop playing" first.`; return { result, deliver: null }; }
    const { bricks } = play.clear();
    result.ok = true;
    result.message = bricks ? `Took apart ${bricks} bricks and put the table away without shelving it. The floor is clear.` : 'The table is already put away.';
    return { result, deliver: null };
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
  if (/^(policy|the policy|what(?:'s| is) the policy|security policy|office policy|rules)$/.test(t)) return policyText();
  if ((m = t.match(/^what(?:'s| is| are we building in)\s+(?:project\s+)?(\S+?)(?:\s+about)?$/)) && (projectRootOf(m[1]) || knownRoot(m[1]))) { const r = projectRootOf(m[1]) || m[1]; return projectAbout(r) ? `${path.basename(r)}: ${projectAbout(r)}` : `Nobody told me what ${path.basename(r)} is about. Say "about ${path.basename(r)}: <what you're building>".`; }
  if (/^projects?$/.test(t)) { const ps = projectsList(); return ps.length ? ps.map((p) => `${p.name}: ${p.agents} agent${p.agents === 1 ? '' : 's'}${p.about ? ` — ${p.about.slice(0, 120)}` : ''}`).join('\n') : 'Nobody is on the floor.'; }
  if (/^(plans?|the plan|plan status|what(?:'s| is) the plan)$/.test(t)) {
    if (!plans.size) return 'No plan is running. Give me a big task, or say "plan: <task>", and I\'ll have a planner split it up.';
    return [...plans.values()].map(describePlan).join('\n');
  }
  if (/^(skills|what skills|who (?:can|does) what skills?|skill list)$/.test(t)) return Object.keys(DEPT_SKILLS).map((d) => `${DEPT_NAMES[d]}: ${DEPT_SKILLS[d].map((k) => `/${k.skill}`).join(', ')}`).join('\n');
  if ((m = t.match(/^what (?:can|does) (.+?) (?:do|know|handle|run)$/))) {
    const a = findAgent(m[1]); if (!a) return `Nobody here is called "${m[1]}".`;
    const ks = DEPT_SKILLS[a.dept] || [];
    return `${agentName(a)} is ${DEPT_NAMES[a.dept]}${a.hasTerminal ? '' : ' (desktop session: I can\'t type into them)'}.${ks.length ? ' Skills: ' + ks.map((k) => `/${k.skill} (${k.what})`).join('; ') : ''}`;
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
  const DEPT_WORDS = 'qa|security|sec|engineering|eng|dev|ui\\s*\\/?\\s*ux|ui|ux|design|test(?:ing)?|planner|planning|video|film|producer';
  const m = text.trim().match(new RegExp(`^(?:send|move|put|assign|transfer)\\s+(.+?)\\s+(?:to|into)\\s+(?:the\\s+)?(${DEPT_WORDS})(?:\\s+(?:dept|department|team|room|office))?\\s*[.!]?$`, 'i'))
    || text.trim().match(new RegExp(`^(?:make|set)\\s+(.+?)\\s+(?:an?\\s+|the\\s+)?(${DEPT_WORDS})(?:\\s+(?:agent|specialist|engineer|person|guy|dev))?\\s*[.!]?$`, 'i'))
    || text.trim().match(new RegExp(`^(.+?)\\s+(?:is|should be|will be|becomes)\\s+(?:an?\\s+|the\\s+|our\\s+)?(${DEPT_WORDS})(?:\\s+(?:agent|specialist|engineer|person|guy|dev))?\\s*[.!]?$`, 'i'));
  if (!m) return null;
  return { name: m[1], dept: JOB_ALIASES[m[2].toLowerCase().replace(/\s+/g, '')] };
}
// ---------- specialists: who takes a task, and bringing one in when nobody with that job is free ----------
// ---------- skills: each job owns the skills installed on this Mac that do that job ----------
// When the manager hands a task to a specialist he invokes the matching skill as a slash command,
// so "ask Ezra for a security report" runs /security-report, not an improvised audit. The first
// skill of a job is its default, used whenever the task reads as that job's kind of work.
// Skills live in ~/.claude/skills (user-wide, so every session has them); code-review, simplify and
// security-review are Claude Code built-ins.
const DEPT_SKILLS = {
  security: [
    { skill: 'security-report', what: 'read-only security audit of a repo, service or diff; HTML report with OWASP/WSTG coverage', trigger: /\b(security (?:report|audit|review|check|scan)|audit|pentest|owasp|wstg|vulnerab\w*|is (?:it|this) secure)\b/i },
    { skill: 'security-review', what: 'security review of the pending changes on the current branch', trigger: /\b(review (?:the |my )?(?:changes|diff|branch|pr)|pending changes)\b/i },
  ],
  uiux: [
    { skill: 'lemo-opuscar:lemo-opuscar', what: 'direct and produce a short film entirely in code, in one of 59 styles (oil painting, watercolor, ukiyo-e, satellite briefing, teardown…)', trigger: VIDEO_RE },
    { skill: 'frontend-design', default: true, what: 'distinctive, production-grade UI: pages, components, layouts, styling', trigger: /\b(design|restyle|style|styling|layout|ui|ux|component|page|landing|dashboard|theme|look|polish|beautif\w*)\b/i },
    { skill: 'gpt-image-2-style-library', what: 'image-generation prompts and visual styles', trigger: /\b(image prompt|image style|generate an? image|illustration|poster|visual style)\b/i },
  ],
  qa: [ // petrkindlmann/qa-skills (50 skills in ~/.claude/skills): the ones below are picked by wording, qa-do routes everything else
    { skill: 'code-review', what: 'review a diff, PR or branch for correctness bugs', trigger: /\b(code review|review (?:the |my |this )?(?:code|diff|pr|branch|changes))\b/i },
    { skill: 'replay-qa-loop', what: 'Replay QA: record sessions of the running app at qa.replay.io, root-cause bugs, loop on fixes', trigger: /\breplay\b/i },
    { skill: 'bug-reproduction', what: 'reproduce a reported bug step by step and pin down the cause', trigger: /\b(reproduce|repro|can'?t reproduce|flaky bug|intermittent)\b/i },
    { skill: 'agentic-browser-testing', what: 'drive the running app in a browser from a plain-language goal and report what breaks', trigger: /\b(in (?:chrome|safari|the browser)|click through|try (?:the|it) in|walk through the app|explore the app|smoke test)\b/i },
    { skill: 'playwright-automation', what: 'write or fix Playwright end-to-end tests, selectors, fixtures', trigger: /\b(playwright|e2e|end[- ]to[- ]end|selector)\b/i },
    { skill: 'exploratory-testing', what: 'structured exploratory session: charter, heuristics, notes, findings', trigger: /\b(exploratory|bug hunt|find bugs|hunt for bugs|poke at)\b/i },
    { skill: 'unit-testing', what: 'write or repair unit tests', trigger: /\b(unit tests?|write tests? for|add tests?|test coverage)\b/i },
    { skill: 'api-testing', what: 'test HTTP endpoints, contracts and error handling', trigger: /\b(api tests?|endpoints?|test the (?:api|server|bridge))\b/i },
    { skill: 'accessibility-testing', what: 'accessibility audit: WCAG, keyboard, screen readers', trigger: /\b(accessib\w*|a11y|wcag|screen reader|keyboard nav\w*)\b/i },
    { skill: 'visual-testing', what: 'visual regression: screenshots compared across changes', trigger: /\b(visual regression|pixel|looks (?:wrong|different|off)|screenshot diff)\b/i },
    { skill: 'performance-testing', what: 'load, latency and frame-rate testing', trigger: /\b(performance|load test|latency|fps|frame rate|slow)\b/i },
    { skill: 'test-planning', what: 'turn a change into a test plan with risks and cases', trigger: /\b(test plan|test cases?|what to test|coverage plan)\b/i },
    { skill: 'release-readiness', what: 'go/no-go check before a release', trigger: /\b(release|ship it|ready to ship|go\/no[- ]go|sign[- ]off)\b/i },
    { skill: 'qa-do', default: true, what: 'routes any other QA request to the right qa-skills workflow, runs it and reports with evidence', trigger: /\b(qa|test the app|run qa|regression|verify|check that)\b/i },
  ],
  engineering: [
    { skill: 'codebase-memory', what: 'structural questions about the codebase: architecture, callers, dependencies, dead code', trigger: /\b(architecture|who calls|call chain|dependencies|dead code|explore the codebase|structure of)\b/i },
    { skill: 'simplify', what: 'simplify and clean up the changed code', trigger: /\b(simplify|clean ?up|refactor)\b/i },
    { skill: 'graphify', what: 'turn code or docs into a knowledge graph', trigger: /\b(knowledge graph|graphify)\b/i },
  ],
};
// Which skill a task should run for an agent with this job, or null for plain work.
function skillFor(dept, prompt, { defaultOk = true } = {}) {
  const list = DEPT_SKILLS[dept] || []; if (!list.length) return null;
  const hit = list.find((k) => k.trigger.test(prompt)); if (hit) return hit.skill;
  if (defaultOk && dept !== 'engineering' && classifyText(prompt) === dept) return (list.find((k) => k.default) || list[0]).skill; // in-job work without a named skill: the job's default
  return null;
}
function withSkill(prompt, skill) { return skill && !/^\s*\//.test(prompt) ? `/${skill} ${prompt}` : prompt; }
// ---------- screens: images you attach to a prompt, and the screenshots / wireframes agents hand back ----------
const SCREENS_DIR = path.join(__dirname, 'screens');
fs.mkdirSync(SCREENS_DIR, { recursive: true });
const SCREEN_EXT = /\.(png|jpe?g|gif|webp|svg|html?)$/i;
const SCREEN_RULE = `\n\n(Office rule: to show Daniel a screenshot, wireframe, mockup or page, save it as a PNG, JPG, SVG or HTML file under ${SCREENS_DIR} and name the path in your final reply; it goes up on his big screen.)`;
function safeName(n) { return String(n || 'file').replace(/[^\w.-]+/g, '_').slice(-80); }
// Files this turn produced or named that belong on the big screen: copied into screens/ and served from /screens/.
function collectScreens(info, text, reportId) {
  const cands = new Set(info.files || []);
  for (const m of String(text || '').matchAll(/(?:\/|~\/)[^\s"'`<>()]+?\.(?:png|jpe?g|gif|webp|svg|html?)\b/gi)) cands.add(m[0].replace(/^~/, os.homedir()));
  const out = [];
  for (const f of cands) {
    try {
      const st = fs.statSync(f); if (!st.isFile() || st.size > 40e6) continue;
      let name = path.basename(f);
      if (!f.startsWith(SCREENS_DIR + path.sep)) { name = `out-${reportId}-${safeName(name)}`; fs.copyFileSync(f, path.join(SCREENS_DIR, name)); }
      out.push({ name, url: `/screens/${encodeURIComponent(name)}`, kind: /\.html?$/i.test(name) ? 'html' : 'image' });
    } catch { /* not there */ }
    if (out.length >= 12) break;
  }
  return out;
}
const HANDOFF_RULE = '\n\n(Office rule: when you are done, if this needs follow-up by QA, Security or UI/UX, end your final reply with one line exactly like "HANDOFF: qa — <what they should do>", using qa, security or uiux.)';
// The video producer's standing orders: one round of questions, then split the production.
const VIDEO_RULE = '\n\n(Office rule: you are the office\'s video producer. Make the film with the lemo-opuscar skill. Everything you need from Daniel goes in ONE message: a numbered list of questions, one per line, each ending with a question mark and followed by the default you will use if he skips it; then stop and wait for his answers. Never come back with a second round. Divide the production: run sub-agents in parallel for the voice, the music, the scenes and the render checks, and hand the finished film to QA with a HANDOFF line.)';
function pickSpecialist(job, exceptId = null, { root = null } = {}) { // job: a department, or 'video' for a video producer (who only takes video work); root: only people working in that project
  const pool = [...agents.values()].filter((a) => a.hasTerminal && !a.parentAgentId && a.id !== exceptId && !isPlanner(a) && !playing(a.id) && (job === 'video' ? isVideo(a) : a.dept === job && !isVideo(a)) && (!root || projectRootOfAgent(a) === root));
  pool.sort((p, q) => ((p.status === 'active' || p.permission || p.awaitingInput) - (q.status === 'active' || q.permission || q.awaitingInput)) || (q.lastEvent - p.lastEvent));
  return pool[0] || null;
}
function homeDirFor(a, root = null) { // the project folder a new specialist should join: the selected project's, else the requester's, else the busiest terminal's, else the playroom
  if (root) return root;
  const dirs = [a?.directoryName, ...[...agents.values()].filter((x) => x.hasTerminal && x.directoryName && x.directoryName !== 'playroom').sort((p, q) => q.lastEvent - p.lastEvent).map((x) => x.directoryName)];
  for (const d of dirs) { const r = d && resolveDir(d); if (r) return r; }
  return preparePlayroom();
}
// ---------- projects: the folder an agent runs in, so several code projects can share one floor ----------
// A project is a folder (directoryName is its basename). Worktrees of a project (.worktrees/<id>, .claude/worktrees/<name>)
// and the playroom belong to the project that holds them. Each project name gets a stable colour.
const PROJECT_COLORS = ['#2dd4bf', '#fb923c', '#f472b6', '#a3e635', '#38bdf8', '#a78bfa', '#fbbf24', '#fb7185', '#34d399', '#818cf8', '#e879f9', '#facc15'];
function projectColor(name) { let h = 0; for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return PROJECT_COLORS[h % PROJECT_COLORS.length]; }
const projectRoots = new Map(); // directoryName -> { root, at }
const WORKTREE_DIRS = ['.worktrees', path.join('.claude', 'worktrees')];
// Is `name` a worktree folder of `root`? Also by suffix: the desktop app reports "determined-shannon-7541bc" as "7541bc".
function isWorktreeOf(root, name) {
  for (const d of WORKTREE_DIRS) {
    try { if (fs.statSync(path.join(root, d, name)).isDirectory()) return true; } catch { /* not there */ }
    try { if (fs.readdirSync(path.join(root, d)).some((f) => f.endsWith(`-${name}`))) return true; } catch { /* no such dir */ }
  }
  return false;
}
function dirInSearch(name) { for (const base of SEARCH_DIRS) { const p = path.join(base, name); try { if (fs.statSync(p).isDirectory()) return p; } catch { /* next */ } } return null; }
function rootOfCwd(cwd) { const m = /^(.*?)\/(?:\.worktrees|\.claude\/worktrees|playroom)(?:\/[^/]+)?$/.exec(cwd); return m ? m[1] : cwd; } // a worktree (or the playroom) belongs to the checkout that holds it
function projectRootOf(dirName) {
  if (!dirName) return null;
  const hit = projectRoots.get(dirName);
  if (hit && (hit.root || Date.now() - hit.at < 60000)) return hit.root;
  let root = null;
  if (dirName === 'playroom' || dirName === path.basename(PROJECT) || isWorktreeOf(PROJECT, dirName)) root = PROJECT;
  else root = dirInSearch(dirName);
  if (!root) for (const r of new Set([...projectRoots.values()].map((e) => e.root).filter(Boolean))) if (isWorktreeOf(r, dirName)) { root = r; break; }
  if (!root) { const m = /^(.+)-[a-z0-9]+(?:\.\d+)?$/i.exec(dirName); const r = m && dirInSearch(m[1]); if (r && isWorktreeOf(r, dirName)) root = r; } // a beads id like monitoragents-15l: a worktree of monitoragents
  projectRoots.set(dirName, { root, at: Date.now() });
  return root;
}
// The transcript lives in ~/.claude/projects/<cwd with / and . turned into ->/; undo that against the disk.
const slugCache = new Map();
function cwdFromJsonl(file) {
  if (!file) return null;
  const slug = path.basename(path.dirname(file)); if (slugCache.has(slug)) return slugCache.get(slug);
  const parts = slug.split('-').slice(1); let found = null;
  const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
  const partial = (p) => { try { const b = path.basename(p); return fs.readdirSync(path.dirname(p)).some((f) => f !== b && f.startsWith(b)); } catch { return false; } }; // "determined" on the way to "determined-shannon-7541bc"
  const walk = (cur, i) => {
    if (found) return;
    if (i === parts.length) { if (isDir(cur)) found = cur; return; }
    for (const sep of i === 0 ? ['/'] : ['/', '-', '.']) { const next = (i === 0 ? '' : cur) + sep + parts[i]; if (isDir(next) || partial(next)) walk(next, i + 1); }
  };
  try { walk('', 0); } catch { /* give up */ }
  slugCache.set(slug, found); return found;
}
function projectRootOfAgent(a) { const cwd = cwdFromJsonl(a.jsonlFile); return (cwd && rootOfCwd(cwd)) || projectRootOf(a.directoryName); }
function projectKeyOf(a) { const root = projectRootOfAgent(a); return root ? path.basename(root) : (a.directoryName || null); }
function knownRoot(root) { return typeof root === 'string' && (root === PROJECT || [...agents.values()].some((a) => projectRootOfAgent(a) === root)); }
// What Daniel is building in each project, in his words: kept per folder in office-projects.json and
// handed to every agent in that project along with its task.
const PROJECTS_FILE = path.join(__dirname, 'office-projects.json');
let projectInfo = {}; // root -> { about, at }
try { projectInfo = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8')) || {}; } catch { /* none yet */ }
function projectAbout(root) { return (root && projectInfo[root]?.about) || ''; }
function setProjectAbout(root, about) {
  const text = String(about || '').replace(/\s+/g, ' ').trim().slice(0, 1200);
  if (text) projectInfo[root] = { about: text, at: Date.now() }; else delete projectInfo[root];
  fs.writeFile(PROJECTS_FILE, JSON.stringify(projectInfo, null, 1) + '\n', () => {}); markDirty(); return text;
}
function projectContext(a) { const about = projectAbout(projectRootOfAgent(a)); return about ? `\n\n(Project context from Daniel: ${about})` : ''; }
function projectsList() {
  const by = new Map();
  for (const a of agents.values()) {
    const name = projectKeyOf(a); if (!name) continue;
    let p = by.get(name); if (!p) { const root = projectRootOfAgent(a); p = { name, root, color: projectColor(name), agents: 0, working: 0, waiting: 0, idle: 0, beads: !!(root && fs.existsSync(path.join(root, '.beads'))), home: root === PROJECT, about: projectAbout(root) }; by.set(name, p); }
    if (a.parentAgentId) continue;
    p.agents++;
    if (a.permission || (a.status !== 'active' && a.awaitingInput)) p.waiting++; else if (a.status === 'active') p.working++; else p.idle++;
  }
  return [...by.values()].sort((p, q) => (q.home - p.home) || (q.agents - p.agents) || p.name.localeCompare(q.name));
}
async function launchSpecialist(dept, dir) {
  const id = await launchAgent(dir); const a = agents.get(id);
  a.humanName = pickHumanName(dept); a.role = dept; applyRole(a); markDirty();
  fx('managerTarget', id, { text: '' });
  const ready = await waitForPrompt(id, { acceptTrust: dir === PLAYROOM || dir.startsWith(WORKTREES + path.sep) });
  await sleep(ready ? 600 : 0); return a;
}
// Type a task into an agent, file it on the board and remember that an answer is owed.
// ---------- the task queue: ready issues on the board go to fresh specialists, each in its own worktree ----------
// Any open issue with no assignee and no open blocker is eligible (label it `hold` to keep it back).
// The manager hires a specialist whose job matches the issue, in a git worktree of this project on
// branch office/<id>, hands over the task, and the report closes the issue. At most `limit` queue
// workers run at once; agents you hire yourself don't count.
const PROJECT = process.env.OFFICE_PROJECT ? path.resolve(process.env.OFFICE_PROJECT) : __dirname;
const WORKTREES = path.join(PROJECT, '.worktrees');
const queue = { on: process.env.OFFICE_QUEUE !== 'off', // runs from the start; "queue off" (or OFFICE_QUEUE=off) pauses it
  limit: Math.max(0, Number(process.env.OFFICE_WORKERS || 4)), workers: new Map(), skipped: new Map(), busy: false };
// Who is on which task survives a bridge restart (agent ids are pixel-agents' and persist), so reviews and
// slot accounting carry on instead of every running task looking idle after a restart.
const QUEUE_FILE = path.join(__dirname, 'office-queue.json');
try { for (const [id, w] of Object.entries(JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8')))) if (!w.done && !w.starting) queue.workers.set(id, w); } catch { /* none yet */ }
let queueSaveTimer = 0;
function saveQueue() {
  clearTimeout(queueSaveTimer);
  queueSaveTimer = setTimeout(() => {
    const out = {}; for (const [id, w] of queue.workers) if (!w.done && !w.starting) out[id] = { ...w, review: w.review ? { ...w.review, devReport: w.review.devReport ? { id: w.review.devReport.id, name: w.review.devReport.name, dept: w.review.devReport.dept, text: (w.review.devReport.text || '').slice(0, 2000), recap: w.review.devReport.recap || '' } : null } : undefined };
    fs.writeFile(QUEUE_FILE, JSON.stringify(out, null, 1), () => {});
  }, 300);
}
function git(args) { return new Promise((resolve, reject) => execFile('git', ['-C', PROJECT, ...args], { timeout: 30000 }, (err, out, errOut) => err ? reject(new Error(String(errOut || err.message).trim().slice(0, 300))) : resolve(String(out)))); }
const gitLock = { tail: Promise.resolve() }; // parallel 'git worktree add' runs trip over git's lock files
function makeWorktree(issueId) { return serial(gitLock, () => makeWorktreeNow(issueId)); }
function gitIn(dir, args) { return new Promise((resolve, reject) => execFile('git', ['-C', dir, ...args], { timeout: 30000 }, (err, out, errOut) => err ? reject(new Error(String(errOut || err.message).trim().slice(0, 300))) : resolve(String(out).trim()))); }
// Point an existing worktree at office/<issueId>, fresh from the project's HEAD unless the branch already exists. Only when it is clean.
async function switchWorktree(dir, issueId) {
  const branch = `office/${issueId}`;
  if (await gitIn(dir, ['status', '--porcelain'])) throw new Error(`${path.basename(dir)} has uncommitted changes`);
  if ((await gitIn(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])) === branch) return branch;
  const head = await git(['rev-parse', 'HEAD']);
  try { await gitIn(dir, ['checkout', '-q', '-b', branch, head.trim()]); }
  catch (e) { if (!/already exists/.test(e.message)) throw e; await gitIn(dir, ['checkout', '-q', branch]); }
  return branch;
}
async function makeWorktreeNow(issueId) {
  const dir = path.join(WORKTREES, issueId); const branch = `office/${issueId}`;
  fs.mkdirSync(WORKTREES, { recursive: true });
  if (fs.existsSync(path.join(dir, '.git'))) { await switchWorktree(dir, issueId); return { dir, branch }; } // left from an earlier run (maybe reused for another task since): put it back on its branch
  try { await git(['worktree', 'add', '-b', branch, dir, 'HEAD']); }
  catch (e) { if (!/already exists/.test(e.message)) throw e; await git(['worktree', 'add', dir, branch]); }
  return { dir, branch };
}
function queueRunning() { return [...queue.workers.values()].filter((w) => !w.done && (w.starting || agents.has(w.agentId))); }
function queueMeta() { return { on: queue.on, limit: queue.limit, running: queueRunning().length, workers: [...queue.workers.entries()].map(([issueId, w]) => ({ issueId, agentId: w.agentId, name: w.name, dept: w.dept, branch: w.branch, done: !!w.done, startedAt: w.startedAt })).slice(-20) }; }
async function eligibleIssues() {
  const [readyOut, listOut] = await Promise.all([bd(['ready', '--json']), bd(['list', '--status', 'open', '--json'])]);
  let ready = [], open = []; try { ready = JSON.parse(readyOut) || []; } catch { /* empty */ } try { open = JSON.parse(listOut) || []; } catch { /* empty */ }
  const byId = new Map(open.map((i) => [i.id, i]));
  return ready.map((r) => ({ ...r, ...(byId.get(r.id) || {}) }))
    .filter((i) => i.status === 'open' && !i.assignee && !(i.labels || []).includes('hold') && !/^(epic|convoy|event)$/.test(i.issue_type || '') && !queue.workers.has(i.id))
    .filter((i) => !(queue.skipped.get(i.id) > Date.now()))
    .sort((p, q) => (p.priority ?? 2) - (q.priority ?? 2) || String(p.created_at).localeCompare(String(q.created_at)));
}
// Parts of a plan are dispatched even while the queue is paused, up to PLAN_WORKERS at once.
const PLAN_WORKERS = Math.max(1, Number(process.env.OFFICE_PLAN_WORKERS || 4));
const isPlanIssue = (i) => (i.labels || []).includes('plan');
function roomFor(issue) {
  const running = queueRunning();
  if (isPlanIssue(issue)) return running.filter((w) => w.plan).length < PLAN_WORKERS;
  return queue.on && running.filter((w) => !w.plan).length < queue.limit;
}
async function dispatchQueue() {
  if (!beadsOk || !upstream.privileged || !upstream.connected || queue.busy) return; // not connected: a launch would fail and park the task for 10 min
  queue.busy = true;
  const starts = [];
  try {
    // Fill every free slot in one pass; each claimed task starts its specialist in parallel.
    for (const issue of await eligibleIssues()) {
      if (!roomFor(issue)) continue;
      // Claim it in Beads first, only if still unassigned, so another bridge can't hand it out too.
      try { await bd(['update', issue.id, '--if-assignee=', '--assignee', 'floor-manager', '--status', 'in_progress']); } catch { continue; }
      queue.workers.set(issue.id, { starting: true, done: false, plan: isPlanIssue(issue), startedAt: Date.now() }); markDirty();
      starts.push(dispatchIssue(issue).catch(async (e) => {
        queue.workers.delete(issue.id); markDirty();
        await bd(['update', issue.id, '--assignee', '', '--status', 'open', '--force']).catch(() => {}); // our claim: release it even if the agent's name is on it
        queue.skipped.set(issue.id, Date.now() + 10 * 60000); // don't hammer a task that won't start
        const message = `Couldn't start ${issue.id}: ${e.message}. I'll leave it for ten minutes.`;
        console.log('[queue]', message); logChat('manager', 'floor manager', message, { ok: false }); fx('managerSay', null, { text: issue.title, message, ok: false, action: 'answer', pending: false });
      }));
    }
  } finally { queue.busy = false; }
  await Promise.all(starts);
}
// A finished queue worker still sitting in its worktree can take the next task of its job instead of a new hire:
// idle at the prompt, owes nobody an answer, has room left in its context, and its worktree is clean.
function idleSpecialists(dept) {
  const busy = new Set(queueRunning().map((w) => w.agentId));
  return [...agents.values()].filter((a) => a.hasTerminal && !a.parentAgentId && a.dept === dept && !isPlanner(a) && !isVideo(a) && !busy.has(a.id)
    && a.status !== 'active' && !a.permission && !a.awaitingInput && !a.ask && !playing(a.id) && !pendingReplies.has(a.id)
    && a.directoryName && fs.existsSync(path.join(WORKTREES, a.directoryName, '.git'))
    && !(a.maxContextTokens && a.contextTokens > a.maxContextTokens * 0.6))
    .sort((p, q) => (p.contextTokens || 0) - (q.contextTokens || 0));
}
async function reuseSpecialist(dept, issueId) {
  if (fs.existsSync(path.join(WORKTREES, issueId, '.git'))) return null; // earlier work on this task lives there: continue it in place
  for (const a of idleSpecialists(dept)) {
    const dir = path.join(WORKTREES, a.directoryName);
    try { const branch = await serial(gitLock, () => switchWorktree(dir, issueId)); return { a, dir, branch }; }
    catch (e) { console.log(`[queue] not reusing ${agentName(a)}: ${e.message}`); }
  }
  return null;
}
async function dispatchIssue(issue) {
  const dept = (issue.labels || []).map((l) => DEPT_ALIASES[l]).find(Boolean) || classifyText(`${issue.title} ${issue.description || ''}`) || 'engineering';
  const reused = await reuseSpecialist(dept, issue.id);
  const { dir, branch } = reused || await makeWorktree(issue.id);
  const a = reused ? reused.a : await launchSpecialist(dept, dir);
  if (reused) { fx('managerTarget', a.id, { text: '' }); }
  const w = { issueId: issue.id, agentId: a.id, name: agentName(a), dept, dir, branch, startedAt: Date.now(), done: false, plan: isPlanIssue(issue), reused: !!reused };
  queue.workers.set(issue.id, w); markDirty();
  await bd(['update', issue.id, '--assignee', agentName(a)]).catch(() => {});
  await bd(['note', issue.id, `Dispatched by the floor manager to ${agentName(a)} (${DEPT_NAMES[dept]}${reused ? ', already on the floor' : ''}), working in ${dir} on branch ${branch}.`]).catch(() => {});
  const where = reused ? `Your previous task is finished; forget it. Your worktree (${dir}) is now on a fresh branch ${branch}, cut from the project's current HEAD, so start by re-reading any file you touch.` : `You are working in your own git worktree (${dir}) on branch ${branch}.`;
  const prompt = `Task ${issue.id}: ${issue.title}\n\n${(issue.description || '').trim()}\n\n${where} Commit your work on that branch when it is done; do not push and do not switch branches. The floor manager tracks this task as ${issue.id}, so you don't need bd for it. When you finish, reply with a short report of what you changed and how you verified it.`;
  const skill = skillFor(dept, `${issue.title} ${issue.description || ''}`, { defaultOk: false }); // queued issues only run a skill they name
  await typeInto(a.id, withSkill(prompt, skill) + projectContext(a) + SCREEN_RULE + HANDOFF_RULE);
  if (skill) logEvent(a, 'tool', `running /${skill}`);
  pendingReplies.set(a.id, { text: `queue: ${issue.title}`, t: Date.now(), issueId: issue.id, hops: 0, skill, queued: true });
  refreshIssues();
  const message = `${w.plan ? 'Plan' : 'Queue'}: ${agentName(a)} (${DEPT_NAMES[dept]}${skill ? `, running /${skill}` : ''}${reused ? ', was idle' : ', new hire'}) picked up ${issue.id} "${issue.title}" in a worktree on ${branch}.`;
  logChat('manager', 'floor manager', message, { ok: true, action: 'queue' });
  fx('managerSay', a.id, { text: `${issue.id}: ${issue.title}`, message, ok: true, action: 'queue', pending: false });
  const pl = w.plan && planOf(issue.id); if (pl) { const part = pl.parts.find((x) => x.id === issue.id); if (part) { part.by = agentName(a); part.branch = branch; } }
}
if (beadsOk) { setInterval(dispatchQueue, 15000); setTimeout(dispatchQueue, 3000); } // first pass once pixel-agents is connected, not 15 s in
function parseQueue(text) {
  const t = text.trim(); let m;
  if ((m = t.match(/^queue\s*[:\-]\s*(.+)$/i)) || (m = t.match(/^(?:add|put)\s+(.+?)\s+(?:to|on|in)\s+(?:the\s+)?queue$/i))) return { kind: 'add', title: m[1].trim() };
  if (/^queue\s+(?:on|start|resume|go|run)$/i.test(t)) return { kind: 'on' };
  if (/^queue\s+(?:off|pause|stop|hold)$/i.test(t)) return { kind: 'off' };
  if ((m = t.match(/^(?:queue\s+limit|workers?\s+at\s+once|max\s+workers?)\s*[:=]?\s*(\d+)$/i)) || (m = t.match(/^(\d+)\s+workers?\s+at\s+once$/i))) return { kind: 'limit', n: Number(m[1]) };
  if (/^(?:queue(?:\s+status)?|what(?:'s| is) (?:queued|in the queue|on the queue))\??$/i.test(t)) return { kind: 'status' };
  if (/^queue\s+(?:next|now)$/i.test(t)) return { kind: 'next' };
  return null;
}
async function queueHandle(q) {
  const result = { ok: true, action: 'answer', targetId: null, message: '' };
  if (!beadsOk) { result.ok = false; result.message = 'There is no beads database in this folder, so there is no queue. Run `bd init` here first.'; return { result, deliver: null }; }
  if (q.kind === 'add') {
    try {
      const out = await bd(['create', '--title', q.title.slice(0, 120), '--description', `Queued from the Agent Office chat.\n\n${q.title}`, '--type', 'task', '--priority', '2', '--labels', 'queue', '--json']);
      const id = JSON.parse(out).id; refreshIssues(); setTimeout(dispatchQueue, 500);
      result.message = `Queued as ${id}. ${queue.on ? `Next free slot takes it (${queueRunning().length}/${queue.limit} running).` : 'The queue is paused: say "queue on".'}`;
    } catch (e) { result.ok = false; result.message = `Couldn't queue that: ${e.message}`; }
    return { result, deliver: null };
  }
  if (q.kind === 'on') { queue.on = true; markDirty(); setTimeout(dispatchQueue, 300); result.message = `Queue is on: up to ${queue.limit} at once.`; return { result, deliver: null }; }
  if (q.kind === 'off') { queue.on = false; markDirty(); result.message = 'Queue paused. Running workers finish what they have.'; return { result, deliver: null }; }
  if (q.kind === 'limit') { queue.limit = Math.min(8, Math.max(0, q.n)); markDirty(); setTimeout(dispatchQueue, 300); result.message = `Up to ${queue.limit} queue worker${queue.limit === 1 ? '' : 's'} at once.`; return { result, deliver: null }; }
  if (q.kind === 'next') { if (!queue.on) queue.on = true; setTimeout(dispatchQueue, 100); result.message = 'Looking for the next ready task…'; return { result, deliver: null }; }
  const running = queueRunning(); let eligible = [];
  try { eligible = await eligibleIssues(); } catch { /* bd down */ }
  result.message = `Queue ${queue.on ? 'on' : 'paused'} · ${running.length}/${queue.limit} running` +
    (running.length ? `\n` + running.map((w) => `◐ ${[...queue.workers.entries()].find(([, x]) => x === w)[0]} ${w.starting ? 'starting a specialist…' : `${w.name} (${DEPT_NAMES[w.dept]}${w.review ? `, in review round ${w.review.round}` : ''}) on ${w.branch}`}`).join('\n') : '') +
    (eligible.length ? `\nWaiting: ` + eligible.slice(0, 6).map((i) => `${i.id} P${i.priority ?? 2} ${i.title}`).join('; ') + (eligible.length > 6 ? ` …+${eligible.length - 6}` : '') : '\nNothing waiting.');
  return { result, deliver: null };
}
const MAX_HOPS = 1; // a task may be handed off once; the specialist finishes it
async function giveTask(a, prompt, from, { discoveredFrom = null, hops = 0, review = null } = {}) {
  const skill = isVideo(a) ? 'lemo-opuscar:lemo-opuscar' : skillFor(a.dept, prompt);
  await typeInto(a.id, withSkill(prompt, skill) + projectContext(a) + SCREEN_RULE + (isVideo(a) ? VIDEO_RULE : '') + (hops < MAX_HOPS ? HANDOFF_RULE : '\n\n(Office rule: this is a handoff. Finish it yourself and do not hand it off again.)'));
  if (skill) logEvent(a, 'tool', `running /${skill}`);
  const issueId = await fileTask({ prompt: skill ? `/${skill} ${prompt}` : prompt, from, agent: a, discoveredFrom });
  pendingReplies.set(a.id, { text: from, t: Date.now(), issueId, hops, skill, review });
  return issueId;
}
function skillNote(a, prompt) { const k = isVideo(a) ? 'lemo-opuscar:lemo-opuscar' : skillFor(a.dept, prompt); return k ? `, running /${k}` : ''; }
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
// ---------- the review pass: an engineering queue task goes to QA (and Security when it touches sensitive code) before it closes ----------
// The developer stays on the task (their queue slot is held) while reviewers read the branch in the developer's
// worktree without touching it. FAIL verdicts go back to the developer as a fix round; after REVIEW_ROUNDS the
// task is left for Daniel. OFFICE_REVIEW=off turns the pass off.
const REVIEW_ON = process.env.OFFICE_REVIEW !== 'off';
const REVIEW_ROUNDS = Math.max(1, Number(process.env.OFFICE_REVIEW_ROUNDS || 2));
const SECURITY_PATHS = /(^|\/)(server[^/]*|bridge[^/]*|auth[^/]*|login[^/]*|session[^/]*|permission[^/]*|polic[^/]*|secur[^/]*|token[^/]*|\.env[^/]*|.*\.(sh|zsh|bash|command))$|(^|\/)\.claude\/settings|office-policy\.json$/i;
const SECURITY_CODE = /\b(child_process|execFile|execSync|spawn(Sync)?|exec\(|eval\(|new Function|dangerouslySetInnerHTML|innerHTML\s*=|process\.env|X-Office-Token|hasToken|allow(ed)?Tools|permission|authoriz|crypto\.|fs\.(write|unlink|rm)|\.\.\/)/i;
const VERDICT_RULE = '\n\n(Office rule: end your reply with exactly one line, "VERDICT: PASS" or "VERDICT: FAIL". Before it, list the findings the developer must fix as a numbered list: file and line, what is wrong, why it matters. No findings means PASS. Do not edit, commit or check out anything in the developer\'s worktree; anything you write goes in your own folder.)';
function reviewWanted(w, a) { return REVIEW_ON && upstream.privileged && a.dept === 'engineering' && !w.plan && !(w.review && (w.review.passed || w.review.gaveUp)); }
async function branchChange(w) { // what the developer changed on the branch, committed or not
  const base = (await git(['rev-parse', 'HEAD'])).trim();
  let mb = base; try { mb = await gitIn(w.dir, ['merge-base', 'HEAD', base]); } catch { /* unrelated history: compare with HEAD */ }
  const files = new Set((await gitIn(w.dir, ['diff', '--name-only', `${mb}...HEAD`]).catch(() => '')).split('\n').filter(Boolean));
  const dirty = (await gitIn(w.dir, ['status', '--porcelain']).catch(() => '')).split('\n').filter(Boolean);
  for (const l of dirty) files.add(l.slice(3).trim());
  const commits = (await gitIn(w.dir, ['log', '--oneline', `${mb}..HEAD`]).catch(() => '')).split('\n').filter(Boolean).length;
  let diff = ''; try { diff = await gitIn(w.dir, ['diff', mb]); } catch { /* fine */ }
  return { base: mb, files: [...files], dirty: dirty.length > 0, commits, diff };
}
function needsSecurity(ch) { return ch.files.some((f) => SECURITY_PATHS.test(f)) || SECURITY_CODE.test(ch.diff.split('\n').filter((l) => /^\+[^+]/.test(l)).join('\n')); }
function reviewPrompt(stage, w, title, description, ch, round) {
  const see = `See the change with: git -C ${w.dir} diff ${ch.base.slice(0, 12)}  (${ch.commits} commit${ch.commits === 1 ? '' : 's'} on ${w.branch}${ch.dirty ? ', plus uncommitted changes' : ''}; files: ${ch.files.slice(0, 20).join(', ') || 'none found'}).`;
  const head = `${stage === 'qa' ? 'QA review' : 'Security pass'} of the changes on branch ${w.branch}, round ${round}: task ${w.issueId} "${title}" by ${w.name} (Engineering), in the worktree ${w.dir}.\n${see}\n\nThe task was:\n${(description || '').trim().slice(0, 1500) || '(no description)'}`;
  const body = stage === 'qa'
    ? `\n\nReview the changes on that branch for correctness, then verify the task actually does what it says: read the diff, run whatever can be run against that worktree without modifying it (syntax checks, tests, a throwaway server on a spare port), and try the behaviour the task describes. Report what you ran and what you saw.`
    : `\n\nReview the changes on that branch for security problems: command or shell injection, path traversal, auth or permission bypass, token handling, unsafe file writes, anything a prompt-injected agent could abuse. Judge only the diff, not the rest of the codebase.`;
  return head + body + VERDICT_RULE;
}
async function startReview(dev, r, w) {
  const issue = issues.find((i) => i.id === w.issueId) || {}; const title = issue.title || w.issueId;
  const ch = await branchChange(w);
  if (!ch.files.length) { finishWithoutReview(w.issueId, r, w, 'no changes on the branch to review'); return; }
  const stages = ['qa', ...(needsSecurity(ch) ? ['security'] : [])];
  const round = (w.review?.round || 0) + 1;
  w.review = { round, stages, results: {}, startedAt: Date.now(), devReport: r }; markDirty();
  const message = `Review round ${round} for ${w.issueId}: ${w.name}'s branch goes to QA${stages.includes('security') ? ' and Security' : ''} before it closes.`;
  logChat('manager', 'floor manager', message, { ok: true, action: 'handoff' }); fx('managerSay', dev.id, { text: `${w.issueId}: review`, message, ok: true, action: 'handoff', pending: true });
  await bd(['note', w.issueId, message]).catch(() => {});
  for (const stage of stages) await sendReviewStage(w, stage, dev.id);
  refreshIssues();
}
async function sendReviewStage(w, stage, exceptId = null) {
  const issue = issues.find((i) => i.id === w.issueId) || {}; const title = issue.title || w.issueId;
  const ch = await branchChange(w); const dev = agents.get(w.agentId);
  let target = pickSpecialist(stage, exceptId);
  if (!target) target = await launchSpecialist(stage, homeDirFor(dev));
  const prompt = reviewPrompt(stage, w, title, issue.description, ch, w.review.round);
  await giveTask(target, prompt, `review of ${w.issueId} (${stage})`, { discoveredFrom: w.issueId, hops: MAX_HOPS, review: { issueId: w.issueId, stage, round: w.review.round } });
  w.review.results[stage] = { agentId: target.id, name: agentName(target), verdict: null }; markDirty();
  logChat('manager', 'floor manager', `${agentName(target)} (${DEPT_NAMES[stage]}) is reviewing ${w.issueId}.`, { ok: true }); fx('managerDone', target.id, { ok: true, message: `${agentName(target)} is reviewing ${w.issueId}`, text: `${w.issueId}: review` });
}
const isReviewTitle = (t) => /^(?:\/\S+\s+)?(?:QA review|Security pass) of the changes on branch /.test(t || '');
function finishWithoutReview(issueId, r, w, why) { // the pass could not run: close as before and say so
  const message = `No review for ${issueId} (${why}); closing on ${r.name}'s report.`;
  logChat('manager', 'floor manager', message, { ok: false }); console.log('[review]', message);
  if (w) { w.done = true; w.review = { ...(w.review || {}), gaveUp: true }; markDirty(); setTimeout(dispatchQueue, 2000); }
  bd(['close', issueId, '--reason', `report filed by ${r.name}; ${why}`], { actor: r.name }).catch(() => {}).then(() => { refreshIssues(); planProgress(issueId, r); });
}
async function handleReviewReport(a, r, rv) {
  const w = queue.workers.get(rv.issueId); if (!w || !w.review || w.review.round !== rv.round) return;
  const res = w.review.results[rv.stage]; if (!res || res.agentId !== a.id) return;
  const m = /VERDICT:\s*(PASS|FAIL)/i.exec(r.text || ''); res.verdict = m ? m[1].toUpperCase() : 'FAIL';
  res.text = (r.text || r.recap).replace(/VERDICT:.*$/im, '').trim().slice(0, 3000); res.noVerdict = !m;
  await bd(['note', w.issueId, `${DEPT_NAMES[rv.stage]} review round ${rv.round} by ${r.name}: ${res.verdict}${res.noVerdict ? ' (no verdict line)' : ''}\n${res.text}`], { actor: r.name }).catch(() => {});
  logChat('manager', 'floor manager', `${r.name} (${DEPT_NAMES[rv.stage]}): ${res.verdict} on ${w.issueId}${res.noVerdict ? ' (no verdict line, treated as FAIL)' : ''}.`, { ok: res.verdict === 'PASS' });
  if (w.review.stages.some((st) => !w.review.results[st]?.verdict)) return; // the other reviewer is still at it
  await finishReview(w);
}
async function finishReview(w) {
  const rv = w.review; const dev = agents.get(w.agentId); const r = rv.devReport;
  const failed = rv.stages.filter((st) => rv.results[st].verdict !== 'PASS');
  if (!failed.length) {
    rv.passed = true; w.done = true; markDirty(); setTimeout(dispatchQueue, 2000);
    const message = `${w.issueId} passed review (${rv.stages.map((st) => `${DEPT_NAMES[st]}: ${rv.results[st].name}`).join(', ')}) in round ${rv.round}. Closed; ${w.name}'s work is on ${w.branch}.`;
    logChat('manager', 'floor manager', message, { ok: true, action: 'queue' }); fx('managerSay', w.agentId, { text: `${w.issueId}: review passed`, message, ok: true, action: 'answer', pending: false });
    await bd(['close', w.issueId, '--reason', `passed review: ${rv.stages.map((st) => DEPT_NAMES[st]).join(' + ')}`]).catch(() => {});
    refreshIssues(); planProgress(w.issueId, r); return;
  }
  const findings = failed.map((st) => `${DEPT_NAMES[st]} (${rv.results[st].name}):\n${rv.results[st].text || '(no details)'}`).join('\n\n');
  if (rv.round < REVIEW_ROUNDS && dev && agents.has(dev.id) && dev.hasTerminal) {
    const next = rv.round + 1;
    const prompt = `Review round ${rv.round} of task ${w.issueId} came back with findings. Fix them in your worktree (${w.dir}) on branch ${w.branch}, commit, and reply with what you changed; the branch goes back to review. If a finding is wrong, say why in the reply instead of changing the code.\n\n${findings}`;
    await typeInto(dev.id, prompt + SCREEN_RULE + '\n\n(Office rule: this is a fix round. Finish it yourself and do not hand it off.)');
    pendingReplies.set(dev.id, { text: `review round ${next}: ${w.issueId}`, t: Date.now(), issueId: w.issueId, hops: 0, queued: true });
    const message = `${w.issueId}: ${failed.map((st) => DEPT_NAMES[st]).join(' and ')} found problems. Back to ${w.name} for a fix (round ${next} of ${REVIEW_ROUNDS}).`;
    logChat('manager', 'floor manager', message, { ok: false, action: 'handoff' }); fx('managerSay', dev.id, { text: `${w.issueId}: fix round`, message, ok: true, action: 'handoff', pending: true });
    await bd(['note', w.issueId, message]).catch(() => {});
    return;
  }
  rv.gaveUp = true; w.done = true; markDirty(); setTimeout(dispatchQueue, 2000);
  const message = dev && agents.has(dev.id) ? `${w.issueId} still fails ${failed.map((st) => DEPT_NAMES[st]).join(' and ')} after ${rv.round} round${rv.round === 1 ? '' : 's'}. Left open on ${w.branch} for you; the findings are on the task.` : `${w.issueId} failed review and ${w.name} is gone. Left open on ${w.branch} for you; the findings are on the task.`;
  logChat('manager', 'floor manager', message, { ok: false, action: 'answer' }); fx('managerSay', null, { text: `${w.issueId}: review`, message, ok: false, action: 'answer', pending: false });
  await bd(['note', w.issueId, message]).catch(() => {}); refreshIssues();
}
// ---------- orphaned tasks: an in-progress office task whose assignee has left the floor goes back on the board ----------
// Runs once a minute, after the floor has had time to re-learn its agents following a (re)start. Only tasks the
// office handed out (label `office`) are touched; your own tasks are never reopened.
const ORPHAN_GRACE_MS = 3 * 60000;
let upstreamSince = 0;
async function sweepOrphans() {
  if (!beadsOk || !upstream.connected || !upstreamSince || Date.now() - upstreamSince < ORPHAN_GRACE_MS) return;
  const onFloor = new Set([...agents.values()].flatMap((a) => [a.humanName, a.nickname, a.teammateName, a.directoryName]).filter(Boolean).map((n) => n.toLowerCase()));
  for (const w of queueRunning()) if (w.name) onFloor.add(w.name.toLowerCase());
  onFloor.add('floor-manager');
  for (const i of issues) {
    if (i.status !== 'in_progress' || !i.assignee || !(i.labels || []).includes('office')) continue;
    if (onFloor.has(i.assignee.toLowerCase())) continue;
    if (i.updated && Date.now() - Date.parse(i.updated) < ORPHAN_GRACE_MS) continue; // just handed out: the agent may still be arriving
    if (isReviewTitle(i.title)) { // a review whose reviewer left: the stage is re-run below from the developer's task, this ticket just closes
      await bd(['close', i.id, '--reason', `${i.assignee} left before finishing the review; the stage is being re-run`]).catch(() => {});
      continue;
    }
    try {
      await bd(['update', i.id, '--assignee', '', '--status', 'open', '--force']);
      await bd(['note', i.id, `${i.assignee} left the office before finishing this; the floor manager put it back on the board.`]).catch(() => {});
      queue.workers.delete(i.id);
      const message = `${i.assignee} is gone, so ${i.id} "${i.title}" is back on the board.`;
      console.log('[orphans]', message); logChat('manager', 'floor manager', message, { ok: true, action: 'queue' }); fx('managerSay', null, { text: i.id, message, ok: true, action: 'answer', pending: false });
    } catch (e) { console.log('[orphans]', i.id, e.message); }
  }
  for (const w of queue.workers.values()) { // a review stage whose reviewer left gets a new reviewer
    if (w.done || !w.review || w.review.passed || w.review.gaveUp) continue;
    for (const stage of w.review.stages) {
      const res = w.review.results[stage]; if (!res || res.verdict || agents.has(res.agentId)) continue;
      if (Date.now() - (w.review.startedAt || 0) < ORPHAN_GRACE_MS) continue;
      const message = `${res.name} left mid-review, so ${DEPT_NAMES[stage]} is reviewing ${w.issueId} again.`;
      console.log('[orphans]', message); logChat('manager', 'floor manager', message, { ok: true });
      try { await sendReviewStage(w, stage, w.agentId); } catch (e) { console.log('[orphans]', w.issueId, e.message); }
    }
  }
  await refreshIssues(); dispatchQueue();
}
setInterval(() => sweepOrphans().catch((e) => console.log('[orphans]', e.message)), 60000);
// ---------- sending idle agents home ----------
// Office-launched (pty) agents are closed for good; the manager hires fresh specialists when work comes in.
// Desktop sessions can't be ended from here: pixel-agents just hides them until they're used again.
const SEND_HOME = /\bsend\s+(?:all\s+)?(?:the\s+)?(?:idle|free|bored)\b.*\bhome\b|\b(?:idle|free|bored)\b.*\b(?:sen[dt]|go(?:ne)?)\s+home\b|\bsen[dt]\s+home\b.*\bidle\b|^(?:please\s+)?dismiss\s+(?:the\s+|all\s+)?idle\b/i;
const isSendHome = (t) => t.length < 160 && !/^(?:add|build|make|implement|fix|write|create)\b|^@?[\w-]+(?:\s+\d+)?\s*:/i.test(t) && SEND_HOME.test(t);
// hiredAt is set only when the office launches an agent, not when a bridge restart re-learns one
const justHired = (a) => Date.now() - (a.hiredAt || 0) < 120000; // their task may still be on its way
function idleForHome(a) {
  if (a.parentAgentId || a.status === 'active' || a.permission || a.awaitingInput || a.ask || playing(a.id) || justHired(a)) return false;
  return !queueRunning().some((w) => w.agentId === a.id && !w.done);
}
function sendHomeHandle() {
  const result = { ok: false, action: 'sendHome', targetId: null, message: '' };
  if (!upstream.privileged) { result.message = "I can't send anyone home: the bridge is read-only (no pixel-agents token found)."; return { result, deliver: null }; }
  const going = [...agents.values()].filter(idleForHome);
  const fresh = [...agents.values()].filter((a) => justHired(a) && a.status !== 'active' && !a.permission && !a.awaitingInput);
  const freshNote = fresh.length ? ` ${fresh.map(agentName).join(', ')} just arrived, so I'm keeping ${fresh.length === 1 ? 'them' : 'them all'} for now.` : '';
  if (!going.length) { result.message = (fresh.length ? 'Nobody else is idle.' : 'Nobody is idle: everyone here is working or waiting on you.') + freshNote; return { result, deliver: null }; }
  for (const a of going) sendUpstream({ type: 'closeAgent', id: a.id });
  const hired = going.filter((a) => a.hasTerminal), desk = going.length - hired.length;
  result.ok = true;
  result.message = `Sent ${going.length} home: ${going.map(agentName).join(', ')}.` +
    (desk ? ` ${desk} of them ${desk === 1 ? 'is a desktop session' : 'are desktop sessions'}, so they'll be back when you use them.` : '') + freshNote;
  return { result, deliver: null };
}
// ---------- the office policy and the security desk ----------
// office-policy.json says what agents may run without asking (written into every launched folder's
// .claude/settings.local.json) and how the security desk decides the rest: a permission prompt that
// still comes up goes to a Security specialist with the policy text, and their one-line verdict is
// typed into the asking agent's terminal. Commands matching ask_daniel_patterns come straight to you.
const POLICY_FILE = path.join(__dirname, 'office-policy.json');
let policyCache = { at: 0, mtime: 0, policy: null };
function policy() {
  try {
    const mtime = fs.statSync(POLICY_FILE).mtimeMs;
    if (!policyCache.policy || mtime !== policyCache.mtime) { policyCache = { at: Date.now(), mtime, policy: JSON.parse(fs.readFileSync(POLICY_FILE, 'utf8')) }; }
    return policyCache.policy;
  } catch (e) { if (Date.now() - policyCache.at > 60000) { policyCache.at = Date.now(); console.log('[policy]', e.message); } return policyCache.policy; }
}
function applyPolicy(dir) { // merge the policy's allow/deny into the folder's local Claude settings
  const p = policy(); if (!p || (!p.allow && !p.deny)) return false;
  try {
    const file = path.join(dir, '.claude', 'settings.local.json'); fs.mkdirSync(path.dirname(file), { recursive: true });
    let cur = {}; try { cur = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { /* none yet */ }
    const perms = cur.permissions = cur.permissions || {};
    perms.allow = [...new Set([...(perms.allow || []), ...(p.allow || [])])];
    perms.deny = [...new Set([...(perms.deny || []), ...(p.deny || [])])];
    fs.writeFileSync(file, JSON.stringify(cur, null, 2) + '\n'); return true;
  } catch (e) { console.log('[policy] could not write settings in', dir, e.message); return false; }
}
function policyText() {
  const p = policy(); if (!p) return 'There is no office-policy.json next to server.mjs, so there is no policy: every prompt comes to you.';
  const d = p.desk || {}; const list = (xs) => (xs || []).map((x) => `  • ${x}`).join('\n') || '  (nothing)';
  return `Pre-approved in every launched folder (${(p.allow || []).length} rules) and denied outright (${(p.deny || []).length} rules): see office-policy.json.\nThe security desk approves:\n${list(d.approve)}\nrefuses:\n${list(d.refuse)}\nand brings to you:\n${list(d.ask_daniel)}`;
}
const desk = new Map(); // askerId -> { toolUseId, securityId, t, summary }
const DESK_TIMEOUT = 4 * 60000;
function deskable(a) {
  if (!a.hasTerminal || a.parentAgentId || !a.ask || a.ask.kind !== 'permission' || !(a.permission || a.awaitingInput)) return false;
  const cur = desk.get(a.id); if (cur && cur.toolUseId === a.ask.toolUseId && Date.now() - cur.t < DESK_TIMEOUT) return false;
  const pending = pendingReplies.get(a.id); if (pending && pending.desk) return false; // the desk itself never gets desked
  return true;
}
function deskSkip(a) { // commands you want to see yourself
  const pats = (policy()?.desk?.ask_daniel_patterns) || []; const s = `${a.ask.summary || ''} ${a.ask.description || ''}`.toLowerCase();
  return pats.find((x) => s.includes(String(x).toLowerCase())) || null;
}
function deskPrompt(a, p) {
  const d = p.desk || {}; const list = (xs) => (xs || []).map((x) => `- ${x}`).join('\n') || '- (nothing)';
  return `Security desk. You answer permission prompts for the office according to Daniel's policy. Do not run any tools and do not investigate: decide from the policy and the request below alone.\n\n${agentName(a)} (${DEPT_NAMES[a.dept]}), working in ${a.directoryName || 'the project'}, wants to run the tool ${a.ask.tool}:\n${a.ask.description ? `${a.ask.description}\n` : ''}${a.ask.summary || '(no details)'}\n\nPolicy. Approve:\n${list(d.approve)}\nRefuse:\n${list(d.refuse)}\nAsk Daniel:\n${list(d.ask_daniel)}\n\nReply with exactly one line and nothing else, in this form:\nAPPROVE: <reason in a few words>\nor REFUSE: <reason>\nor ASK: <what Daniel should decide>`;
}
async function deskRoute(a) {
  const p = policy(); if (!p || !p.desk) return;
  const skip = deskSkip(a);
  if (skip) {
    desk.set(a.id, { toolUseId: a.ask.toolUseId, securityId: null, t: Date.now(), summary: a.ask.summary, skipped: skip });
    const message = `${agentName(a)} wants to run something the policy says is yours to decide ("${skip}"): ${(a.ask.summary || a.ask.tool).slice(0, 120)}. Allow or deny it in their panel.`;
    logChat('manager', 'floor manager', message, { ok: false, action: 'desk' }); fx('managerSay', a.id, { text: `${agentName(a)} needs you`, message, ok: false, action: 'answer', pending: false });
    return;
  }
  let sec = pickSpecialist('security', a.id);
  desk.set(a.id, { toolUseId: a.ask.toolUseId, securityId: sec ? sec.id : null, t: Date.now(), summary: a.ask.summary });
  a.desk = { name: sec ? agentName(sec) : 'the security desk', t: Date.now() }; markDirty();
  const what = (a.ask.summary || a.ask.tool).replace(/\s+/g, ' ').slice(0, 90);
  try {
    if (!sec) { if (!upstream.privileged) return; sec = await launchSpecialist('security', homeDirFor(a)); const e = desk.get(a.id); if (e) e.securityId = sec.id; a.desk = { name: agentName(sec), t: Date.now() }; }
    await typeInto(sec.id, deskPrompt(a, p));
    pendingReplies.set(sec.id, { text: `desk: ${agentName(a)} wants ${what}`, t: Date.now(), issueId: null, hops: MAX_HOPS, desk: { askerId: a.id, toolUseId: a.ask.toolUseId, summary: a.ask.summary, tool: a.ask.tool } });
    logEvent(a, 'manager', `permission sent to ${agentName(sec)} (security desk)`); logEvent(sec, 'manager', `checking ${agentName(a)}'s request`);
    const message = `${agentName(a)} asked to run ${what}: checking with ${agentName(sec)} at the security desk.`;
    logChat('manager', 'floor manager', message, { ok: true, action: 'desk' }); fx('managerSay', sec.id, { text: `${agentName(a)}: ${what}`, message, ok: true, action: 'desk', pending: false });
  } catch (e) { desk.delete(a.id); a.desk = null; markDirty(); console.log('[desk]', e.message); }
}
async function handleDeskReport(sec, r, d) {
  const a = agents.get(d.askerId); const m = /\b(APPROVE|REFUSE|ASK)\b\s*[:—–-]?\s*(.*)/i.exec(r.text || '');
  const verdict = m ? m[1].toUpperCase() : 'ASK'; const reason = (m ? m[2] : r.text || '').trim().slice(0, 200) || 'no reason given';
  const what = (d.summary || d.tool || '').replace(/\s+/g, ' ').slice(0, 90);
  const live = a && a.hasTerminal && a.ask && a.ask.toolUseId === d.toolUseId && (a.permission || a.awaitingInput);
  if (a) { a.desk = null; markDirty(); }
  desk.delete(d.askerId);
  if (!live) { logChat('manager', 'floor manager', `${r.name} said ${verdict} to ${a ? agentName(a) : 'an agent'}'s ${what}, but that prompt is already gone.`, { ok: true, action: 'desk' }); return; }
  try {
    if (verdict === 'APPROVE') { await typeInto(a.id, '1', true); logEvent(a, 'manager', `approved by ${r.name}: ${reason}`); }
    else if (verdict === 'REFUSE') { await typeInto(a.id, '\u001b', false); await sleep(800); await typeInto(a.id, `The security desk (${r.name}) refused that: ${reason}. Don't retry it; find another way within your task or stop and report.`); logEvent(a, 'manager', `refused by ${r.name}: ${reason}`); }
    const message = verdict === 'APPROVE' ? `${r.name} approved ${agentName(a)}'s ${what} (${reason}).` : verdict === 'REFUSE' ? `${r.name} refused ${agentName(a)}'s ${what} (${reason}).` : `${r.name} wants you to decide ${agentName(a)}'s ${what}: ${reason}. Allow or deny it in their panel.`;
    logChat('manager', 'floor manager', message, { ok: verdict !== 'ASK', action: 'desk' });
    fx('managerSay', verdict === 'ASK' ? a.id : null, { text: `${agentName(a)}: ${what}`, message, ok: verdict !== 'ASK', action: 'answer', pending: false });
    if (verdict === 'ASK') desk.set(d.askerId, { toolUseId: d.toolUseId, securityId: sec.id, t: Date.now(), summary: d.summary, skipped: 'desk asked you' });
  } catch (e) { logChat('manager', 'floor manager', `Couldn't pass ${r.name}'s answer to ${agentName(a)}: ${e.message}`, { ok: false }); }
}
try { for (const d of fs.readdirSync(WORKTREES)) if (fs.existsSync(path.join(WORKTREES, d, '.git'))) applyPolicy(path.join(WORKTREES, d)); } catch { /* no worktrees yet */ }
setInterval(() => { for (const a of agents.values()) if (deskable(a)) deskRoute(a).catch((e) => console.log('[desk]', e.message)); }, 3000);
// Office-hired agents also go home by themselves once they've sat idle this long with nothing owed,
// so finished queue workers don't pile up. OFFICE_IDLE_HOME_MIN=0 turns it off.
const IDLE_HOME_MS = Math.max(0, Number(process.env.OFFICE_IDLE_HOME_MIN ?? 10)) * 60000;
function sendIdleHome() {
  if (!IDLE_HOME_MS || !upstream.privileged) return;
  const going = [...agents.values()].filter((a) => a.hasTerminal && !pendingReplies.has(a.id) && Date.now() - a.lastEvent > IDLE_HOME_MS && idleForHome(a));
  if (!going.length) return;
  for (const a of going) sendUpstream({ type: 'closeAgent', id: a.id });
  const message = `Sent ${going.map(agentName).join(', ')} home after ${IDLE_HOME_MS / 60000} idle minutes.`;
  console.log('[office]', message); logChat('manager', 'floor manager', message, { ok: true });
}
setInterval(sendIdleHome, 60000);
// ---------- planning: a big request goes to a planner, who splits it into parts for the specialists ----------
// The manager takes anything that reads as more than one job (or "plan: <task>") to a planner, a Claude
// session like the others. The planner reads the code, changes nothing, and answers with a PLAN block.
// Each part becomes a bead under an epic, with its dependencies, plus a final integration part; the
// queue then hands every unblocked part to a fresh specialist in its own worktree, several at once.
const PLAN_CHARS = Number(process.env.OFFICE_PLAN_CHARS || 280);
function wantsPlan(prompt) {
  const p = String(prompt || '').trim(); if (p.length < 40) return false;
  if (p.length > PLAN_CHARS) return true;
  const sentences = (p.match(/[.!?](\s|$)/g) || []).length;
  const bullets = (p.match(/^\s*(?:[-*•]|\d+[.)])\s/gm) || []).length;
  const joins = (p.match(/\b(and then|then|also|as well as|plus|after that|finally|and also|once that|afterwards)\b/gi) || []).length;
  return sentences >= 3 || bullets >= 2 || joins >= 2 || (p.length > 140 && joins >= 1);
}
function pickPlanner() {
  const pool = [...agents.values()].filter((a) => a.hasTerminal && !a.parentAgentId && isPlanner(a) && !playing(a.id));
  pool.sort((p, q) => ((p.status === 'active' || p.permission || p.awaitingInput) - (q.status === 'active' || q.permission || q.awaitingInput)) || (q.lastEvent - p.lastEvent));
  return pool[0] || null;
}
function plannerPrompt(prompt) {
  return `You are the planner of this office. The floor manager got a request that is too big for one person and wants it split into parts that different specialists will do at the same time, each in their own git worktree of this project.

The request:
---
${prompt}
---

Read the code as much as you need, but change nothing. Then reply with a plan block, exactly in this format, as the last thing in your message:

PLAN
1. [engineering] Short title :: what to do, concretely, naming the files to touch (after: none)
2. [qa] Short title :: what to do (after: 1)
END PLAN

Rules: 2 to 6 parts. The job in brackets is one of engineering, qa, uiux, security. "after:" lists the part numbers that must be finished first, or none. Parts with no "after" run at the same time in separate worktrees, so give them different files where you can and say in each part what it must not touch. Do not add a merge or integration part: the manager adds that himself. If the request is honestly one job, reply with a one-part PLAN.`;
}
const plans = new Map(); // epicId -> { epicId, title, prompt, planner, parts: [{ n, id, dept, title, after, done, by, branch }], integId, integDone, startedAt }
function planOf(issueId) { for (const p of plans.values()) if (p.integId === issueId || p.parts.some((x) => x.id === issueId)) return p; return null; }
function describePlan(p) {
  const done = p.parts.filter((x) => x.done).length;
  return `${p.epicId} "${p.title}" by ${p.planner}: ${done}/${p.parts.length} parts done\n` + p.parts.map((x) => `  ${x.done ? '●' : x.by ? '◐' : '○'} ${x.id} [${DEPT_NAMES[x.dept]}] ${x.title}${x.by ? ` (${x.by}${x.branch ? `, ${x.branch}` : ''})` : ''}${x.after.length ? ` after ${x.after.join(',')}` : ''}`).join('\n') + (p.integId ? `\n  ${p.integDone ? '●' : '○'} ${p.integId} integrate everything` : '');
}
function parsePlanBlock(text) {
  const m = /^\s*PLAN\s*$([\s\S]*?)^\s*END PLAN\s*$/im.exec(text || ''); const body = m ? m[1] : String(text || '');
  const parts = [];
  for (const line of body.split('\n')) {
    const h = /^\s*(\d+)[.)]\s*\[\s*([a-z /]+?)\s*\]\s*(.+?)\s*$/i.exec(line); if (!h) continue;
    let rest = h[3]; let after = [];
    const a = /\(\s*after:\s*([^)]*)\)\s*$/i.exec(rest); if (a) { after = (a[1].match(/\d+/g) || []).map(Number); rest = rest.slice(0, a.index).trim(); }
    const [title, ...detail] = rest.split(/\s*::\s*/);
    const dept = DEPT_ALIASES[h[2].toLowerCase().replace(/\s+/g, '')] || classifyText(rest) || 'engineering';
    parts.push({ n: Number(h[1]), dept, title: title.replace(/[*_`]/g, '').trim().slice(0, 100), detail: detail.join(' :: ').trim(), after });
  }
  const nums = new Set(parts.map((p) => p.n));
  for (const p of parts) p.after = p.after.filter((n) => nums.has(n) && n !== p.n);
  return parts;
}
async function fileEpic(prompt, planner) {
  if (!beadsOk) return null;
  const title = prompt.replace(/\s+/g, ' ').trim().slice(0, 90);
  try {
    const out = await bd(['create', '--title', title, '--description', `A big request the floor manager took to ${agentName(planner)} (planner) to split into parts.\n\nRequest: ${prompt}`, '--type', 'epic', '--priority', '2', '--labels', 'office,plan', '--json']);
    const id = JSON.parse(out).id || null; refreshIssues(); return id;
  } catch (e) { console.log('[beads] epic failed:', e.message); return null; }
}
function planHandle(prompt, from, explicit, root = null) {
  const result = { ok: false, action: 'plan', targetId: null, message: '' };
  if (!beadsOk) { result.message = 'That needs a plan with several parts, but there is no beads database here to track them. Run `bd init` in this folder, or say "@<name>: …" to give it to one person.'; return { result, deliver: null }; }
  if (!upstream.privileged) { result.message = "That needs splitting up, but the bridge is read-only so I can't bring anyone in."; return { result, deliver: null }; }
  let planner = pickPlanner();
  result.ok = true; result.targetId = planner ? planner.id : null;
  result.message = `${explicit ? 'Right' : "That's a big one"}. ${planner ? `Taking it to ${agentName(planner)} to break it down…` : 'Bringing in a planner to break it down…'}`;
  return { result, deliver: async () => {
    if (!planner) planner = await launchSpecialist('planner', homeDirFor(null, root));
    const epicId = await fileEpic(prompt, planner);
    await typeInto(planner.id, plannerPrompt(prompt));
    logEvent(planner, 'manager', 'splitting a big task');
    pendingReplies.set(planner.id, { text: from, t: Date.now(), issueId: null, hops: MAX_HOPS, plan: { prompt, from, epicId } });
    return { targetId: planner.id, message: `${agentName(planner)} is breaking it down${epicId ? ` (${epicId})` : ''}. When the plan is back I'll call everyone over and hand out the parts.` };
  } };
}
async function handlePlanReport(planner, r, plan) {
  const parts = parsePlanBlock(r.text);
  if (plan.epicId) bd(['note', plan.epicId, `Plan from ${r.name}:\n${r.text.slice(0, 3000)}`]).catch(() => {});
  if (parts.length < 2) { // no plan, or one job after all: hand the whole thing to a specialist
    const why = parts.length ? `${r.name} says it's really one job` : `${r.name} didn't give me a plan I can read`;
    const prompt = parts.length && parts[0].detail ? `${parts[0].title}: ${parts[0].detail}\n\nThe original request: ${plan.prompt}` : plan.prompt;
    const dept = (parts[0] && parts[0].dept) || classifyText(prompt) || 'engineering';
    let target = pickSpecialist(dept);
    const message = `${why}. Handing the whole thing to ${target ? agentName(target) : `a new ${DEPT_NAMES[dept]} specialist`}.`;
    logChat('manager', 'floor manager', message, { ok: true, action: 'plan' }); fx('managerSay', target ? target.id : null, { text: plan.from, message, ok: true, action: target ? 'type' : 'launch', pending: true });
    try {
      if (!target) target = await launchSpecialist(dept, homeDirFor(planner));
      const issueId = await giveTask(target, prompt, plan.from, { discoveredFrom: plan.epicId });
      if (plan.epicId) bd(['close', plan.epicId, '--reason', 'one job after all; handed to a specialist']).catch(() => {});
      const done = `Told ${agentName(target)} (${DEPT_NAMES[target.dept]})${issueId ? `, filed as ${issueId}` : ''}.`;
      logChat('manager', 'floor manager', done, { ok: true }); fx('managerDone', target.id, { ok: true, message: done, text: plan.from });
    } catch (e) { const message = `Couldn't hand it over: ${e.message}`; logChat('manager', 'floor manager', message, { ok: false }); fx('managerDone', null, { ok: false, message, text: plan.from }); }
    return;
  }
  const epicId = plan.epicId || await fileEpic(plan.prompt, planner);
  const p = { epicId, title: plan.prompt.replace(/\s+/g, ' ').trim().slice(0, 60), prompt: plan.prompt, planner: r.name, parts: [], integId: null, integDone: false, startedAt: Date.now() };
  const ids = new Map();
  for (const t of parts) {
    const others = parts.filter((o) => o !== t).map((o) => `${o.n}. ${o.title}`).join('; ');
    const description = `Part ${t.n} of ${parts.length} of a plan by ${r.name} (${epicId}).\n\nThe whole request: ${plan.prompt}\n\nThis part: ${t.detail || t.title}\n\nThe other parts run at the same time in other worktrees (${others}): stay inside this part and leave their files alone.${t.after.length ? ` This part starts only after part${t.after.length > 1 ? 's' : ''} ${t.after.join(', ')} ${t.after.length > 1 ? 'are' : 'is'} done; their work is on branches office/<their id>, listed in the epic.` : ''}`;
    try {
      const out = await bd(['create', '--title', t.title, '--description', description, '--type', 'task', '--priority', '2', '--labels', `office,plan,${t.dept}`, ...(epicId ? ['--parent', epicId] : []), '--json']);
      const id = JSON.parse(out).id; ids.set(t.n, id); p.parts.push({ n: t.n, id, dept: t.dept, title: t.title, after: t.after, done: false, by: null, branch: null });
    } catch (e) { console.log('[plan] create failed:', e.message); }
  }
  for (const t of parts) for (const n of t.after) if (ids.has(t.n) && ids.has(n)) await bd(['dep', 'add', ids.get(t.n), ids.get(n)]).catch((e) => console.log('[plan] dep failed:', e.message));
  if (p.parts.length) {
    const branches = p.parts.map((x) => `office/${x.id} (${x.title})`).join(', ');
    try {
      const out = await bd(['create', '--title', `Integrate: ${p.title}`, '--description', `Last part of the plan ${epicId} by ${r.name}. The parts were done on separate branches: ${branches}. Merge every one of them into your branch, resolve conflicts, run whatever builds and tests this project has, fix what the merge broke, and report what is on the branch and how you verified it. The whole request, for context: ${plan.prompt}`, '--type', 'task', '--priority', '2', '--labels', 'office,plan,engineering', ...(epicId ? ['--parent', epicId] : []), '--deps', p.parts.map((x) => x.id).join(','), '--json']);
      p.integId = JSON.parse(out).id;
    } catch (e) { console.log('[plan] integration task failed:', e.message); }
  }
  if (epicId) { plans.set(epicId, p); bd(['note', epicId, `Parts: ${p.parts.map((x) => `${x.id} [${x.dept}] ${x.title}`).join('; ')}${p.integId ? `; then ${p.integId} integrates.` : ''}`]).catch(() => {}); }
  refreshIssues();
  const lines = p.parts.map((x) => `${x.n}. ${DEPT_NAMES[x.dept]}: ${x.title}${x.after.length ? ` (after ${x.after.join(', ')})` : ''}`);
  const message = `${r.name}'s plan, ${p.parts.length} parts:\n${lines.join('\n')}\n${p.integId ? `Then ${p.integId} merges it all. ` : ''}Starting every part that isn't waiting on another, up to ${PLAN_WORKERS} at once, each in its own worktree.`;
  logChat('manager', 'floor manager', message, { ok: true, action: 'plan' });
  fx('huddle', planner.id, { epicId, message, planner: r.name, parts: p.parts.map((x) => ({ n: x.n, id: x.id, dept: x.dept, title: x.title, after: x.after })) });
  setTimeout(dispatchQueue, 1500);
}
function planProgress(issueId, r) {
  const p = issueId && planOf(issueId); if (!p) return;
  if (p.integId === issueId) {
    p.integDone = true;
    const message = `Plan "${p.title}" is complete: ${r.name} merged all ${p.parts.length} parts on branch office/${p.integId}. Merge that into main when you're happy with it.`;
    logChat('manager', 'floor manager', message, { ok: true, action: 'plan' }); fx('managerSay', null, { text: p.title, message, ok: true, action: 'answer', pending: false });
    plans.delete(p.epicId); if (p.epicId) bd(['close', p.epicId, '--reason', 'all parts integrated']).catch(() => {});
    return;
  }
  const part = p.parts.find((x) => x.id === issueId); if (!part || part.done) return;
  part.done = true; part.by = r.name; part.branch = part.branch || r.branch || null;
  const left = p.parts.filter((x) => !x.done).length;
  const message = left ? `Part ${part.n} of "${p.title}" is in from ${r.name}; ${left} to go.` : `All ${p.parts.length} parts of "${p.title}" are in.${p.integId ? ' Next up: merging them together.' : ''}`;
  logChat('manager', 'floor manager', message, { ok: true, action: 'plan' }); fx('managerSay', null, { text: p.title, message, ok: true, action: 'answer', pending: false });
  setTimeout(dispatchQueue, 1500);
}
async function managerHandle(text, { project: root = null } = {}) { // root: the project tab you have open, if any
  if (isSendHome(text.trim())) return sendHomeHandle();
  const playReq = parsePlay(text);
  if (playReq) return playHandle(playReq);
  const result = { ok: false, action: null, targetId: null, message: '' };
  const q = parseQueue(text); if (q) return queueHandle(q);
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
    if (!assignRole(a, move.dept)) result.message = `${agentName(a)} is already ${JOB_NAMES[move.dept]}.`;
    else result.message = `${agentName(a)}, from now on you're ${JOB_NAMES[move.dept]}.`;
    return { result, deliver: null };
  }
  const ab = text.trim().match(/^(?:about|project)\s+(\S+?)\s*:\s*([\s\S]+)$/i); // "about <folder>: what I'm building"
  if (ab) {
    const dir = knownRoot(ab[1]) ? ab[1] : projectRootOf(ab[1]) || resolveDir(ab[1]);
    if (!dir) { result.message = `I can't find a project called "${ab[1]}".`; return { result, deliver: null }; }
    const about = setProjectAbout(dir, ab[2]);
    result.ok = true; result.action = 'answer'; result.message = about ? `Noted for ${path.basename(dir)}: ${about}` : `Cleared the description of ${path.basename(dir)}.`;
    return { result, deliver: null };
  }
  const answer = statusAnswer(text);
  if (answer) { result.ok = true; result.action = 'answer'; result.message = answer; return { result, deliver: null }; }
  const req = parseRequest(text);
  if (req.kind === 'launch') {
    const dir = resolveDir(req.dir);
    if (!dir) { result.message = `I can't find a folder called "${req.dir}". Give me a full path or a folder under Downloads, Documents or Desktop.`; return { result, deliver: null }; }
    result.action = 'launch'; result.message = `Launching a new agent in ${path.basename(dir)}…`; result.ok = true; result.dir = dir; // the client selects this project's tab once the agent shows up
    return { result, deliver: async () => {
      const id = await launchAgent(dir); fx('managerTarget', id, { text }); const ready = await waitForPrompt(id);
      let issueId = null;
      const a = agents.get(id);
      if (a && req.role) { a.humanName = pickHumanName(req.role); a.role = req.role; applyRole(a); markDirty(); }
      if (req.prompt && a) { await sleep(ready ? 600 : 0); issueId = await giveTask(a, req.prompt, text); }
      else if (a && projectAbout(dir)) { await sleep(ready ? 600 : 0); await typeInto(id, `You are joining the project in ${dir}. What Daniel is building: ${projectAbout(dir)}\n\nRead the project briefly so you know your way around, then stop and wait: the floor manager will hand you a task.`); }
      return { targetId: id, message: req.prompt ? `Handed the task to the new ${path.basename(dir)} agent${issueId ? ` and filed it as ${issueId}` : ''}.` : `New agent is up in ${path.basename(dir)}.` };
    } };
  }
  if (req.kind === 'any' && !VIDEO_RE.test(req.prompt) && (req.plan || wantsPlan(req.prompt))) return planHandle(req.prompt, text, !!req.plan, root); // a video brief is long by nature: the producer splits it, not a planner
  let target = null;
  if (req.kind === 'agent') {
    target = findAgent(req.name);
    if (!target) { result.message = `Nobody here is called "${req.name}". Say "new agent in <folder>: <task>" and I'll bring someone in.`; return { result, deliver: null }; }
  } else { // nobody named: the job the task needs decides who gets it
    const dept = jobForText(req.prompt) || 'engineering';
    target = pickSpecialist(dept, null, { root });
    if (!target) {
      if (!upstream.privileged) { result.message = `No ${JOB_NAMES[dept]} specialist ${root ? `in ${path.basename(root)}` : 'on the floor'}, and the bridge is read-only so I can't bring one in.`; return { result, deliver: null }; }
      const dir = homeDirFor(null, root);
      result.ok = true; result.action = 'launch'; result.message = dept === 'video' ? `No video producer is free. Bringing one in to ${path.basename(dir)}…` : `No ${DEPT_NAMES[dept]} specialist is free. Bringing one in to ${path.basename(dir)}…`;
      return { result, deliver: async () => {
        const a = await launchSpecialist(dept, dir);
        const issueId = await giveTask(a, req.prompt, text);
        return { targetId: a.id, message: `${agentName(a)} joined as ${dept === 'video' ? 'video producer' : DEPT_NAMES[dept]} in ${path.basename(dir)} and is on it${skillNote(a, req.prompt)}${issueId ? ` (${issueId})` : ''}.` };
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
    return { targetId: target.id, message: `Told ${agentName(target)} (${DEPT_NAMES[target.dept]}${skillNote(target, req.prompt)})${issueId ? `, filed as ${issueId}` : ''}. I'll bring you the answer when they're done.` };
  } };
}

// ---------- http ----------
const MIME = { '.html': 'text/html', '.htm': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
function readBody(req, max = 1e6) { return new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > max) req.destroy(); }); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } }); }); }
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }

// ---------- access control ----------
// Loopback alone isn't a boundary: any web page can POST to it and a rebinding domain can read it.
// So: only answer our own Host and Origin, and require a per-start token (0600 file for lego.mjs,
// a meta tag in index.html for the page) on every API call and on the event stream.
const TOKEN = crypto.randomBytes(32).toString('hex');
const TOKEN_FILE = path.join(os.homedir(), '.agent-office', 'token');
fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true, mode: 0o700 });
function writeToken() { fs.writeFileSync(TOKEN_FILE, TOKEN, { mode: 0o600 }); fs.chmodSync(TOKEN_FILE, 0o600); } // written once we own the port, so a second start that fails on a busy port can't clobber the live token
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
    res.write(`data: ${JSON.stringify(play.galleryMsg())}\n\n`);
    sseClients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
    return;
  }
  if (url.pathname === '/api/state') return json(res, 200, snapshot());
  if (url.pathname === '/api/gallery') return json(res, 200, { ok: true, ...play.galleryMsg() }); // every shelved build, newest first
  if (url.pathname === '/api/manager' && req.method === 'POST') {
    const body = await readBody(req);
    let text = typeof body.text === 'string' ? body.text : '';
    const images = (Array.isArray(body.images) ? body.images : []).filter((u) => typeof u === 'string' && /^\/screens\/[^/]+$/.test(u)).slice(0, 10);
    if (!text.trim() && !images.length) return json(res, 400, { ok: false, message: 'say something' });
    const project = knownRoot(body.project) ? body.project : null; // only a folder someone on the floor is already working in
    const shown = text.slice(0, 12000);
    if (images.length) text = (shown.trim() || 'Look at the attached image.') + `\n\nAttached ${images.length === 1 ? 'image' : 'images'} (read ${images.length === 1 ? 'it' : 'them'} with the Read tool): ` + images.map((u) => path.join(SCREENS_DIR, decodeURIComponent(u.slice('/screens/'.length)))).join(' , ');
    else text = shown;
    try {
      const { result, deliver } = await managerHandle(text, { project });
      json(res, 200, result);
      logChat('you', 'you', shown, images.length ? { images } : {}); logChat('manager', 'floor manager', result.message, { ok: result.ok, action: result.action });
      fx('managerSay', result.targetId, { text: shown, images, message: result.message, ok: result.ok, action: result.action, pending: !!deliver });
      if (deliver) {
        deliver().then((r) => { logChat('manager', 'floor manager', r.message, { ok: true }); fx('managerDone', r.targetId, { ok: true, message: r.message, text }); })
          .catch((e) => { const message = `That didn't work: ${e.message}`; logChat('manager', 'floor manager', message, { ok: false }); fx('managerDone', result.targetId, { ok: false, message, text }); });
      }
    } catch (e) { json(res, 500, { ok: false, message: e.message }); }
    return;
  }
  if (url.pathname === '/api/upload' && req.method === 'POST') { // an image for a prompt: { name, data: dataURL }
    const { name, data } = await readBody(req, 40e6);
    const m = /^data:(image\/(png|jpeg|gif|webp|svg\+xml));base64,([A-Za-z0-9+/=]+)$/.exec(String(data || ''));
    if (!m) return json(res, 400, { ok: false, message: 'send a PNG, JPG, GIF, WEBP or SVG' });
    const ext = { png: '.png', jpeg: '.jpg', gif: '.gif', webp: '.webp', 'svg+xml': '.svg' }[m[2]];
    const base = safeName(String(name || 'image').replace(/\.[^.]*$/, '')) || 'image';
    const file = `in-${Date.now()}-${base}${ext}`;
    fs.writeFileSync(path.join(SCREENS_DIR, file), Buffer.from(m[3], 'base64'));
    return json(res, 200, { ok: true, url: `/screens/${encodeURIComponent(file)}`, name: file });
  }
  if (url.pathname.startsWith('/screens/')) { // what you attached and what the agents handed back
    const name = path.basename(decodeURIComponent(url.pathname.slice('/screens/'.length)));
    const file = path.join(SCREENS_DIR, name);
    return fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); res.end(data);
    });
  }
  if (url.pathname === '/api/history') return json(res, 200, { reports: reports.slice(-100), chat: chatLog.slice(-100), depts: DEPT_NAMES, issues, beads: beadsOk, skills: Object.fromEntries(Object.entries(DEPT_SKILLS).map(([d, ks]) => [d, ks.map((k) => ({ skill: k.skill, what: k.what }))])) });
  if (url.pathname === '/api/projects/about' && req.method === 'POST') { // { folder, about }: remember what Daniel is building there
    const { folder, about } = await readBody(req);
    const dir = typeof folder === 'string' && folder.trim() ? (knownRoot(folder) ? folder : resolveDir(folder)) : null;
    if (!dir) return json(res, 404, { ok: false, message: `I can't find a folder called "${String(folder || '').slice(0, 80)}". Give me a full path or a folder under Downloads, Documents or Desktop.` });
    const saved = setProjectAbout(dir, about);
    return json(res, 200, { ok: true, root: dir, name: path.basename(dir), about: saved });
  }
  if (url.pathname === '/api/issues') { // ?project=<root> reads that project's board instead of this repo's
    const root = url.searchParams.get('project');
    if (root && !knownRoot(root)) return json(res, 400, { ok: false, message: 'not a project on the floor' });
    if (root) { const r = await issuesFor(root); return json(res, 200, { ok: true, root, ...r }); }
    return json(res, 200, { ok: true, issues: await refreshIssues(), beads: beadsOk });
  }
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
  if ((m = url.pathname.match(/^\/api\/agents\/(\d+)\/answers$/)) && req.method === 'POST') {
    // One answer per question of an AskUserQuestion: { option: <1-based index> } picks a button,
    // { text } types into its "Other" slot. Claude Code walks the questions one after the other and
    // ends on a submit step, so the answers are typed in order with a pause between them.
    const id = Number(m[1]); const a = agents.get(id); const body = await readBody(req); const answers = Array.isArray(body.answers) ? body.answers : [];
    const qs = a?.ask?.questions || (a?.ask ? [a.ask] : []);
    if (!a || !qs.length) return json(res, 400, { ok: false, message: 'that agent is not asking anything' });
    try {
      for (let i = 0; i < qs.length; i++) {
        const ans = answers[i] || {}; const q = qs[i];
        if (ans.text && String(ans.text).trim()) { await typeInto(id, String(q.options.length + 1), true); await sleep(500); await typeInto(id, String(ans.text).trim(), true); }
        else await typeInto(id, String(ans.option || 1), true);
        await sleep(600);
      }
      if (qs.length > 1) await typeInto(id, '\r', false); // the submit step after the last question
      logEvent(a, 'manager', `you answered ${qs.length} question${qs.length === 1 ? '' : 's'}`);
      return json(res, 200, { ok: true });
    } catch (e) { return json(res, 400, { ok: false, message: e.message }); }
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
server.listen(PORT, '127.0.0.1', () => { writeToken(); console.log(`\n  Agent Office 3D at http://127.0.0.1:${PORT}\n`); });
server.on('error', (e) => { console.log(`[bridge] cannot listen on ${PORT}: ${e.message}`); process.exit(1); });
