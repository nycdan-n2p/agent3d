// Playtime: the floor manager hands every idle agent the same LEGO baseplate and
// they have to agree on something to build. The bridge owns the board; agents
// reach it through lego.mjs, so one Bash prefix covers everything they do.

import fs from 'node:fs';
import path from 'node:path';

export const GRID = 24;   // studs per side
export const LAYERS = 24; // bricks high
const MAX_PER_CALL = 40, MAX_BRICKS = 2000, MAX_CHAT = 400;
const SHAPES = ['brick', 'tile', 'slope', 'round'];
const DIRS = ['n', 'e', 's', 'w'];

export const COLORS = {
  red: '#c91a09', blue: '#0055bf', yellow: '#f2cd37', green: '#237841', lime: '#bbe90b',
  white: '#f4f4f4', black: '#1b2a34', gray: '#a0a5a9', darkgray: '#6c6e68', orange: '#fe8a18',
  brown: '#583927', tan: '#e4cd9e', pink: '#fc97ac', purple: '#81007b', azure: '#36aebf',
  darkblue: '#0a3463', darkred: '#720e0f', darkgreen: '#184632', gold: '#dbac34', glass: '#c1dff0',
};
const CODE = {
  red: 'r', blue: 'b', yellow: 'y', green: 'g', lime: 'l', white: 'w', black: 'k', gray: 'a', darkgray: 'd', orange: 'o',
  brown: 'n', tan: 't', pink: 'p', purple: 'u', azure: 'z', darkblue: 'B', darkred: 'R', darkgreen: 'G', gold: '$', glass: '~',
};
const LEGEND = Object.entries(CODE).map(([c, k]) => `${k}=${c}`).join(' ');

