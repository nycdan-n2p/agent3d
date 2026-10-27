import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// Every API call and the event stream carry the per-start token the bridge puts in index.html.
const TOKEN = document.querySelector('meta[name="office-token"]')?.content || '';
const api = (url, opts = {}) => fetch(url, { ...opts, headers: { ...opts.headers, 'X-Office-Token': TOKEN } });

// ============================================================ setup
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 200);
// Your office is on the mezzanine at the front of the room; the camera starts there, looking down over
// the floor. "overview" swings out to the old corner view.
const MEZZ = { y: 4.6, z0: 11, z1: 15, deskX: 0, deskZ: 13.6 };
const HOME = new THREE.Vector3(3.5, 8.2, 16.8);
const HOME_TARGET = new THREE.Vector3(0, 0.2, -4.5);
const OVERVIEW = new THREE.Vector3(16, 14, 20);
const OVERVIEW_TARGET = new THREE.Vector3(0, 1, -1);
camera.position.copy(HOME);
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
document.body.prepend(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.copy(HOME_TARGET);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.autoRotate = false; // the balcony view stays put; "orbit" turns the slow spin on
controls.autoRotateSpeed = 0.35;
controls.maxPolarAngle = Math.PI * 0.49;
controls.minDistance = 4;
controls.maxDistance = 60;

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.55, 0.5, 0.82);
composer.addPass(bloom);
composer.addPass(new OutputPass());

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight); composer.setSize(innerWidth, innerHeight);
});

// ============================================================ palette helpers
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const mat = (color, opts = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.05, ...opts });
const TOOL_COLORS = {
  terminal: 0x39d98a, read: 0x4ea1ff, write: 0xffb020, agent: 0xc77dff, web: 0x33e6e6, think: 0xd6dcff, off: 0x0b0d1a, permission: 0xff4d6d,
};
function prettyTool(name = '') {
  let n = String(name);
  const m = n.match(/^mcp__[^_]+(?:_[^_]+)*?__(.+)$/); if (m) n = m[1];
  n = n.replace(/^mcp__/, '').replace(/__/g, ' ').replace(/_/g, ' ');
  return n.length > 22 ? n.slice(0, 21) + '…' : n;
}
function toolKind(name = '') {
  const n = name.toLowerCase();
  if (/bash|shell|terminal|exec|run/.test(n)) return 'terminal';
  if (/write|edit|notebook|create|patch/.test(n)) return 'write';
  if (/task|agent|spawn|team/.test(n)) return 'agent';
  if (/web|fetch|search|http|browser|navigate/.test(n)) return 'web';
  if (/read|grep|glob|find|ls|list|cat|view/.test(n)) return 'read';
  return 'think';
}

// ============================================================ lighting + sky
const hemi = new THREE.HemisphereLight(0xbfd4ff, 0x30244a, 0.9);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff1d6, 2.2);
sun.position.set(14, 22, 10);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -22; sun.shadow.camera.right = 22; sun.shadow.camera.top = 22; sun.shadow.camera.bottom = -22;
sun.shadow.camera.near = 1; sun.shadow.camera.far = 70;
sun.shadow.bias = -0.0005;
scene.add(sun);
const fill = new THREE.PointLight(0x7c5cff, 30, 40, 1.6);
fill.position.set(-8, 6, 6);
scene.add(fill);

// warm ambient light keeps the night office readable without ceiling lamps
const ambient = new THREE.AmbientLight(0xffe2b8, 0.9);
scene.add(ambient);

const DAY = { bg: new THREE.Color(0xaecbff), hemi: 1.1, sun: 2.4, sunColor: new THREE.Color(0xfff1d6), fog: 0xaecbff, fill: 8, ambient: 0.35, exposure: 1.05 };
const NIGHT = { bg: new THREE.Color(0x070812), hemi: 0.75, sun: 0.9, sunColor: new THREE.Color(0x9fb3ff), fog: 0x070812, fill: 60, ambient: 0.9, exposure: 1.25 };
let nightT = 1; // 1 = night
let nightTarget = 1;
scene.fog = new THREE.Fog(0x070812, 40, 90);
function applySky(dt) {
  nightT = lerp(nightT, nightTarget, 1 - Math.pow(0.001, dt));
  const bg = DAY.bg.clone().lerp(NIGHT.bg, nightT);
  scene.background = bg; scene.fog.color.copy(bg);
  hemi.intensity = lerp(DAY.hemi, NIGHT.hemi, nightT);
  sun.intensity = lerp(DAY.sun, NIGHT.sun, nightT);
  sun.color.copy(DAY.sunColor).lerp(NIGHT.sunColor, nightT);
  fill.intensity = lerp(DAY.fill, NIGHT.fill, nightT);
  ambient.intensity = lerp(DAY.ambient, NIGHT.ambient, nightT);
  renderer.toneMappingExposure = lerp(DAY.exposure, NIGHT.exposure, nightT);
  bloom.strength = lerp(0.25, 0.7, nightT);
}

// ============================================================ room
const ROOM = { w: 30, d: 26, h: 7 };
// Four department bays side by side, each with its own aisle and six desks, then the corridor,
// then the lounge on the left and the floor manager's office on the right.
const DEPTS = {
  engineering: { name: 'Engineering', color: 0x4ea1ff, cx: -11.25 },
  qa: { name: 'QA', color: 0x39d98a, cx: -3.75 },
  uiux: { name: 'UI / UX', color: 0xc77dff, cx: 3.75 },
  security: { name: 'Security', color: 0xff4d6d, cx: 11.25 },
};
const DEPT_ORDER = ['engineering', 'qa', 'uiux', 'security'];
const BAY_W = 7.5;
const DESK_ROWS = [-8, -4, 0];
const AISLES = DEPT_ORDER.map((k) => DEPTS[k].cx);
const CORRIDOR_Z = 3.4;
const LOUNGE = { x0: -11, x1: 5.2, z0: 5, z1: 10.5 };
const OFFICE = { x0: 7, x1: 14.6, z0: 4.6, z1: 11, color: 0xffb020, drop: new THREE.Vector3(8.8, 0, 7.3), tray: new THREE.Vector3(8.8, 0.86, 8.6) };
const binParts = []; // the report tray, its table, sign and sheets: clicking any of them opens the reports inbox
let trayHit = null; // the clickable report tray, set when the room is built
const deptOf = (k) => DEPTS[k] || DEPTS.engineering;
const deptHex = (k) => '#' + new THREE.Color(deptOf(k).color).getHexString();
const rgba = (hex, a) => `rgba(${(hex >> 16) & 255},${(hex >> 8) & 255},${hex & 255},${a})`;
const bayAt = (x) => DEPT_ORDER[clamp(Math.floor((x + ROOM.w / 2) / BAY_W), 0, 3)];

// ---------- wall dashboard (canvas texture) ----------
const boardCanvas = document.createElement('canvas'); boardCanvas.width = 1800; boardCanvas.height = 400;
const boardTex = new THREE.CanvasTexture(boardCanvas); boardTex.colorSpace = THREE.SRGBColorSpace;
const boardMaterial = new THREE.MeshStandardMaterial({ map: boardTex, emissiveMap: boardTex, emissive: 0xffffff, emissiveIntensity: 0.85, roughness: 0.4 });
const feed = []; // global activity feed {t, name, text, kind}
const toolStats = []; // {t, kind}
function pushFeed(kind, name, text, project = null) { feed.push({ t: Date.now(), kind, name, text, project }); if (feed.length > 60) feed.shift(); }
function drawBoard(agents) {
  agents = agents.filter(inProject); const selName = effProject();
  const c = boardCanvas, ctx = c.getContext('2d'); const W = c.width, H = c.height;
  ctx.fillStyle = '#06070f'; ctx.fillRect(0, 0, W, H);
  // subtle grid
  ctx.strokeStyle = 'rgba(124,92,255,0.08)'; ctx.lineWidth = 1;
  for (let x = 0; x < W; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = 0; y < H; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  const mono = 'ui-monospace, Menlo, Consolas, monospace';
  const counts = { active: 0, needs: 0, waiting: 0, idle: 0 };
  for (const a of agents) { const av = avatars.get(a.id); const w = av ? av.wants() : 'wander'; if (w === 'work') counts.active++; else if (w === 'permission') counts.needs++; else if (w === 'question') counts.waiting++; else counts.idle++; }
  // header
  ctx.fillStyle = '#7c5cff'; ctx.fillRect(0, 0, W, 6);
  ctx.font = `bold 26px ${mono}`; ctx.fillStyle = '#e8ecff'; ctx.textBaseline = 'top'; ctx.textAlign = 'left';
  ctx.fillText('AGENT OPS', 28, 22);
  if (selName) { ctx.fillStyle = projColor(selName); ctx.font = `bold 22px ${mono}`; ctx.fillText(`· ${selName.toUpperCase()}`.slice(0, 26), 28 + ctx.measureText('AGENT OPS ').width * 1.18, 25); }
  ctx.font = `20px ${mono}`; ctx.fillStyle = '#8b92b8'; ctx.textAlign = 'right';
  ctx.fillText(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }), W - 28, 24);
  ctx.textAlign = 'left';
  // column 1: big numbers
  const tiles = [['WORKING', counts.active, '#39d98a'], ['NEED YOU', counts.needs, '#ff4d6d'], ['ASKING', counts.waiting, '#ffb020'], ['IDLE', counts.idle, '#8b92b8']];
  tiles.forEach(([label, n, col], i) => {
    const x = 28 + (i % 2) * 190, y = 74 + Math.floor(i / 2) * 150;
    ctx.fillStyle = 'rgba(255,255,255,0.04)'; roundRect(ctx, x, y, 176, 130, 12); ctx.fill();
    if (n > 0 && label === 'NEED YOU' && Math.floor(Date.now() / 500) % 2) { ctx.strokeStyle = col; ctx.lineWidth = 3; roundRect(ctx, x, y, 176, 130, 12); ctx.stroke(); }
    ctx.fillStyle = col; ctx.font = `bold 72px ${mono}`; ctx.fillText(String(n), x + 16, y + 18);
    ctx.fillStyle = '#8b92b8'; ctx.font = `bold 18px ${mono}`; ctx.fillText(label, x + 18, y + 98);
  });
  // column 2: activity feed
  let x2 = 440; ctx.fillStyle = '#8b92b8'; ctx.font = `bold 18px ${mono}`; ctx.fillText('LIVE FEED', x2, 74);
  ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.fillRect(x2, 98, 520, 2);
  const items = feed.filter((e) => !e.project || !selName || e.project === selName).slice(-9).reverse();
  items.forEach((e, i) => {
    const y = 112 + i * 31; const col = e.kind === 'permission' ? '#ff4d6d' : e.kind === 'turnEnd' ? '#7c5cff' : e.kind === 'subagentStart' ? '#c77dff' : e.kind === 'agentCreated' ? '#39d98a' : e.kind === 'manager' || e.kind === 'report' ? '#ffb020' : '#d6dcff';
    ctx.globalAlpha = 1 - i * 0.08; ctx.fillStyle = '#5c6390'; ctx.font = `16px ${mono}`; ctx.fillText(ago(e.t).padStart(4), x2, y + 4);
    ctx.fillStyle = col; ctx.font = `bold 18px ${mono}`; ctx.fillText(e.name.slice(0, 16), x2 + 60, y + 2);
    ctx.fillStyle = '#d6dcff'; ctx.font = `18px ${mono}`; ctx.fillText(e.text.slice(0, 34), x2 + 240, y + 2);
  });
  ctx.globalAlpha = 1;
  if (!items.length) { ctx.fillStyle = '#5c6390'; ctx.font = `18px ${mono}`; ctx.fillText('waiting for activity…', x2, 116); }
  // column 3: agents
  let x3 = 1010; ctx.fillStyle = '#8b92b8'; ctx.font = `bold 18px ${mono}`; ctx.fillText('AGENTS', x3, 74);
  ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.fillRect(x3, 98, 440, 2);
  const sorted = [...agents].map((a) => ({ a, av: avatars.get(a.id) })).filter((r) => r.av).sort((p, q) => rank(p.av.wants()) - rank(q.av.wants())).slice(0, 9);
  sorted.forEach(({ a, av }, i) => {
    const y = 112 + i * 31; const w = av.wants(); const col = w === 'work' ? '#39d98a' : w === 'permission' ? '#ff4d6d' : w === 'question' ? '#ffb020' : '#5c6390';
    ctx.fillStyle = '#' + av.color.getHexString(); roundRect(ctx, x3, y + 4, 14, 14, 3); ctx.fill();
    ctx.fillStyle = deptHex(a.dept); ctx.fillRect(x3 - 8, y + 4, 4, 14); // department stripe
    if (a.project) { ctx.fillStyle = projColor(a.project); ctx.fillRect(x3 - 16, y + 4, 4, 14); } // project stripe
    ctx.fillStyle = '#e8ecff'; ctx.font = `18px ${mono}`; ctx.fillText(av.name().slice(0, 15), x3 + 24, y + 2);
    const tools = Object.values(a.tools); const t = tools[tools.length - 1];
    const label = w === 'permission' ? 'needs approval' : w === 'question' ? 'asked you' : t ? prettyTool(t.toolName) : w === 'work' ? 'thinking' : 'idle';
    ctx.fillStyle = col; ctx.fillText(label.slice(0, 16), x3 + 200, y + 2);
    const frac = a.maxContextTokens ? clamp(a.contextTokens / a.maxContextTokens, 0, 1) : 0;
    ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.fillRect(x3 + 380, y + 8, 60, 8);
    ctx.fillStyle = frac < 0.6 ? '#39d98a' : frac < 0.85 ? '#ffb020' : '#ff4d6d'; ctx.fillRect(x3 + 380, y + 8, 60 * frac, 8);
  });
  if (agents.length > 9) { ctx.fillStyle = '#5c6390'; ctx.font = `16px ${mono}`; ctx.fillText(`+${agents.length - 9} more`, x3, 112 + 9 * 31); }
  // column 4: tool mix (last 10 min)
  let x4 = 1500; ctx.fillStyle = '#8b92b8'; ctx.font = `bold 18px ${mono}`; ctx.fillText('TOOLS · 10 MIN', x4, 74);
  ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.fillRect(x4, 98, 270, 2);
  const cutoff = Date.now() - 600000; while (toolStats.length && toolStats[0].t < cutoff) toolStats.shift();
  const mix = {}; for (const s of toolStats) mix[s.kind] = (mix[s.kind] || 0) + 1;
  const kinds = ['terminal', 'read', 'write', 'web', 'agent', 'think']; const max = Math.max(1, ...kinds.map((k) => mix[k] || 0));
  kinds.forEach((k, i) => {
    const y = 112 + i * 44; const n = mix[k] || 0; const col = '#' + new THREE.Color(TOOL_COLORS[k]).getHexString();
    ctx.fillStyle = '#8b92b8'; ctx.font = `16px ${mono}`; ctx.fillText(k, x4, y + 4);
    ctx.fillStyle = 'rgba(255,255,255,0.06)'; ctx.fillRect(x4 + 90, y + 6, 140, 14);
    ctx.fillStyle = col; ctx.fillRect(x4 + 90, y + 6, 140 * (n / max), 14);
    ctx.fillStyle = '#e8ecff'; ctx.textAlign = 'right'; ctx.fillText(String(n), x4 + 270, y + 4); ctx.textAlign = 'left';
  });
  boardTex.needsUpdate = true;
}
function rank(w) { return w === 'permission' ? 0 : w === 'question' ? 1 : w === 'work' ? 2 : 3; }
// ---------- task board (beads issues) on the left wall ----------
const taskCanvas = document.createElement('canvas'); taskCanvas.width = 1100; taskCanvas.height = 560;
const taskTex = new THREE.CanvasTexture(taskCanvas); taskTex.colorSpace = THREE.SRGBColorSpace;
const taskMaterial = new THREE.MeshStandardMaterial({ map: taskTex, emissiveMap: taskTex, emissive: 0xffffff, emissiveIntensity: 0.8, roughness: 0.4 });
let lastIssues = []; let beadsOn = false; let taskSig = ''; let deptSkills = {}; let lastQueue = null;
// ---------- projects: the folders the agents work in; one tab each, like the tabs you keep in Claude ----------
let lastProjects = []; let homeProject = null; let selProject = null;
try { selProject = localStorage.getItem('office.project') || null; } catch { /* private window */ }
function effProject() { return selProject && lastProjects.some((p) => p.name === selProject) ? selProject : null; } // a remembered tab whose project has left the floor counts as "All" until it is back
function inProject(a) { const s = effProject(); return !s || a.project === s; }
function projectOf(name) { return lastProjects.find((p) => p.name === name) || null; }
function projColor(name) { return projectOf(name)?.color || '#5c6390'; }
function selRoot() { const p = projectOf(effProject()); return p?.root || null; }
let projBoard = null; // { root, name, issues, beads, at } : another project's task board, when its tab is open
function foreignBoardProject() { const p = projectOf(effProject()); return p && p.root && homeProject && p.root !== homeProject.root ? p : null; }
async function refreshProjBoard(force = false) {
  const p = foreignBoardProject();
  if (!p) { if (projBoard) { projBoard = null; drawTaskBoard(); } return; }
  if (!force && projBoard && projBoard.root === p.root && Date.now() - projBoard.at < 15000) return;
  try {
    const j = await (await api(`/api/issues?project=${encodeURIComponent(p.root)}`)).json();
    if (foreignBoardProject()?.root !== p.root) return; // the tab changed while we waited
    projBoard = { root: p.root, name: p.name, issues: j.issues || [], beads: !!j.beads, at: Date.now() }; drawTaskBoard();
  } catch { /* bridge offline */ }
}
setInterval(() => refreshProjBoard(), 5000);
function boardIssues() { return projBoard ? projBoard.issues : lastIssues; }
function boardBeads() { return projBoard ? projBoard.beads : beadsOn; }
const PRIO_COLORS = ['#ff4d6d', '#ffb020', '#4ea1ff', '#8b92b8', '#5c6390'];
function floorAgents() { try { return lastAgents; } catch { return []; } } // the board is first drawn before the agent list exists
function drawTaskBoard(force = false) {
  const floor = floorAgents(); const foreign = projBoard; const issues = boardIssues(), beads = boardBeads();
  const sig = JSON.stringify([beads, issues, foreign ? [foreign.root, foreign.at] : lastQueue, floor.map((a) => a.humanName || a.nickname || a.directoryName)]); if (!force && sig === taskSig) return; taskSig = sig;
  const c = taskCanvas, ctx = c.getContext('2d'); const W = c.width, H = c.height; const mono = 'ui-monospace, Menlo, Consolas, monospace';
  ctx.fillStyle = '#0b0a14'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = foreign ? projColor(foreign.name) : '#ffb020'; ctx.fillRect(0, 0, W, 6);
  ctx.font = `bold 26px ${mono}`; ctx.fillStyle = '#e8ecff'; ctx.textBaseline = 'top'; ctx.textAlign = 'left'; ctx.fillText('TASK BOARD', 28, 22);
  if (foreign) { ctx.fillStyle = projColor(foreign.name); ctx.font = `bold 22px ${mono}`; ctx.fillText(`· ${foreign.name.toUpperCase()}`.slice(0, 30), 200, 25); }
  ctx.font = `18px ${mono}`; ctx.fillStyle = '#8b92b8'; ctx.textAlign = 'right';
  const q = lastQueue; const qText = q ? (q.on ? `queue on · ${q.running}/${q.limit} running` : 'queue paused') : '';
  ctx.fillText(beads ? `${issues.length} open${foreign ? '' : ` · ${qText}`}` : foreign ? 'no beads here' : 'no beads database here', W - 28, 26); ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.fillRect(28, 62, W - 56, 2);
  if (!issues.length) { ctx.fillStyle = '#5c6390'; ctx.font = `20px ${mono}`; ctx.fillText(beads ? 'board is clear' : foreign ? `no beads here: run \`bd init\` in ${foreign.name}` : 'run `bd init` in the project folder', 28, 84); }
  issues.slice(0, 12).forEach((i, k) => {
    const y = 80 + k * 39; const col = PRIO_COLORS[Math.min(4, i.priority)] || '#8b92b8';
    ctx.fillStyle = col; roundRect(ctx, 28, y + 6, 42, 24, 6); ctx.fill();
    ctx.fillStyle = '#0b0d17'; ctx.font = `bold 16px ${mono}`; ctx.fillText(`P${i.priority}`, 36, y + 10);
    const blocked = !!(i.blockedBy && i.blockedBy.length) && i.status !== 'in_progress'; const epic = i.type === 'epic';
    const glyph = i.status === 'in_progress' ? '◐' : blocked ? '●' : epic ? '▣' : '○';
    ctx.fillStyle = i.status === 'in_progress' ? '#39d98a' : blocked ? '#ff4d6d' : epic ? '#8b92b8' : '#5c6390'; ctx.font = `20px ${mono}`; ctx.fillText(glyph, 82, y + 8);
    ctx.fillStyle = '#8b92b8'; ctx.font = `16px ${mono}`; ctx.fillText(i.id.slice(-8), 110, y + 11);
    const tag = blocked ? `⛔ after ${i.blockedBy.map((b) => b.slice(-5)).join(',')} · ` : epic ? 'epic · ' : '';
    ctx.fillStyle = blocked || epic ? '#8b92b8' : '#e8ecff'; ctx.font = `19px ${mono}`;
    const title = tag + i.title; ctx.fillText(title.slice(0, 60) + (title.length > 60 ? '…' : ''), 215, y + 9);
    const qw = !foreign && lastQueue?.workers?.find((w) => w.issueId === i.id && !w.done);
    const gone = i.assignee && i.assignee !== 'floor-manager' && !floor.some((a) => [a.humanName, a.nickname, a.teammateName, a.directoryName].some((n) => n && n.toLowerCase() === i.assignee.toLowerCase()));
    if (i.assignee) { ctx.fillStyle = qw ? '#39d98a' : gone ? '#ff4d6d' : '#c77dff'; ctx.font = `15px ${mono}`; ctx.textAlign = 'right'; ctx.fillText((qw ? '🌿 ' : gone ? '✗ ' : '') + i.assignee.slice(0, 14) + (gone ? ' (gone)' : ''), W - 28, y + 12); ctx.textAlign = 'left'; }
  });
  if (issues.length > 12) { ctx.fillStyle = '#5c6390'; ctx.font = `16px ${mono}`; ctx.fillText(`+${issues.length - 12} more`, 28, 80 + 12 * 39); }
  taskTex.needsUpdate = true;
}
drawTaskBoard(true);
setInterval(() => drawBoard(lastAgents), 1000);
// wall boards you can click to look at up close: { mesh, w, h, normal, maxDist } (filled in by buildRoom)
const boards = [];

