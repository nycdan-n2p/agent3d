#!/usr/bin/env node
// The only tool a playing agent needs: node lego.mjs <your id> <command> [args]
// It talks to the Agent Office bridge, which owns the shared LEGO board. Run "help" for the rules.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [id, cmd = 'help', ...args] = process.argv.slice(2);
const base = `http://127.0.0.1:${process.env.AGENT_OFFICE_PORT || 4900}/api/lego`;
if (!id || !/^\d+$/.test(id)) {
  console.log('usage: node lego.mjs <your player id> <command> [args]   (try: help)');
  process.exit(1);
}
try {
  // The bridge writes a fresh token here (0600) each time it starts and refuses calls without it.
  const token = fs.readFileSync(path.join(os.homedir(), '.agent-office', 'token'), 'utf8').trim();
  const r = await fetch(`${base}/${encodeURIComponent(cmd)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': token }, body: JSON.stringify({ as: Number(id), args }),
  });
  const j = await r.json();
  console.log(j.text || j.message || JSON.stringify(j));
  process.exit(j.ok === false && !j.over ? 1 : 0);
} catch (e) {
  console.log(`Can't reach the Agent Office at ${base} (${e.message}). Playtime is probably over: stop here.`);
  process.exit(1);
}