export function createPlayroom({ buildsDir, cli, broadcast, fx, markDirty, present }) {
  const cmd = (id) => `node ${/\s/.test(cli) ? JSON.stringify(cli) : cli} ${id}`;
  let s = blank();
  let occ = new Map(); // "x,y,z" -> brick id
  const waiters = new Set();

  function blank() {
    return { active: false, theme: '', title: '', minutes: 0, startedAt: 0, endsAt: 0, endedAt: 0, reason: '', players: [], bricks: new Map(), chat: [], seq: 0, nextId: 1 };
  }
  const key = (x, y, z) => `${x},${y},${z}`;
  function cells(b, fn) { for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) for (let z = b.z; z < b.z + b.d; z++) fn(x, y, z); }
  function rebuildOcc() { occ = new Map(); for (const b of s.bricks.values()) cells(b, (x, y, z) => occ.set(key(x, y, z), b.id)); }
  function topAt(x, z) { for (let y = LAYERS - 1; y >= 0; y--) if (occ.has(key(x, y, z))) return y + 1; return 0; }
  const player = (as) => s.players.find((p) => p.id === Number(as));
  const ok = (text) => ({ ok: true, text });
  const err = (text) => ({ ok: false, text });
  function timeLeft() { const ms = Math.max(0, s.endsAt - Date.now()); return `${Math.floor(ms / 60000)}m ${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}s`; }
  function clock(t) { const sec = Math.max(0, Math.round((t - s.startedAt) / 1000)); return `+${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; }
  function line(e) { return `${clock(e.t)} ${e.name}${e.kind === 'say' ? ':' : ''} ${e.text}`; }

  // ---------- chat + long-poll ----------
  function post(p, text, kind = 'say') {
    const e = { seq: ++s.seq, t: Date.now(), from: p ? p.id : null, name: p ? p.name : '[game]', kind, text: String(text).slice(0, 400) };
    s.chat.push(e); if (s.chat.length > MAX_CHAT) s.chat.shift();
    for (const w of waiters) if (e.from !== w.p.id) { clearTimeout(w.timer); waiters.delete(w); w.resolve(); }
    markDirty(); return e;
  }
  function unseen(p) { return s.chat.filter((e) => e.seq > p.cursor && e.from !== p.id); }
  function withNews(p, text) {
    const news = unseen(p); p.cursor = s.seq;
    return news.length ? `${text}\n\nMeanwhile:\n${news.map(line).join('\n')}` : text;
  }

  // ---------- views ----------
  function grid(cellChar) {
    const pad = '        ';
    const tens = Array.from({ length: GRID }, (_, i) => Math.floor(i / 10)).join('');
    const ones = Array.from({ length: GRID }, (_, i) => i % 10).join('');
    const rows = [`x →     ${tens}`, `${pad}${ones}`];
    for (let z = 0; z < GRID; z++) {
      let r = ''; for (let x = 0; x < GRID; x++) r += cellChar(x, z);
      rows.push(`${z === 0 ? 'z' : ' '} ${String(z).padStart(2)}    ${r}`);
    }
    return rows;
  }
  function topView() {
    const colors = grid((x, z) => { for (let y = LAYERS - 1; y >= 0; y--) { const id = occ.get(key(x, y, z)); if (id) return CODE[s.bricks.get(id).color]; } return '.'; });
    const heights = grid((x, z) => { const h = topAt(x, z); return h ? h.toString(36) : '.'; });
    const out = ['Top view: colour of the highest brick          Height in layers (1-9, then a=10 … n=23)'];
    for (let i = 0; i < colors.length; i++) out.push(colors[i].padEnd(46) + heights[i].replace(/^x →|^z/, (m) => ' '.repeat(m.length)));
    out.push(`Colours: ${LEGEND}`);
    return out.join('\n');
  }
  function layerView(y) {
    return [`Layer ${y} (which colour fills each cell at this height):`, ...grid((x, z) => { const id = occ.get(key(x, y, z)); return id ? CODE[s.bricks.get(id).color] : '.'; }), `Colours: ${LEGEND}`].join('\n');
  }
  function brickLine(b) {
    const owner = player(b.by)?.name || `#${b.by}`;
    return `#${b.id} ${b.color} ${b.shape}${b.dir ? `(${b.dir})` : ''} ${b.w}x${b.d}${b.h > 1 ? `x${b.h}` : ''} at x${b.x} z${b.z} y${b.y} — ${owner}`;
  }
  function header(p) {
    const players = s.players.map((q) => `${q.name}${q.id === p.id ? ' (you)' : ''}${q.host ? ' [host]' : ''}: ${q.bricks} bricks${q.done ? ', done' : ''}${present(q.id) ? '' : ', left'}`).join(' | ');
    return [
      `LEGO PLAYTIME — ${s.theme ? `theme: ${s.theme}` : 'no theme: invent something unique'} — ${s.title ? `title: "${s.title}"` : 'no title yet'} — ${timeLeft()} left — ${s.bricks.size}/${MAX_BRICKS} bricks used`,
      `Players: ${players}`,
    ].join('\n');
  }

  // ---------- bricks ----------
  function addBrick(p, spec) {
    if (s.bricks.size >= MAX_BRICKS) return { error: `the box is empty (${MAX_BRICKS} bricks max)` };
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return { error: 'each brick must be an object like {"x":0,"z":0,"w":2,"d":4,"color":"red"}' };
    const num = (v, d) => (v === undefined || v === null || v === '' ? d : Number(v));
    const x = num(spec.x), z = num(spec.z), w = num(spec.w, 1), d = num(spec.d, 1), h = num(spec.h, 1);
    for (const [k, v] of Object.entries({ x, z, w, d, h })) if (!Number.isInteger(v)) return { error: `${k} must be a whole number` };
    const shape = String(spec.shape || 'brick').toLowerCase();
    if (!SHAPES.includes(shape)) return { error: `unknown shape "${spec.shape}"; use ${SHAPES.join(', ')}` };
    if (w < 1 || d < 1 || w > 8 || d > 8) return { error: 'w and d must be 1-8' };
    if (h < 1 || h > 6) return { error: 'h must be 1-6' };
    if (shape === 'round' && w !== d) return { error: 'round bricks need w = d' };
    let dir = null;
    if (shape === 'slope') { dir = String(spec.dir || 's').toLowerCase()[0]; if (!DIRS.includes(dir)) return { error: 'slope dir must be n, e, s or w (the downhill side)' }; }
    const color = String(spec.color || '').toLowerCase().replace(/[\s_-]/g, '').replace('grey', 'gray');
    if (!COLORS[color]) return { error: `unknown colour "${spec.color}"; use ${Object.keys(COLORS).join(', ')}` };
    if (x < 0 || z < 0 || x + w > GRID || z + d > GRID) return { error: `off the baseplate: x ${x}..${x + w - 1}, z ${z}..${z + d - 1} must stay within 0..${GRID - 1}` };
    let y;
    if (spec.y === undefined || spec.y === null || spec.y === '') { y = 0; for (let i = x; i < x + w; i++) for (let k = z; k < z + d; k++) y = Math.max(y, topAt(i, k)); }
    else { y = Number(spec.y); if (!Number.isInteger(y) || y < 0) return { error: 'y must be a whole number from 0' }; }
    if (y + h > LAYERS) return { error: `too tall: it would reach layer ${y + h - 1}, the top is ${LAYERS - 1}` };
    const b = { id: 0, x, y, z, w, d, h, color, shape, dir, by: p.id };
    let hit = null; cells(b, (cx, cy, cz) => { hit ??= occ.get(key(cx, cy, cz)); });
    if (hit) return { error: `collides with brick #${hit} (${brickLine(s.bricks.get(hit))})` };
    b.id = s.nextId++;
    s.bricks.set(b.id, b); cells(b, (cx, cy, cz) => occ.set(key(cx, cy, cz), b.id));
    return { brick: b };
  }

  // ---------- lifecycle ----------
  function start({ theme = '', minutes = 15, players }) {
    for (const w of waiters) { clearTimeout(w.timer); w.resolve(); } waiters.clear();
    s = blank(); occ = new Map();
    Object.assign(s, { active: true, theme, minutes, startedAt: Date.now(), endsAt: Date.now() + minutes * 60000 });
    s.players = players.map((p, i) => ({ id: p.id, name: p.name, host: i === 0, done: false, bricks: 0, cursor: 0 }));
    broadcast(boardMsg());
    post(null, `Playtime started. ${theme ? `Theme: ${theme}.` : 'No theme: invent something unique together.'} Host: ${s.players[0].name}. Players: ${s.players.map((p) => p.name).join(', ')}. ${minutes} minutes on the clock.`, 'system');
  }
  function end(reason) {
    if (!s.active) return;
    s.active = false; s.endedAt = Date.now(); s.reason = reason;
    post(null, `Playtime is over: ${reason}.`, 'system');
    save();
    fx('legoEnd', null, { title: s.title, theme: s.theme, reason, bricks: s.bricks.size });
    markDirty();
  }
  function save() {
    if (!s.bricks.size) return;
    try {
      fs.mkdirSync(buildsDir, { recursive: true });
      const slug = (s.title || s.theme || 'untitled').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'untitled';
      const file = path.join(buildsDir, `${new Date(s.startedAt).toISOString().replace(/[:.]/g, '-')}-${slug}.json`);
      const { title, theme, minutes, startedAt, endedAt, reason, players, chat } = s;
      fs.writeFileSync(file, JSON.stringify({ title, theme, minutes, startedAt, endedAt, reason, players, bricks: [...s.bricks.values()], chat }, null, 1));
    } catch (e) { console.log('[play] could not save the build:', e.message); }
  }
  function loadLatest() {
    try {
      const files = fs.readdirSync(buildsDir).filter((f) => f.endsWith('.json')).sort().reverse();
      if (!files.length) return;
      const saved = JSON.parse(fs.readFileSync(path.join(buildsDir, files[0]), 'utf8'));
      s = { ...blank(), ...saved, active: false, bricks: new Map(saved.bricks.map((b) => [b.id, b])), seq: saved.chat?.at(-1)?.seq || 0 };
      s.nextId = Math.max(0, ...saved.bricks.map((b) => b.id)) + 1;
      rebuildOcc();
    } catch { /* nothing saved yet */ }
  }
  loadLatest();
  // Take the last build apart to free the floor. Saved builds go to builds/shelf (kept, but no longer
  // reloaded on start), so the table stays put away across restarts.
  function clear() {
    if (s.active) return { ok: false, bricks: 0 };
    const bricks = s.bricks.size;
    try {
      const files = fs.readdirSync(buildsDir).filter((f) => f.endsWith('.json'));
      if (files.length) fs.mkdirSync(path.join(buildsDir, 'shelf'), { recursive: true });
      for (const f of files) fs.renameSync(path.join(buildsDir, f), path.join(buildsDir, 'shelf', f));
    } catch (e) { if (e.code !== 'ENOENT') console.log('[play] could not shelve builds:', e.message); }
    s = blank(); occ = new Map();
    broadcast(boardMsg());
    markDirty();
    return { ok: true, bricks };
  }
  setInterval(() => {
    if (!s.active) return;
    if (Date.now() > s.endsAt) end("time's up");
    else if (!s.players.some((p) => present(p.id))) end('everyone left');
  }, 2000);

  function over() {
    if (!s.endedAt) return { ok: false, over: true, text: "There's no LEGO game on right now. Stop here." };
    return { ok: false, over: true, text: `PLAYTIME IS OVER (${s.reason}). Stop now and don't run any more lego commands. Reply with one short line about what the team built${s.title ? ` ("${s.title}")` : ''}, then go idle.` };
  }

  function help(p) {
    const c = cmd(p.id);
    return `LEGO PLAYTIME: how to play
You and your teammates share one ${GRID}x${GRID}-stud baseplate. Together you build ONE thing.
You are ${p.name}${p.host ? ', the HOST' : ''}. Every command: ${c} <command> [args]

  look                      top view, heights, players and recent chat (start here)
  look layer <y>            cross-section of one layer
  look bricks [mine]        brick ids, positions and owners (latest 60)
  say "<message>"           talk to the team
  wait [seconds]            block until a teammate says or builds something (default 45, max 90)
  place '<json>' ["note"]   add up to ${MAX_PER_CALL} bricks in one go; the note tells the team what they are
  remove <id> [id...]       take back your own bricks
  title "<name>"            name the build (anyone can rename it)
  done ["note"]             you're finished; the game ends when every player is done

A brick: {"x":0,"z":0,"w":2,"d":4,"color":"red"}
  x 0-${GRID - 1} west→east, z 0-${GRID - 1} back→front, y = layer (0 sits on the baseplate, top is ${LAYERS - 1})
  w width along x (1-8), d depth along z (1-8), h height in layers (1-6, default 1)
  y is optional: leave it out and the brick drops onto whatever is under it
  shape: brick (default) | tile (smooth top) | slope (add "dir": n|e|s|w, the downhill side) | round (needs w = d)
  colours: ${Object.keys(COLORS).join(' ')}
  Bricks can't overlap. There are ${MAX_BRICKS} bricks in the box.
  Example: ${c} place '[{"x":4,"z":4,"w":4,"d":2,"color":"gray"},{"x":4,"z":4,"w":1,"d":1,"h":4,"color":"white"}]' "west tower base"

How to play well
- ${p.host ? 'You are the host: speak first. Propose one specific, surprising idea and split it into parts or areas, one per player (with x/z ranges).' : 'The host speaks first with an idea and a split of the work. Wait for that plan, then say which part you take or suggest a twist.'}
- Run look before you build. Between batches, use wait to hear the others instead of polling look.
- Say what you're about to build and where. Stay in your area, build bottom-up, and check how your part meets your neighbours'.
- Make it unique: a specific idea with character beats a generic house.
- When it looks finished, agree on a title together, then each of you runs done.
- Use only this command: don't edit files or run anything else. When the game says playtime is over, stop.
- ${timeLeft()} left on the clock.`;
  }

  function invite(id) {
    const p = player(id); const host = s.players[0];
    return `PLAYTIME! Take a break from your current work: you're playing LEGO with the other agents in the office. You are player ${p.name}${p.host ? ', the HOST: you propose the idea and split up the work' : `; ${host.name} is the host and will propose the idea`}. ${s.theme ? `Theme: ${s.theme}.` : 'There is no theme: together, invent and build something unique.'} Start by running \`${cmd(id)} help\`, then use only that command to look, talk, wait for teammates and place bricks until the team agrees the build is finished. Playtime ends in ${s.minutes} minutes.`;
  }

  // ---------- api for lego.mjs ----------
  async function api(name, body) {
    const p = player(body.as); const args = Array.isArray(body.args) ? body.args.map(String) : [];
    if (!s.active) return over();
    if (!p) return err(`Player ${body.as} isn't in this game. Players: ${s.players.map((q) => `${q.name} (id ${q.id})`).join(', ')}.`);
    switch (name) {
      case 'help': return ok(help(p));
      case 'look': {
        let text;
        if (args[0] === 'layer') { const y = Number(args[1]); if (!Number.isInteger(y) || y < 0 || y >= LAYERS) return err(`look layer <0-${LAYERS - 1}>`); text = layerView(y); }
        else if (args[0] === 'bricks') { const list = [...s.bricks.values()].filter((b) => args[1] !== 'mine' || b.by === p.id).slice(-60); text = list.length ? list.map(brickLine).join('\n') : 'No bricks yet.'; }
        else text = topView();
        const chat = s.chat.slice(-15).map(line).join('\n');
        p.cursor = s.seq;
        return ok(`${header(p)}\n\n${text}\n\nRecent chat:\n${chat}`);
      }
      case 'say': {
        const text = args.join(' ').trim(); if (!text) return err('say "<message>"');
        p.done = false; post(p, text); fx('legoSay', p.id, { text: text.slice(0, 120) });
        return ok(withNews(p, 'Said it.'));
      }
      case 'wait': {
        const secs = Math.min(90, Math.max(5, Number(args[0]) || 45));
        if (!unseen(p).length) await new Promise((resolve) => { const w = { p, resolve }; w.timer = setTimeout(() => { waiters.delete(w); resolve(); }, secs * 1000); waiters.add(w); });
        if (!s.active) return over();
        const news = unseen(p); p.cursor = s.seq;
        return ok(news.length ? news.map(line).join('\n') + `\n(${timeLeft()} left)` : `Nothing new in ${secs}s (${timeLeft()} left). Keep building your part, or run look.`);
      }
      case 'place': {
        let list;
        try { list = JSON.parse(args[0] ?? ''); } catch (e) { return err(`That isn't valid JSON (${e.message}). Wrap the array in single quotes, e.g. place '[{"x":0,"z":0,"w":2,"d":4,"color":"red"}]'`); }
        if (!Array.isArray(list)) list = [list];
        if (!list.length) return err('place needs at least one brick');
        if (list.length > MAX_PER_CALL) return err(`${list.length} bricks is too many for one go: send at most ${MAX_PER_CALL}`);
        const note = args.slice(1).join(' ').trim().slice(0, 120);
        const placed = [], errors = [];
        list.forEach((spec, i) => { const r = addBrick(p, spec); if (r.error) errors.push(`  brick ${i + 1}: ${r.error}`); else placed.push(r.brick); });
        if (placed.length) {
          p.bricks += placed.length; p.done = false;
          broadcast({ type: 'legoAdd', by: p.id, bricks: placed });
          post(p, `placed ${placed.length} brick${placed.length === 1 ? '' : 's'}${note ? `: ${note}` : ''}`, 'build');
        }
        const lines = [`Placed ${placed.length} of ${list.length}.`];
        if (placed.length) lines.push(placed.map((b) => `#${b.id} ${b.color} ${b.w}x${b.d} at x${b.x} z${b.z} y${b.y}`).join(', '));
        if (errors.length) lines.push('Not placed:', ...errors);
        return { ok: placed.length > 0, text: withNews(p, lines.join('\n')) };
      }
      case 'remove': {
        const ids = args.flatMap((a) => a.split(/[\s,]+/)).map((a) => Number(a.replace(/^#/, ''))).filter(Number.isInteger);
        if (!ids.length) return err('remove <brick id> [more ids]  (see look bricks mine)');
        const gone = [], refused = [];
        for (const id of ids) {
          const b = s.bricks.get(id);
          if (!b) refused.push(`#${id} doesn't exist`);
          else if (b.by !== p.id) refused.push(`#${id} belongs to ${player(b.by)?.name || 'someone else'}; ask them`);
          else { s.bricks.delete(id); gone.push(id); }
        }
        if (gone.length) { rebuildOcc(); p.bricks -= gone.length; broadcast({ type: 'legoRemove', ids: gone }); post(p, `removed ${gone.length} brick${gone.length === 1 ? '' : 's'}`, 'build'); }
        return { ok: gone.length > 0, text: withNews(p, [gone.length ? `Removed ${gone.map((i) => `#${i}`).join(', ')}. Bricks above them stay where they are.` : 'Removed nothing.', ...refused].join('\n')) };
      }
      case 'title': {
        const t = args.join(' ').trim().replace(/^["']|["']$/g, '').slice(0, 60); if (!t) return err('title "<name>"');
        s.title = t; post(p, `named the build "${t}"`, 'title'); return ok(withNews(p, `The build is now called "${t}".`));
      }
      case 'done': {
        p.done = true; const note = args.join(' ').trim().slice(0, 120);
        post(p, `is done${note ? `: ${note}` : ''}`, 'done');
        const left = s.players.filter((q) => present(q.id) && !q.done);
        if (!left.length) { end(`everyone is done${s.title ? `: "${s.title}"` : ''}`); return over(); }
        return ok(withNews(p, `Marked you done. Still building: ${left.map((q) => q.name).join(', ')}. You can wait to keep up with the chat; anything you place or say makes you un-done.`));
      }
      default: return err(`Unknown command "${name}". Try: ${cmd(p.id)} help`);
    }
  }

  return {
    api, start, end, invite, clear,
    isActive: () => s.active,
    describe: () => s.title ? `"${s.title}"` : s.theme || 'something unique',
    boardMsg,
    meta: () => ({
      active: s.active, theme: s.theme, title: s.title, startedAt: s.startedAt, endsAt: s.endsAt, endedAt: s.endedAt, reason: s.reason,
      brickCount: s.bricks.size, players: s.players.map(({ id, name, host, done, bricks }) => ({ id, name, host, done, bricks })),
      chat: s.chat.slice(-40).map(({ seq, t, from, name, kind, text }) => ({ seq, t, from, name, kind, text })),
    }),
  };
  function boardMsg() { return { type: 'lego', colors: COLORS, bricks: [...s.bricks.values()] }; }
}