function buildRoom() {
  // floor: two-tone tiles
  const tiles = new THREE.Group();
  const geo = new THREE.PlaneGeometry(2, 2);
  const tint = (base, col, k) => new THREE.Color(base).lerp(new THREE.Color(col), k).getHex();
  const mL = mat(0x4b3a66, { roughness: 0.7 }); const mL2 = mat(0x3f3058, { roughness: 0.7 });
  const mO = mat(tint(0x4b3a66, OFFICE.color, 0.22), { roughness: 0.7 }); const mO2 = mat(tint(0x3f3058, OFFICE.color, 0.22), { roughness: 0.7 });
  const bayMats = {}; for (const k of DEPT_ORDER) bayMats[k] = [mat(tint(0x2a2f55, DEPTS[k].color, 0.16), { roughness: 0.6 }), mat(tint(0x232848, DEPTS[k].color, 0.16), { roughness: 0.6 })];
  const mA = mat(0x2a2f55, { roughness: 0.6 }); const mB = mat(0x232848, { roughness: 0.6 });
  for (let x = -ROOM.w / 2; x < ROOM.w / 2; x += 2) for (let z = -ROOM.d / 2 + 2; z < ROOM.d / 2 + 2; z += 2) {
    const even = ((x + z) / 2) % 2 === 0; const cx = x + 1, cz = z + 1;
    let pair = [mA, mB];
    if (cz < 2.4) pair = bayMats[bayAt(cx)];
    else if (cz >= LOUNGE.z0 - 1) pair = cx >= OFFICE.x0 ? [mO, mO2] : [mL, mL2];
    const t = new THREE.Mesh(geo, even ? pair[0] : pair[1]); t.rotation.x = -Math.PI / 2; t.position.set(cx, 0, cz); t.receiveShadow = true; tiles.add(t);
  }
  scene.add(tiles);
  // department bays: low glass partitions between them, a hanging sign and a light strip at each entrance
  const glass = new THREE.MeshStandardMaterial({ color: 0x9fb3ff, transparent: true, opacity: 0.16, roughness: 0.1, metalness: 0.2, side: THREE.DoubleSide, depthWrite: false });
  for (const x of [-7.5, 0, 7.5]) {
    const w = new THREE.Mesh(new THREE.BoxGeometry(0.06, 2.1, 12.2), glass); w.position.set(x, 1.05, -3.9); scene.add(w);
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.08, 12.2), mat(0x3a3f6b, { metalness: 0.4, roughness: 0.5 })); rail.position.set(x, 2.1, -3.9); rail.castShadow = true; scene.add(rail);
    const foot = rail.clone(); foot.position.y = 0.05; scene.add(foot);
  }
  for (const k of DEPT_ORDER) {
    const d = DEPTS[k];
    const sign = textSprite(d.name.toUpperCase(), { size: 58, color: '#fff', bg: rgba(d.color, 0.85) }); sign.position.set(d.cx, 3.3, 2.1); sign.scale.set(4.6, 0.7, 1); scene.add(sign);
    const strip = new THREE.Mesh(new THREE.BoxGeometry(BAY_W - 0.6, 0.04, 0.22), new THREE.MeshStandardMaterial({ color: d.color, emissive: d.color, emissiveIntensity: 1.8 })); strip.position.set(d.cx, 0.03, 2.35); scene.add(strip);
  }
  // the floor manager's office: glass wall with a doorway, a desk, and the report tray
  const ow = new THREE.Mesh(new THREE.BoxGeometry(0.06, 2.1, OFFICE.z1 - 6.4), glass); ow.position.set(OFFICE.x0, 1.05, (6.4 + OFFICE.z1) / 2); scene.add(ow);
  const orail = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.08, OFFICE.z1 - 6.4), mat(0x3a3f6b, { metalness: 0.4, roughness: 0.5 })); orail.position.set(OFFICE.x0, 2.1, (6.4 + OFFICE.z1) / 2); scene.add(orail);
  const post = new THREE.Mesh(new THREE.BoxGeometry(0.14, 2.1, 0.14), mat(0x3a3f6b)); post.position.set(OFFICE.x0, 1.05, 6.4); scene.add(post);
  const osign = textSprite('OFFICE', { size: 58, color: '#111', bg: 'rgba(255,176,32,0.92)' }); osign.position.set(OFFICE.x0 + 0.4, 3.3, 5.4); osign.scale.set(3.4, 0.7, 1); scene.add(osign);
  const ostrip = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.04, 1.8), new THREE.MeshStandardMaterial({ color: OFFICE.color, emissive: OFFICE.color, emissiveIntensity: 1.8 })); ostrip.position.set(OFFICE.x0, 0.03, 5.5); scene.add(ostrip);
  const mdesk = buildDesk(11.6, 8.9, false); // the manager's own desk: not for agents
  drawScreen(mdesk.screen, 'think', 'REPORTS'); mdesk.screen.userData.key = 'office';
  // report tray on a side table by the door
  const side = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.08, 1.0), mat(0xd9b48f, { roughness: 0.55 })); side.position.set(OFFICE.tray.x, 0.8, OFFICE.tray.z); side.castShadow = true; side.receiveShadow = true; scene.add(side);
  for (const [sx, sz] of [[-0.65, -0.4], [0.65, -0.4], [-0.65, 0.4], [0.65, 0.4]]) { const leg = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.78, 0.08), mat(0x2b2b33)); leg.position.set(OFFICE.tray.x + sx, 0.39, OFFICE.tray.z + sz); scene.add(leg); }
  const tray = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.06, 0.7), mat(0x1a1a22, { metalness: 0.4, roughness: 0.5 })); tray.position.set(OFFICE.tray.x, OFFICE.tray.y, OFFICE.tray.z); scene.add(tray);
  trayHit = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.2, 1.1), new THREE.MeshBasicMaterial({ visible: false })); trayHit.position.set(OFFICE.tray.x, 1.1, OFFICE.tray.z); trayHit.userData.tray = true; scene.add(trayHit); // click target: the whole tray corner
  for (const s of [-1, 1]) { const lip = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.16, 0.7), mat(0x1a1a22)); lip.position.set(OFFICE.tray.x + s * 0.47, OFFICE.tray.y + 0.08, OFFICE.tray.z); scene.add(lip); binParts.push(lip); }
  const tsign = textSprite('REPORTS', { size: 44, color: '#ffb020', bg: 'rgba(12,14,30,0.8)' }); tsign.position.set(OFFICE.tray.x, 1.9, OFFICE.tray.z); tsign.scale.set(2.2, 0.36, 1); scene.add(tsign);
  binParts.push(side, tray, tsign);
  scene.add(plant(14.0, 10.4, 1.1));
  // walls
  const wallM = mat(0x1a1d36, { roughness: 0.95 });
  const back = new THREE.Mesh(new THREE.BoxGeometry(ROOM.w, ROOM.h, 0.4), wallM); back.position.set(0, ROOM.h / 2, -ROOM.d / 2 + 2); back.receiveShadow = true; scene.add(back);
  const left = new THREE.Mesh(new THREE.BoxGeometry(0.4, ROOM.h, ROOM.d), wallM); left.position.set(-ROOM.w / 2, ROOM.h / 2, 2); left.receiveShadow = true; scene.add(left);
  // big wall display: a live dashboard drawn on a canvas
  const frame = new THREE.Mesh(new THREE.BoxGeometry(18.4, 4.4, 0.25), mat(0x0d0f20, { metalness: 0.4, roughness: 0.5 })); frame.position.set(2, 4.0, -ROOM.d / 2 + 2.15); scene.add(frame);
  const win = new THREE.Mesh(new THREE.PlaneGeometry(18, 4.0), boardMaterial);
  win.position.set(2, 4.0, -ROOM.d / 2 + 2.29); scene.add(win);
  boards.push({ mesh: win, w: 18, h: 4.0, normal: new THREE.Vector3(0, 0, 1), maxDist: MEZZ.z0 - 0.5 - win.position.z }); // stay in front of the mezzanine
  // task board on the left wall, by the Engineering bay
  const tframe = new THREE.Mesh(new THREE.BoxGeometry(0.25, 4.2, 8.2), mat(0x0d0f20, { metalness: 0.4, roughness: 0.5 })); tframe.position.set(-ROOM.w / 2 + 0.33, 3.6, -3.9); scene.add(tframe);
  const tboard = new THREE.Mesh(new THREE.PlaneGeometry(7.9, 4.0), taskMaterial); tboard.rotation.y = Math.PI / 2; tboard.position.set(-ROOM.w / 2 + 0.47, 3.6, -3.9); scene.add(tboard);
  boards.push({ mesh: tboard, w: 7.9, h: 4.0, normal: new THREE.Vector3(1, 0, 0) });
  // baseboard neon strip
  const strip = new THREE.Mesh(new THREE.BoxGeometry(ROOM.w, 0.08, 0.08), new THREE.MeshStandardMaterial({ color: 0x7c5cff, emissive: 0x7c5cff, emissiveIntensity: 2.5 }));
  strip.position.set(0, 0.06, -ROOM.d / 2 + 2.25); scene.add(strip);
  const strip2 = strip.clone(); strip2.rotation.y = Math.PI / 2; strip2.position.set(-ROOM.w / 2 + 0.25, 0.06, 2); scene.add(strip2);
  // lounge: couch, coffee machine, plants, rug
  const rug = new THREE.Mesh(new THREE.CircleGeometry(4.2, 40), mat(0xb5654a, { roughness: 1 })); rug.rotation.x = -Math.PI / 2; rug.position.set(0, 0.01, 8); rug.receiveShadow = true; scene.add(rug);
  scene.add(couch(-3.5, 9.3, 0), couch(3.5, 9.3, 0));
  scene.add(coffeeMachine(-10, 7.5), plant(5.6, 10.2, 1.2), plant(-10.5, 10, 0.9), plant(14.3, -10.2, 1.3));
  // wall clock-ish sign
  const sign = textSprite('CLAUDE CODE · OFFICE', { size: 54, color: '#e8ecff', bg: 'rgba(124,92,255,0.25)' }); sign.position.set(-10, 5.6, -ROOM.d / 2 + 2.3); sign.scale.set(7, 1.1, 1); scene.add(sign);
}
function couch(x, z, ry) {
  const g = new THREE.Group();
  const m = mat(0x6b4fd8, { roughness: 0.9 });
  const seat = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.6, 1.4), m); seat.position.y = 0.45; seat.castShadow = true; g.add(seat);
  const backr = new THREE.Mesh(new THREE.BoxGeometry(4.2, 1.0, 0.4), m); backr.position.set(0, 1.0, 0.6); backr.castShadow = true; g.add(backr);
  for (const s of [-1, 1]) { const arm = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.9, 1.4), m); arm.position.set(s * 2.0, 0.6, 0); g.add(arm); }
  for (let i = 0; i < 3; i++) { const cush = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.15, 1.1), mat(0x8d78ec)); cush.position.set(-1.3 + i * 1.3, 0.82, -0.1); g.add(cush); }
  g.position.set(x, 0, z); g.rotation.y = ry; return g;
}
function coffeeMachine(x, z) {
  const g = new THREE.Group();
  const counter = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.0, 1.0), mat(0x2d3253)); counter.position.y = 0.5; counter.castShadow = true; g.add(counter);
  const top = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.08, 1.1), mat(0xd9b48f)); top.position.y = 1.04; g.add(top);
  const machine = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.8, 0.6), mat(0x1a1a22, { metalness: 0.5, roughness: 0.4 })); machine.position.set(-0.4, 1.48, 0); machine.castShadow = true; g.add(machine);
  const led = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.06, 0.02), new THREE.MeshStandardMaterial({ color: 0x39d98a, emissive: 0x39d98a, emissiveIntensity: 3 })); led.position.set(-0.4, 1.75, 0.31); g.add(led);
  for (let i = 0; i < 3; i++) { const mug = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.1, 0.22, 12), mat(pick([0xff4d6d, 0xffb020, 0x39d98a, 0x4ea1ff]))); mug.position.set(0.3 + i * 0.32, 1.2, -0.2 + (i % 2) * 0.35); g.add(mug); }
  g.position.set(x, 0, z); return g;
}
function plant(x, z, s = 1) {
  const g = new THREE.Group();
  const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.28, 0.5, 12), mat(0xc96f3b)); pot.position.y = 0.25; pot.castShadow = true; g.add(pot);
  for (let i = 0; i < 7; i++) {
    const leaf = new THREE.Mesh(new THREE.ConeGeometry(0.22, 1.1, 6), mat(pick([0x2faa5e, 0x3cc973, 0x238a4c])));
    leaf.position.set(Math.cos(i * 0.9) * 0.22, 0.95 + (i % 3) * 0.2, Math.sin(i * 0.9) * 0.22);
    leaf.rotation.set(Math.sin(i) * 0.5, 0, Math.cos(i) * 0.5); leaf.castShadow = true; g.add(leaf);
  }
  g.position.set(x, 0, z); g.scale.setScalar(s); return g;
}
// (the room is built after the desks below, since the office holds a desk)

// ============================================================ lego table (playtime)
// The bridge owns the board; we draw it with a handful of instanced meshes.
const LEGO = { S: 0.17, H: 0.2, N: 24, x: 0, z: 6.1, top: 0.47 };
const PLAY_SPOTS = [[-1, 3.35], [1, 3.35], [-2.75, 5.1], [2.75, 5.1], [-2.75, 7.1], [2.75, 7.1], [-0.6, 8.75], [0.6, 8.75]];
const MANAGER_PLAY_SPOT = new THREE.Vector3(3.1, 0, 3.5);
const DIR_ANGLE = { s: 0, e: Math.PI / 2, n: Math.PI, w: -Math.PI / 2 };
const legoColors = {}; let legoBricks = new Map(); let legoOcc = new Set(); let legoDirty = true; let legoAnimating = false;
const legoMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.32, metalness: 0 });
const STUD_GEO = new THREE.CylinderGeometry(0.05, 0.05, 0.035, 12);
function wedgeGeo() { // unit wedge, high at the back (-z), downhill toward +z
  const sh = new THREE.Shape(); sh.moveTo(-0.5, -0.5); sh.lineTo(0.5, -0.5); sh.lineTo(-0.5, 0.5); sh.closePath();
  const g = new THREE.ExtrudeGeometry(sh, { depth: 1, bevelEnabled: false }); g.translate(0, 0, -0.5); g.rotateY(-Math.PI / 2); return g;
}
function instanced(geo, cap) {
  const im = new THREE.InstancedMesh(geo, legoMat, cap); im.castShadow = true; im.receiveShadow = true; im.frustumCulled = false;
  im.setColorAt(0, new THREE.Color(0xffffff)); im.count = 0; scene.add(im); return im;
}
const brickIM = instanced(new THREE.BoxGeometry(1, 1, 1), 2200), roundIM = instanced(new THREE.CylinderGeometry(0.5, 0.5, 1, 20), 2200);
const slopeIM = instanced(wedgeGeo(), 2200), studIM = instanced(STUD_GEO, 16000);
studIM.castShadow = false;
// Put away between games so the lounge floor stays clear; renderPlay brings it out.
const playTable = new THREE.Group(); playTable.visible = false; scene.add(playTable);
(function buildPlayTable() {
  const size = LEGO.N * LEGO.S, half = size / 2;
  const top = new THREE.Mesh(new THREE.BoxGeometry(size + 0.5, 0.1, size + 0.5), mat(0xd9b48f, { roughness: 0.5 })); top.position.set(LEGO.x, 0.38, LEGO.z); top.castShadow = true; top.receiveShadow = true; playTable.add(top);
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) { const leg = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.33, 0.12), mat(0x5a4330)); leg.position.set(LEGO.x + sx * (half + 0.1), 0.165, LEGO.z + sz * (half + 0.1)); playTable.add(leg); }
  const plate = new THREE.Mesh(new THREE.BoxGeometry(size, 0.04, size), mat(0x237841, { roughness: 0.45 })); plate.position.set(LEGO.x, 0.45, LEGO.z); plate.receiveShadow = true; playTable.add(plate);
  const studs = new THREE.InstancedMesh(STUD_GEO, mat(0x2a8a4c, { roughness: 0.45 }), LEGO.N * LEGO.N); const m = new THREE.Matrix4(); let i = 0;
  for (let x = 0; x < LEGO.N; x++) for (let z = 0; z < LEGO.N; z++) { const [wx, , wz] = legoWorld(x + 0.5, 0, z + 0.5); m.makeTranslation(wx, LEGO.top + 0.0175, wz); studs.setMatrixAt(i++, m); }
  studs.receiveShadow = true; playTable.add(studs);
})();
const legoSign = textSprite('LEGO', { size: 46, color: '#fff', bg: 'rgba(35,120,65,0.85)' }); legoSign.position.set(LEGO.x, 3.3, LEGO.z); legoSign.scale.set(4.2, 0.66, 1); legoSign.visible = false; scene.add(legoSign);
function legoWorld(x, y, z) { return [LEGO.x + (x - LEGO.N / 2) * LEGO.S, LEGO.top + y * LEGO.H, LEGO.z + (z - LEGO.N / 2) * LEGO.S]; }
function rebuildLegoOcc() {
  legoOcc = new Set();
  for (const b of legoBricks.values()) for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) for (let z = b.z; z < b.z + b.d; z++) legoOcc.add(`${x},${y},${z}`);
}
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _c = new THREE.Color(), _up = new THREE.Vector3(0, 1, 0);
function rebuildLego(now) {
  const n = new Map([[brickIM, 0], [roundIM, 0], [slopeIM, 0], [studIM, 0]]);
  const put = (im) => { const i = n.get(im); if (i >= im.instanceMatrix.count) return; im.setMatrixAt(i, _m); im.setColorAt(i, _c); n.set(im, i + 1); };
  legoAnimating = false;
  for (const b of legoBricks.values()) {
    const k = clamp(1 - (now - (b.addedAt || 0)) / 450, 0, 1); if (k > 0) legoAnimating = true;
    const drop = k * k * 1.2;
    const [wx, wy, wz] = legoWorld(b.x + b.w / 2, b.y + b.h / 2, b.z + b.d / 2);
    const sideways = b.shape === 'slope' && (b.dir === 'e' || b.dir === 'w');
    _c.set(legoColors[b.color] || '#cccccc');
    _p.set(wx, wy + drop, wz); _s.set((sideways ? b.d : b.w) * LEGO.S - 0.006, b.h * LEGO.H - 0.004, (sideways ? b.w : b.d) * LEGO.S - 0.006);
    _q.setFromAxisAngle(_up, b.shape === 'slope' ? DIR_ANGLE[b.dir] || 0 : 0);
    _m.compose(_p, _q, _s); put(b.shape === 'slope' ? slopeIM : b.shape === 'round' ? roundIM : brickIM);
    if (b.shape !== 'brick' && b.shape !== 'round') continue;
    _q.identity(); _s.set(1, 1, 1);
    for (let x = b.x; x < b.x + b.w; x++) for (let z = b.z; z < b.z + b.d; z++) {
      if (legoOcc.has(`${x},${b.y + b.h},${z}`)) continue; // covered: no stud to see
      const [sx, sy, sz] = legoWorld(x + 0.5, b.y + b.h, z + 0.5); _p.set(sx, sy + 0.0175 + drop, sz); _m.compose(_p, _q, _s); put(studIM);
    }
  }
  for (const [im, count] of n) { im.count = count; im.instanceMatrix.needsUpdate = true; if (im.instanceColor) im.instanceColor.needsUpdate = true; }
}
function applyLego(m) {
  if (m.type === 'legoGallery') { applyGallery(m); return; }
  if (m.type === 'lego') { Object.assign(legoColors, m.colors || {}); legoBricks = new Map(m.bricks.map((b) => [b.id, b])); }
  else if (m.type === 'legoAdd') {
    const now = Date.now(); m.bricks.forEach((b, i) => { b.addedAt = now + i * 60; legoBricks.set(b.id, b); });
    const av = avatars.get(m.by); if (av) av.lastBuild = now;
    pushFeed('lego', av ? av.name() : `agent ${m.by}`, `placed ${m.bricks.length} brick${m.bricks.length === 1 ? '' : 's'}`, av?.data.project || null);
  } else if (m.type === 'legoRemove') for (const id of m.ids) legoBricks.delete(id);
  rebuildLegoOcc(); legoDirty = true;
}

