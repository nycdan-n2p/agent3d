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
const HOME = new THREE.Vector3(16, 14, 20);
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
controls.target.set(0, 1, -1);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.autoRotate = true;
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

const DAY = { bg: new THREE.Color(0xaecbff), hemi: 1.1, sun: 2.4, sunColor: new THREE.Color(0xfff1d6), fog: 0xaecbff, fill: 8, exposure: 1.05 };
const NIGHT = { bg: new THREE.Color(0x070812), hemi: 0.75, sun: 0.9, sunColor: new THREE.Color(0x9fb3ff), fog: 0x070812, fill: 60, exposure: 1.25 };
// warm ceiling lamps so the night office stays readable
for (const [x, z] of [[-6, -6], [6, -6], [-6, 0], [6, 0], [0, 8]]) {
  const lamp = new THREE.PointLight(0xffe2b8, 18, 16, 1.4); lamp.position.set(x, 5.5, z); scene.add(lamp);
  const bulb = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.08, 0.5), new THREE.MeshStandardMaterial({ color: 0xffe2b8, emissive: 0xffe2b8, emissiveIntensity: 1.6 })); bulb.position.set(x, 6.2, z); scene.add(bulb);
}
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
function pushFeed(kind, name, text) { feed.push({ t: Date.now(), kind, name, text }); if (feed.length > 60) feed.shift(); }
function drawBoard(agents) {
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
  const items = feed.slice(-9).reverse();
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
let lastIssues = []; let beadsOn = false; let taskSig = '';
const PRIO_COLORS = ['#ff4d6d', '#ffb020', '#4ea1ff', '#8b92b8', '#5c6390'];
function drawTaskBoard(force = false) {
  const sig = JSON.stringify([beadsOn, lastIssues]); if (!force && sig === taskSig) return; taskSig = sig;
  const c = taskCanvas, ctx = c.getContext('2d'); const W = c.width, H = c.height; const mono = 'ui-monospace, Menlo, Consolas, monospace';
  ctx.fillStyle = '#0b0a14'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#ffb020'; ctx.fillRect(0, 0, W, 6);
  ctx.font = `bold 26px ${mono}`; ctx.fillStyle = '#e8ecff'; ctx.textBaseline = 'top'; ctx.textAlign = 'left'; ctx.fillText('TASK BOARD', 28, 22);
  ctx.font = `18px ${mono}`; ctx.fillStyle = '#8b92b8'; ctx.textAlign = 'right';
  ctx.fillText(beadsOn ? `${lastIssues.length} open · beads` : 'no beads database here', W - 28, 26); ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.fillRect(28, 62, W - 56, 2);
  if (!lastIssues.length) { ctx.fillStyle = '#5c6390'; ctx.font = `20px ${mono}`; ctx.fillText(beadsOn ? 'board is clear' : 'run `bd init` in the project folder', 28, 84); }
  lastIssues.slice(0, 12).forEach((i, k) => {
    const y = 80 + k * 39; const col = PRIO_COLORS[Math.min(4, i.priority)] || '#8b92b8';
    ctx.fillStyle = col; roundRect(ctx, 28, y + 6, 42, 24, 6); ctx.fill();
    ctx.fillStyle = '#0b0d17'; ctx.font = `bold 16px ${mono}`; ctx.fillText(`P${i.priority}`, 36, y + 10);
    ctx.fillStyle = i.status === 'in_progress' ? '#39d98a' : '#5c6390'; ctx.font = `20px ${mono}`; ctx.fillText(i.status === 'in_progress' ? '◐' : '○', 82, y + 8);
    ctx.fillStyle = '#8b92b8'; ctx.font = `16px ${mono}`; ctx.fillText(i.id.slice(-8), 110, y + 11);
    ctx.fillStyle = '#e8ecff'; ctx.font = `19px ${mono}`; ctx.fillText(i.title.slice(0, 60) + (i.title.length > 60 ? '…' : ''), 215, y + 9);
    if (i.assignee) { ctx.fillStyle = '#c77dff'; ctx.font = `15px ${mono}`; ctx.textAlign = 'right'; ctx.fillText(i.assignee.slice(0, 14), W - 28, y + 12); ctx.textAlign = 'left'; }
  });
  if (lastIssues.length > 12) { ctx.fillStyle = '#5c6390'; ctx.font = `16px ${mono}`; ctx.fillText(`+${lastIssues.length - 12} more`, 28, 80 + 12 * 39); }
  taskTex.needsUpdate = true;
}
drawTaskBoard(true);
setInterval(() => drawBoard(lastAgents), 1000);

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
  // task board on the left wall, by the Engineering bay
  const tframe = new THREE.Mesh(new THREE.BoxGeometry(0.25, 4.2, 8.2), mat(0x0d0f20, { metalness: 0.4, roughness: 0.5 })); tframe.position.set(-ROOM.w / 2 + 0.33, 3.6, -3.9); scene.add(tframe);
  const tboard = new THREE.Mesh(new THREE.PlaneGeometry(7.9, 4.0), taskMaterial); tboard.rotation.y = Math.PI / 2; tboard.position.set(-ROOM.w / 2 + 0.47, 3.6, -3.9); scene.add(tboard);
  // baseboard neon strip
  const strip = new THREE.Mesh(new THREE.BoxGeometry(ROOM.w, 0.08, 0.08), new THREE.MeshStandardMaterial({ color: 0x7c5cff, emissive: 0x7c5cff, emissiveIntensity: 2.5 }));
  strip.position.set(0, 0.06, -ROOM.d / 2 + 2.25); scene.add(strip);
  const strip2 = strip.clone(); strip2.rotation.y = Math.PI / 2; strip2.position.set(-ROOM.w / 2 + 0.25, 0.06, 2); scene.add(strip2);
  // lounge: couch, coffee machine, plants, rug
  const rug = new THREE.Mesh(new THREE.CircleGeometry(4.2, 40), mat(0x8a4b8f, { roughness: 1 })); rug.rotation.x = -Math.PI / 2; rug.position.set(0, 0.01, 8); rug.receiveShadow = true; scene.add(rug);
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
(function buildPlayTable() {
  const size = LEGO.N * LEGO.S, half = size / 2;
  const top = new THREE.Mesh(new THREE.BoxGeometry(size + 0.5, 0.1, size + 0.5), mat(0xd9b48f, { roughness: 0.5 })); top.position.set(LEGO.x, 0.38, LEGO.z); top.castShadow = true; top.receiveShadow = true; scene.add(top);
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) { const leg = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.33, 0.12), mat(0x5a4330)); leg.position.set(LEGO.x + sx * (half + 0.1), 0.165, LEGO.z + sz * (half + 0.1)); scene.add(leg); }
  const plate = new THREE.Mesh(new THREE.BoxGeometry(size, 0.04, size), mat(0x237841, { roughness: 0.45 })); plate.position.set(LEGO.x, 0.45, LEGO.z); plate.receiveShadow = true; scene.add(plate);
  const studs = new THREE.InstancedMesh(STUD_GEO, mat(0x2a8a4c, { roughness: 0.45 }), LEGO.N * LEGO.N); const m = new THREE.Matrix4(); let i = 0;
  for (let x = 0; x < LEGO.N; x++) for (let z = 0; z < LEGO.N; z++) { const [wx, , wz] = legoWorld(x + 0.5, 0, z + 0.5); m.makeTranslation(wx, LEGO.top + 0.0175, wz); studs.setMatrixAt(i++, m); }
  studs.receiveShadow = true; scene.add(studs);
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
  if (m.type === 'lego') { Object.assign(legoColors, m.colors || {}); legoBricks = new Map(m.bricks.map((b) => [b.id, b])); }
  else if (m.type === 'legoAdd') {
    const now = Date.now(); m.bricks.forEach((b, i) => { b.addedAt = now + i * 60; legoBricks.set(b.id, b); });
    const av = avatars.get(m.by); if (av) av.lastBuild = now;
    pushFeed('lego', av ? av.name() : `agent ${m.by}`, `placed ${m.bricks.length} brick${m.bricks.length === 1 ? '' : 's'}`);
  } else if (m.type === 'legoRemove') for (const id of m.ids) legoBricks.delete(id);
  rebuildLegoOcc(); legoDirty = true;
}

