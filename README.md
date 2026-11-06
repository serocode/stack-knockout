# Stack Knockout

Six-player peer-to-peer falling-block knockout. React + TypeScript + Canvas, WebRTC
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

Menu → **Vs Computer**: pick 1–5 bots and a difficulty (Easy, Medium, Hard,
Expert) and play a full knockout match offline. You host the room on an
in-memory network in your tab and the bots join it as ordinary coordinators, so
garbage, bombs, KOs, results and rematches all run the normal code path. You
can add or remove bots and change the difficulty from the lobby between matches.

## Try host migration without other devices

* **Migration lab** (menu → Migration lab): six real coordinators with bots in
  one tab on a simulated network. Kill the host, cut its Wi-Fi, split the room
  3|3 or 2|4, heal, reopen closed tabs.
* **Same-device room:** Create room → tick "Same device only" → share the link
  into up to five more tabs of the same browser. Close the host's tab mid-match.

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