// ============================================================ lego gallery (shelved builds)
// A side room off the Security bay: every build the agents finished sits on a shelf as a small model,
// newest first. The bridge streams the list (builds/shelf/*.json) once at connect and when a build is shelved.
// Avatars never walk here (computePath/LOUNGE are untouched): it's a room for looking.
const GAL = { x0: 15.2, x1: 22.4, z0: -ROOM.d / 2 + 2, z1: 2.4, color: 0xdbac34, tiers: [0.85, 1.9, 2.95], slotW: 1.4, footprint: 1.2, maxH: 0.85 };
// shelf units: 4 slots per tier, 3 tiers; a unit sits against a wall and its models face `normal`
const GAL_UNITS = [
  { x: 18.8, z: GAL.z0 + 0.2 + 0.5, along: 'x', normal: new THREE.Vector3(0, 0, 1) },   // back wall
  { x: GAL.x1 - 0.2 - 0.5, z: -6.9, along: 'z', normal: new THREE.Vector3(-1, 0, 0) },   // right wall, back half
  { x: GAL.x1 - 0.2 - 0.5, z: -0.9, along: 'z', normal: new THREE.Vector3(-1, 0, 0) },   // right wall, front half
];
const GAL_SLOTS = []; // { pos: Vector3 (shelf top, slot centre), normal, rotY }
for (const u of GAL_UNITS) for (const y of [...GAL.tiers].reverse()) for (let i = 0; i < 4; i++) { // top shelf first
  const off = (i - 1.5) * GAL.slotW;
  GAL_SLOTS.push(u.along === 'x' ? { pos: new THREE.Vector3(u.x + off, y + 0.03, u.z), normal: u.normal, rotY: 0 } : { pos: new THREE.Vector3(u.x, y + 0.03, u.z + off), normal: u.normal, rotY: -Math.PI / 2 });
}
const galleryGroup = new THREE.Group(); scene.add(galleryGroup);
const galleryBoards = []; // click targets: { mesh, w, h, normal, minDist, build }, one per shelved build, plus the sign
let galleryBuilds = []; let galleryMax = GAL_SLOTS.length;
const galMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.32, metalness: 0 });
function galInstanced(geo, cap) { const im = new THREE.InstancedMesh(geo, galMat, cap); im.castShadow = true; im.receiveShadow = true; im.frustumCulled = false; im.setColorAt(0, new THREE.Color(0xffffff)); im.count = 0; galleryGroup.add(im); return im; }
const galBrickIM = galInstanced(new THREE.BoxGeometry(1, 1, 1), 40000), galRoundIM = galInstanced(new THREE.CylinderGeometry(0.5, 0.5, 1, 20), 8000);
const galSlopeIM = galInstanced(wedgeGeo(), 8000), galStudIM = galInstanced(STUD_GEO, 60000);
galStudIM.castShadow = false;
const galPlates = []; const galHits = [];
let gallerySign = null; const galleryAnchor = new THREE.Object3D(); galleryAnchor.position.set(18.8, 1.6, -4.3); scene.add(galleryAnchor);
function buildGallery() {
  const g = galleryGroup;
  // floor: small gold-tinted tiles
  const tint = (base, col, k) => new THREE.Color(base).lerp(new THREE.Color(col), k).getHex();
  const tA = mat(tint(0x2a2f55, GAL.color, 0.14), { roughness: 0.6 }), tB = mat(tint(0x232848, GAL.color, 0.14), { roughness: 0.6 });
  const tile = new THREE.PlaneGeometry(1.2, 1.2); let n = 0;
  for (let x = GAL.x0 + 0.6; x < GAL.x1 - 0.2; x += 1.2) for (let z = GAL.z0 + 0.8; z < GAL.z1; z += 1.2) { const t = new THREE.Mesh(tile, n++ % 2 ? tA : tB); t.rotation.x = -Math.PI / 2; t.position.set(x, 0.005, z); t.receiveShadow = true; g.add(t); }
  // walls: the back wall carries on, a new right wall closes the room
  const wallM = mat(0x1a1d36, { roughness: 0.95 });
  const back = new THREE.Mesh(new THREE.BoxGeometry(GAL.x1 - 15 + 0.2, ROOM.h, 0.4), wallM); back.position.set((15 + GAL.x1 + 0.2) / 2, ROOM.h / 2, GAL.z0); back.receiveShadow = true; g.add(back);
  const right = new THREE.Mesh(new THREE.BoxGeometry(0.4, ROOM.h, GAL.z1 - GAL.z0 + 0.4), wallM); right.position.set(GAL.x1, ROOM.h / 2, (GAL.z0 + GAL.z1) / 2); right.receiveShadow = true; g.add(right);
  // a low rail toward the main floor and the corridor, with a gap by the corridor end as the doorway
  const railM = mat(0x2a2d4a, { roughness: 0.8 });
  const rail = new THREE.Mesh(new THREE.BoxGeometry(0.22, 1.1, 0.4 - GAL.z0), railM); rail.position.set(GAL.x0, 0.55, (GAL.z0 + 0.4) / 2); rail.castShadow = true; g.add(rail); // z0 .. 0.4, then the doorway
  const front = new THREE.Mesh(new THREE.BoxGeometry(GAL.x1 - GAL.x0, 1.1, 0.22), railM); front.position.set((GAL.x0 + GAL.x1) / 2, 0.55, GAL.z1); front.castShadow = true; g.add(front);
  // doorway posts and lintel, with the sign above
  const postM = mat(0x0d0f20, { metalness: 0.4, roughness: 0.5 });
  for (const z of [0.4, GAL.z1]) { const post = new THREE.Mesh(new THREE.BoxGeometry(0.22, 3.3, 0.22), postM); post.position.set(GAL.x0, 1.65, z); post.castShadow = true; g.add(post); }
  const lintel = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.22, GAL.z1 - 0.4 + 0.22), postM); lintel.position.set(GAL.x0, 3.3, (0.4 + GAL.z1) / 2); g.add(lintel);
  gallerySign = textSprite('🧱 LEGO GALLERY', { size: 50, color: '#111', bg: 'rgba(219,172,52,0.92)' }); gallerySign.position.set(GAL.x0, 3.95, (0.4 + GAL.z1) / 2); gallerySign.scale.set(3.4, 0.53, 1); g.add(gallerySign);
  galleryBoards.push({ mesh: gallerySign, anchor: galleryAnchor, w: 7.4, h: 5, normal: new THREE.Vector3(-0.55, 0.42, 0.72).normalize(), sign: true });
  // baseboard strip in gold
  const strip = new THREE.Mesh(new THREE.BoxGeometry(GAL.x1 - GAL.x0, 0.08, 0.08), new THREE.MeshStandardMaterial({ color: GAL.color, emissive: GAL.color, emissiveIntensity: 0.7 }));
  strip.position.set((GAL.x0 + GAL.x1) / 2, 0.06, GAL.z0 + 0.25); g.add(strip);
  const strip2 = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, GAL.z1 - GAL.z0), strip.material); strip2.position.set(GAL.x1 - 0.25, 0.06, (GAL.z0 + GAL.z1) / 2); g.add(strip2);
  // shelf units: three planks on brackets per unit
  const plankM = mat(0xd9b48f, { roughness: 0.55 }), bracketM = mat(0x3a3f6b);
  for (const u of GAL_UNITS) for (const y of GAL.tiers) {
    const len = GAL.slotW * 4;
    const plank = new THREE.Mesh(u.along === 'x' ? new THREE.BoxGeometry(len, 0.06, 1.0) : new THREE.BoxGeometry(1.0, 0.06, len), plankM);
    plank.position.set(u.x, y, u.z); plank.castShadow = true; plank.receiveShadow = true; g.add(plank);
    for (const s of [-1, 1]) {
      const br = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.3, 0.08), bracketM);
      br.position.set(u.along === 'x' ? u.x + s * (len / 2 - 0.3) : u.x + 0.35, y - 0.18, u.along === 'x' ? u.z + 0.35 : u.z + s * (len / 2 - 0.3)); g.add(br);
    }
  }
  // a wall label inside, at the back
  const label = textSprite('finished builds · newest first', { size: 34, color: '#e8ecff', bg: 'rgba(219,172,52,0.22)' }); label.position.set(18.8, 4.1, GAL.z0 + 0.3); label.scale.set(4.4, 0.4, 1); g.add(label);
  g.add(plant(GAL.x0 + 0.9, GAL.z0 + 1.1, 1.0));
}
const GAL_SHAPES = ['brick', 'tile', 'slope', 'round'], GAL_DIRS = ['n', 'e', 's', 'w'];
function galleryDate(t) { try { return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); } catch { return ''; } }
function galleryTitle(b) { return (b.title || b.theme || 'untitled').slice(0, 24); }
// lay every shelved build out on its slot: one matrix per brick, scaled to fit the slot
function rebuildGallery() {
  const n = new Map([[galBrickIM, 0], [galRoundIM, 0], [galSlopeIM, 0], [galStudIM, 0]]);
  const put = (im) => { const i = n.get(im); if (i >= im.instanceMatrix.count) return; im.setMatrixAt(i, _m); im.setColorAt(i, _c); n.set(im, i + 1); };
  const M = new THREE.Matrix4(), L = new THREE.Matrix4(), rot = new THREE.Quaternion(), sc = new THREE.Vector3();
  for (const h of galHits) { galleryGroup.remove(h); h.geometry.dispose(); } galHits.length = 0;
  galleryBoards.splice(1); // keep the sign
  galleryBuilds.forEach((b, slot) => {
    const sl = GAL_SLOTS[slot]; if (!sl) return;
    const bricks = b.bricks || []; let top = 1; const occ = new Set();
    for (const k of bricks) { top = Math.max(top, k[1] + k[5]); for (let y = k[1]; y < k[1] + k[5]; y++) for (let x = k[0]; x < k[0] + k[3]; x++) for (let z = k[2]; z < k[2] + k[4]; z++) occ.add(`${x},${y},${z}`); }
    const f = Math.min(GAL.footprint / (LEGO.N * LEGO.S), GAL.maxH / (top * LEGO.H));
    rot.setFromAxisAngle(_up, sl.rotY); sc.setScalar(f); M.compose(sl.pos, rot, sc);
    for (const k of bricks) {
      const [x, y, z, w, d, hh, color, shape, dir] = k; const sh = GAL_SHAPES[shape] || 'brick', dr = GAL_DIRS[dir] || null;
      const sideways = sh === 'slope' && (dr === 'e' || dr === 'w');
      _c.set(legoColors[color] || '#cccccc');
      _p.set((x + w / 2 - LEGO.N / 2) * LEGO.S, (y + hh / 2) * LEGO.H, (z + d / 2 - LEGO.N / 2) * LEGO.S);
      _s.set((sideways ? d : w) * LEGO.S - 0.006, hh * LEGO.H - 0.004, (sideways ? w : d) * LEGO.S - 0.006);
      _q.setFromAxisAngle(_up, sh === 'slope' ? DIR_ANGLE[dr] || 0 : 0);
      L.compose(_p, _q, _s); _m.multiplyMatrices(M, L); put(sh === 'slope' ? galSlopeIM : sh === 'round' ? galRoundIM : galBrickIM);
      if (sh !== 'brick' && sh !== 'round') continue;
      _q.identity(); _s.set(1, 1, 1);
      for (let sx = x; sx < x + w; sx++) for (let sz = z; sz < z + d; sz++) {
        if (occ.has(`${sx},${y + hh},${sz}`)) continue;
        _p.set((sx + 0.5 - LEGO.N / 2) * LEGO.S, (y + hh) * LEGO.H + 0.0175, (sz + 0.5 - LEGO.N / 2) * LEGO.S); L.compose(_p, _q, _s); _m.multiplyMatrices(M, L); put(galStudIM);
      }
    }
    // the plate under the model, and an invisible box over it to click
    let plate = galPlates[slot]; if (!plate) { plate = textSprite('', { size: 36 }); plate.scale.set(1.3, 0.2, 1); galleryGroup.add(plate); galPlates[slot] = plate; }
    updateSprite(plate, `${galleryTitle(b)} · ${galleryDate(b.date)}`, { size: 36, color: '#fff', bg: 'rgba(12,14,30,0.85)', tab: '#dbac34' });
    plate.position.copy(sl.pos).addScaledVector(sl.normal, 0.62); plate.position.y += 0.02; plate.visible = true; // hangs on the shelf's front edge
    const modelH = top * LEGO.H * f;
    const hit = new THREE.Mesh(new THREE.BoxGeometry(GAL.footprint, modelH + 0.2, GAL.footprint), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
    hit.position.copy(sl.pos); hit.position.y += modelH / 2 + 0.05; hit.userData.slot = slot; galleryGroup.add(hit); galHits.push(hit);
    galleryBoards.push({ mesh: hit, w: GAL.footprint + 0.2, h: Math.max(0.9, modelH + 0.3), normal: sl.normal, minDist: 2.0, build: b, slot });
  });
  for (let i = galleryBuilds.length; i < galPlates.length; i++) if (galPlates[i]) galPlates[i].visible = false;
  for (const [im, count] of n) { im.count = count; im.instanceMatrix.needsUpdate = true; if (im.instanceColor) im.instanceColor.needsUpdate = true; }
  if (boardZoom?.board?.build) { // you were looking at a shelved build: keep following it (it may have moved a slot), or step back if it went
    const again = galleryBoards.find((b) => b.build?.file === boardZoom.board.build.file);
    if (again) boardZoom.board = again; else endBoardZoom();
  }
}
function applyGallery(m) {
  Object.assign(legoColors, m.colors || {});
  galleryMax = Math.min(GAL_SLOTS.length, m.max || GAL_SLOTS.length);
  galleryBuilds = (m.builds || []).slice(0, galleryMax);
  rebuildGallery();
}
function gallerySlotWorld(slot) { const sl = GAL_SLOTS[slot]; return sl ? sl.pos.clone() : galleryAnchor.position.clone(); }
window.__officeGallery = (builds) => { applyGallery({ builds: Array.isArray(builds) ? builds : [] }); return galleryBuilds.length; }; // debug hook: feed fake shelved builds

// ============================================================ text sprites + screens
// a plate: rounded box with the text, and with `tab` a colour block down its left edge (the project colour)
function drawPlate(c, text, { size = 48, color = '#fff', bg = 'rgba(0,0,0,0.55)', font = 'bold', tab = null } = {}) {
  const ctx = c.getContext('2d'); ctx.clearRect(0, 0, c.width, c.height);
  ctx.font = `${font} ${size}px ui-monospace, Menlo, monospace`;
  const pad = tab ? 36 : 0; const w = Math.min(1000, ctx.measureText(text).width + 60 + pad); const x0 = 512 - w / 2;
  ctx.fillStyle = bg; roundRect(ctx, x0, 20, w, 120, 30); ctx.fill();
  if (tab) { ctx.save(); roundRect(ctx, x0, 20, w, 120, 30); ctx.clip(); ctx.fillStyle = tab; ctx.fillRect(x0, 20, 28, 120); ctx.restore(); }
  ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, 512 + pad / 2, 82, 960 - pad);
}
function textSprite(text, opts = {}) {
  const c = document.createElement('canvas'); c.width = 1024; c.height = 160;
  drawPlate(c, text, opts);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true, depthWrite: false })); // depth-tested so labels don't show through floors
  sp.scale.set(3.2, 0.5, 1); sp.renderOrder = 10; sp.userData.canvas = c; return sp;
}
function updateSprite(sp, text, opts = {}) {
  const key = text + '\u0000' + (opts.tab || '') + (opts.color || '');
  if (sp.userData.text === key) return; sp.userData.text = key;
  drawPlate(sp.userData.canvas, text, opts);
  sp.material.map.needsUpdate = true;
}
function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }

function makeScreen() {
  const c = document.createElement('canvas'); c.width = 256; c.height = 160;
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.3 });
  m.userData = { canvas: c, tex, kind: null, lines: [] };
  drawScreen(m, 'off', '');
  return m;
}
function drawScreen(m, kind, title) {
  const { canvas: c, tex } = m.userData; const ctx = c.getContext('2d');
  const col = '#' + new THREE.Color(TOOL_COLORS[kind] ?? TOOL_COLORS.think).getHexString();
  ctx.fillStyle = kind === 'off' ? '#05060c' : '#0a0c18'; ctx.fillRect(0, 0, c.width, c.height);
  if (kind !== 'off') {
    ctx.fillStyle = col; ctx.globalAlpha = 0.25; ctx.fillRect(0, 0, c.width, 22); ctx.globalAlpha = 1;
    ctx.fillStyle = col; ctx.font = 'bold 14px ui-monospace, Menlo, monospace'; ctx.fillText((title || kind).slice(0, 28), 8, 16);
    let y = 36;
    for (let i = 0; i < 9; i++) {
      const indent = 8 + (i % 4) * 14; const w = rand(40, 200 - indent);
      ctx.fillStyle = i % 3 === 0 ? col : '#5c6390'; ctx.globalAlpha = i % 3 === 0 ? 0.9 : 0.6;
      ctx.fillRect(indent, y, w, 7); y += 13;
    }
    ctx.globalAlpha = 1; ctx.fillStyle = col; ctx.fillRect(8 + (Math.random() * 100 | 0), y, 8, 10); // cursor
  }
  m.userData.kind = kind;
  m.emissiveIntensity = kind === 'off' ? 0 : kind === 'permission' ? 1.6 : 0.9;
  tex.needsUpdate = true;
}

// ============================================================ desks
const desks = []; // { group, screen, x, z, agentId, mugColor }
function buildDesk(x, z, register = true) {
  const g = new THREE.Group();
  const top = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.1, 1.2), mat(0xd9b48f, { roughness: 0.55 })); top.position.y = 0.78; top.castShadow = true; top.receiveShadow = true; g.add(top);
  for (const [sx, sz] of [[-1.2, -0.5], [1.2, -0.5], [-1.2, 0.5], [1.2, 0.5]]) { const leg = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.75, 0.08), mat(0x2b2b33)); leg.position.set(sx, 0.375, sz); g.add(leg); }
  const stand = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.2), mat(0x1a1a22)); stand.position.set(0, 0.95, -0.35); g.add(stand);
  const bezel = new THREE.Mesh(new THREE.BoxGeometry(1.25, 0.8, 0.07), mat(0x15161e, { metalness: 0.3, roughness: 0.5 })); bezel.position.set(0, 1.45, -0.38); bezel.rotation.x = -0.1; bezel.castShadow = true; g.add(bezel);
  const screen = makeScreen();
  const scr = new THREE.Mesh(new THREE.PlaneGeometry(1.15, 0.7), screen); scr.position.set(0, 1.45, -0.34); scr.rotation.x = -0.1; g.add(scr);
  const kb = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.04, 0.3), mat(0x2a2c3a)); kb.position.set(0, 0.85, 0.2); g.add(kb);
  const mugColor = pick([0xff4d6d, 0xffb020, 0x39d98a, 0x4ea1ff, 0xc77dff]);
  const mug = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.09, 0.2, 12), mat(mugColor)); mug.position.set(0.8, 0.93, 0.1); g.add(mug);
  if (Math.random() < 0.5) g.add(plant(-1.0, -0.3, 0.35));
  // chair
  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.1, 0.7), mat(0x3a3d5c)); seat.position.set(0, 0.5, 1.1); seat.castShadow = true; g.add(seat);
  const back = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.8, 0.1), mat(0x3a3d5c)); back.position.set(0, 0.95, 1.45); g.add(back);
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.45, 8), mat(0x1a1a22)); pole.position.set(0, 0.25, 1.1); g.add(pole);
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.05, 12), mat(0x1a1a22)); base.position.set(0, 0.03, 1.1); g.add(base);
  g.position.set(x, 0, z); scene.add(g);
  const d = { group: g, screen, x, z, agentId: null, mugColor, dept: bayAt(x) }; if (register) desks.push(d);
  return d;
}
for (const k of DEPT_ORDER) for (const z of DESK_ROWS) for (const dx of [-1.8, 1.8]) buildDesk(DEPTS[k].cx + dx, z);
buildRoom();
buildGallery();
// ---------- the mezzanine: your office, up the stairs, looking down over the floor ----------
function buildMezzanine() {
  const g = new THREE.Group(); scene.add(g);
  const depth = MEZZ.z1 - MEZZ.z0, zc = (MEZZ.z0 + MEZZ.z1) / 2;
  const slab = new THREE.Mesh(new THREE.BoxGeometry(ROOM.w, 0.3, depth), mat(0x1f2242, { roughness: 0.8 })); slab.position.set(0, MEZZ.y - 0.15, zc); slab.castShadow = true; slab.receiveShadow = true; g.add(slab);
  const carpet = new THREE.Mesh(new THREE.BoxGeometry(ROOM.w - 0.4, 0.04, depth - 0.3), mat(0x3b2f5c, { roughness: 1 })); carpet.position.set(0, MEZZ.y + 0.02, zc + 0.1); carpet.receiveShadow = true; g.add(carpet);
  const edge = new THREE.Mesh(new THREE.BoxGeometry(ROOM.w, 0.06, 0.06), new THREE.MeshStandardMaterial({ color: 0xffb020, emissive: 0xffb020, emissiveIntensity: 1.6 })); edge.position.set(0, MEZZ.y - 0.3, MEZZ.z0); g.add(edge);
  // glass railing along the open edge, with a gap where the stairs arrive
  const glass = new THREE.MeshStandardMaterial({ color: 0x9fb3ff, transparent: true, opacity: 0.14, roughness: 0.1, metalness: 0.2, side: THREE.DoubleSide, depthWrite: false });
  const railX0 = -ROOM.w / 2 + 2.6, railLen = ROOM.w - 2.6;
  const pane = new THREE.Mesh(new THREE.BoxGeometry(railLen, 1.0, 0.05), glass); pane.position.set(railX0 + railLen / 2, MEZZ.y + 0.55, MEZZ.z0 + 0.05); g.add(pane);
  const rail = new THREE.Mesh(new THREE.BoxGeometry(railLen, 0.07, 0.12), mat(0x3a3f6b, { metalness: 0.5, roughness: 0.4 })); rail.position.set(railX0 + railLen / 2, MEZZ.y + 1.08, MEZZ.z0 + 0.05); rail.castShadow = true; g.add(rail);
  for (let x = railX0; x <= ROOM.w / 2; x += 3) { const post = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.1, 0.08), mat(0x3a3f6b)); post.position.set(Math.min(x, ROOM.w / 2 - 0.1), MEZZ.y + 0.55, MEZZ.z0 + 0.05); g.add(post); }
  // stairs up the left wall: from the lounge floor at z=6 to the balcony at z=11
  const steps = 10, rise = MEZZ.y / steps, run = (MEZZ.z0 - 6) / steps, sx = -ROOM.w / 2 + 1.35;
  for (let i = 0; i < steps; i++) {
    const st = new THREE.Mesh(new THREE.BoxGeometry(2.2, rise, run + 0.02), mat(i % 2 ? 0x2a2f55 : 0x303660, { roughness: 0.7 }));
    st.position.set(sx, rise * (i + 0.5), 6 + run * (i + 0.5)); st.castShadow = true; st.receiveShadow = true; g.add(st);
  }
  const side = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.0, MEZZ.z0 - 6), glass); side.position.set(sx + 1.13, MEZZ.y * 0.5 + 0.55, (6 + MEZZ.z0) / 2); side.rotation.x = 0; g.add(side);
  const hand = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, Math.hypot(MEZZ.y, MEZZ.z0 - 6)), mat(0x3a3f6b, { metalness: 0.5 })); hand.position.set(sx + 1.13, MEZZ.y / 2 + 1.05, (6 + MEZZ.z0) / 2); hand.rotation.x = -Math.atan2(MEZZ.y, MEZZ.z0 - 6); g.add(hand);
  // your desk, facing the floor, with a plant and a sign
  const desk = buildDesk(MEZZ.deskX, MEZZ.deskZ, false); desk.group.position.y = MEZZ.y; // chair at the back, monitor toward the railing: you look over the floor
  setupYourScreen(desk);
  const p1 = plant(-4.5, MEZZ.z1 - 0.9, 1.1); p1.position.y = MEZZ.y; g.add(p1);
  const p2 = plant(4.5, MEZZ.z1 - 0.9, 1.0); p2.position.y = MEZZ.y; g.add(p2);
  const sofa = couch(9, MEZZ.z1 - 1.2, 0); sofa.position.y = MEZZ.y; g.add(sofa);
  // the sign hangs over the top of the stairs, off to the side, so it never sits between you and the floor
  const sign = textSprite('YOUR OFFICE', { size: 54, color: '#111', bg: 'rgba(255,176,32,0.92)' }); sign.position.set(-ROOM.w / 2 + 1.35, MEZZ.y + 2.1, MEZZ.z0 + 0.9); sign.scale.set(2.8, 0.44, 1); g.add(sign);
  const rug = new THREE.Mesh(new THREE.CircleGeometry(2.4, 32), mat(0x8a4b8f, { roughness: 1 })); rug.rotation.x = -Math.PI / 2; rug.position.set(MEZZ.deskX, MEZZ.y + 0.05, MEZZ.deskZ + 0.6); rug.receiveShadow = true; g.add(rug);
}
// ---------- your desk screen: who needs you, and the day at a glance ----------
// The monitor on the balcony desk faces the camera, so it works as your inbox: every agent waiting
// on an answer or an approval, oldest first, and a strip with today's numbers. Click a row to jump.
let yourScreen = null;
function setupYourScreen(desk) {
  const c = document.createElement('canvas'); c.width = 800; c.height = 488;
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  const m = new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0.95, roughness: 0.3 });
  let mesh = null; desk.group.traverse((o) => { if (o.isMesh && o.material === desk.screen) mesh = o; });
  mesh.material = m; mesh.userData.yourScreen = true;
  yourScreen = { mesh, canvas: c, tex, rows: [], sig: '' }; // first drawn by the interval, once the agent state exists
}
function askText(a) {
  if (a.ask?.kind === 'question') return a.ask.question;
  if (a.ask?.kind === 'permission') return `may I run ${prettyTool(a.ask.tool)}${a.ask.summary ? ': ' + a.ask.summary : ''}?`;
  return a.permission ? 'needs your approval' : 'asked you a question';
}
function drawYourScreen(force = false) {
  if (!yourScreen) return;
  const mine = lastAgents.filter(inProject); const selName = effProject();
  const waiting = mine.map((a) => ({ a, av: avatars.get(a.id) })).filter((r) => r.av && (r.av.wants() === 'permission' || r.av.wants() === 'question'))
    .sort((p, q) => (q.a.permission - p.a.permission) || (p.a.lastEvent - q.a.lastEvent));
  const working = mine.filter((a) => avatars.get(a.id)?.wants() === 'work').length;
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const reportsToday = [...reportsById.values()].filter((r) => r.t >= dayStart.getTime()).length;
  const q = lastQueue;
  const sig = JSON.stringify([waiting.map((r) => [r.a.id, askText(r.a).slice(0, 60), Math.floor((Date.now() - r.a.lastEvent) / 30000)]), working, reportsToday, boardIssues().length, q && [q.on, q.running, q.limit], mine.length, selName]);
  if (!force && sig === yourScreen.sig) return; yourScreen.sig = sig;
  const c = yourScreen.canvas, ctx = c.getContext('2d'); const W = c.width, H = c.height; const mono = 'ui-monospace, Menlo, Consolas, monospace';
  ctx.fillStyle = '#07080f'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = waiting.length ? '#ff4d6d' : '#39d98a'; ctx.fillRect(0, 0, W, 6);
  ctx.textBaseline = 'top'; ctx.textAlign = 'left';
  ctx.font = `bold 30px ${mono}`; ctx.fillStyle = '#e8ecff'; ctx.fillText('INBOX', 24, 22);
  let hx = 136; if (selName) { ctx.fillStyle = projColor(selName); ctx.font = `bold 20px ${mono}`; const t = `· ${selName}`.slice(0, 18); ctx.fillText(t, hx, 30); hx += ctx.measureText(t).width + 14; }
  ctx.font = `22px ${mono}`; ctx.fillStyle = waiting.length ? '#ff4d6d' : '#8b92b8';
  ctx.fillText(waiting.length ? `${waiting.length} waiting on you` : 'nobody is waiting on you', hx, 28);
  ctx.textAlign = 'right'; ctx.fillStyle = '#5c6390'; ctx.fillText(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), W - 24, 28); ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.fillRect(24, 64, W - 48, 2);
  yourScreen.rows = [];
  const rowH = 66, top = 76, max = 5;
  waiting.slice(0, max).forEach(({ a, av }, i) => {
    const y = top + i * rowH;
    ctx.fillStyle = a.permission ? 'rgba(255,77,109,0.10)' : 'rgba(255,176,32,0.10)'; roundRect(ctx, 24, y, W - 48, rowH - 8, 10); ctx.fill();
    ctx.fillStyle = a.permission ? '#ff4d6d' : '#ffb020'; ctx.fillRect(24, y, 6, rowH - 8);
    ctx.fillStyle = '#' + av.color.getHexString(); roundRect(ctx, 44, y + 12, 16, 16, 4); ctx.fill();
    ctx.fillStyle = '#e8ecff'; ctx.font = `bold 22px ${mono}`; ctx.fillText(av.name().slice(0, 14), 70, y + 9);
    ctx.fillStyle = deptHex(a.dept); ctx.font = `bold 14px ${mono}`; ctx.fillText(deptOf(a.dept).name.toUpperCase(), 70 + ctx.measureText(av.name().slice(0, 14)).width * 1.6 + 16, y + 14);
    ctx.textAlign = 'right'; ctx.fillStyle = '#8b92b8'; ctx.font = `16px ${mono}`; ctx.fillText(`${ago(a.lastEvent)} · ${a.hasTerminal ? 'click to answer' : 'desktop app'}`, W - 36, y + 12); ctx.textAlign = 'left';
    ctx.fillStyle = a.permission ? '#ffb8c4' : '#ffe0a8'; ctx.font = `19px ${mono}`;
    const text = askText(a).replace(/\s+/g, ' '); let line = text; while (ctx.measureText(line).width > W - 110 && line.length > 4) line = line.slice(0, -4); if (line !== text) line = line.slice(0, -1) + '…';
    ctx.fillText(line, 70, y + 36);
    yourScreen.rows.push({ id: a.id, y0: y, y1: y + rowH - 8 });
  });
  if (waiting.length > max) { ctx.fillStyle = '#5c6390'; ctx.font = `16px ${mono}`; ctx.fillText(`+${waiting.length - max} more in the roster`, 24, top + max * rowH); }
  if (!waiting.length) { ctx.fillStyle = '#39d98a'; ctx.font = `bold 44px ${mono}`; ctx.fillText('✓ all clear', 24, 150); ctx.fillStyle = '#5c6390'; ctx.font = `20px ${mono}`; ctx.fillText(`${working} working · ${mine.length - working} idle or done`, 24, 206); }
  // the day at a glance
  const sy = H - 78; ctx.fillStyle = 'rgba(255,255,255,0.05)'; ctx.fillRect(0, sy, W, 78);
  ctx.fillStyle = '#ffb020'; ctx.fillRect(0, sy, W, 2);
  const tiles = [['WORKING', working, '#39d98a'], ['REPORTS TODAY', reportsToday, '#ffb020'], ['OPEN TASKS', boardIssues().length, '#4ea1ff'], ['QUEUE', q ? (q.on ? `${q.running}/${q.limit}` : 'off') : '—', q?.on ? '#39d98a' : '#8b92b8']];
  tiles.forEach(([label, n, col], i) => {
    const x = 24 + i * (W - 48) / 4;
    ctx.fillStyle = col; ctx.font = `bold 34px ${mono}`; ctx.fillText(String(n), x, sy + 12);
    ctx.fillStyle = '#8b92b8'; ctx.font = `bold 13px ${mono}`; ctx.fillText(label, x, sy + 54);
  });
  yourScreen.tex.needsUpdate = true;
}
setInterval(() => drawYourScreen(), 1000);
buildMezzanine();
function claimDesk(id, dept) {
  let d = desks.find((d) => d.agentId === id && (!dept || d.dept === dept)); if (d) return d;
  releaseDesk(id);
  d = desks.find((d) => d.agentId === null && d.dept === dept) || desks.find((d) => d.agentId === null && d.dept === 'engineering') || desks.find((d) => d.agentId === null) || desks.find((d) => d.dept === dept) || desks[0];
  d.agentId = id; return d;
}
function releaseDesk(id) { for (const d of desks) if (d.agentId === id) { d.agentId = null; drawScreen(d.screen, 'off', ''); d.screen.userData.key = 'off|'; } }