// ============================================================ text sprites + screens
function textSprite(text, { size = 48, color = '#fff', bg = 'rgba(0,0,0,0.55)', font = 'bold' } = {}) {
  const c = document.createElement('canvas'); c.width = 1024; c.height = 160;
  const ctx = c.getContext('2d');
  ctx.font = `${font} ${size}px ui-monospace, Menlo, monospace`;
  const w = Math.min(1000, ctx.measureText(text).width + 60);
  ctx.fillStyle = bg; roundRect(ctx, 512 - w / 2, 20, w, 120, 30); ctx.fill();
  ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, 512, 82, 960);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  sp.scale.set(3.2, 0.5, 1); sp.renderOrder = 10; sp.userData.canvas = c; return sp;
}
function updateSprite(sp, text, opts = {}) {
  if (sp.userData.text === text) return; sp.userData.text = text;
  const { size = 48, color = '#fff', bg = 'rgba(0,0,0,0.55)', font = 'bold' } = opts;
  const c = sp.userData.canvas, ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.font = `${font} ${size}px ui-monospace, Menlo, monospace`;
  const w = Math.min(1000, ctx.measureText(text).width + 60);
  ctx.fillStyle = bg; roundRect(ctx, 512 - w / 2, 20, w, 120, 30); ctx.fill();
  ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, 512, 82, 960);
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
    this.speech = textSprite('', { size: 38, color: '#111', bg: 'rgba(255,255,255,0.95)' }); this.speech.position.y = 3.0; this.speech.scale.set(4.4, 0.6, 1); this.speech.visible = false; this.group.add(this.speech); this.speechUntil = 0; this.lastBuild = 0;
    // context bar
    this.barBg = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 0.08), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.5, depthTest: false }));
    this.bar = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 0.06), new THREE.MeshBasicMaterial({ color: 0x39d98a, depthTest: false }));
    this.barHolder = new THREE.Group(); this.barHolder.position.y = 1.98; this.barHolder.add(this.barBg, this.bar); this.bar.position.z = 0.001; this.bar.renderOrder = 11; this.barBg.renderOrder = 11; this.group.add(this.barHolder);
    // glow ring on the floor
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.52, 32), new THREE.MeshBasicMaterial({ color: this.color, transparent: true, opacity: 0.0, side: THREE.DoubleSide }));
    this.ring.rotation.x = -Math.PI / 2; this.ring.position.y = 0.02; this.group.add(this.ring);
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
    scene.add(this.group);
    this.decide(true);
  }
  dept() { return this.data.dept || 'engineering'; }
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
  speak(text) { updateSprite(this.speech, text.length > 46 ? text.slice(0, 45) + '…' : text, { size: 38, color: '#111', bg: 'rgba(255,255,255,0.95)' }); this.speech.visible = true; this.speechUntil = Date.now() + 7000; }
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
    this.head.rotation.x = this.mode === 'play' && !moving ? 0.35 : typing ? 0.12 + Math.sin(this.t * 1.7) * 0.05 : (w === 'work' ? Math.sin(this.t * 0.9) * 0.15 : 0);
    this.head.rotation.y = w === 'work' && !typing ? Math.sin(this.t * 0.7) * 0.35 : 0;
    this.mouth.scale.y = needsYou ? 2.5 : 1;
    // jump / bounce for permission
    if (needsYou && !moving && this.jumpY <= 0 && Math.random() < dt * (w === 'permission' ? 2.5 : 1.2)) this.jumpV = w === 'permission' ? 3.0 : 2.2;
    this.jumpV -= 9.8 * dt; this.jumpY = Math.max(0, this.jumpY + this.jumpV * dt); if (this.jumpY === 0 && this.jumpV < 0) this.jumpV = 0;
    // --- labels + bubble
    updateSprite(this.nameSprite, this.name(), { size: 44, color: '#e8ecff', bg: 'rgba(12,14,30,0.75)' });
    let status = ''; let statusColor = '#39d98a';
    if (w === 'permission' || w === 'question') { status = a.ask?.kind === 'question' ? a.ask.question.slice(0, 40) : a.ask?.kind === 'permission' ? `may I run ${prettyTool(a.ask.tool)}?` : 'needs your approval'; statusColor = '#ff4d6d'; }
    else if (typing && this.mode === 'play') { const t = tools[tools.length - 1]; const lm = /lego\.mjs"?\s+\d+\s+(\w+)/.exec(t.status || ''); status = LEGO_ACTIONS[lm?.[1]] || 'playing'; statusColor = '#39d98a'; }
    else if (typing) { const t = tools[tools.length - 1]; status = (t.status || t.toolName).replace(/mcp__\S+/g, (m) => prettyTool(m)).slice(0, 36); statusColor = '#' + new THREE.Color(TOOL_COLORS[toolKind(t.toolName)]).getHexString(); }
    else if (w === 'work') { status = 'thinking' + '.'.repeat(1 + (Math.floor(this.t * 2) % 3)); statusColor = '#d6dcff'; }
    else if (w === 'question') { status = 'asked you a question'; statusColor = '#ffb020'; }
    else if (this.pendingReports.length) { status = `filing a ${deptOf(this.pendingReports[0].dept).name} report`; statusColor = '#ffb020'; }
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
    // --- glyph particles when typing
    if (typing && this.mode === 'desk' && Math.random() < dt * 9) spawnGlyph(this.desk.x + rand(-0.3, 0.3), 0.95, this.desk.z + 0.2, TOOL_COLORS[kind]);
    // --- drones for subagents
    const subs = Object.entries(a.subagents);
    for (const [k, s] of subs) if (!this.drones.has(k)) this.drones.set(k, makeDrone(s.toolName, this.color));
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
    this.bubble = textSprite('', { size: 40, color: '#111', bg: 'rgba(255,255,255,0.95)' }); this.bubble.position.set(0, 2.85, 0); this.bubble.scale.set(4.4, 0.6, 1); this.bubble.visible = false; this.group.add(this.bubble);
    this.pos = new THREE.Vector3(11, 0, 6.4); this.group.position.copy(this.pos); this.yaw = Math.PI; this.t = 0; this.path = []; this.waitUntil = 0;
    this.task = null; // { targetId, text, phase: 'walk'|'talk'|'done', until }
    this.bubbleUntil = 0; this.jumpV = 0; this.jumpY = 0; this.faceId = null;
    scene.add(this.group);
  }
  say(text, { color = '#111', bg = 'rgba(255,255,255,0.95)', ms = 6000 } = {}) {
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
    } else if (this.task && this.task.phase === 'walk' && !this.task.pendingTarget) {
      this.task.phase = 'talk'; this.say(this.task.text, { ms: 7000 }); this.jumpV = 2.0;
      if (!this.task.pending) { this.task.phase = 'done'; this.task.until = now + 7000; } // nothing more is coming back from the bridge
    } else if (!this.task) {
      if (!this.waitUntil) this.waitUntil = now + rand(3000, 9000);
      if (now > this.waitUntil) { this.waitUntil = 0; this.goHome(); }
    }
    if (this.task && this.task.pendingTarget && avatars.has(this.task.pendingTarget)) { this.task.targetId = this.task.pendingTarget; this.task.pendingTarget = null; this.task.phase = 'walk'; this.walkTo(this.task.targetId); }
    if (!moving && this.faceId === null && this.facePoint) this.yaw = Math.atan2(this.facePoint.x - this.pos.x, this.facePoint.z - this.pos.z);
    if (!moving && this.faceId !== null && avatars.has(this.faceId)) { const p = avatars.get(this.faceId).pos; this.yaw = Math.atan2(p.x - this.pos.x, p.z - this.pos.z); }
    if (this.task && this.task.phase === 'done' && now > this.task.until) { this.task = null; this.goHome(); }
    this.jumpV -= 9.8 * dt; this.jumpY = Math.max(0, this.jumpY + this.jumpV * dt); if (this.jumpY === 0 && this.jumpV < 0) this.jumpV = 0;
    this.group.position.set(this.pos.x, this.jumpY, this.pos.z);
    this.group.rotation.y = lerpAngle(this.group.rotation.y, this.yaw, 1 - Math.pow(0.0005, dt));
    const swing = moving ? Math.sin(this.t * 11) * 0.6 : 0;
    this.legs[0].rotation.x = swing; this.legs[1].rotation.x = -swing;
    const talking = this.bubble.visible && this.task && (this.task.phase === 'talk' || this.task.phase === 'done');
    this.arms[1].rotation.x = talking ? -1.2 + Math.sin(this.t * 5) * 0.4 : swing * 0.8;
    this.arms[0].rotation.x = -0.9; // clipboard arm
    this.body.position.y = moving ? Math.abs(Math.sin(this.t * 11)) * 0.06 : 0;
    this.head.rotation.y = talking ? Math.sin(this.t * 3) * 0.15 : (moving ? 0 : Math.sin(this.t * 0.6) * 0.4);
    this.mouth.scale.y = talking ? 1.5 + Math.sin(this.t * 14) : 1;
    if (this.bubble.visible && now > this.bubbleUntil) this.bubble.visible = false;
  }
}
let manager = null;
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
  logBody.appendChild(el); while (logBody.children.length > 200) logBody.firstChild.remove();
  if (show) logPanel.classList.add('show');
  logBody.scrollTop = logBody.scrollHeight;
}
function mdLite(s) { return String(s || '').replace(/^#{1,6}\s+/gm, '').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').trim(); }
$('#logClose').onclick = () => logPanel.classList.remove('show');
$('#btnLog').onclick = () => { logPanel.classList.toggle('show'); logBody.scrollTop = logBody.scrollHeight; };
// ---------- the reports inbox ----------
const reportsPanel = $('#reports'), rList = $('#rList'), rBadge = $('#rBadge'), rCount = $('#rCount');
const reportsById = new Map(); let unread = 0;
function renderBadge() { rBadge.textContent = String(unread); rBadge.classList.toggle('show', unread > 0 && !reportsPanel.classList.contains('show')); rCount.textContent = `${reportsById.size}${unread ? ` · ${unread} new` : ''}`; }
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
  const el = document.createElement('div'); el.className = 'rep' + (fresh ? ' unread' : ''); el.dataset.id = r.id;
  const body = mdLite(r.text) || mdLite(r.recap) || '(no text in this turn)';
  el.innerHTML = `<div class="rt"><span class="chip" style="background:${deptHex(r.dept)}">${escapeHtml(deptOf(r.dept).name)}</span><b>${escapeHtml(r.name)}</b><span class="ago" data-t="${r.t}">${ago(r.t)} ago</span></div>
    ${r.prompt ? `<div class="rp">↳ ${escapeHtml(r.prompt)}</div>` : ''}${r.issueId ? `<div class="rp">🧵 ${escapeHtml(r.issueId)}${r.asked ? ' · still open' : ' · closed'}</div>` : ''}${r.asked ? '<div class="rq">❓ ended with a question for you</div>' : ''}<div class="rb">${escapeHtml(body)}</div>`;
  el.onclick = () => { el.classList.toggle('open'); if (el.classList.contains('unread')) { el.classList.remove('unread'); unread = Math.max(0, unread - 1); renderBadge(); } };
  rList.prepend(el); while (rList.children.length > 100) rList.lastChild.remove();
  if (fresh) unread++; renderBadge();
}
setInterval(() => { for (const sp of rList.querySelectorAll('.ago[data-t]')) sp.textContent = `${ago(Number(sp.dataset.t))} ago`; }, 10000);
// An agent hands in a report: it lands on the tray, in the inbox, in the log when it answers you, and you get a notice.
function handInReport(r, av, walked) {
  addSheet(r.dept); addReportRow(r, true);
  if (walked) burstConfetti(OFFICE.tray.x, 1.4, OFFICE.tray.z, deptOf(r.dept).color);
  const head = mdLite(r.text || r.recap).split('\n').find((l) => l.trim()) || '';
  toast(`${r.name} dropped off a report: ${head}`, { notice: true, chip: r.dept, onclick: () => openReports(r.id) });
  if (r.replyTo) logChat({ who: 'agent', name: r.name, dept: r.dept, text: r.text || r.recap });
  else logChat({ who: 'manager', name: 'floor manager', text: `${r.name} filed a ${deptOf(r.dept).name} report${r.asked ? ' and is waiting on your answer' : ''}. Say "what did ${r.name} say" or open 📋 reports.` }, { show: false });
  pushFeed('report', r.name, `filed a ${deptOf(r.dept).name} report`); drawBoard(lastAgents); chime();
}
async function loadHistory() {
  try {
    const h = await (await api('/api/history')).json();
    for (const r of h.reports || []) addReportRow(r, false);
    for (const m of h.chat || []) logChat(m, { show: false });
    if (h.issues) { lastIssues = h.issues; beadsOn = !!h.beads; drawTaskBoard(); }
    for (const r of (h.reports || []).slice(-TRAY_MAX)) addSheet(r.dept);
  } catch { /* bridge offline */ }
}
// ---------- end-of-play reveal: the camera takes a slow lap around the finished build ----------
const revealSign = textSprite('', { size: 34, color: '#fff', bg: 'rgba(12,14,30,0.8)' }); revealSign.position.set(LEGO.x, 2.6, LEGO.z); revealSign.visible = false; scene.add(revealSign);
let reveal = null; let revealText = '';
function startReveal() {
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
let rosterSig = '';
function renderRoster(agents) {
  const rows = [];
  for (const a of agents) {
    const av = avatars.get(a.id); if (!av) continue;
    const w = av.wants(); const st = w === 'work' ? 'active' : w === 'permission' ? 'permission' : w === 'question' ? 'waiting' : 'idle';
    const tools = Object.values(a.tools); const detail = tools.length ? prettyTool(tools[tools.length - 1].toolName) : st;
    rows.push({ a, av, st, detail });
  }
  const sig = rows.map((r) => `${r.a.id}|${r.av.name()}|${r.st}|${r.detail}|${r.a.dept}|${Object.keys(r.a.subagents || {}).length}|${followId === r.a.id}`).join(';');
  empty.classList.toggle('show', agents.length === 0);
  if (sig === rosterSig) return; rosterSig = sig;
  roster.innerHTML = '';
  for (const { a, av, st, detail } of rows) {
    const row = document.createElement('div'); row.className = 'row' + (followId === a.id ? ' sel' : '');
    row.innerHTML = `<span class="sw" style="background:#${av.color.getHexString()}"></span><span class="name">${escapeHtml(av.name())}${a.subagents && Object.keys(a.subagents).length ? ` <span style="color:#c77dff">+${Object.keys(a.subagents).length}</span>` : ''}</span><span class="dp" style="color:${deptHex(a.dept)}">${escapeHtml(deptOf(a.dept).name)}</span><span class="st ${st}">${escapeHtml(detail)}</span>`;
    row.onclick = () => { followId = followId === a.id ? null : a.id; renderRoster(lastAgents); };
    roster.appendChild(row);
  }
}
const detail = $('#detail'); const dScreen = $('#dScreen'), dTerm = $('#dTerm'), dReply = $('#dReply'), dInput = $('#dInput');
function ago(t) { const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`; }
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
        <button type="button" data-answer="other">✎ other…</button></div></div>`;
    } else {
      askHtml = `<div class="ask perm"><div class="askTitle">⚠ ${escapeHtml(av.name())} wants to run <b>${escapeHtml(prettyTool(a.ask.tool))}</b></div>
        ${a.ask.description ? `<div class="askQ">${escapeHtml(a.ask.description)}</div>` : ''}<pre class="askCode">${escapeHtml(a.ask.summary || '')}</pre>
        <div class="askOpts"><button type="button" data-answer="1" class="yes">✓ allow</button><button type="button" data-answer="2">allow &amp; don't ask again</button><button type="button" data-answer="esc" class="no">✕ deny</button></div></div>`;
    }
  } else if (needsYou) {
    askHtml = `<div class="ask"><div class="askTitle">⚠ ${escapeHtml(av.name())} is waiting on you</div><div class="askQ">${a.hasTerminal ? 'Reading the prompt from the transcript…' : 'This is a desktop-app session: answer it in that window.'}</div></div>`;
  }
  const html = askHtml + `
      <div class="now ${stClass}${w === 'work' ? ' cursor' : ''}">${escapeHtml(nowText)} </div>
      <div class="kv">
        <span>job</span><b><select class="deptSel" title="${escapeHtml(a.deptReason || '')}">${DEPT_ORDER.map((k) => `<option value="${k}"${k === (a.dept || 'engineering') ? ' selected' : ''}>${escapeHtml(DEPTS[k].name)}</option>`).join('')}</select>${a.deptReason ? ` <span style="color:var(--dim)">· ${escapeHtml(a.deptReason.slice(0, 40))}</span>` : ''}</b>
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
let playSig = '';
function renderPlay() {
  const p = lastPlay;
  const has = !!(p && (p.active || p.brickCount));
  playPanel.classList.toggle('show', has); legoSign.visible = has;
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
$('#btnOrbit').onclick = (e) => { controls.autoRotate = !controls.autoRotate; e.target.classList.toggle('on', controls.autoRotate); };
$('#btnSound').onclick = (e) => { soundOn = !soundOn; e.target.classList.toggle('on', soundOn); if (soundOn) chime(); };
$('#btnNight').onclick = (e) => { nightTarget = nightTarget ? 0 : 1; e.target.textContent = nightTarget ? 'night' : 'day'; e.target.classList.toggle('on', !!nightTarget); };
$('#btnNight').classList.add('on');
$('#btnReset').onclick = () => { endReveal(); followId = null; camera.position.copy(HOME); controls.target.set(0, 1, -1); renderRoster(lastAgents); };
addEventListener('keydown', (e) => { if (e.key === 'Escape') { endReveal(); followId = null; renderRoster(lastAgents); } });
// click to follow
const ray = new THREE.Raycaster(); const mouse = new THREE.Vector2(); let downAt = null;
renderer.domElement.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
let hoverAt = 0;
renderer.domElement.addEventListener('pointermove', (e) => {
  if (e.buttons || performance.now() - hoverAt < 80) return; hoverAt = performance.now();
  mouse.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1); ray.setFromCamera(mouse, camera);
  renderer.domElement.style.cursor = ray.intersectObjects(binParts, true).length ? 'pointer' : '';
});
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
  mouse.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1); ray.setFromCamera(mouse, camera);
  if (trayHit && ray.intersectObject(trayHit).length) { openReports(); return; } // the report tray opens the inbox
  const hits = ray.intersectObjects([...avatars.values()].map((a) => a.group), true);
  const hit = hits.find((h) => { let o = h.object; while (o && o.userData.avatarId === undefined) o = o.parent; return o; });
  const binHit = ray.intersectObjects(binParts, true)[0];
  if (binHit && (!hit || binHit.distance < hit.distance)) { reportsPanel.classList.contains('show') ? closeReports() : openReports(); return; }
  if (hit) { let o = hit.object; while (o && o.userData.avatarId === undefined) o = o.parent; followId = followId === o.userData.avatarId ? null : o.userData.avatarId; renderRoster(lastAgents); }
});

// ============================================================ data feed
const avatars = new Map(); let lastAgents = []; let connected = false; let lastPlay = null;
function applyState(s) {
  lastAgents = s.agents; connected = s.upstream.connected; lastPlay = s.play || null; lastIssues = s.issues || []; beadsOn = !!s.beads; drawTaskBoard();
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
    for (const a of s.agents) for (const e of a.log || []) all.push({ t: e.t, kind: e.kind === 'tool' ? 'tool' : e.kind === 'turn' ? 'turnEnd' : e.kind, name: avatars.get(a.id)?.name() || `agent ${a.id}`, text: e.text.replace(/mcp__\S+/g, (m) => prettyTool(m)) });
    all.sort((p, q) => p.t - q.t); for (const e of all.slice(-40)) feed.push(e);
  }
  renderRoster(s.agents); renderDetail(); drawBoard(s.agents); renderPlay();
}
window.__officeFx = (f) => applyFx(f); // debug hook: replay an event from the console
window.__officeDebug = () => ({ issues: lastIssues.length, beads: beadsOn, reveal: reveal ? { msLeft: reveal.until - Date.now(), angle: reveal.angle } : null, cam: camera.position.toArray().map((v) => +v.toFixed(2)), target: controls.target.toArray().map((v) => +v.toFixed(2)), followId, avatars: [...avatars.values()].map((a) => ({ id: a.id, name: a.name(), mode: a.mode, dept: a.dept(), desk: a.desk.dept, pending: a.pendingReports.length, pos: a.pos.toArray().map((v) => +v.toFixed(1)), path: a.path.length })) });
function applyFx(f) {
  const av = avatars.get(f.id); const name = av ? av.name() : `agent ${f.id}`;
  if (f.kind === 'toolStart') { toolStats.push({ t: Date.now(), kind: toolKind(f.toolName) }); pushFeed('tool', name, (f.status || prettyTool(f.toolName)).replace(/mcp__\S+/g, (m) => prettyTool(m))); }
  else if (f.kind === 'turnEnd') pushFeed('turnEnd', name, f.asked ? 'asked you a question' : 'finished its turn');
  else if (f.kind === 'permission') pushFeed('permission', name, 'needs your approval');
  else if (f.kind === 'agentCreated') pushFeed('agentCreated', name, 'joined the office');
  else if (f.kind === 'agentClosed') pushFeed('agentClosed', name, 'left');
  else if (f.kind === 'subagentStart') pushFeed('subagentStart', name, 'spawned a sub-agent');
  if (f.kind !== 'toolDone') drawBoard(lastAgents);
  if (f.kind === 'issues') { pushFeed('manager', 'task board', `${f.count} open task${f.count === 1 ? '' : 's'}`); drawBoard(lastAgents); return; }
  if (f.kind === 'dept') { if (av) { av.decide(); pushFeed('dept', name, `→ ${deptOf(f.dept).name}`); } return; }
  if (f.kind === 'report') { if (f.report) { if (av) av.file(f.report); else handInReport(f.report, null, false); } return; }
  if (f.kind === 'managerSay') {
    logChat({ who: 'you', name: 'you', text: f.text }); logChat({ who: 'manager', name: 'floor manager', text: f.message, ok: f.ok });
    manager.task = { targetId: f.id, pendingTarget: null, text: f.action === 'move' ? f.message : f.text, phase: 'walk', until: 0, pending: !!f.pending };
    if (f.action === 'answer') { manager.task = null; manager.say(f.message.split('\n')[0], { ms: 8000 }); manager.jumpV = 1.6; }
    else if (f.id !== null && f.id !== undefined && avatars.has(f.id)) manager.walkTo(f.id);
    else if (f.action === 'launch' || f.action === 'handoff') { manager.say(f.message.split('\n')[0], { ms: 20000 }); }
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
  if (f.kind === 'managerTarget') { if (manager.task) { manager.task.pendingTarget = f.id; manager.task.phase = 'walk'; } return; }
  if (f.kind === 'managerDone') {
    const until = Date.now() + 5000;
    if (manager.task) { manager.task.phase = 'done'; manager.task.until = until; }
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
$('#chat').onsubmit = (e) => {
  e.preventDefault();
  const input = $('#chatInput'); const text = input.value.trim(); if (!text) return; input.value = '';
  if (/^(?:open|show|see)\s+(?:the\s+)?(?:reports?|inbox)$/i.test(text)) { openReports(); return; }
  if (/^(?:close|hide)\s+(?:the\s+)?(?:reports?|inbox)$/i.test(text)) { closeReports(); return; }
  askManager(text);
};
$('#btnPlay').onclick = () => askManager(lastPlay?.active ? 'stop playing' : 'play');
async function askManager(text) {
  manager.say('On it!', { ms: 3000 }); manager.jumpV = 2.4;
  try { const r = await api('/api/manager', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) }); if (!r.ok) toast('the floor manager is not answering'); }
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
  for (const av of avatars.values()) av.update(dt, now);
  if (manager) manager.update(dt, now);
  updateParticles(dt);
  if (legoDirty || legoAnimating) { legoDirty = false; rebuildLego(now); }
  if (reveal && (followId !== null || now > reveal.until)) endReveal();
  if (reveal) {
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
  composer.render();
  requestAnimationFrame(frame);
}
frame();
