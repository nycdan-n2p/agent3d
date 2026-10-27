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

## Skills belong to jobs

The skills installed on this Mac are attached to the job that does that work, and the manager invokes them as slash commands when he hands a task to a specialist: ask Ezra (or anyone in Security) for a security report and he runs `/security-report`; a design task for Felix runs `/frontend-design`; "QA the app" runs `/replay-qa-loop`. Each job's first skill is its default for any in-job task without a named skill. The table is `DEPT_SKILLS` in `server.mjs`, `skills` in the chat lists it, `what can Ezra do` describes one agent, and the agent's screen shows the skills for its job.

| Job | Skills |
| --- | --- |
| Security | `/security-report` (default), `/security-review` |
| UI / UX | `/frontend-design` (default), `/lemo-opuscar:lemo-opuscar` (video producers: Vera, Remy, Sol, Juno), `/gpt-image-2-style-library` |
| QA | `/qa-do` (default; routes to the 50 [qa-skills](https://github.com/petrkindlmann/qa-skills) workflows), `/bug-reproduction`, `/agentic-browser-testing`, `/playwright-automation`, `/exploratory-testing`, `/unit-testing`, `/api-testing`, `/accessibility-testing`, `/visual-testing`, `/performance-testing`, `/test-planning`, `/release-readiness`, `/replay-qa-loop` (say "replay"), `/code-review` |
| Engineering | `/codebase-memory`, `/simplify`, `/graphify` (only when the task asks for them) |

## The task board and the queue

If the folder has a Beads database (`bd init`), the floor manager files an issue for every task he hands out: the agent is the assignee, the request is the description, and the issue sits in progress until the agent's report comes back, which the agent appends as a note before closing it. If the agent ends with a question the issue stays open with the note attached. Open issues are drawn on the task board on the left wall, `tasks` in the chat lists them, and each report in the inbox names its issue.

The board is also a queue. The manager works through it by himself: any open issue with no assignee and no open blocker is eligible (label one `hold` to keep it back), highest priority first. For each he hires a fresh specialist whose job matches the issue, in that issue's own git worktree of this project (`.worktrees/<id>` on branch `office/<id>`), hands over the task with the rule to commit on that branch and never push, and the report closes the issue. At most four run at once (`queue limit 6`, or `OFFICE_WORKERS=6` at start); agents you hire yourself don't count. `queue: <task>` files a new issue straight onto the queue, `queue` shows what is running and waiting, `queue next` dispatches one right away, `queue off` pauses it while running workers finish, and `queue on` resumes it. The queue runs from the start unless the bridge is started with `OFFICE_QUEUE=off`. Queued workers only run a skill the issue names; a worktree worker's report says which branch holds its commits, and the worktrees stay until you remove them (`git worktree remove .worktrees/<id>`).

## Playtime

Say `play` (or press 🧱 play) and the floor manager hands every idle agent he can type into a box of LEGO. They share one 24×24-stud baseplate on the lounge table and have to agree on something to build: the first player is the host, who proposes an idea and splits up the work; the others claim parts, and they talk it through in the panel on the left while bricks drop onto the table. The game ends when every player runs `done`, when the clock runs out, or when you say `stop playing`. Finished builds are saved in `builds/`, and the latest one stays on the table.

- `play: a lighthouse` gives them a theme; without one they invent something.
- `play with 3` also launches three fresh players in `playroom/` (handy when nobody is idle), and `play for 20 min` changes the clock (15 by default).
- Agents play through `node lego.mjs <id> <command>` and nothing else (`help` prints the rules). Fresh players in `playroom/` are pre-approved to run it; an agent from another project will ask for approval the first time, which you can grant from his screen.

Click an agent to open his screen: current tool, recent activity, context usage, sub-agents, and for launched agents the raw terminal with a reply box (send text, Enter, 1, 2, Esc) so you can answer prompts without leaving the office. When an agent needs your approval or asks a question, he stands up, turns around, and jumps.

## Your office upstairs

A mezzanine runs along the front of the room, up a flight of stairs on the left: your own desk, a sofa and plants, behind a glass railing that looks down over all four bays, the lounge and the floor manager's office. The monitor on your desk is your inbox: every agent waiting on an approval (red) or an answer (amber), oldest first, with what it is asking and how long it has waited. Click a row and the camera goes to that agent with its answer buttons open. Under the inbox a strip shows the day at a glance: agents working, reports filed today, open tasks and the queue. The camera starts there, and `🪜 my office` brings it back; `overview` swings out to a corner view of the whole floor, and `orbit` turns the slow spin on. Say `put away the lego` (or `clear the table`) when you have seen enough of a build and the play table disappears from the lounge, with the build saved under `builds/shelf/`.

## Controls

- drag to orbit, scroll to zoom
- click a person (or a roster row) to follow them, `esc` to let go
- `🪜 my office` returns to the balcony view, `overview` to the corner view, `orbit` toggles auto-rotate, `sound` chimes when an agent finishes, `night`/`day` switches lighting

## Files

- `server.mjs` — connects to the Pixel Agents WebSocket, reduces its events into agent state, classifies each agent into a department, reads finished turns out of the transcripts as reports, and streams everything over Server-Sent Events. No dependencies.
- `reports.jsonl` — every report filed, one per line (ignored by git).
- `public/app.js` — the scene: room, desks, people, drones, particles, HUD.