// ============================================================ characters
const SKIN = [0xffd3b6, 0xe8b894, 0xc68642, 0x8d5524, 0xf1c27d, 0x5c3a21];
const HAIR = [0x2b1b12, 0x5a3b1f, 0xe3c27a, 0xd14b3d, 0x1c1c1c, 0x8e4bd8, 0x39d98a];
function hashHue(s) { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h % 360; }

function buildBody(host, { skin: skinC, hair: hairC, shirt: shirtC, pants: pantsC, hat = null, tie = null, clipboard = false }) {
  const skin = mat(skinC), hair = mat(hairC), shirt = mat(shirtC), pants = mat(pantsC);
  host.body = new THREE.Group(); host.group.add(host.body);
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.62, 0.34), shirt); torso.position.y = 0.95; torso.castShadow = true; host.body.add(torso);
  if (tie !== null) { const t = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.4, 0.03), mat(tie)); t.position.set(0, 1.0, 0.18); host.body.add(t); }
  host.legs = [];
  for (const s of [-1, 1]) { const leg = new THREE.Group(); leg.position.set(s * 0.14, 0.64, 0); const lm = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.62, 0.24), pants); lm.position.y = -0.31; lm.castShadow = true; leg.add(lm); host.body.add(leg); host.legs.push(leg); }
  host.arms = [];
  for (const s of [-1, 1]) { const arm = new THREE.Group(); arm.position.set(s * 0.36, 1.2, 0); const am = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.56, 0.18), shirt); am.position.y = -0.28; am.castShadow = true; arm.add(am); const hand = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.14, 0.18), skin); hand.position.y = -0.6; arm.add(hand); host.body.add(arm); host.arms.push(arm); }
  if (clipboard) { const cb = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.4, 0.03), mat(0xe8dcc0)); cb.position.set(0, -0.62, 0.16); cb.rotation.x = -0.5; host.arms[0].add(cb); const clip = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.05, 0.04), mat(0x888888)); clip.position.set(0, -0.44, 0.2); clip.rotation.x = -0.5; host.arms[0].add(clip); }
  host.head = new THREE.Group(); host.head.position.y = 1.52; host.body.add(host.head);
  const hm = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.48, 0.48), skin); hm.castShadow = true; host.head.add(hm);
  if (hat !== null) {
    const brim = new THREE.Mesh(new THREE.BoxGeometry(0.64, 0.06, 0.62), mat(hat)); brim.position.set(0, 0.22, 0.02); host.head.add(brim);
    const dome = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.22, 0.48), mat(hat)); dome.position.set(0, 0.34, 0); host.head.add(dome);
  } else {
    const hr = new THREE.Mesh(new THREE.BoxGeometry(0.54, 0.2, 0.52), hair); hr.position.set(0, 0.2, -0.02); host.head.add(hr);
    const hb = new THREE.Mesh(new THREE.BoxGeometry(0.54, 0.3, 0.1), hair); hb.position.set(0, 0.0, -0.22); host.head.add(hb);
  }
  for (const s of [-1, 1]) { const eye = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.09, 0.03), mat(0x111111)); eye.position.set(s * 0.12, 0.0, 0.25); host.head.add(eye); }
  const mouth = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.03, 0.03), mat(0x7a3b3b)); mouth.position.set(0, -0.14, 0.25); host.head.add(mouth); host.mouth = mouth;
}
function computePath(from, target) {
  const path = []; const inDesks = (z) => z < CORRIDOR_Z;
  if (inDesks(from.z) || inDesks(target.z)) {
    const near = (x) => AISLES.reduce((best, a) => Math.abs(a - x) < Math.abs(best - x) ? a : best, AISLES[0]);
    const aisle = near(target.x), aisleFrom = near(from.x);
    if (inDesks(from.z)) { path.push(new THREE.Vector3(aisleFrom, 0, from.z)); path.push(new THREE.Vector3(aisleFrom, 0, CORRIDOR_Z)); }
    if (inDesks(target.z)) { path.push(new THREE.Vector3(aisle, 0, CORRIDOR_Z)); path.push(new THREE.Vector3(aisle, 0, target.z)); }
  }
  path.push(target.clone()); return path;
}

