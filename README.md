# Agent Office 3D

A Three.js office where every Claude Code session on this Mac is a little voxel person. They walk to their desk and type when working, their monitor glows the color of the tool they are using, sub-agents orbit as drones, confetti flies when a turn ends, and a red `!` bubble bounces when an agent needs approval.

It reads live state from a running [Pixel Agents](https://github.com/pixel-agents-hq/pixel-agents) standalone server, so hooks and session discovery are handled there.

## Run

Terminal 1, the tracker:

```bash
npx -y pixel-agents@1.5.0 --port 4848
```

Terminal 2, the 3D office:

```bash
npm start
```

Then open http://127.0.0.1:4900. The bridge finds the Pixel Agents port on its own from `~/.pixel-agents/servers/`; set `PIXEL_AGENTS_PORT` to override and `PORT` to move the office.

## The floor manager

The person in the hard hat takes instructions from the chat box at the bottom. He walks to the agent concerned, says it in a speech bubble, and the agent gets to work. Three kinds of request work:

- `new agent in <folder>: <task>` launches a Claude Code session in that folder (looked up under Downloads, Documents, Desktop or as a full path) and hands it the task once it has booted.
- `@<agent>: <task>` or `tell <agent> to <task>` types the task into an agent he launched earlier. When that agent finishes, its answer comes back into the chat.
- `status`, `what is <agent> doing`, `where is <agent>`, `what did <agent> say` and `show the last report` he answers himself, on the spot.
- `send <agent> to qa` (or security, engineering, ui/ux) moves someone to another department.
- Anything else goes to the most recently active agent he can reach.

The whole conversation stays in the 💬 log above the chat box, so nothing he says disappears with the speech bubble.

He can only type into sessions that were launched through Pixel Agents. Sessions from the Claude desktop app show up in the office, but he has no way into their window, and he'll tell you so.

## Departments and the office

The desk floor is split into four glass-walled bays: **Engineering**, **QA**, **UI / UX** and **Security**. Every agent has a job that comes with its name: Ezra is always Security, Felix always UI / UX, Nora QA, and so on (the table is `NAME_ROLES` in `server.mjs`). The job is remembered with the name in `names.json`, and you can change it with `make Ezra qa`, `send Felix to engineering`, or the job picker on the agent's screen.

The floor manager routes by job. A task with no agent named (`run the test suite`, `audit the token handling`, `restyle the roster`) goes to a free specialist with the matching job; if nobody with that job is on the floor, he brings one in (`No Security specialist is free. Bringing one in to monitoragents…`), launched in the folder of the busiest project, and hands over the task. `new security agent in <folder>: <task>` hires one by hand. Agents can also pass work along: a task handed out by the manager carries a note that the agent may end its reply with `HANDOFF: qa — <what to do>`, and the manager then gives that follow-up, with the report as context, to a specialist with that job. One handoff per task, never to the agent's own department, and each handoff is filed as an issue linked to the original.

To the right of the lounge is the floor manager's **office** with a report tray. When an agent finishes a turn it picks up a sheet of paper, walks to the office and drops its report (the final message of the turn, plus the desktop app's recap when there is one) on the tray. You get a notice at the bottom of the screen, the `📋 reports` button counts the unread ones, and clicking the tray, the notice or the button opens the inbox, where each report shows its department, the task it answered and the full text. Reports are kept in `reports.jsonl` so they survive a restart. If an agent ends its turn with a question for you it stays at its desk, but the report is filed anyway and marked.

## The task board

If the folder has a Beads database (`bd init`), the floor manager files an issue for every task he hands out: the agent is the assignee, the request is the description, and the issue sits in progress until the agent's report comes back, which the agent appends as a note before closing it. If the agent ends with a question the issue stays open with the note attached. Open issues are drawn on the task board on the left wall, `tasks` in the chat lists them, and each report in the inbox names its issue. Agents launched in a Beads-enabled folder also get `bd prime` through the repo hooks, so they track their own sub-tasks there too.

## Playtime

Say `play` (or press 🧱 play) and the floor manager hands every idle agent he can type into a box of LEGO. They share one 24×24-stud baseplate on the lounge table and have to agree on something to build: the first player is the host, who proposes an idea and splits up the work; the others claim parts, and they talk it through in the panel on the left while bricks drop onto the table. The game ends when every player runs `done`, when the clock runs out, or when you say `stop playing`. Finished builds are saved in `builds/`, and the latest one stays on the table.

- `play: a lighthouse` gives them a theme; without one they invent something.
- `play with 3` also launches three fresh players in `playroom/` (handy when nobody is idle), and `play for 20 min` changes the clock (15 by default).
- Agents play through `node lego.mjs <id> <command>` and nothing else (`help` prints the rules). Fresh players in `playroom/` are pre-approved to run it; an agent from another project will ask for approval the first time, which you can grant from his screen.

Click an agent to open his screen: current tool, recent activity, context usage, sub-agents, and for launched agents the raw terminal with a reply box (send text, Enter, 1, 2, Esc) so you can answer prompts without leaving the office. When an agent needs your approval or asks a question, he stands up, turns around, and jumps.

## Controls

- drag to orbit, scroll to zoom
- click a person (or a roster row) to follow them, `esc` to let go
- `orbit` toggles auto-rotate, `sound` chimes when an agent finishes, `night`/`day` switches lighting

## Files

- `server.mjs` — connects to the Pixel Agents WebSocket, reduces its events into agent state, classifies each agent into a department, reads finished turns out of the transcripts as reports, and streams everything over Server-Sent Events. No dependencies.
- `reports.jsonl` — every report filed, one per line (ignored by git).
- `public/app.js` — the scene: room, desks, people, drones, particles, HUD.
