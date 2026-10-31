# Tetris Knockout

Six-player peer-to-peer Tetris knockout. React + TypeScript + Canvas, WebRTC
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
pnpm build       # static output in apps/web/dist
```

Longer chaos run: `CHAOS_SEEDS=100 pnpm vitest run packages/coordinator/test/chaos.test.ts`

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

Import the repository with the project root at the repo root; `vercel.json`
builds `apps/web` and serves `apps/web/dist`. No environment variables or
functions are needed.

## Customize

Menu → Customize (or 🎨 inside a room): block skins, colours, frames, effects,
backgrounds, ghost and garbage styles, avatar, UI theme, sound pack and music.
Other players see your look; theme and audio are just for you.
Premium items (◆) unlock as your career score grows — every point you score in
practice or online counts. Progress, stats and achievements are saved in this
browser (Menu → Trophies). Settings has
volume sliders, reduce motion / flashing, vibration, and touch control mode.

## Controls

←/→ move · ↓ soft drop · Space hard drop · ↑/X rotate CW · Z rotate CCW ·
C/Shift hold · tap an opponent to target them.
Phones: drag to move · tap left/right half to rotate · swipe down to drop · swipe up to hold, plus an on-screen pad.

## Layout

```
packages/engine        pure game rules (deterministic)
packages/net           transports, authenticated mesh, heartbeats
packages/coordinator   replicated log, host election, recovery
apps/web               React/Canvas presentation
```