const LEGO_ACTIONS = { help: 'reading the rules', look: 'studying the build', place: 'placing bricks', remove: 'taking bricks off', say: 'talking it over', wait: 'listening to the team', title: 'naming the build', done: 'done!' };
class Avatar {
  constructor(a) {
    this.id = a.id; this.data = a; this.group = new THREE.Group(); this.group.userData.avatarId = a.id;
    const hue = typeof a.palette === 'number' ? (a.palette * 61 + (a.hueShift || 0)) % 360 : hashHue(a.id);
    this.color = new THREE.Color().setHSL(hue / 360, 0.75, 0.55);
    buildBody(this, { skin: SKIN[Math.abs(a.id) % SKIN.length], hair: HAIR[hashHue(a.id + 'h') % HAIR.length], shirt: this.color.getHex(), pants: 0x2d3350 });
    // labels
    this.nameSprite = textSprite(this.name(), { size: 44, color: '#e8ecff', bg: 'rgba(12,14,30,0.75)' }); this.nameSprite.position.y = 2.2; this.nameSprite.scale.set(2.6, 0.42, 1); this.group.add(this.nameSprite);
    this.statusSprite = textSprite('', { size: 40, color: '#39d98a', bg: 'rgba(12,14,30,0.75)' }); this.statusSprite.position.y = 2.58; this.statusSprite.scale.set(3.4, 0.46, 1); this.statusSprite.visible = false; this.group.add(this.statusSprite);
    this.bubble = textSprite('!', { size: 90, color: '#fff', bg: 'rgba(255,77,109,0.95)' }); this.bubble.position.set(0.55, 2.3, 0); this.bubble.scale.set(0.8, 0.5, 1); this.bubble.visible = false; this.group.add(this.bubble);
    this.speech = textSprite('', { size: 38, color: '#f3f5ff', bg: 'rgba(12,14,30,0.88)' }); this.speech.position.y = 3.0; this.speech.scale.set(4.4, 0.6, 1); this.speech.visible = false; this.group.add(this.speech); this.speechUntil = 0; this.lastBuild = 0;
    // context bar
    this.barBg = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 0.08), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.5, depthWrite: false }));
    this.bar = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 0.06), new THREE.MeshBasicMaterial({ color: 0x39d98a, depthWrite: false }));
    this.barHolder = new THREE.Group(); this.barHolder.position.y = 1.98; this.barHolder.add(this.barBg, this.bar); this.bar.position.z = 0.001; this.bar.renderOrder = 11; this.barBg.renderOrder = 11; this.group.add(this.barHolder);
    // glow ring on the floor
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.52, 32), new THREE.MeshBasicMaterial({ color: this.color, transparent: true, opacity: 0.0, side: THREE.DoubleSide }));
    this.ring.rotation.x = -Math.PI / 2; this.ring.position.y = 0.02; this.group.add(this.ring);
    // generous invisible hitbox so a click lands even while the character jumps or waves
    this.hitbox = new THREE.Mesh(new THREE.BoxGeometry(1.3, 3.2, 1.3), new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
    this.hitbox.position.y = 1.6; this.hitbox.renderOrder = -1; this.group.add(this.hitbox);
    // the report an agent carries to the office when its turn is done
    this.paper = new THREE.Group();
    const sheet = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.44, 0.02), mat(0xf4f1e8)); this.paper.add(sheet);
    for (let i = 0; i < 4; i++) { const ln = new THREE.Mesh(new THREE.BoxGeometry(0.22 - (i % 2) * 0.06, 0.025, 0.005), mat(0x5c6390)); ln.position.set(-0.03 + (i % 2) * 0.03, 0.13 - i * 0.08, 0.012); this.paper.add(ln); }
    this.paper.position.set(0, -0.62, 0.18); this.paper.rotation.x = -0.35; this.paper.visible = false; this.arms[1].add(this.paper);
    this.pendingReports = [];
    // behaviour
    this.desk = claimDesk(a.id, a.dept);
    this.pos = new THREE.Vector3(this.desk.x, 0, CORRIDOR_Z + 1); this.group.position.copy(this.pos);
    this.path = []; this.mode = 'wander'; this.waitUntil = 0; this.seated = false; this.yaw = Math.PI; this.t = Math.random() * 10; this.bounce = 0; this.jumpV = 0; this.jumpY = 0;
    this.drones = new Map();
    this.lastToolText = '';
    this.ghost = false; // another project's tab is open: drawn faint, no labels
    scene.add(this.group);
    this.decide(true);
  }
  dept() { return this.data.dept || 'engineering'; }
  setGhost(on) {
    this.ghost = on;
    this.body.traverse((o) => { if (o.isMesh && o.material && !o.isSprite) { o.material.transparent = on; o.material.opacity = on ? 0.2 : 1; o.material.needsUpdate = true; o.castShadow = !on; } });
    for (const dr of this.drones.values()) { dr.label.visible = !on; dr.group.traverse((o) => { if (o.isMesh && o.material && !o.isSprite) { o.material.transparent = on; o.material.opacity = on ? 0.2 : 1; o.material.needsUpdate = true; } }); }
  }
  // a finished turn: carry the report to the office unless the agent is busy or waiting on you
  file(report) {
    const w = this.wants();
    if (w === 'work' || w === 'permission' || w === 'question' || this.playing()) { handInReport(report, this, false); return; }
    this.pendingReports.push(report); this.decide(true);
  }
  dropReports() {
    for (const r of this.pendingReports) handInReport(r, this, true);
    this.pendingReports = []; this.jumpV = 2.2; this.waitUntil = Date.now() + 2200;
  }
  name() { const a = this.data; return a.nickname || a.teammateName || a.humanName || a.directoryName || `agent ${a.id}`; }
  wants() {
    const a = this.data;
    if (a.permission) return 'permission';
    if (a.status === 'active') return 'work';
    if (a.awaitingInput) return 'question';
    return 'wander';
  }
  routeTo(target) { this.path = computePath(this.pos, target); }
  playing() { return !!(lastPlay?.active && lastPlay.players.some((p) => p.id === this.id)); }
  playSpot() { const i = Math.max(0, lastPlay.players.findIndex((p) => p.id === this.id)); const [x, z] = PLAY_SPOTS[i % PLAY_SPOTS.length]; return new THREE.Vector3(x, 0, z); }
  speak(text) { updateSprite(this.speech, text.length > 46 ? text.slice(0, 45) + '…' : text, { size: 38, color: '#f3f5ff', bg: 'rgba(12,14,30,0.88)' }); this.speech.visible = true; this.speechUntil = Date.now() + 7000; }
  decide(force = false) {
    const w = this.wants();
    if (this.desk.dept !== this.dept()) { // moved to another department: take a desk there
      this.desk = claimDesk(this.id, this.dept()); this.seated = false; force = true;
    }
    if (this.playing() && w !== 'permission' && w !== 'question') {
      if (this.mode !== 'play' || force) { this.mode = 'play'; this.seated = false; this.routeTo(this.playSpot()); }
    } else if (w === 'work' || w === 'permission' || w === 'question') {
      if (this.pendingReports.length) { for (const r of this.pendingReports) handInReport(r, this, false); this.pendingReports = []; }
      if (this.mode !== 'desk' || force) { this.mode = 'desk'; this.routeTo(new THREE.Vector3(this.desk.x, 0, this.desk.z + 1.1)); }
    } else if (this.pendingReports.length) {
      if (this.mode !== 'report' || force) { this.mode = 'report'; this.seated = false; this.routeTo(OFFICE.drop.clone()); }
    } else if (huddle) { // the manager is handing out a plan: gather round
      if (this.mode !== 'huddle' || force) { this.mode = 'huddle'; this.seated = false; this.waitUntil = 0; this.routeTo(huddleSpot(this.id)); }
    } else {
      if (this.mode !== 'wander' || force) { this.mode = 'wander'; this.seated = false; this.waitUntil = 0; this.routeTo(this.randomLoungePoint()); }
    }
  }
  randomLoungePoint() { return new THREE.Vector3(rand(LOUNGE.x0, LOUNGE.x1), 0, rand(LOUNGE.z0, LOUNGE.z1)); }
  update(dt, now) {
    this.t += dt;
    const a = this.data; const w = this.wants();
    // --- movement along path
    const speed = w === 'permission' ? 4.2 : 2.6;
    let moving = false;
    if (this.path.length) {
      const target = this.path[0]; const d = target.clone().sub(this.pos); d.y = 0; const dist = d.length();
      if (dist < 0.08) { this.path.shift(); if (!this.path.length && this.mode === 'desk') this.seated = true; if (!this.path.length && this.mode === 'report') this.dropReports(); }
      else { moving = true; const step = Math.min(dist, speed * dt); this.pos.addScaledVector(d.normalize(), step); this.yaw = Math.atan2(d.x, d.z); }
    } else if (this.mode === 'huddle') {
      if (!huddle) this.decide(true);
      else if (manager) this.yaw = Math.atan2(manager.pos.x - this.pos.x, manager.pos.z - this.pos.z); // listen to the manager
    } else if (this.mode === 'wander' || this.mode === 'report') {
      if (!this.waitUntil) this.waitUntil = now + rand(1500, 5000);
      if (now > this.waitUntil) { this.waitUntil = 0; this.mode = 'wander'; this.routeTo(this.randomLoungePoint()); }
    }
    const needsYou = w === 'permission' || w === 'question';
    if (this.mode === 'desk' && !this.path.length) this.yaw = needsYou ? 0 : Math.PI; // face the monitor, or turn around to face you
    if (this.mode === 'play' && !this.path.length) this.yaw = Math.atan2(LEGO.x - this.pos.x, LEGO.z - this.pos.z);
    if (this.mode === 'report' && !this.path.length) this.yaw = Math.atan2(OFFICE.tray.x - this.pos.x, OFFICE.tray.z - this.pos.z);
    this.paper.visible = this.pendingReports.length > 0;
    // --- pose
    const tools = Object.values(a.tools); const typing = w === 'work' && tools.length > 0;
    const seated = this.seated && this.mode === 'desk' && !needsYou;
    if (needsYou && this.mode === 'desk' && !this.path.length) { this.pos.z = lerp(this.pos.z, this.desk.z + 1.9, 1 - Math.pow(0.01, dt)); } // step out from the chair
    const targetY = seated ? 0.1 : 0;
    this.group.position.set(this.pos.x, targetY + this.jumpY, this.pos.z);
    this.group.rotation.y = lerpAngle(this.group.rotation.y, this.yaw, 1 - Math.pow(0.0005, dt));
    const swing = moving ? Math.sin(this.t * 10) * 0.6 : 0;
    this.legs[0].rotation.x = seated ? -1.4 : swing; this.legs[1].rotation.x = seated ? -1.4 : -swing;
    const building = this.mode === 'play' && !moving && now - this.lastBuild < 1500;
    if (this.paper.visible) { this.arms[1].rotation.x = -1.5; this.arms[1].rotation.z = 0; this.arms[0].rotation.x = -swing * 0.8; this.arms[0].rotation.z = 0; }
    else if (building) { this.arms[0].rotation.x = -1.35 + Math.sin(this.t * 12) * 0.3; this.arms[1].rotation.x = -1.35 - Math.sin(this.t * 12) * 0.3; }
    else if (typing) { this.arms[0].rotation.x = -1.1 + Math.sin(this.t * 22) * 0.18; this.arms[1].rotation.x = -1.1 + Math.cos(this.t * 22) * 0.18; }
    else if (seated) { this.arms[0].rotation.x = -0.9; this.arms[1].rotation.x = -0.9; }
    else if (needsYou && !moving) { const wave = Math.sin(this.t * 9) * 0.35; this.arms[0].rotation.x = Math.PI - 0.3 + wave; this.arms[1].rotation.x = Math.PI - 0.3 - wave; this.arms[0].rotation.z = -0.4; this.arms[1].rotation.z = 0.4; }
    else { this.arms[0].rotation.x = -swing * 0.8; this.arms[1].rotation.x = swing * 0.8; this.arms[0].rotation.z = 0; this.arms[1].rotation.z = 0; }
    if (seated) { this.body.position.y = -0.3; } else this.body.position.y = moving ? Math.abs(Math.sin(this.t * 10)) * 0.06 : 0;
    this.head.rotation.x = this.mode === 'play' && !moving ? 0.35 : typing ? 0.12 + Math.sin(this.t * 1.7) * 0.05 : (w === 'work' ? Math.sin(this.t * 0.9) * 0.15 : this.mode === 'huddle' && !moving ? Math.max(0, Math.sin(this.t * 2.2 + this.id)) * 0.18 : 0);
    this.head.rotation.y = w === 'work' && !typing ? Math.sin(this.t * 0.7) * 0.35 : 0;
    this.mouth.scale.y = needsYou ? 2.5 : 1;
    if (godVoice) { // the voice of god: everyone freezes, looks up to the heavens and trembles
      const k = godVoice.listening ? 0.6 : 1; // a little less violent while you are still talking
      this.head.rotation.x = -0.8 + Math.sin(this.t * 37) * 0.04 * k; this.head.rotation.y = Math.sin(this.t * 29 + this.id) * 0.05 * k;
      this.group.position.x += Math.sin(this.t * 53 + this.id) * 0.03 * k; this.group.position.z += Math.cos(this.t * 47 + this.id * 2) * 0.03 * k;
      this.body.position.y += Math.sin(this.t * 41) * 0.012 * k;
      this.arms[0].rotation.x = -0.5 + Math.sin(this.t * 31) * 0.12; this.arms[1].rotation.x = -0.5 - Math.sin(this.t * 31) * 0.12; this.arms[0].rotation.z = 0.5; this.arms[1].rotation.z = -0.5; // arms clutched in
      this.mouth.scale.y = 3; this.mouth.scale.x = 0.6;
    } else this.mouth.scale.x = 1;
    // jump / bounce for permission
    if (needsYou && !moving && this.jumpY <= 0 && Math.random() < dt * (w === 'permission' ? 2.5 : 1.2)) this.jumpV = w === 'permission' ? 3.0 : 2.2;
    this.jumpV -= 9.8 * dt; this.jumpY = Math.max(0, this.jumpY + this.jumpV * dt); if (this.jumpY === 0 && this.jumpV < 0) this.jumpV = 0;
    // --- labels + bubble
    updateSprite(this.nameSprite, a.role === 'planner' ? `${this.name()} · planner` : this.name(), { size: 44, color: a.role === 'planner' ? '#ffb020' : '#e8ecff', bg: 'rgba(12,14,30,0.75)', tab: a.project ? projColor(a.project) : null });
    let status = ''; let statusColor = '#39d98a';
    if (godVoice) { status = godVoice.listening ? '…he speaks' : 'trembling'; statusColor = '#fff4d6'; }
    else if ((w === 'permission' || w === 'question') && a.desk && a.ask?.kind === 'permission') { status = `security desk: ${a.desk.name}`; statusColor = '#ffb020'; }
    else if (w === 'permission' || w === 'question') { status = a.ask?.kind === 'question' ? a.ask.question.slice(0, 40) : a.ask?.kind === 'permission' ? `may I run ${prettyTool(a.ask.tool)}?` : 'needs your approval'; statusColor = '#ff4d6d'; }
    else if (typing && this.mode === 'play') { const t = tools[tools.length - 1]; const lm = /lego\.mjs"?\s+\d+\s+(\w+)/.exec(t.status || ''); status = LEGO_ACTIONS[lm?.[1]] || 'playing'; statusColor = '#39d98a'; }
    else if (typing) { const t = tools[tools.length - 1]; status = (t.status || t.toolName).replace(/mcp__\S+/g, (m) => prettyTool(m)).slice(0, 36); statusColor = '#' + new THREE.Color(TOOL_COLORS[toolKind(t.toolName)]).getHexString(); }
    else if (w === 'work') { status = 'thinking' + '.'.repeat(1 + (Math.floor(this.t * 2) % 3)); statusColor = '#d6dcff'; }
    else if (w === 'question') { status = 'asked you a question'; statusColor = '#ffb020'; }
    else if (this.pendingReports.length) { status = `filing a ${deptOf(this.pendingReports[0].dept).name} report`; statusColor = '#ffb020'; }
    else if (this.mode === 'huddle' && !moving) { status = 'listening'; statusColor = '#ffb020'; }
    this.statusSprite.visible = !!status;
    if (status) updateSprite(this.statusSprite, status, { size: 40, color: statusColor, bg: 'rgba(12,14,30,0.78)' });
    const idleFor = now - (a.lastEvent || 0);
    let bub = null;
    if (w === 'permission') bub = ['!', 'rgba(255,77,109,0.95)'];
    else if (w === 'question') bub = ['?', 'rgba(255,176,32,0.95)'];
    else if (w === 'wander' && idleFor > 120000 && !moving && this.mode !== 'play') bub = ['z z', 'rgba(124,92,255,0.9)'];
    this.bubble.visible = !!bub;
    if (bub) { updateSprite(this.bubble, bub[0], { size: 90, color: '#fff', bg: bub[1] }); this.bubble.position.y = 2.3 + Math.sin(this.t * 6) * 0.08; }
    if (this.speech.visible && now > this.speechUntil) this.speech.visible = false;
    // --- context bar
    const frac = a.maxContextTokens ? clamp(a.contextTokens / a.maxContextTokens, 0, 1) : 0;
    this.barHolder.visible = frac > 0; this.bar.scale.x = Math.max(0.01, frac); this.bar.position.x = -(1 - frac) / 2;
    this.bar.material.color.setHex(frac < 0.6 ? 0x39d98a : frac < 0.85 ? 0xffb020 : 0xff4d6d);
    this.barHolder.quaternion.copy(this.group.quaternion).invert().multiply(camera.quaternion); // billboard in world space
    // --- ring
    this.ring.material.opacity = w === 'work' ? 0.45 + Math.sin(this.t * 4) * 0.2 : w === 'permission' ? 0.8 : 0.0;
    this.ring.material.color.setHex(w === 'permission' ? 0xff4d6d : this.color.getHex());
    // --- monitor screen
    const scr = this.desk.screen;
    let kind = 'off', title = '';
    if (w === 'permission') { kind = 'permission'; title = 'APPROVE?'; }
    else if (typing) { const t = tools[tools.length - 1]; kind = toolKind(t.toolName); title = prettyTool(t.toolName); }
    else if (w === 'work') { kind = 'think'; title = 'thinking'; }
    const key = kind + '|' + title;
    if (scr.userData.key !== key) { scr.userData.key = key; drawScreen(scr, kind, title); }
    if (kind === 'permission') scr.emissiveIntensity = 1.0 + Math.sin(this.t * 9) * 0.8;
    // --- another project's tab is open: fade out, no labels
    const ghost = !inProject(a); if (ghost !== this.ghost) this.setGhost(ghost);
    if (ghost) { this.nameSprite.visible = this.statusSprite.visible = this.bubble.visible = this.speech.visible = this.barHolder.visible = false; this.ring.material.opacity = 0; }
    else this.nameSprite.visible = true;
    // --- glyph particles when typing
    if (typing && !ghost && this.mode === 'desk' && Math.random() < dt * 9) spawnGlyph(this.desk.x + rand(-0.3, 0.3), 0.95, this.desk.z + 0.2, TOOL_COLORS[kind]);
    // --- drones for subagents
    const subs = Object.entries(a.subagents);
    for (const [k, s] of subs) if (!this.drones.has(k)) { this.drones.set(k, makeDrone(s.toolName, this.color)); if (this.ghost) this.setGhost(true); }
    for (const [k, dr] of this.drones) if (!a.subagents[k]) { scene.remove(dr.group); this.drones.delete(k); }
    let i = 0;
    for (const [k, dr] of this.drones) {
      const s = a.subagents[k]; const ang = this.t * 1.2 + (i / Math.max(1, this.drones.size)) * Math.PI * 2;
      const cx = this.desk.x, cz = this.desk.z - 0.2; const r = 1.4 + i * 0.15;
      dr.group.position.set(cx + Math.cos(ang) * r, 2.1 + Math.sin(this.t * 3 + i) * 0.15, cz + Math.sin(ang) * r * 0.6);
      dr.rotor.rotation.y += dt * 30; dr.group.lookAt(cx, 2.0, cz);
      updateSprite(dr.label, s.tool ? `${s.toolName}: ${s.tool}`.slice(0, 30) : s.toolName, { size: 36, color: '#c77dff', bg: 'rgba(12,14,30,0.75)' });
      i++;
    }
  }
  dispose() { scene.remove(this.group); for (const dr of this.drones.values()) scene.remove(dr.group); for (const r of this.pendingReports) handInReport(r, this, false); releaseDesk(this.id); }
}
// ---------- the report tray: every filed report becomes a sheet on the pile ----------
const trayPile = []; const TRAY_MAX = 24;
function addSheet(dept) {
  const sheet = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.012, 0.56), mat(0xf4f1e8, { roughness: 0.9 }));
  const tab = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.014, 0.08), new THREE.MeshStandardMaterial({ color: deptOf(dept).color, emissive: deptOf(dept).color, emissiveIntensity: 0.5 })); tab.position.set(0, 0.002, -0.24); sheet.add(tab);
  const n = trayPile.length;
  sheet.position.set(OFFICE.tray.x + rand(-0.03, 0.03), OFFICE.tray.y + 0.04 + n * 0.014, OFFICE.tray.z + rand(-0.03, 0.03)); sheet.rotation.y = rand(-0.12, 0.12); sheet.castShadow = true;
  scene.add(sheet); trayPile.push(sheet); binParts.push(sheet);
  if (trayPile.length > TRAY_MAX) { const old = trayPile.shift(); scene.remove(old); binParts.splice(binParts.indexOf(old), 1); trayPile.forEach((s, i) => { s.position.y = OFFICE.tray.y + 0.04 + i * 0.014; }); }
}
// ---------- the floor manager ----------
const MANAGER_HOME = { x0: 9.2, x1: 13.4, z0: 5.4, z1: 7.6 };
class Manager {
  constructor() {
    this.group = new THREE.Group(); this.group.userData.manager = true;
    buildBody(this, { skin: 0xe8b894, hair: 0x2b1b12, shirt: 0x1b1f3a, pants: 0x12142a, hat: 0xffb020, tie: 0xff4d6d, clipboard: true });
    this.nameSprite = textSprite('floor manager', { size: 44, color: '#ffb020', bg: 'rgba(12,14,30,0.8)' }); this.nameSprite.position.y = 2.35; this.nameSprite.scale.set(2.6, 0.42, 1); this.group.add(this.nameSprite);
    this.bubble = textSprite('', { size: 40, color: '#f3f5ff', bg: 'rgba(12,14,30,0.88)' }); this.bubble.position.set(0, 2.85, 0); this.bubble.scale.set(4.4, 0.6, 1); this.bubble.visible = false; this.group.add(this.bubble);
    this.pos = new THREE.Vector3(11, 0, 6.4); this.group.position.copy(this.pos); this.yaw = Math.PI; this.t = 0; this.path = []; this.waitUntil = 0;
    this.task = null; // { targetId, text, phase: 'walk'|'talk'|'done', until }
    this.bubbleUntil = 0; this.jumpV = 0; this.jumpY = 0; this.faceId = null; this.huddling = false;
    scene.add(this.group);
  }
  // a plan came back: stand in the lounge, call everyone over, and read the parts out one by one
  startHuddle(f) {
    const lines = f.parts.map((t) => `${t.n}. ${deptOf(t.dept).name}: ${t.title}`);
    huddle = { center: HUDDLE_CENTER.clone(), lines, i: -1, nextAt: 0, slots: new Map(), planner: f.planner, until: Date.now() + 60000 };
    this.task = null; this.faceId = null; this.facePoint = null; this.huddling = true;
    this.path = computePath(this.pos, HUDDLE_CENTER.clone());
    this.say(`Everyone, gather round: ${f.planner}'s plan, ${lines.length} parts`, { ms: 7000 }); this.jumpV = 2.0;
    for (const av of avatars.values()) av.decide(true);
  }
  endHuddle() {
    huddle = null; this.huddling = false;
    this.say('Go!', { color: '#fff', bg: 'rgba(57,217,138,0.95)', ms: 3500 }); this.jumpV = 2.6; burstConfetti(this.pos.x, 2.0, this.pos.z, 0xffb020);
    this.goHome(); for (const av of avatars.values()) av.decide(true);
  }
  say(text, { color = '#f3f5ff', bg = 'rgba(12,14,30,0.88)', ms = 6000 } = {}) {
    updateSprite(this.bubble, text.length > 44 ? text.slice(0, 43) + '…' : text, { size: 40, color, bg }); this.bubble.visible = true; this.bubbleUntil = Date.now() + ms;
  }
  walkTo(id) {
    const av = avatars.get(id); if (!av) return false;
    this.faceId = id;
    const d = av.desk; this.facePoint = null; this.path = computePath(this.pos, new THREE.Vector3(d.x + 1.1, 0, d.z + 1.9)); return true;
  }
  walkToTable() { this.faceId = null; this.facePoint = new THREE.Vector3(LEGO.x, 0, LEGO.z); this.path = computePath(this.pos, MANAGER_PLAY_SPOT.clone()); }
  goHome() { this.faceId = null; this.facePoint = null; this.path = computePath(this.pos, new THREE.Vector3(rand(MANAGER_HOME.x0, MANAGER_HOME.x1), 0, rand(MANAGER_HOME.z0, MANAGER_HOME.z1))); }
  update(dt, now) {
    this.t += dt;
    let moving = false;
    if (this.path.length) {
      const target = this.path[0]; const d = target.clone().sub(this.pos); d.y = 0; const dist = d.length();
      if (dist < 0.08) this.path.shift();
      else { moving = true; this.pos.addScaledVector(d.normalize(), Math.min(dist, 3.2 * dt)); this.yaw = Math.atan2(d.x, d.z); }
    } else if (this.huddling && huddle) { // at the huddle spot: read the plan out, a part every few seconds
      if (!huddle.nextAt) huddle.nextAt = now + 2500; // let them walk over first
      if (now > huddle.nextAt) {
        huddle.i++;
        if (huddle.i < huddle.lines.length) { this.say(huddle.lines[huddle.i], { ms: 4200 }); this.jumpV = 1.2; huddle.nextAt = now + 4500; }
        else this.endHuddle();
      }
      this.yaw += dt * 0.7; // turn to face the ring
    } else if (this.huddling) { this.endHuddle(); }
    else if (this.task && this.task.phase === 'walk' && !this.task.pendingTarget) {
      this.task.phase = 'talk'; this.say(this.task.text, { ms: 7000 }); this.jumpV = 2.0;
      if (!this.task.pending) { this.task.phase = 'done'; this.task.until = now + 7000; } // nothing more is coming back from the bridge
    } else if (!this.task) {
      if (!this.waitUntil) this.waitUntil = now + rand(3000, 9000);
      if (now > this.waitUntil) { this.waitUntil = 0; this.goHome(); }
    }
    if (this.task && this.task.pendingTarget && avatars.has(this.task.pendingTarget)) { this.task.targetId = this.task.pendingTarget; this.task.pendingTarget = null; this.task.phase = 'walk'; this.walkTo(this.task.targetId); }
    if (!moving && !this.huddling && this.faceId === null && this.facePoint) this.yaw = Math.atan2(this.facePoint.x - this.pos.x, this.facePoint.z - this.pos.z);
    if (!moving && !this.huddling && this.faceId !== null && avatars.has(this.faceId)) { const p = avatars.get(this.faceId).pos; this.yaw = Math.atan2(p.x - this.pos.x, p.z - this.pos.z); }
    if (this.task && this.task.phase === 'done' && now > this.task.until) { this.task = null; this.goHome(); }
    this.jumpV -= 9.8 * dt; this.jumpY = Math.max(0, this.jumpY + this.jumpV * dt); if (this.jumpY === 0 && this.jumpV < 0) this.jumpV = 0;
    this.group.position.set(this.pos.x, this.jumpY, this.pos.z);
    this.group.rotation.y = lerpAngle(this.group.rotation.y, this.yaw, 1 - Math.pow(0.0005, dt));
    const swing = moving ? Math.sin(this.t * 11) * 0.6 : 0;
    this.legs[0].rotation.x = swing; this.legs[1].rotation.x = -swing;
    const talking = this.bubble.visible && ((this.task && (this.task.phase === 'talk' || this.task.phase === 'done')) || this.huddling);
    this.arms[1].rotation.x = talking ? -1.2 + Math.sin(this.t * 5) * 0.4 : swing * 0.8;
    this.arms[0].rotation.x = -0.9; // clipboard arm
    this.body.position.y = moving ? Math.abs(Math.sin(this.t * 11)) * 0.06 : 0;
    this.head.rotation.y = talking ? Math.sin(this.t * 3) * 0.15 : (moving ? 0 : Math.sin(this.t * 0.6) * 0.4);
    this.mouth.scale.y = talking ? 1.5 + Math.sin(this.t * 14) : 1;
    if (godVoice) { this.head.rotation.x = -0.7 + Math.sin(this.t * 33) * 0.03; this.head.rotation.y = 0; this.group.position.x += Math.sin(this.t * 51) * 0.02; this.group.position.z += Math.cos(this.t * 43) * 0.02; this.mouth.scale.y = 2.5; }
    if (this.bubble.visible && now > this.bubbleUntil) this.bubble.visible = false;
  }
}
let manager = null;
// ---------- the huddle: everyone idle stands in a ring around the manager while he hands out a plan ----------
let huddle = null; // { center, lines, i, nextAt, slots: Map(agentId -> slot), planner, until }
const HUDDLE_CENTER = new THREE.Vector3(-3.2, 0, 7.6);
function huddleSpot(id) { // a fixed slot per agent, spread round the ring in the order they join
  if (!huddle.slots.has(id)) huddle.slots.set(id, huddle.slots.size);
  const i = huddle.slots.get(id); const ring = Math.floor(i / 7); const ang = (i % 7) * (Math.PI * 2 / 7) + ring * 0.45 + 0.3; const r = 1.7 + ring * 0.9;
  return new THREE.Vector3(huddle.center.x + Math.cos(ang) * r, 0, huddle.center.z + Math.sin(ang) * r * 0.8);
}
function lerpAngle(a, b, t) { let d = ((b - a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI; return a + d * t; }

function makeDrone(label, color) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 10), new THREE.MeshStandardMaterial({ color: 0xc77dff, emissive: 0xc77dff, emissiveIntensity: 1.2, roughness: 0.3 })); g.add(body);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.26, 0.03, 8, 24), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.5 })); ring.rotation.x = Math.PI / 2; g.add(ring);
  const rotor = new THREE.Group(); for (const s of [-1, 1]) { const bl = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.01, 0.05), mat(0xffffff)); bl.rotation.y = s * Math.PI / 4; rotor.add(bl); } rotor.position.y = 0.2; g.add(rotor);
  const eye = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.05, 0.02), mat(0x111111)); eye.position.set(0, 0.02, 0.16); g.add(eye);
  const sp = textSprite(label, { size: 36, color: '#c77dff', bg: 'rgba(12,14,30,0.75)' }); sp.position.y = 0.45; sp.scale.set(1.8, 0.3, 1); g.add(sp);
  scene.add(g); return { group: g, rotor, label: sp };
}

// ============================================================ particles
const GLYPHS = '{}<>;=()[]λ01+*#/'.split('');
const glyphPool = [];
function glyphTex(ch, color) {
  const c = document.createElement('canvas'); c.width = 64; c.height = 64; const ctx = c.getContext('2d');
  ctx.font = 'bold 44px ui-monospace, Menlo, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#' + new THREE.Color(color).getHexString(); ctx.fillText(ch, 32, 34);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
const glyphTexCache = new Map();
function spawnGlyph(x, y, z, color) {
  const ch = pick(GLYPHS); const key = ch + color;
  if (!glyphTexCache.has(key)) glyphTexCache.set(key, glyphTex(ch, color));
  let g = glyphPool.find((g) => !g.alive);
  if (!g) { g = { sprite: new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false })), alive: false }; g.sprite.scale.set(0.25, 0.25, 1); scene.add(g.sprite); glyphPool.push(g); if (glyphPool.length > 150) return; }
  g.alive = true; g.life = 0; g.sprite.material.map = glyphTexCache.get(key); g.sprite.material.needsUpdate = true;
  g.sprite.position.set(x, y, z); g.vel = new THREE.Vector3(rand(-0.3, 0.3), rand(1.2, 2.0), rand(-0.3, 0.3)); g.sprite.visible = true;
}
const confetti = [];
function burstConfetti(x, y, z, baseColor) {
  for (let i = 0; i < 40; i++) {
    let c = confetti.find((c) => !c.alive);
    if (!c) { c = { mesh: new THREE.Mesh(new THREE.PlaneGeometry(0.12, 0.08), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, transparent: true })), alive: false }; scene.add(c.mesh); confetti.push(c); if (confetti.length > 260) return; }
    c.alive = true; c.life = 0; c.mesh.visible = true; c.mesh.position.set(x, y, z);
    c.mesh.material.color.set(Math.random() < 0.4 ? baseColor : pick([0xff4d6d, 0xffb020, 0x39d98a, 0x4ea1ff, 0xc77dff, 0xffffff])); c.mesh.material.opacity = 1;
    c.vel = new THREE.Vector3(rand(-2.5, 2.5), rand(2.5, 5.5), rand(-2.5, 2.5)); c.spin = new THREE.Vector3(rand(-8, 8), rand(-8, 8), rand(-8, 8));
  }
}
function updateParticles(dt) {
  for (const g of glyphPool) if (g.alive) { g.life += dt; g.sprite.position.addScaledVector(g.vel, dt); g.sprite.material.opacity = 1 - g.life / 1.3; if (g.life > 1.3) { g.alive = false; g.sprite.visible = false; } }
  for (const c of confetti) if (c.alive) { c.life += dt; c.vel.y -= 7 * dt; c.mesh.position.addScaledVector(c.vel, dt); c.mesh.rotation.x += c.spin.x * dt; c.mesh.rotation.y += c.spin.y * dt; c.mesh.material.opacity = clamp(1.6 - c.life, 0, 1); if (c.life > 1.8 || c.mesh.position.y < 0) { c.alive = false; c.mesh.visible = false; } }
}

