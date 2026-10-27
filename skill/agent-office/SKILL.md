---
name: agent-office
description: Run Agent Office 3D, a live Three.js office where every Claude Code session on this machine is a voxel person who walks to a desk, types, glows with the tool in use, and jumps with a bubble when it needs an answer. Use this whenever the user wants to see, watch, monitor, or visualize their running Claude Code agents or sessions, asks for "the office", "the agent office", "pixel agents in 3D", a dashboard of what their agents are doing, or wants a floor manager that can launch agents and hand them tasks from a chat box, even if they do not say "3D" or "office" explicitly.
---

# Agent Office 3D

Everything needed is bundled in `app/` next to this file: a dependency-free Node bridge (`app/server.mjs`) and the browser scene (`app/public/`). The bridge reads live state from a running [Pixel Agents](https://github.com/pixel-agents-hq/pixel-agents) server, which handles the Claude Code hooks and session discovery, so the office is a client of that server, not a replacement for it.

## Before starting: what the user is agreeing to

Say these two things once, plainly, before the first run on a machine:

1. **Pixel Agents installs hooks** into `~/.claude/settings.json` so it can see tool calls, turn ends, and permission prompts. That is how the office knows what agents are doing. Ask before running it the first time.
2. **The bridge is privileged.** It reads the Pixel Agents token from `~/.pixel-agents/servers/` and can launch new Claude Code sessions and type into their terminals. That is what the floor manager chat uses. Nothing leaves the machine; both servers bind to 127.0.0.1.

Requirements: Node 22 or newer (the bridge uses the built-in WebSocket and fetch).

## Starting it

Two long-running processes. Run each in its own terminal tab or as a background process, never as a blocking shell command, or the turn hangs.

Terminal 1, the tracker:

```bash
npx -y pixel-agents@1.5.0 --port 4848
```

Terminal 2, the office (from the `app/` folder of this skill):

```bash
node server.mjs
```

Then open http://127.0.0.1:4900 in a browser and tell the user it is up. Only Claude Code sessions started after the hooks were installed show up, so if the office looks empty, that is why: start a new session and it joins.

Environment overrides, rarely needed: `PIXEL_AGENTS_PORT` if the bridge picks the wrong tracker (it reads the port files under `~/.pixel-agents/servers/`), `PORT` to move the office off 4900.

## What the user can do there

- **Watch.** Each session is a person. Typing means working, the monitor color is the tool in use, drones orbiting are sub-agents, confetti is a finished turn. A red `!` means a permission prompt is waiting, an orange `?` means the agent asked a question, including questions asked through the Claude desktop app's end-of-turn box.
- **Click an agent** to open its screen: current tool, recent activity, context usage, the question or permission it is waiting on, and for agents launched from the office, the raw terminal with a reply box.
- **Talk to the floor manager** in the chat box at the bottom. He walks over and delivers the message. Three forms work:
  - `new agent in <folder>: <task>` launches a Claude Code session in that folder (looked up under Downloads, Documents, Desktop, or a full path) and hands it the task.
  - `@<agent>: <task>` or `tell <agent> to <task>` types into an agent he launched earlier.
  - Anything else goes to the most recently active agent he can reach.
  - `status`, `what is <agent> doing`, `what did <agent> say`: he answers himself. `send <agent> to qa` moves someone to another department. The conversation stays in the 💬 log above the chat box.
  - `play` or `lego` starts playtime: idle agents get a shared LEGO board and build something together (`stop playing` ends it).
- **Skills per job.** Installed skills are attached to jobs (`DEPT_SKILLS` in the bridge): Security runs `/security-report`, UI / UX `/frontend-design`, QA `/replay-qa-loop`, and the manager invokes them as slash commands when he hands out matching work. `skills` and `what can <name> do` list them.
- **Task board.** With a Beads database in the folder (`bd init`), every task the manager hands out becomes a `bd` issue assigned to the agent, closed with the report as its note when the report comes back; open issues show on the wall board and with `tasks` in the chat.
- **Departments and jobs.** The desk floor has Engineering, QA, UI / UX and Security bays. Each agent's job comes with its name (Ezra is Security, Felix UI / UX, Nora QA…; `make <name> qa` changes it). The manager routes unnamed tasks to a free specialist with the right job, launches one when none is free, and passes `HANDOFF: qa — …` lines at the end of an agent's reply on to that department (one hop per task). When a turn ends the agent walks to the manager's office and drops a report on the tray: a notice appears, `📋 reports` counts unread ones, and clicking the tray or the button opens the inbox with the full text.
- Controls: drag to orbit, scroll to zoom, click a person or roster row to follow, `esc` to let go, `orbit` / `sound` / `night` toggles.

## Limits worth telling the user

- Sessions from the Claude desktop app appear in the office but have no terminal the bridge can type into, so the manager cannot give them tasks and answer buttons for them show a hint to answer in the app. Only sessions launched through Pixel Agents (or from the office) can be driven from the office.
- If the bridge prints `read-only: no token found`, Pixel Agents is not running or was started by a different user; start it first, then restart the bridge.

## If something is off

- Office page loads but nobody is there: Pixel Agents is not running, or no session has started since the hooks went in. Check that `~/.pixel-agents/servers/` has a `<pid>-<port>.json` file for a live process.
- Bridge says `connecting` forever: wrong port. Set `PIXEL_AGENTS_PORT` to the port in that json file.
- Port 4900 in use: set `PORT` to another value and open that instead.
