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
- `@<agent>: <task>` or `tell <agent> to <task>` types the task into an agent he launched earlier.
- Anything else goes to the most recently active agent he can reach.

He can only type into sessions that were launched through Pixel Agents. Sessions from the Claude desktop app show up in the office, but he has no way into their window, and he'll tell you so.

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

- `server.mjs` — connects to the Pixel Agents WebSocket read-only, reduces its events into agent state, streams it over Server-Sent Events. No dependencies.
- `public/app.js` — the scene: room, desks, people, drones, particles, HUD.