// ============================================================ sound
let soundOn = false; let actx = null;
function chime() {
  if (!soundOn) return; actx ??= new (window.AudioContext || window.webkitAudioContext)();
  const t0 = actx.currentTime;
  for (const [f, dt] of [[659.25, 0], [880, 0.12], [1318.5, 0.24]]) {
    const o = actx.createOscillator(); const g = actx.createGain(); o.type = 'sine'; o.frequency.value = f;
    g.gain.setValueAtTime(0, t0 + dt); g.gain.linearRampToValueAtTime(0.18, t0 + dt + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.5);
    o.connect(g).connect(actx.destination); o.start(t0 + dt); o.stop(t0 + dt + 0.6);
  }
}

// ============================================================ HUD
const $ = (s) => document.querySelector(s);
const roster = $('#roster'), dot = $('#dot'), meta = $('#meta'), toastBox = $('#toast'), empty = $('#empty');
function toast(text, { ms = 3300, notice = false, onclick = null, chip = null } = {}) {
  const el = document.createElement('div'); el.className = 'toast' + (notice ? ' notice' : '');
  if (chip) { const c = document.createElement('span'); c.className = 'chip'; c.style.background = deptHex(chip); c.textContent = deptOf(chip).name; el.appendChild(c); }
  const s = document.createElement('span'); s.textContent = text; el.appendChild(s);
  if (onclick) el.onclick = () => { onclick(); el.remove(); };
  toastBox.appendChild(el); setTimeout(() => el.remove(), ms);
}
let followId = null;
// ---------- the conversation with the floor manager ----------
const logPanel = $('#log'), logBody = $('#logBody');
const chatLog = [];
function logChat(m, { show = true } = {}) {
  chatLog.push(m); if (chatLog.length > 200) chatLog.shift();
  const el = document.createElement('div'); el.className = `msg ${m.who}${m.ok === false ? ' bad' : ''}`;
  const who = document.createElement('span'); who.className = 'who'; who.textContent = m.who === 'you' ? 'you' : m.who === 'agent' ? `${m.name} · ${deptOf(m.dept).name} report` : 'floor manager'; el.appendChild(who);
  el.appendChild(document.createTextNode(mdLite(m.text)));
  if (m.images?.length) { const p = document.createElement('div'); p.className = 'pics'; for (const u of m.images) { const im = document.createElement('img'); im.src = u; im.onclick = () => openScreen([{ url: u, kind: 'image', name: u.split('/').pop() }], { name: 'you', dept: null, title: 'your image' }); p.appendChild(im); } el.appendChild(p); }
  logBody.appendChild(el); while (logBody.children.length > 200) logBody.firstChild.remove();
  if (show) logPanel.classList.add('show');
  logBody.scrollTop = logBody.scrollHeight;
}
function mdLite(s) { return String(s || '').replace(/^#{1,6}\s+/gm, '').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').trim(); }
$('#logClose').onclick = () => logPanel.classList.remove('show');
$('#btnLog').onclick = () => { logPanel.classList.toggle('show'); logBody.scrollTop = logBody.scrollHeight; };
// the chat box grows with multi-line drafts, so keep the log sitting just above it instead of under it
const seatLog = () => { logPanel.style.bottom = `${window.innerHeight - $('#chat').getBoundingClientRect().top + 8}px`; };
new ResizeObserver(seatLog).observe($('#chat')); window.addEventListener('resize', seatLog);
// ▾ folds a panel to its title bar; remembered per panel across reloads
function collapsible(panel, btn, key) {
  const set = (on) => { panel.classList.toggle('min', on); try { localStorage.setItem(key, on ? '1' : ''); } catch { /* private window */ } };
  try { panel.classList.toggle('min', localStorage.getItem(key) === '1'); } catch { /* private window */ }
  btn.onclick = (e) => { e.stopPropagation(); set(!panel.classList.contains('min')); };
}
// ---------- the big screen: a screenshot, wireframe or page an agent handed you, full screen until you press esc ----------
const screenEl = $('#screen'); let screen = null; // { items, i, from }
function openScreen(items, from, i = 0) {
  if (!items?.length) return;
  screen = { items, i: Math.max(0, Math.min(i, items.length - 1)), from };
  $('#sChip').style.display = from?.dept ? '' : 'none'; if (from?.dept) { $('#sChip').textContent = deptOf(from.dept).name; $('#sChip').style.background = deptHex(from.dept); }
  $('#sName').textContent = from?.name ? `from ${from.name}` : '';
  screenEl.classList.add('show'); renderScreen();
}
function renderScreen() {
  if (!screen) return;
  const it = screen.items[screen.i]; const body = $('#sBody'); body.innerHTML = '';
  $('#sTitle').textContent = it.name; $('#sOpen').href = it.url;
  if (it.kind === 'html') { const f = document.createElement('iframe'); f.sandbox = 'allow-scripts allow-same-origin'; f.src = it.url; body.appendChild(f); }
  else { const im = document.createElement('img'); im.src = it.url; im.alt = it.name; body.appendChild(im); }
  const many = screen.items.length > 1; $('#sPrev').style.display = $('#sNext').style.display = many ? '' : 'none';
  $('#sDots').innerHTML = many ? screen.items.map((_, j) => `<span class="dot${j === screen.i ? ' on' : ''}" data-j="${j}"></span>`).join('') : '';
}
function closeScreen() { screen = null; screenEl.classList.remove('show'); $('#sBody').innerHTML = ''; }
function stepScreen(d) { if (!screen) return; screen.i = (screen.i + d + screen.items.length) % screen.items.length; renderScreen(); }
$('#sClose').onclick = closeScreen; $('#sPrev').onclick = () => stepScreen(-1); $('#sNext').onclick = () => stepScreen(1);
$('#sDots').onclick = (e) => { if (e.target.dataset.j !== undefined) { screen.i = Number(e.target.dataset.j); renderScreen(); } };
screenEl.addEventListener('click', (e) => { if (e.target === $('#sBody')) closeScreen(); }); // click the dark around it to close
window.__officeSay = (text = 'Here, taking the top corner of the octopus') => { for (const av of avatars.values()) av.speak(text); manager?.say(text); return 'ok'; }; // debug hook: everyone talks at once
window.__officeScreen = (urls) => openScreen((urls || ['/favicon.svg']).map((u) => ({ url: u, kind: /\.html?$/.test(u) ? 'html' : 'image', name: u.split('/').pop() })), { name: 'debug', dept: 'uiux' }); // debug hook
// ---------- the reports inbox ----------
const reportsPanel = $('#reports'), rList = $('#rList'), rBadge = $('#rBadge'), rCount = $('#rCount');
const reportsById = new Map(); let unread = 0;
function reportVisible(project) { const s = effProject(); return !s || !project || project === s; } // reports from before projects existed show everywhere
function applyReportFilter() {
  let shown = 0; for (const el of rList.querySelectorAll('.rep')) { const on = reportVisible(el.dataset.project); el.style.display = on ? '' : 'none'; if (on) shown++; }
  renderBadge(shown);
}
function renderBadge(shown = null) {
  rBadge.textContent = String(unread); rBadge.classList.toggle('show', unread > 0 && !reportsPanel.classList.contains('show'));
  const s = effProject(); const n = shown ?? (s ? [...reportsById.values()].filter((r) => reportVisible(r.project)).length : reportsById.size);
  rCount.textContent = `${n}${s ? ` in ${s}` : ''}${unread ? ` · ${unread} new` : ''}`;
}
function openReports(id = null) {
  reportsPanel.classList.add('show'); $('#help').style.display = 'none';
  if (id !== null) { const el = rList.querySelector(`.rep[data-id="${id}"]`); if (el) { el.classList.add('open'); el.classList.remove('unread'); el.scrollIntoView({ block: 'nearest' }); } }
  unread = 0; renderBadge();
}
function closeReports() { reportsPanel.classList.remove('show'); $('#help').style.display = ''; for (const el of rList.querySelectorAll('.rep.unread')) el.classList.remove('unread'); renderBadge(); }
$('#btnReports').onclick = () => reportsPanel.classList.contains('show') ? closeReports() : openReports();
$('#reportsClose').onclick = closeReports;
function addReportRow(r, fresh) {
  if (reportsById.has(r.id)) return; reportsById.set(r.id, r);
  rList.querySelector('.none')?.remove();
  const el = document.createElement('div'); el.className = 'rep' + (fresh ? ' unread' : ''); el.dataset.id = r.id; el.dataset.project = r.project || '';
  if (r.project) el.style.borderLeftColor = projColor(r.project);
  if (r.project && !reportVisible(r.project)) el.style.display = 'none';
  const body = mdLite(r.text) || mdLite(r.recap) || '(no text in this turn)';
  el.innerHTML = `<div class="rt"><span class="chip" style="background:${deptHex(r.dept)}">${escapeHtml(deptOf(r.dept).name)}</span><b>${escapeHtml(r.name)}</b>${r.project ? `<span class="ago" style="color:${projColor(r.project)}">${escapeHtml(r.project)}</span>` : ''}<span class="ago" data-t="${r.t}">${ago(r.t)} ago</span></div>
    ${r.prompt ? `<div class="rp">↳ ${escapeHtml(r.prompt)}</div>` : ''}${r.issueId ? `<div class="rp">🧵 ${escapeHtml(r.issueId)}${r.asked ? ' · still open' : ' · closed'}${r.branch ? ` · 🌿 ${escapeHtml(r.branch)}` : ''}</div>` : ''}${r.asked ? '<div class="rq">❓ ended with a question for you</div>' : ''}<div class="rb">${escapeHtml(body)}</div>${(r.screens || []).length ? `<div class="shots">${r.screens.map((sc, i) => sc.kind === 'html' ? `<div class="doc" data-i="${i}" title="${escapeHtml(sc.name)}">🖥</div>` : `<img data-i="${i}" src="${sc.url}" alt="${escapeHtml(sc.name)}" />`).join('')}</div>` : ''}${(r.questions || []).length ? `<button type="button" class="ra">📝 answer ${r.questions.length === 1 ? 'the question' : `all ${r.questions.length} questions`}</button>` : ''}`;
  el.onclick = (e) => { if (e.target.classList.contains('ra')) { e.stopPropagation(); openBriefForReport(r); return; } if (e.target.dataset.i !== undefined && e.target.closest('.shots')) { e.stopPropagation(); openScreen(r.screens, r, Number(e.target.dataset.i)); return; } el.classList.toggle('open'); if (el.classList.contains('unread')) { el.classList.remove('unread'); unread = Math.max(0, unread - 1); renderBadge(); } };
  rList.prepend(el); while (rList.children.length > 100) rList.lastChild.remove();
  if (fresh) unread++; renderBadge();
}
setInterval(() => { for (const sp of rList.querySelectorAll('.ago[data-t]')) sp.textContent = `${ago(Number(sp.dataset.t))} ago`; }, 10000);
// An agent hands in a report: it lands on the tray, in the inbox, in the log when it answers you, and you get a notice.
function handInReport(r, av, walked) {
  addSheet(r.dept); addReportRow(r, true);
  if (r.screens?.length) openScreen(r.screens, r); // straight onto the big screen; esc when you're done
  if (walked) burstConfetti(OFFICE.tray.x, 1.4, OFFICE.tray.z, deptOf(r.dept).color);
  const head = mdLite(r.text || r.recap).split('\n').find((l) => l.trim()) || '';
  toast(`${r.name} dropped off a report: ${head}`, { notice: true, chip: r.dept, onclick: () => openReports(r.id) });
  if (r.replyTo) logChat({ who: 'agent', name: r.name, dept: r.dept, text: r.text || r.recap });
  else logChat({ who: 'manager', name: 'floor manager', text: `${r.name} filed a ${deptOf(r.dept).name} report${r.asked ? ' and is waiting on your answer' : ''}. Say "what did ${r.name} say" or open 📋 reports.` }, { show: false });
  pushFeed('report', r.name, `filed a ${deptOf(r.dept).name} report`, r.project || null); drawBoard(lastAgents); chime();
  if ((r.questions || []).length >= 2 && !briefPanel.classList.contains('show')) openBriefForReport(r);
}
// ---------- the brief: a big form when an agent asks a lot at once ----------
// The whole reply on the left, one field per question on the right; every answer goes back to the
// agent's terminal as a single message (or, for an AskUserQuestion form, as one pick per question).
const briefPanel = $('#brief'), bForm = $('#bForm'), bText = $('#bText'), bHint = $('#bHint'), bSend = $('#bSend');
let brief = null; // { agentId, name, kind: 'text' | 'form', questions, ask }
function agentData(id) { return lastAgents.find((a) => a.id === id) || avatars.get(id)?.data || null; }
function openBriefForReport(r) {
  const a = agentData(r.agentId);
  openBrief({ agentId: r.agentId, name: r.name, dept: r.dept, hasTerminal: !!a?.hasTerminal, kind: 'text', text: r.text || r.recap || '', prompt: r.prompt, questions: r.questions || [] });
}
function openBriefForAsk(a, name) {
  const qs = a.ask?.questions || (a.ask ? [a.ask] : []);
  const text = (a.ask.recap ? a.ask.recap + '\n\n' : '') + qs.map((q, i) => `${i + 1}. ${q.header ? `[${q.header}] ` : ''}${q.question}` + (q.options.length ? '\n' + q.options.map((o, j) => `   ${j + 1}) ${o.label}${o.description ? ' — ' + o.description : ''}`).join('\n') : '')).join('\n\n');
  openBrief({ agentId: a.id, name, dept: a.dept, hasTerminal: !!a.hasTerminal, kind: 'form', text, prompt: a.prompt, questions: qs });
}
function openBrief(b) {
  brief = b; const d = deptOf(b.dept);
  $('#bChip').textContent = d.name; $('#bChip').style.background = deptHex(b.dept);
  $('#bTitle').textContent = `${b.name} needs ${b.questions.length === 1 ? 'an answer' : `${b.questions.length} answers`}`;
  $('#bMeta').textContent = b.hasTerminal ? '' : 'desktop session: copy your answers into that window';
  bText.innerHTML = `<div class="lbl">what ${escapeHtml(b.name)} wrote${b.prompt ? ` · about: ${escapeHtml(b.prompt.slice(0, 80))}` : ''}</div>${escapeHtml(mdLite(b.text))}`;
  const fields = b.questions.map((q, i) => {
    if (b.kind === 'form') {
      const opts = q.options.map((o, j) => `<button type="button" data-q="${i}" data-opt="${j + 1}" title="${escapeHtml(o.description)}"><b>${j + 1}</b> ${escapeHtml(o.label)}</button>`).join('');
      return `<div class="q" data-q="${i}">${q.header ? `<div class="qh">${escapeHtml(q.header)}</div>` : ''}<div class="qt"><b>${i + 1}.</b>${escapeHtml(q.question)}</div><div class="opts">${opts}</div><input type="text" data-q="${i}" placeholder="or type your own answer…" /></div>`;
    }
    return `<div class="q" data-q="${i}"><div class="qt"><b>${i + 1}.</b>${escapeHtml(q)}</div><textarea data-q="${i}" rows="2" placeholder="leave empty and ${escapeHtml(b.name)} uses the default"></textarea></div>`;
  });
  bForm.innerHTML = `<div class="lbl">your answers</div>${fields.join('')}${b.kind === 'text' ? `<div class="q"><div class="qt"><b>+</b>anything else</div><textarea data-q="extra" rows="2" placeholder="notes, material, constraints…"></textarea></div>` : ''}`;
  for (const btn of bForm.querySelectorAll('button[data-opt]')) btn.onclick = () => { const q = bForm.querySelector(`.q[data-q="${btn.dataset.q}"]`); for (const x of q.querySelectorAll('button[data-opt]')) x.classList.toggle('sel', x === btn && !btn.classList.contains('sel')); q.querySelector('input').value = ''; };
  for (const inp of bForm.querySelectorAll('input[type=text]')) inp.oninput = () => { if (inp.value) for (const x of inp.closest('.q').querySelectorAll('button[data-opt]')) x.classList.remove('sel'); };
  bHint.textContent = b.kind === 'form' ? 'pick a button or type your own for each question · ⌘⏎ sends' : 'answer what you care about; the rest goes back as "your call" · ⌘⏎ sends';
  bSend.disabled = !b.hasTerminal; briefPanel.classList.add('show'); $('#help').style.display = 'none';
  const first = bForm.querySelector('textarea, input'); if (first) setTimeout(() => first.focus(), 50);
}
function closeBrief() { briefPanel.classList.remove('show'); brief = null; $('#help').style.display = ''; }
async function sendBrief() {
  if (!brief || !brief.hasTerminal) return;
  bSend.disabled = true;
  try {
    if (brief.kind === 'form') {
      const answers = brief.questions.map((q, i) => { const sel = bForm.querySelector(`button[data-q="${i}"].sel`); const text = bForm.querySelector(`input[data-q="${i}"]`).value.trim(); return text ? { text } : { option: sel ? Number(sel.dataset.opt) : 1 }; });
      const r = await api(`/api/agents/${brief.agentId}/answers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answers }) });
      if (!r.ok) throw new Error((await r.json()).message || 'failed');
    } else {
      const lines = brief.questions.map((q, i) => { const v = bForm.querySelector(`textarea[data-q="${i}"]`).value.trim(); return `${i + 1}. ${v || 'your call, go with your default'}`; });
      const extra = bForm.querySelector('textarea[data-q="extra"]').value.trim();
      await sendToAgent(brief.agentId, `Answers to your questions:\n${lines.join('\n')}${extra ? `\n\nAlso: ${extra}` : ''}`, true);
    }
    toast(`answers sent to ${brief.name}`); logChat({ who: 'you', name: 'you', text: `answered ${brief.name}'s ${brief.questions.length} question${brief.questions.length === 1 ? '' : 's'}` }, { show: false });
    const id = brief.agentId; closeBrief(); if (avatars.has(id)) { followId = id; renderRoster(lastAgents); }
  } catch (e) { toast(`could not send: ${e.message}`); bSend.disabled = false; }
}
bSend.onclick = sendBrief; $('#bClose').onclick = closeBrief; $('#bLater').onclick = closeBrief;
briefPanel.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendBrief(); } });
briefPanel.onclick = (e) => { if (e.target === briefPanel) closeBrief(); };
window.__officeBrief = (kind = 'text') => { const a = lastAgents[0]; if (!a) return 'no agent'; if (kind === 'form') openBriefForAsk({ ...a, ask: { kind: 'question', recap: 'Fake recap.', questions: [{ question: 'Which style?', header: 'Style', options: [{ label: 'Watercolor', description: 'soft' }, { label: 'Ukiyo-e', description: 'woodblock' }] }, { question: 'Length?', header: 'Length', options: [{ label: '30s', description: '' }, { label: '60s', description: '' }] }] } }, 'Vera'); else openBriefForReport({ agentId: a.id, name: 'Vera', dept: 'uiux', prompt: 'promo video for the office', text: 'Before I start, a few things:\n\n1. Which product is the promo for? Default: the office itself.\n2. Which style? (default: Watercolor Brush)\n3. Do you have a logo or brand font?\n4. Should I render at 1080p?', questions: ['Which product is the promo for? Default: the office itself.', 'Which style? (default: Watercolor Brush)', 'Do you have a logo or brand font?', 'Should I render at 1080p?'] }); return 'ok'; }; // debug hook
async function loadHistory() {
  try {
    const h = await (await api('/api/history')).json();
    for (const r of h.reports || []) addReportRow(r, false);
    for (const m of h.chat || []) logChat(m, { show: false });
    if (h.issues) { lastIssues = h.issues; beadsOn = !!h.beads; drawTaskBoard(); }
    if (h.skills) deptSkills = h.skills;
    for (const r of (h.reports || []).slice(-TRAY_MAX)) addSheet(r.dept);
  } catch { /* bridge offline */ }
}
// ---------- end-of-play reveal: the camera takes a slow lap around the finished build ----------
const revealSign = textSprite('', { size: 34, color: '#fff', bg: 'rgba(12,14,30,0.8)' }); revealSign.position.set(LEGO.x, 2.6, LEGO.z); revealSign.visible = false; scene.add(revealSign);
let reveal = null; let revealText = '';
function startReveal() {
  if (boardZoom) return; // you're reading a board: don't swing the camera away
  followId = null; renderRoster(lastAgents);
  reveal = { until: Date.now() + 14000, angle: Math.atan2(camera.position.x - LEGO.x, camera.position.z - LEGO.z), nextConfetti: Date.now() + 1200, wasAutoRotate: controls.autoRotate };
  controls.autoRotate = false; revealText = ''; revealSign.visible = true; updateRevealSign();
}
function updateRevealSign() {
  const p = lastPlay; if (!p || !p.players.length) return;
  const text = p.players.map((q) => `${q.name} · ${q.bricks}`).join('    ');
  if (text === revealText) return; revealText = text;
  updateSprite(revealSign, text, { size: 34, color: '#fff', bg: 'rgba(12,14,30,0.8)' });
  revealSign.scale.set(Math.min(6, 0.085 * text.length + 0.6), 0.32, 1);
}
function endReveal() { if (!reveal) return; controls.autoRotate = reveal.wasAutoRotate; reveal = null; revealSign.visible = false; }
controls.addEventListener('start', endReveal); // any drag or scroll hands the camera back
// ---------- board zoom: click a wall board and the camera squares up to it ----------
const BOARD_FILL = 0.5; // share of the screen the board takes, on whichever side runs out first
let boardZoom = null;
function zoomPose(b) {
  const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  let d = Math.max(b.h / (2 * BOARD_FILL * tanHalf), b.w / (2 * BOARD_FILL * tanHalf * camera.aspect));
  if (b.maxDist) d = Math.min(d, b.maxDist);
  const target = (b.anchor || b.mesh).getWorldPosition(new THREE.Vector3());
  return { target, pos: target.clone().addScaledVector(b.normal, d) };
}
function startBoardZoom(b) {
  endReveal(); followId = null; renderRoster(lastAgents);
  boardZoom = { board: b, wasAutoRotate: boardZoom ? boardZoom.wasAutoRotate : controls.autoRotate };
  controls.autoRotate = false; controls.maxPolarAngle = Math.PI / 2; // the board is at eye level: let the camera look straight at it
  controls.minDistance = b.minDist || 4; // a shelf model is small: let the camera get close
}
function endBoardZoom() { if (!boardZoom) return; controls.autoRotate = boardZoom.wasAutoRotate; controls.maxPolarAngle = Math.PI * 0.49; controls.minDistance = 4; boardZoom = null; }
const allBoards = () => [...boards, ...galleryBoards];
// OrbitControls fires 'start' on every pointerdown, clicks included, so a click on the zoomed board could never step back:
// the zoom ends on a real drag (more than 5px with a button down) or a wheel turn instead (see the pointer handlers below).
let rosterSig = '';
function renderRoster(agents) {
  const rows = [];
  for (const a of agents) {
    const av = avatars.get(a.id); if (!av || !inProject(a)) continue;
    const w = av.wants(); const st = w === 'work' ? 'active' : w === 'permission' ? 'permission' : w === 'question' ? 'waiting' : 'idle';
    const tools = Object.values(a.tools); const detail = tools.length ? prettyTool(tools[tools.length - 1].toolName) : st;
    rows.push({ a, av, st, detail });
  }
  const sig = rows.map((r) => `${r.a.id}|${r.av.name()}|${r.st}|${r.detail}|${r.a.dept}|${r.a.project}|${projColor(r.a.project)}|${Object.keys(r.a.subagents || {}).length}|${followId === r.a.id}`).join(';');
  empty.classList.toggle('show', agents.length === 0);
  if (sig === rosterSig) return; rosterSig = sig;
  roster.innerHTML = '';
  for (const { a, av, st, detail } of rows) {
    const row = document.createElement('div'); row.className = 'row' + (followId === a.id ? ' sel' : '');
    if (a.project) { row.style.borderLeftColor = projColor(a.project); row.title = `project: ${a.project}${a.directoryName && a.directoryName !== a.project ? ` (${a.directoryName})` : ''}`; }
    row.innerHTML = `<span class="sw" style="background:#${av.color.getHexString()}"></span><span class="name">${escapeHtml(av.name())}${a.subagents && Object.keys(a.subagents).length ? ` <span style="color:#c77dff">+${Object.keys(a.subagents).length}</span>` : ''}</span><span class="dp" style="color:${deptHex(a.dept)}">${escapeHtml(deptOf(a.dept).name)}</span><span class="st ${st}">${escapeHtml(detail)}</span>`;
    row.onclick = () => { followId = followId === a.id ? null : a.id; renderRoster(lastAgents); };
    roster.appendChild(row);
  }
}
const detail = $('#detail'); const dScreen = $('#dScreen'), dTerm = $('#dTerm'), dReply = $('#dReply'), dInput = $('#dInput');
function ago(t) { const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`; }
collapsible(detail, $('#detailMin'), 'office.min.detail');
$('#detailClose').onclick = () => { followId = null; renderRoster(lastAgents); renderDetail(); };
// click the name in the detail bar to rename the agent; Enter saves, Esc cancels, an empty name goes back to the given one
const dName = $('#dName'); dName.title = 'click to rename';
dName.onclick = () => { if (dName.isContentEditable) return; dName.contentEditable = 'true'; dName.focus(); getSelection().selectAllChildren(dName); };
dName.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); dName.blur(); } else if (e.key === 'Escape') { e.stopPropagation(); dName.dataset.cancel = '1'; dName.blur(); } };
dName.onblur = async () => {
  const cancel = dName.dataset.cancel; delete dName.dataset.cancel; dName.contentEditable = 'false';
  const av = followId !== null ? avatars.get(followId) : null; if (!av) return;
  const name = dName.textContent.trim();
  if (cancel || name === av.name()) { dName.textContent = av.name(); return; }
  try {
    const j = await (await api(`/api/agents/${av.id}/name`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })).json();
    if (j.ok) { av.data.nickname = name || null; dName.textContent = j.name; toast(`renamed to ${j.name}`); } else toast(j.message || 'could not rename');
  } catch { toast('could not rename'); }
};
async function sendToAgent(id, data, enter) {
  const r = await api(`/api/agents/${id}/input`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data, enter }) });
  const j = await r.json(); if (!j.ok) toast(j.message || 'could not send');
}
dReply.onsubmit = (e) => { e.preventDefault(); if (followId === null) return; const v = dInput.value; dInput.value = ''; if (v.trim()) sendToAgent(followId, v, true); };
for (const b of dReply.querySelectorAll('button[data-key]')) b.onclick = () => { if (followId !== null) sendToAgent(followId, JSON.parse(`"${b.dataset.key}"`), false); };
let termPollId = null;
async function pollTerminal() {
  if (followId === null) return;
  const id = followId;
  try {
    const r = await api(`/api/agents/${id}/terminal`); const j = await r.json();
    if (followId !== id) return;
    dTerm.classList.toggle('show', !!j.hasTerminal && j.text !== null); dReply.classList.toggle('show', !!j.hasTerminal);
    if (j.text !== null && dTerm.textContent !== j.text) { const atBottom = dTerm.scrollTop + dTerm.clientHeight >= dTerm.scrollHeight - 8; dTerm.textContent = j.text; if (atBottom) dTerm.scrollTop = dTerm.scrollHeight; }
  } catch { /* bridge offline */ }
}
setInterval(pollTerminal, 1000);
function renderDetail() {
  const av = followId !== null ? avatars.get(followId) : null;
  detail.classList.toggle('show', !!av);
  if (!av) { dTerm.classList.remove('show'); dReply.classList.remove('show'); return; }
  const a = av.data; const w = av.wants();
  const tools = Object.values(a.tools); const cur = tools[tools.length - 1];
  const stClass = w === 'work' ? 'active' : w === 'permission' ? 'permission' : w === 'question' ? 'waiting' : 'idle';
  const nowText = w === 'permission' ? '⚠ needs your approval' : w === 'question' ? '? asked you a question' : cur ? (cur.status || prettyTool(cur.toolName)).replace(/mcp__\S+/g, (m) => prettyTool(m)) : w === 'work' ? 'thinking' : 'idle';
  const frac = a.maxContextTokens ? clamp(a.contextTokens / a.maxContextTokens, 0, 1) : 0;
  const subs = Object.values(a.subagents || {});
  const log = [...(a.log || [])].reverse().map((e) => `<div class="ev ${e.kind}"><span class="t" data-t="${e.t}"></span><span>${escapeHtml(e.text.replace(/mcp__\S+/g, (m) => prettyTool(m)))}</span></div>`).join('') || '<div class="ev"><span class="t"></span><span style="color:var(--dim)">no activity seen yet</span></div>';
  $('#dSw').style.cssText = `width:10px;height:10px;border-radius:3px;background:#${av.color.getHexString()}`; if (!dName.isContentEditable) dName.textContent = av.name();
  const needsYou = w === 'permission' || w === 'question';
  let askHtml = '';
  if (needsYou && a.ask) {
    if (a.ask.kind === 'question') {
      askHtml = `<div class="ask"><div class="askTitle">❓ ${escapeHtml(av.name())} asks:</div><div class="askQ">${escapeHtml(a.ask.question)}</div>
        <div class="askOpts">${a.ask.options.map((o, i) => `<button type="button" data-answer="${i + 1}" title="${escapeHtml(o.description)}"><b>${i + 1}</b> ${escapeHtml(o.label)}</button>`).join('')}
        <button type="button" data-answer="other">✎ other…</button></div>${(a.ask.questions || []).length > 1 ? `<button type="button" class="askAll">📝 answer all ${a.ask.questions.length} questions</button>` : ''}</div>`;
    } else {
      askHtml = `<div class="ask perm"><div class="askTitle">⚠ ${escapeHtml(av.name())} wants to run <b>${escapeHtml(prettyTool(a.ask.tool))}</b></div>
        ${a.desk ? `<div class="askQ" style="color:#ffb020">🛡 at the security desk: ${escapeHtml(a.desk.name)} is checking it against the office policy. You can still answer yourself.</div>` : ''}
        ${a.ask.description ? `<div class="askQ">${escapeHtml(a.ask.description)}</div>` : ''}<pre class="askCode">${escapeHtml(a.ask.summary || '')}</pre>
        <div class="askOpts"><button type="button" data-answer="1" class="yes">✓ allow</button><button type="button" data-answer="2">allow &amp; don't ask again</button><button type="button" data-answer="esc" class="no">✕ deny</button></div></div>`;
    }
  } else if (needsYou) {
    askHtml = `<div class="ask"><div class="askTitle">⚠ ${escapeHtml(av.name())} is waiting on you</div><div class="askQ">${a.hasTerminal ? 'Reading the prompt from the transcript… if nothing shows up in a few seconds, they are just idle at the prompt.' : 'This is a desktop-app session: answer it in that window.'}</div></div>`;
  }
  const html = askHtml + `
      <div class="now ${stClass}${w === 'work' ? ' cursor' : ''}">${escapeHtml(nowText)} </div>
      <div class="kv">
        <span>job</span><b><select class="deptSel" title="${escapeHtml(a.deptReason || '')}">${DEPT_ORDER.map((k) => `<option value="${k}"${k === (a.dept || 'engineering') ? ' selected' : ''}>${escapeHtml(DEPTS[k].name)}</option>`).join('')}</select>${a.deptReason ? ` <span style="color:var(--dim)">· ${escapeHtml(a.deptReason.slice(0, 40))}</span>` : ''}</b>
        ${(deptSkills[a.dept] || []).length ? `<span>skills</span><b>${(deptSkills[a.dept] || []).map((k) => `<span title="${escapeHtml(k.what)}">/${escapeHtml(k.skill)}</span>`).join(' · ')}</b>` : ''}
        <span>project</span><b>${a.project ? `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${projColor(a.project)};margin-right:5px"></span>${escapeHtml(a.project)}` : '—'}</b>
        <span>folder</span><b>${escapeHtml(a.directoryName || '—')}</b>
        <span>session</span><b>#${a.id}${a.hasTerminal ? ' · terminal' : a.isExternal ? ' · desktop app' : ''}${a.teamName ? ' · team ' + escapeHtml(a.teamName) : ''}</b>
        <span>context</span><b>${a.maxContextTokens ? `${Math.round(a.contextTokens / 1000)}k / ${Math.round(a.maxContextTokens / 1000)}k` : '—'}</b>
      </div>
      ${a.maxContextTokens ? `<div class="ctx"><i style="width:${frac * 100}%;background:${frac < 0.6 ? 'var(--ok)' : frac < 0.85 ? 'var(--warn)' : 'var(--bad)'}"></i></div>` : ''}
      ${subs.length ? `<div class="kv"><span>sub-agents</span><b>${subs.map((s) => escapeHtml(s.toolName + (s.tool ? ' · ' + s.tool : ''))).join('<br>')}</b></div>` : ''}
      <div class="log">${log}</div>`;
  // only touch the DOM when the content changed, so buttons stay clickable; times update in place
  const key = `${a.id}|${html}`;
  for (const sp of dScreen.querySelectorAll('.t[data-t]')) sp.textContent = `${ago(Number(sp.dataset.t))} ago`;
  if (dScreen.dataset.key === key) return;
  dScreen.dataset.key = key; dScreen.innerHTML = html;
  for (const sp of dScreen.querySelectorAll('.t[data-t]')) sp.textContent = `${ago(Number(sp.dataset.t))} ago`;
  const all = dScreen.querySelector('.askAll'); if (all) all.onclick = () => openBriefForAsk(a, av.name());
  const sel = dScreen.querySelector('.deptSel'); if (sel) sel.onchange = () => api(`/api/agents/${a.id}/dept`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dept: sel.value }) }).catch(() => toast('could not move them'));
  for (const b of dScreen.querySelectorAll('button[data-answer]')) b.onclick = () => {
    const v = b.dataset.answer;
    if (!a.hasTerminal) { toast('that session is in the desktop app: answer it there'); return; }
    if (v === 'esc') sendToAgent(a.id, '\u001b', false);
    else if (v === 'other') { dInput.focus(); dInput.placeholder = 'type your answer and press enter'; }
    else sendToAgent(a.id, v, true);
    b.disabled = true;
  };
}
setInterval(renderDetail, 1000);
const playPanel = $('#play'), pTitle = $('#pTitle'), pClock = $('#pClock'), pPlayers = $('#pPlayers'), pChat = $('#pChat');
collapsible(playPanel, $('#playMin'), 'office.min.play');
let playSig = '';
function renderPlay() {
  const p = lastPlay;
  const has = !!(p && (p.active || p.brickCount));
  playPanel.classList.toggle('show', has); legoSign.visible = has; playTable.visible = has;
  $('#btnPlay').classList.toggle('on', !!p?.active); $('#btnPlay').textContent = p?.active ? '🧱 stop' : '🧱 play';
  if (!has) return;
  const left = Math.max(0, p.endsAt - Date.now());
  const clockText = p.active ? `${Math.floor(left / 60000)}:${String(Math.floor(left / 1000) % 60).padStart(2, '0')} left · ${p.brickCount} bricks` : `${p.brickCount} bricks`;
  pClock.textContent = clockText;
  const title = p.title ? `“${p.title}”` : p.theme ? p.theme : p.active ? 'something unique…' : 'untitled';
  updateSprite(legoSign, (p.active ? '🧱 ' : '🏆 ') + title.slice(0, 34), { size: 46, color: '#fff', bg: p.active ? 'rgba(35,120,65,0.85)' : 'rgba(219,172,52,0.9)' });
  const sig = JSON.stringify([p.active, p.title, p.theme, p.players, p.chat.at(-1)?.seq]);
  if (sig === playSig) return; playSig = sig;
  pTitle.textContent = `🧱 ${p.active ? 'Playtime' : 'Last build'}: ${title}`;
  const swatch = (id) => '#' + (avatars.get(id)?.color.getHexString() || '8b92b8');
  pPlayers.innerHTML = p.players.map((q) => `<span><i style="background:${swatch(q.id)}"></i>${escapeHtml(q.name)}${q.host ? ' ★' : ''} · ${q.bricks}${q.done ? ' ✓' : ''}</span>`).join('');
  const atBottom = pChat.scrollTop + pChat.clientHeight >= pChat.scrollHeight - 8;
  pChat.innerHTML = p.chat.map((e) => e.kind === 'system'
    ? `<div class="system">${escapeHtml(e.text)}</div>`
    : `<div class="${e.kind}"><span class="who" style="color:${swatch(e.from)}">${escapeHtml(e.name)}</span>${e.kind === 'say' ? ': ' : ' '}${escapeHtml(e.text)}</div>`).join('');
  if (atBottom) pChat.scrollTop = pChat.scrollHeight;
}
setInterval(renderPlay, 1000);
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
// ---------- project tabs ----------
const projectsEl = $('#projects'); let projectsSig = '';
function hexRgba(hex, a) { const n = parseInt(String(hex).replace('#', ''), 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; }
function selectProject(name) {
  selProject = name; try { if (name) localStorage.setItem('office.project', name); else localStorage.removeItem('office.project'); } catch { /* private window */ }
  renderProjects(); renderRoster(lastAgents); drawBoard(lastAgents); drawYourScreen(true); applyReportFilter(); projBoard = null; drawTaskBoard(true); refreshProjBoard(true);
  const p = projectOf(name); toast(p ? `${p.name}: ${p.agents} agent${p.agents === 1 ? '' : 's'}${p.root ? ` · ${p.root.replace(/^\/Users\/[^/]+/, '~')}` : ''}` : 'all projects');
}
function renderProjects() {
  const sel = effProject(); const total = lastAgents.filter((a) => !a.parentAgentId).length;
  const sig = JSON.stringify([sel, total, connected, lastProjects.map((p) => [p.name, p.color, p.agents, p.waiting, p.about])]); if (sig === projectsSig) return; projectsSig = sig;
  projectsEl.classList.toggle('show', connected); projectsEl.innerHTML = '';
  const tab = (name, color, count, need, on, title) => {
    const b = document.createElement('button'); b.className = 'ptab' + (on ? ' on' : ''); b.type = 'button'; b.title = title;
    if (color) { b.style.setProperty('--pc', color); if (on) b.style.background = hexRgba(color, 0.22); }
    b.innerHTML = `${color ? '<i></i>' : ''}${escapeHtml(name)} <em>${count}</em>${need ? '<b class="need" title="someone here needs you"></b>' : ''}`;
    b.onclick = () => selectProject(name === 'All' && !color ? null : name); projectsEl.appendChild(b);
  };
  tab('All', null, total, false, !sel, 'every project on the floor');
  for (const p of lastProjects) tab(p.name, p.color, p.agents, p.waiting > 0, sel === p.name, `${p.root || p.name}\n${p.working} working · ${p.waiting} waiting on you · ${p.idle} idle${p.beads ? ' · beads' : ''}${p.about ? `\n\n${p.about}` : ''}`);
  const add = document.createElement('button'); add.className = 'ptab add'; add.type = 'button'; add.textContent = '+'; add.title = 'start a new project: a folder (name under Downloads, Documents, Desktop… or a full path), optionally "folder: first task"';
  add.onclick = openProjectBox; projectsEl.appendChild(add);
}
// the + tab: a folder, what Daniel is building there, and an optional first task. The bridge remembers the
// description per folder and hands it to every agent in that project; the new tab is selected once it appears.
let pendingProject = null; // basename of the folder we just launched into
const npPanel = $('#newproj'), npFolder = $('#npFolder'), npAbout = $('#npAbout'), npTask = $('#npTask'), npStart = $('#npStart'), npHint = $('#npHint');
function openProjectBox() { npPanel.classList.add('show'); npStart.disabled = false; npHint.textContent = '⌘⏎ starts · esc closes'; setTimeout(() => npFolder.focus(), 30); }
function closeProjectBox() { npPanel.classList.remove('show'); }
$('#npClose').onclick = closeProjectBox; $('#npCancel').onclick = closeProjectBox; npStart.onclick = () => addProject();
npPanel.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeProjectBox(); } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || e.target.tagName === 'INPUT')) { e.preventDefault(); addProject(); } });
async function addProject() {
  const folder = npFolder.value.trim(), about = npAbout.value.trim(), task = npTask.value.trim();
  if (!folder) { npFolder.focus(); return; }
  npStart.disabled = true; npHint.textContent = 'finding the folder…';
  try {
    const j = await (await api('/api/projects/about', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder, about }) })).json();
    if (!j.ok) { npHint.textContent = j.message || 'could not find that folder'; npStart.disabled = false; npFolder.focus(); return; }
    pendingProject = j.name; closeProjectBox(); npFolder.value = ''; npAbout.value = ''; npTask.value = '';
    manager.say('On it!', { ms: 3000 }); manager.jumpV = 2.4;
    const r = await api('/api/manager', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: `new agent in ${j.root}${task ? `: ${task}` : ''}`, images: [], project: null }) });
    const m = await r.json(); if (!m.ok) { pendingProject = null; toast(m.message || 'could not start that project'); }
    else toast(`starting ${j.name}${about ? ' (description saved)' : ''}…`);
  } catch { npHint.textContent = 'bridge offline — run `npm start`'; npStart.disabled = false; }
}
$('#btnOrbit').onclick = (e) => { controls.autoRotate = !controls.autoRotate; e.target.classList.toggle('on', controls.autoRotate); };
$('#btnSound').onclick = (e) => { soundOn = !soundOn; e.target.classList.toggle('on', soundOn); if (soundOn) chime(); };
$('#btnNight').onclick = (e) => { nightTarget = nightTarget ? 0 : 1; e.target.textContent = nightTarget ? 'night' : 'day'; e.target.classList.toggle('on', !!nightTarget); };
$('#btnNight').classList.add('on');
$('#btnReset').onclick = () => { endReveal(); endBoardZoom(); followId = null; camera.position.copy(HOME); controls.target.copy(HOME_TARGET); renderRoster(lastAgents); };
$('#btnOverview').onclick = () => { endReveal(); endBoardZoom(); followId = null; camera.position.copy(OVERVIEW); controls.target.copy(OVERVIEW_TARGET); renderRoster(lastAgents); };
addEventListener('keydown', (e) => {
  if (screen) { if (e.key === 'Escape') closeScreen(); else if (e.key === 'ArrowLeft') stepScreen(-1); else if (e.key === 'ArrowRight') stepScreen(1); return; }
  if (e.key === 'Escape') { if (briefPanel.classList.contains('show')) { closeBrief(); return; } endReveal(); endBoardZoom(); followId = null; renderRoster(lastAgents); } });
// click to follow
const ray = new THREE.Raycaster(); const mouse = new THREE.Vector2(); let downAt = null;
renderer.domElement.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('pointermove', (e) => { if (boardZoom && e.buttons && downAt && Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) endBoardZoom(); }); // a drag hands the camera back
renderer.domElement.addEventListener('wheel', () => endBoardZoom(), { passive: true });
let hoverAt = 0;
renderer.domElement.addEventListener('pointermove', (e) => {
  if (e.buttons || performance.now() - hoverAt < 80) return; hoverAt = performance.now();
  mouse.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1); ray.setFromCamera(mouse, camera);
  renderer.domElement.style.cursor = ray.intersectObjects([...binParts, ...allBoards().map((b) => b.mesh)], true).length ? 'pointer' : '';
});
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
  scene.updateMatrixWorld(); // characters move every frame; pick against where they are now
  mouse.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1); ray.setFromCamera(mouse, camera);
  if (yourScreen) { // a row on your desk screen jumps to that agent, with its answer buttons open
    const h = ray.intersectObject(yourScreen.mesh)[0];
    if (h && h.uv) { const y = (1 - h.uv.y) * yourScreen.canvas.height; const row = yourScreen.rows.find((r) => y >= r.y0 && y <= r.y1); if (row && avatars.has(row.id)) { endReveal(); followId = row.id; renderRoster(lastAgents); renderDetail(); } return; }
  }
  if (trayHit && ray.intersectObject(trayHit).length) { openReports(); return; } // the report tray opens the inbox
  const hits = ray.intersectObjects([...avatars.values()].map((a) => a.group), true);
  const hit = hits.find((h) => { let o = h.object; while (o && o.userData.avatarId === undefined) o = o.parent; return o; });
  const binHit = ray.intersectObjects(binParts, true)[0];
  if (binHit && (!hit || binHit.distance < hit.distance)) { reportsPanel.classList.contains('show') ? closeReports() : openReports(); return; }
  const boardHit = ray.intersectObjects(allBoards().map((b) => b.mesh))[0];
  if (boardHit && (!hit || boardHit.distance < hit.distance)) { const b = allBoards().find((x) => x.mesh === boardHit.object); boardZoom?.board === b ? endBoardZoom() : startBoardZoom(b); return; } // click again to step back
  if (hit) { let o = hit.object; while (o && o.userData.avatarId === undefined) o = o.parent; endReveal(); endBoardZoom(); followId = followId === o.userData.avatarId ? null : o.userData.avatarId; renderRoster(lastAgents); renderDetail(); }
});

// ============================================================ data feed
const avatars = new Map(); let lastAgents = []; let connected = false; let lastPlay = null;
function applyState(s) {
  lastAgents = s.agents; connected = s.upstream.connected; lastPlay = s.play || null; lastIssues = s.issues || []; beadsOn = !!s.beads; lastQueue = s.queue || null; lastProjects = s.projects || []; homeProject = s.home || homeProject; drawTaskBoard();
  dot.classList.toggle('on', connected);
  meta.textContent = connected ? `${s.agents.length} agent${s.agents.length === 1 ? '' : 's'} · pixel-agents :${s.upstream.port}` : (s.upstream.port ? `reconnecting to :${s.upstream.port}…` : 'no pixel-agents server found');
  const seen = new Set();
  for (const a of s.agents) {
    seen.add(a.id);
    let av = avatars.get(a.id);
    if (!av) { av = new Avatar(a); avatars.set(a.id, av); }
    else { av.data = a; av.decide(); }
  }
  for (const [id, av] of avatars) if (!seen.has(id)) { av.dispose(); avatars.delete(id); }
  if (!feed.length) { // seed the wall feed from the agents' recent history
    const all = [];
    for (const a of s.agents) for (const e of a.log || []) all.push({ t: e.t, kind: e.kind === 'tool' ? 'tool' : e.kind === 'turn' ? 'turnEnd' : e.kind, name: avatars.get(a.id)?.name() || `agent ${a.id}`, text: e.text.replace(/mcp__\S+/g, (m) => prettyTool(m)), project: a.project || null });
    all.sort((p, q) => p.t - q.t); for (const e of all.slice(-40)) feed.push(e);
  }
  renderProjects();
  if (pendingProject && lastProjects.some((p) => p.name === pendingProject)) { const n = pendingProject; pendingProject = null; selectProject(n); }
  renderRoster(s.agents); renderDetail(); drawBoard(s.agents); renderPlay();
}
window.__officeFx = (f) => applyFx(f); // debug hook: replay an event from the console
window.__officeState = (s) => { applyState({ upstream: { connected: true, port: 0 }, agents: [], ...s }); return lastAgents.length; }; // debug hook: feed a fake state snapshot
window.__officeFake = (id, kind) => { const av = avatars.get(id); if (!av) return 'no agent'; av.data.permission = kind === 'permission'; av.data.awaitingInput = kind === 'question'; av.data.ask = kind === 'question' ? { kind: 'question', question: 'Fake: which option should I take for the fake test?' } : kind === 'permission' ? { kind: 'permission', tool: 'Bash', summary: 'rm -rf build' } : null; av.decide(); drawYourScreen(true); return 'ok'; }; // debug hook
window.__officeRowPixel = (i) => { const r = yourScreen?.rows[i]; if (!r) return null; const c = yourScreen.canvas; const v = 1 - ((r.y0 + r.y1) / 2) / c.height; const p = new THREE.Vector3(0, (v - 0.5) * 0.7, 0); yourScreen.mesh.localToWorld(p).project(camera); return [(p.x + 1) / 2 * innerWidth, (1 - p.y) / 2 * innerHeight]; }; // debug hook
window.__officePick = (x, y, id) => { mouse.set((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1); ray.setFromCamera(mouse, camera); const av = ray.intersectObjects([...avatars.values()].map((a) => a.group), true)[0]; const one = id !== undefined && avatars.get(id) ? ray.intersectObject(avatars.get(id).group, true).length : -1; const wp = id !== undefined && avatars.get(id) ? avatars.get(id).group.getWorldPosition(new THREE.Vector3()).toArray().map((v) => +v.toFixed(2)) : null; return { one, wp, origin: ray.ray.origin.toArray().map((v) => +v.toFixed(2)), dir: ray.ray.direction.toArray().map((v) => +v.toFixed(3)), near: ray.near, far: ray.far, layers: ray.layers.mask, size: [innerWidth, innerHeight, renderer.domElement.clientWidth, renderer.domElement.clientHeight], yourScreen: !!(yourScreen && ray.intersectObject(yourScreen.mesh)[0]), tray: !!(trayHit && ray.intersectObject(trayHit).length), avatar: av ? { dist: +av.distance.toFixed(2), obj: av.object.type, geom: av.object.geometry?.type } : null, bin: !!ray.intersectObjects(binParts, true)[0], board: !!ray.intersectObjects(boards.map((b) => b.mesh))[0] }; }; // debug hook
window.__officeInternals = () => ({ THREE, camera, scene, avatars, ray, controls, renderer }); // debug hook
window.__officeProject = (id) => { const av = avatars.get(id); if (!av) return null; const p = av.group.position.clone(); p.y += 1.2; p.project(camera); return [(p.x + 1) / 2 * innerWidth, (1 - p.y) / 2 * innerHeight]; }; // debug hook: CSS pixel of an avatar's chest
window.__officeProjectPick = (name) => { selectProject(name || null); return effProject(); }; // debug hook: switch tabs from the console
window.__officeProjects = (list) => { lastProjects = list; lastAgents = lastAgents.map((a) => ({ ...a })); renderProjects(); return lastProjects; }; // debug hook: fake the projects list
window.__officeCam = (p, t) => { endReveal(); followId = null; camera.position.set(...p); controls.target.set(...t); }; // debug hook: place the camera
window.__officeDebug = () => ({ gallery: { builds: galleryBuilds.length, slots: GAL_SLOTS.length, counts: [galBrickIM.count, galRoundIM.count, galSlopeIM.count, galStudIM.count], slot0: GAL_SLOTS[0].pos.toArray(), plate0: galPlates[0]?.position.toArray(), hit0: galHits[0]?.position.toArray(), titles: galleryBuilds.map(galleryTitle), hits: galHits.length, zoom: boardZoom?.board?.build ? galleryTitle(boardZoom.board.build) : boardZoom?.board?.sign ? 'sign' : null, minDist: controls.minDistance }, project: effProject(), projectRoot: selRoot(), projects: lastProjects.map((p) => ({ name: p.name, agents: p.agents, waiting: p.waiting, color: p.color, root: p.root })), board: projBoard ? { name: projBoard.name, issues: projBoard.issues.length, beads: projBoard.beads } : 'home', ghosts: [...avatars.values()].filter((a) => a.ghost).map((a) => a.id), huddle: huddle ? { i: huddle.i, members: [...huddle.slots.keys()] } : null, manager: manager ? { huddling: manager.huddling, bubble: manager.bubble.visible, pos: manager.pos.toArray().map((v) => +v.toFixed(1)), path: manager.path.length, task: !!manager.task } : null, issues: lastIssues.length, beads: beadsOn, reveal: reveal ? { msLeft: reveal.until - Date.now(), angle: reveal.angle } : null, cam: camera.position.toArray().map((v) => +v.toFixed(2)), target: controls.target.toArray().map((v) => +v.toFixed(2)), followId, avatars: [...avatars.values()].map((a) => ({ id: a.id, name: a.name(), mode: a.mode, dept: a.dept(), desk: a.desk.dept, pending: a.pendingReports.length, pos: a.pos.toArray().map((v) => +v.toFixed(1)), path: a.path.length })) });
function applyFx(f) {
  const av = avatars.get(f.id); const name = av ? av.name() : `agent ${f.id}`; const proj = av?.data.project || null;
  if (f.kind === 'toolStart') { toolStats.push({ t: Date.now(), kind: toolKind(f.toolName) }); pushFeed('tool', name, (f.status || prettyTool(f.toolName)).replace(/mcp__\S+/g, (m) => prettyTool(m)), proj); }
  else if (f.kind === 'turnEnd') pushFeed('turnEnd', name, f.asked ? 'asked you a question' : 'finished its turn', proj);
  else if (f.kind === 'permission') pushFeed('permission', name, 'needs your approval', proj);
  else if (f.kind === 'agentCreated') pushFeed('agentCreated', name, 'joined the office', proj);
  else if (f.kind === 'agentClosed') pushFeed('agentClosed', name, 'left', proj);
  else if (f.kind === 'subagentStart') pushFeed('subagentStart', name, 'spawned a sub-agent', proj);
  if (f.kind !== 'toolDone') drawBoard(lastAgents);
  if (f.kind === 'issues') { pushFeed('manager', 'task board', `${f.count} open task${f.count === 1 ? '' : 's'}`); drawBoard(lastAgents); return; }
  if (f.kind === 'dept') { if (av) { av.decide(); pushFeed('dept', name, `→ ${deptOf(f.dept).name}`, proj); } return; }
  if (f.kind === 'report') { if (f.report) { if (av) av.file(f.report); else handInReport(f.report, null, false); } return; }
  if (f.kind === 'managerSay') {
    logChat({ who: 'you', name: 'you', text: f.text, images: f.images || [] }); logChat({ who: 'manager', name: 'floor manager', text: f.message, ok: f.ok });
    manager.task = { targetId: f.id, pendingTarget: null, text: f.action === 'move' ? f.message : f.text, phase: 'walk', until: 0, pending: !!f.pending };
    if (f.action === 'answer') { manager.task = null; manager.say(f.message.split('\n')[0], { ms: 8000 }); manager.jumpV = 1.6; }
    else if (manager.huddling) { manager.task = null; if (f.action !== 'queue') manager.say(f.message.split('\n')[0], { ms: 6000 }); } // stay in the huddle; the parts go out from here
    else if (f.action === 'queue') { if (avatars.has(f.id)) manager.walkTo(f.id); else manager.task = null; manager.say(f.message.replace(/^(Queue|Plan): /, ''), { ms: 9000 }); }
    else if (f.id !== null && f.id !== undefined && avatars.has(f.id)) manager.walkTo(f.id);
    else if (f.action === 'launch' || f.action === 'handoff' || f.action === 'plan') { manager.say(f.message.split('\n')[0], { ms: 20000 }); }
    else if (f.action === 'play' && f.ok) manager.walkToTable();
    else { manager.task = null; manager.say(f.message, { color: '#fff', bg: 'rgba(255,77,109,0.95)', ms: 9000 }); }
    if (f.action !== 'answer') toast(f.message.split('\n')[0]);
    pushFeed('manager', 'floor manager', f.message.split('\n')[0]); drawBoard(lastAgents); return;
  }
  if (f.kind === 'legoSay') { if (av) av.speak(f.text); pushFeed('lego', name, f.text); return; }
  if (f.kind === 'legoEnd') {
    if (f.bricks) startReveal();
    for (let i = 0; i < 3; i++) setTimeout(() => burstConfetti(LEGO.x + rand(-1, 1), 1.8, LEGO.z + rand(-1, 1), 0xf2cd37), i * 250);
    const what = f.title ? `“${f.title}”` : f.theme || 'their build';
    manager.say(`Playtime's over! They built ${what}`, { color: '#fff', bg: 'rgba(35,120,65,0.95)', ms: 9000 }); manager.jumpV = 2.4; chime();
    toast(`Playtime's over (${f.reason}): ${what}, ${f.bricks} bricks`); pushFeed('manager', 'floor manager', `playtime over: ${what}`); return;
  }
  if (f.kind === 'legoShelved') {
    const p = gallerySlotWorld(0); for (let i = 0; i < 2; i++) setTimeout(() => burstConfetti(p.x, p.y + 0.6, p.z, 0xdbac34), i * 300);
    manager.say(`“${f.title}” is in the gallery now`, { color: '#111', bg: 'rgba(219,172,52,0.95)', ms: 7000 }); chime();
    toast(`“${f.title}” went to the gallery shelf (${f.total} on display)`); pushFeed('manager', 'floor manager', `shelved “${f.title}” in the gallery`); drawBoard(lastAgents); return;
  }
  if (f.kind === 'managerTarget') { if (manager.task) { manager.task.pendingTarget = f.id; manager.task.phase = 'walk'; } return; }
  if (f.kind === 'huddle') {
    manager.startHuddle(f); chime();
    logChat({ who: 'manager', name: 'floor manager', text: f.message, ok: true });
    toast(`${f.planner}'s plan: ${f.parts.length} parts. Everyone to the huddle.`); pushFeed('manager', 'floor manager', `huddle: ${f.planner}'s plan, ${f.parts.length} parts`); drawBoard(lastAgents); return;
  }
  if (f.kind === 'managerDone') {
    const until = Date.now() + 5000;
    if (manager.task && !manager.huddling) { manager.task.phase = 'done'; manager.task.until = until; }
    manager.say(f.message, f.ok ? { color: '#fff', bg: 'rgba(57,217,138,0.95)', ms: 5000 } : { color: '#fff', bg: 'rgba(255,77,109,0.95)', ms: 8000 });
    if (f.ok && avatars.has(f.id)) { const av = avatars.get(f.id); av.jumpV = 2.5; burstConfetti(av.pos.x, 2, av.pos.z, av.color.getHex()); }
    logChat({ who: 'manager', name: 'floor manager', text: f.message, ok: f.ok });
    toast(f.message); pushFeed('manager', 'floor manager', f.message); drawBoard(lastAgents); return;
  }
  switch (f.kind) {
    case 'turnEnd': if (av) { burstConfetti(av.pos.x, 2.0, av.pos.z, av.color.getHex()); av.jumpV = 3.2; } chime(); toast(`${name} finished its turn`); break;
    case 'permission': toast(`${name} needs your approval`); break;
    case 'agentCreated': toast(`${name} joined the office`); break;
    case 'agentClosed': toast(`${name} left`); break;
    case 'subagentStart': toast(`${name} spawned a sub-agent`); break;
    default: break;
  }
}
// ---------- the prompt: a box that grows, Enter sends, images ride along ----------
const chatInput = $('#chatInput'); const attachEl = $('#attach'); const attachments = []; // { file, url (data), uploaded: '/screens/..' | null, el }
function growInput() { chatInput.style.height = 'auto'; chatInput.style.height = Math.min(chatInput.scrollHeight, innerHeight * 0.42) + 'px'; }
chatInput.addEventListener('input', growInput);
chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#chat').requestSubmit(); } });
function addAttachment(file) {
  if (!file || !/^image\//.test(file.type) || attachments.length >= 10) return;
  const rd = new FileReader();
  rd.onload = () => {
    const at = { file, data: rd.result, uploaded: null, el: document.createElement('div') };
    at.el.className = 'th up'; at.el.innerHTML = `<img alt="" /><span class="x" title="remove">✕</span>`; at.el.querySelector('img').src = at.data;
    at.el.querySelector('.x').onclick = () => { attachments.splice(attachments.indexOf(at), 1); at.el.remove(); attachEl.classList.toggle('has', attachments.length > 0); };
    attachments.push(at); attachEl.appendChild(at.el); attachEl.classList.add('has');
    api('/api/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: file.name, data: at.data }) }).then((r) => r.json())
      .then((j) => { if (j.ok) { at.uploaded = j.url; at.el.classList.remove('up'); } else { toast(j.message || 'upload failed'); at.el.querySelector('.x').click(); } })
      .catch(() => { toast('upload failed — bridge offline?'); at.el.querySelector('.x').click(); });
  };
  rd.readAsDataURL(file);
}
$('#btnFile').onclick = () => $('#chatFile').click();
$('#chatFile').onchange = (e) => { for (const f of e.target.files) addAttachment(f); e.target.value = ''; };
chatInput.addEventListener('paste', (e) => { const files = [...(e.clipboardData?.files || [])].filter((f) => /^image\//.test(f.type)); if (files.length) { e.preventDefault(); files.forEach(addAttachment); } });
for (const ev of ['dragenter', 'dragover']) $('#chat').addEventListener(ev, (e) => { e.preventDefault(); $('#chat').classList.add('drop'); });
for (const ev of ['dragleave', 'drop']) $('#chat').addEventListener(ev, (e) => { e.preventDefault(); $('#chat').classList.remove('drop'); if (e.type === 'drop') for (const f of e.dataTransfer.files) addAttachment(f); });
$('#chat').onsubmit = (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text && !attachments.length) return;
  if (attachments.some((a) => !a.uploaded)) { toast('still uploading your image…'); return; }
  const images = attachments.map((a) => a.uploaded);
  chatInput.value = ''; growInput(); attachments.length = 0; attachEl.innerHTML = ''; attachEl.classList.remove('has');
  if (!images.length && /^(?:open|show|see)\s+(?:the\s+)?(?:reports?|inbox)$/i.test(text)) { openReports(); return; }
  if (!images.length && /^(?:close|hide)\s+(?:the\s+)?(?:reports?|inbox)$/i.test(text)) { closeReports(); return; }
  askManager(text, images);
};
$('#btnPlay').onclick = () => askManager(lastPlay?.active ? 'stop playing' : 'play');

// ---------- the voice of god: you speak, the floor hears it from above ----------
let godVoice = null; // { listening: bool, until: ms } while the office is trembling
const godEl = $('#god'); const micBtn = $('#btnMic');
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition; let rec = null; let listening = false;
function godStart(listeningNow, text) {
  godVoice = { listening: listeningNow, until: Infinity };
  godEl.textContent = text || '…'; godEl.classList.add('show');
  micBtn.classList.toggle('listening', listeningNow); micBtn.classList.toggle('speaking', !listeningNow);
  if (!listeningNow) rumble(); // thunder under his words
}
function godEnd() { godVoice = null; godEl.classList.remove('show'); micBtn.classList.remove('listening', 'speaking'); }
let godTimer = 0;
function voiceOfGod(text, { send = true } = {}) { // hold the floor in awe for a beat, then hand the words to the manager
  if (!text) return;
  clearTimeout(godTimer);
  godStart(false, text);
  if (send) askManager(text);
  godTimer = setTimeout(godEnd, 1200 + Math.min(text.length, 160) * 45); // long enough to read the words off the sky
}
function rumble() { // a low thunder bed while he speaks
  if (!soundOn) return; actx ??= new (window.AudioContext || window.webkitAudioContext)();
  const t0 = actx.currentTime; const o = actx.createOscillator(); const g = actx.createGain(); const lfo = actx.createOscillator(); const lg = actx.createGain();
  o.type = 'sawtooth'; o.frequency.value = 38; lfo.frequency.value = 6; lg.gain.value = 10; lfo.connect(lg).connect(o.frequency);
  g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(0.12, t0 + 0.4); g.gain.linearRampToValueAtTime(0.0001, t0 + 3.5);
  o.connect(g).connect(actx.destination); o.start(t0); lfo.start(t0); o.stop(t0 + 3.6); lfo.stop(t0 + 3.6);
}
function stopListening() { listening = false; try { rec?.stop(); } catch {} }
micBtn.onclick = () => {
  if (listening) { stopListening(); return; }
  if (!SpeechRec) { toast('this browser has no speech recognition — try Chrome or Safari'); return; }
  rec = new SpeechRec(); rec.lang = navigator.language || 'en-US'; rec.interimResults = true; rec.continuous = false;
  const input = $('#chatInput'); let finalText = '';
  rec.onstart = () => { listening = true; godStart(true, 'listen…'); };
  rec.onresult = (ev) => {
    let interim = ''; for (let i = ev.resultIndex; i < ev.results.length; i++) { const r = ev.results[i]; if (r.isFinal) finalText += r[0].transcript; else interim += r[0].transcript; }
    const shown = (finalText + ' ' + interim).trim(); input.value = shown; godEl.textContent = shown || '…';
  };
  rec.onerror = (ev) => { listening = false; godEnd(); if (ev.error !== 'aborted' && ev.error !== 'no-speech') toast(`microphone: ${ev.error}`); else if (ev.error === 'no-speech') toast('heard nothing'); };
  rec.onend = () => {
    listening = false;
    const text = (finalText || input.value).trim();
    if (!text) { godEnd(); return; }
    input.value = '';
    voiceOfGod(text);
  };
  try { rec.start(); } catch (e) { toast('microphone unavailable'); godEnd(); }
};
window.__officeGod = (text, send = false) => { voiceOfGod(text || 'Finish the build. Then rest.', { send }); return 'ok'; }; // debug hook: no microphone needed

async function askManager(text, images = []) {
  manager.say('On it!', { ms: 3000 }); manager.jumpV = 2.4;
  try { const r = await api('/api/manager', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, images, project: selRoot() }) }); if (!r.ok) toast('the floor manager is not answering'); }
  catch { toast('bridge offline — run `npm start`'); }
}
function connect() {
  manager ??= new Manager();
  loadHistory();
  const es = new EventSource(`/events?token=${TOKEN}`);
  es.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.type === 'state') applyState(m); else if (m.type === 'fx') applyFx(m); else if (m.type.startsWith('lego')) applyLego(m); };
  es.onerror = () => { dot.classList.remove('on'); meta.textContent = 'bridge offline — run `npm start`'; };
}
connect();

