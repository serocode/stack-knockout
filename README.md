# Stack Knockout

Up-to-ten-player peer-to-peer falling-block knockout: free-for-all or teams (up to 5 v 5). React + TypeScript + Canvas, WebRTC
mesh via Trystero, automatic host migration. No game server, no database.

See **ARCHITECTURE.md** for the networking design, migration protocol,
limitations and third-party costs.

## Run

```bash
pnpm install
pnpm test        # engine, networking, migration scenarios, chaos, module boundaries
pnpm typecheck
pnpm dev         # http://localhost:5173, and http://<your-LAN-IP>:5173 for phones
pnpm dev:https   # optional: self-signed https dev server
pnpm build       # static output in dist (copied from apps/web/dist)
```

Longer chaos run: `CHAOS_SEEDS=100 pnpm vitest run packages/coordinator/test/chaos.test.ts`

## Play against the computer

Menu → **Vs Computer**: pick free-for-all or teams, 1–9 bots, a number of
rounds and a difficulty (Easy, Medium, Hard, Expert), and play offline. You
host the room on an in-memory network in your tab and the bots join it as
ordinary coordinators, so teams, rounds, garbage, bombs, KOs, rankings and chat
all run the normal code path. In the waiting room you can add or remove bots,
move them between teams (⇄), change the difficulty, and mute their chatter.

## Try host migration without other devices

* **Migration lab** (menu → Migration lab): six real coordinators with bots in
  one tab on a simulated network. Kill the host, cut its Wi-Fi, split the room
  3|3 or 2|4, heal, reopen closed tabs.
* **Same-device room:** Create room → tick "Same device only" → share the link
  into up to nine more tabs of the same browser. Close the host's tab mid-match.

## Real multiplayer

Phones on your Wi-Fi can open `pnpm dev`'s network URL (`http://192.168…:5173`)
directly. Browsers hide WebCrypto on such plain-http pages, so the app supplies
a pure-JS replacement there (`packages/net/src/webcrypto-shim.ts`, tested
byte-for-byte against native WebCrypto). On https (Vercel) the native API is used.

Create room (online), share the invite link. Friends need the link, or the room
code **and** invite key. If some friends can't connect (strict NAT / mobile
data), add a TURN server under Settings (Metered's free tier works).

## Deploy to Vercel

Import the repository and leave **Root Directory** empty (the repo root).
`vercel.json` runs `pnpm build`, which builds `apps/web` and copies the output
to `dist`. Framework preset "Other" or "Vite" both work; leave the build and
output overrides off. No environment variables or functions are needed.

## Teams, rounds and rankings

The host sets these in the waiting room:

* **Mode:** free-for-all, or **teams** (▲ Red Team vs ■ Blue Team, up to 5 v 5; every team marker pairs the colour with its shape).
  How teams are formed is up to the host:
  * **Players choose:** players are balanced onto teams as they join; anyone can
    switch to a team with a free slot, and the host can move players, even out or shuffle them.
  * **🎲 Random:** even teams are drawn at random when the series starts and kept for every round.
  * **🎲 Random every round:** new random teams before each round; the final ranking is by player.
  You can't target or knock out a teammate, and you can only coach teammates.
  A round ends when one team has nobody left standing.
* **Rounds:** 1, 3, 5, 7 or 10. After every round you see that round's ranking
  and the overall standings (with ▲▼ movement); the next round starts by itself
  after 15 s, or when the host presses *Start now*. Players who joined mid-round
  play from the next round. *End series* goes back to the waiting room early.
* **Points per round:** free-for-all — 1 per player you outlast, +2 for the win,
  +1 per KO. Teams — +3 if your team wins, +1 if you were still standing, +1 per KO.
* **After the last round:** the champion (or winning team), a podium, the overall
  ranking, a round-by-round grid, awards (MVP, Knockout king, Artillery, Line
  machine, High roller, Survivor) and the achievements you unlocked during the series.

## Room chat

Everyone in a room can chat in the waiting room, on the results screens, and
during a match (💬 bottom-left, or press **T**; your keys go back to the game
when you leave the box). Room events (joins, round results) appear in the feed.
In team rooms, toggle **All / Team** to talk to your team only. Late joiners get
the last few public messages. Chat is rate-limited and never enters the game log.

## Waiting rooms

Menu → **Waiting rooms** lists public rooms. New rooms are listed by default
(**List in Waiting rooms** on the Create screen; the host can switch it off any
time under **List publicly** in the room settings). A listed room is announced
every few seconds and answers right away when someone opens the list (online rooms over the Nostr relays, same-device rooms over a
BroadcastChannel) and drops off the list within seconds of closing. Joining a
room that's mid-game lets you watch and play from the next round. A listed room
is joinable by anyone who sees it. The host can remove (✕) a player, who then
can't rejoin that room.

## Bomb garbage

The host can turn on bomb garbage in the lobby. Some incoming garbage rows then
carry a bomb (one per batch, every other row, or every row). Clear a bomb's row
and it goes off:

* **Line** also clears the row beneath it.
* **Area** destroys the 8 cells around it.
* **Column** destroys everything below it.

Bombs caught in a blast go off too, so stacked bombs chain. Each bomb can also
add 0 to 3 bonus attack lines. The rules are fixed when the match starts.

## Customize

Menu → Customize (or 🎨 inside a room): block skins, colours, frames, effects,
backgrounds, ghost, garbage and bomb styles, avatar, UI theme, sound pack and music.
Other players see your look; theme and audio are just for you.
Premium items (◆) unlock as your career score grows — every point you score in
practice or online counts. Progress, stats and achievements are saved in this
browser (Menu → Trophies). Settings has
volume sliders, reduce motion / flashing, vibration, and touch control mode.

## Controls

←/→ move · ↓ soft drop · Space hard drop · ↑/X rotate CW · Z rotate CCW ·
C/Shift hold · tap an opponent to target them.
Phones: drag to move · tap left/right half to rotate · swipe down to drop · swipe up to hold, plus an on-screen pad.

## Coaching and callouts

* **Coach:** once you're knocked out (or while spectating a match you joined
  late), tap a live player's board to coach them. Move or rotate a ghost of
  their current piece (arrows / Z / X, C for hold, B for the bot's pick, or tap
  a column), then press **Suggest** (Enter). Other coaches' ideas show on the
  same board in their own colours.
* **Getting coached:** suggested spots appear outlined on your board, with a card
  under NEXT. Press **G** (or tap the card) to drop your piece there. The room
  is told whose suggestion you used. The suggestion expires when that piece locks.
* **Callouts:** 👏 🎯 🆘 ⚠️ 🌀 🤝 under your board, or keys **1–6**. 🎯 names
  your current target (or the leader, if you're spectating). They show as
  speech bubbles over the sender's board.
* Settings → Coaching turns incoming suggestions and callouts off.

## Layout

```
packages/engine        pure game rules (deterministic)
packages/net           transports, authenticated mesh, heartbeats
packages/coordinator   replicated log, host election, recovery
apps/web               React/Canvas presentation
```
