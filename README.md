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

The desk floor is split into four glass-walled bays: **Engineering**, **QA**, **UI / UX** and **Security**. The bridge watches what each agent is doing and seats it accordingly: running tests, linters or type checks moves it to QA, touching stylesheets, HTML or design work moves it to UI / UX, audits and anything about secrets or vulnerabilities moves it to Security, and editing ordinary code brings it back to Engineering. The prompt that started the turn counts too, so `QA: run the suite` lands in QA from the start. You can override it: `send <agent> to security`, or the department picker on the agent's screen.

To the right of the lounge is the floor manager's **office** with a report tray. When an agent finishes a turn it picks up a sheet of paper, walks to the office and drops its report (the final message of the turn, plus the desktop app's recap when there is one) on the tray. You get a notice at the bottom of the screen, the `📋 reports` button counts the unread ones, and clicking the tray, the notice or the button opens the inbox, where each report shows its department, the task it answered and the full text. Reports are kept in `reports.jsonl` so they survive a restart. If an agent ends its turn with a question for you it stays at its desk, but the report is filed anyway and marked.

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