// ============================================================ loop
const clock = new THREE.Clock();
const followTarget = new THREE.Vector3();
function frame() {
  const dt = Math.min(0.2, clock.getDelta()); const now = Date.now(); // a slow frame still moves people the right distance
  applySky(dt);
  if (godVoice) { const f = godVoice.listening ? 0.25 : 0.6; ambient.intensity = 0.9 + f * (0.6 + Math.sin(now / 70) * 0.4 + Math.random() * 0.3); hemi.intensity = 0.9 + f * 0.8; }
  for (const av of avatars.values()) av.update(dt, now);
  if (manager) manager.update(dt, now);
  updateParticles(dt);
  if (legoDirty || legoAnimating) { legoDirty = false; rebuildLego(now); }
  if (reveal && (followId !== null || now > reveal.until)) endReveal();
  if (boardZoom && followId !== null) endBoardZoom();
  if (boardZoom) {
    const z = zoomPose(boardZoom.board); // recomputed each frame so a window resize refits the board
    controls.target.lerp(z.target, 1 - Math.pow(0.002, dt));
    camera.position.lerp(z.pos, 1 - Math.pow(0.01, dt));
  } else if (reveal) {
    reveal.angle += dt * 0.4;
    followTarget.set(LEGO.x, 1.4, LEGO.z);
    controls.target.lerp(followTarget, 1 - Math.pow(0.002, dt));
    const want = new THREE.Vector3(LEGO.x + Math.sin(reveal.angle) * 9, 5.5, LEGO.z + Math.cos(reveal.angle) * 9);
    camera.position.lerp(want, 1 - Math.pow(0.03, dt));
    if (now > reveal.nextConfetti) { reveal.nextConfetti = now + 1600; burstConfetti(LEGO.x + rand(-1.5, 1.5), 2.2, LEGO.z + rand(-1.5, 1.5), 0xf2cd37); }
    updateRevealSign();
  } else if (followId !== null && avatars.has(followId)) {
    const av = avatars.get(followId); followTarget.set(av.pos.x, 1.3, av.pos.z);
    controls.target.lerp(followTarget, 1 - Math.pow(0.002, dt));
    const want = followTarget.clone().add(new THREE.Vector3(5, 4.5, 6)); camera.position.lerp(want, 1 - Math.pow(0.05, dt));
  }
  controls.update();
  // never let the camera sit inside or under the mezzanine slab: lift it above the floor there
  if (camera.position.z > MEZZ.z0 - 0.6 && camera.position.y > -1 && camera.position.y < MEZZ.y + 0.5) { camera.position.y = MEZZ.y + 0.5; controls.update(); }
  composer.render();
  requestAnimationFrame(frame);
}
frame();
