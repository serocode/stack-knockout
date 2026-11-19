# Stack Knockout — Architecture

Backend-free, peer-to-peer, up to ten players (free-for-all or up to 5 v 5
teams), with automatic host migration.
Static frontend on Vercel; no game server, no database, no accounts.

This document answers the eight "before writing code" questions in spec §14 and
records the decisions, limitations and third-party costs required by §15.

---

## 1. Existing project (spec §14.1–2)

`~/Game Dev` contained only the `gamedev` skill bundle — no prior game code —
so this is a fresh build. The gamedev router has no catalog skill for a custom
TypeScript Canvas engine, so it was treated as a custom engine and the work
was bound to verified local APIs (our own engine), per the router's
custom-engine path.

## 2. Module layout

```
packages/engine        Board, pieces, SRS, 7-bag, T-spins, scoring, garbage maths,
  (pure TS)            deterministic PlayerSim, LiveController, bot.  No DOM, no net.

packages/net           Transport interface; Trystero (WebRTC), BroadcastChannel and
  (no game imports)    in-memory simulator transports; authenticated Mesh (HMAC
                       challenge/response, size limits, rate limits, dedup, heartbeats).

packages/coordinator   Replicated state machine + log, host election, host epochs,
  (engine + net)       commit tracking, snapshots, recovery, reconnection, the local
                       player's optimistic simulation.  No DOM.

apps/web               React + Canvas presentation: menus, lobby, match, results,
  (everything)         spectating, migration lab, settings.  Cosmetics live here only.
```

`packages/coordinator/test/boundaries.test.ts` fails the build if a lower layer
imports an upper one or touches the DOM, so the separation is enforced, not
conventional.

## 3. Networking architecture (spec §14.3)

**Full mesh.** Every peer holds one WebRTC connection to every other peer
(≤ 45 links for 10 players). Gameplay never touches the signaling relay.

**Logical channels** (`packages/net/src/transport.ts`), each with its own size
cap and token-bucket rate limit in the Mesh:

| Channel | Carries | Delivery |
|---|---|---|
| `auth` | room-secret challenge/response | reliable, ordered |
| `crit` | log entries, placements, elections, state sync | reliable, ordered, de-duplicated by message id |
| `state` | acknowledgements | reliable |
| `hb` | heartbeats (epoch, host, last applied seq, commit index, own ping to host), 1 Hz ping/pong | reliable |
| `viz` | coaching suggestions, callouts, room chat | reliable, non-critical |
| `live` | falling-piece positions (≤20 Hz) and provisional locks | **unordered, no retransmits**, newest wins |

Trystero multiplexes these over one reliable, ordered data channel per peer.
`live` gets its own negotiated `RTCDataChannel` on the same connection
(`ordered: false, maxRetransmits: 0`, stream id 77), so a lost packet costs one
stale frame instead of stalling everything queued behind it. A peer only uses
it after receiving something on it (a probe round trip). Until then, and for
older clients, `live` falls back to Trystero's channel.

**Perceived delay.** Your own board never waits for the network. For
opponents:
* Falling-piece positions are sent as soon as they change, at most every 50 ms
  (a trailing send guarantees the final position goes out). Sequence numbers
  drop packets that arrive out of order.
* On lock, the player sends the placed piece on `live` directly to everyone.
  Their board shows it (with any line clears applied locally) one hop later,
  instead of waiting two hops for the host's log entry. The log entry then
  replaces it. If the host rejects the lock, the next preview of the same
  piece drops it.
* Garbage still lands after the host-timed 500 ms cancel window. That delay is
  a game rule, not network lag.

**Not broadcast:** rendering state. Opponent boards are *reconstructed* from
the authoritative log (every placement is an entry), so no board snapshots are
streamed. Only the falling piece position is sent, on `viz`.

**Authentication.** The room code is only a topic name. The separate 10-char
invite key (≈49 bits) (a) is Trystero's `password`, which encrypts SDP on the
relay, and (b) keys an HMAC challenge/response that binds each transport peer
to a player id before any other message is accepted. Nonces are fresh per
connection and the proof covers both transport ids, so proofs cannot be
replayed or relayed. HMAC is plain TypeScript (no `crypto.subtle`), so phones
on a plain-`http` LAN dev server work too.

## 4. Signaling choice (spec §14.4)

Verified (not assumed) what each option actually provides:

| Option | Room presence / discovery | Backend needed | Verdict |
|---|---|---|---|
| **Trystero 0.26 (Nostr strategy)** | `joinRoom` + `onPeerJoin`/`onPeerLeave`/`getPeers` per room topic; `password` encrypts SDP | No — public Nostr relays | **Chosen** |
| Trystero BitTorrent / MQTT | Same API, different public relays | No | Drop-in alternatives |
| Trystero Firebase / Supabase | Same API; managed, with an SLA | Managed DB (Realtime DB / Postgres) | Possible upgrade; arguably conflicts with "no database" |
| PeerJS Cloud | Free broker; peer listing (`allow_discovery`) is off by default and only on self-hosted servers; no stated limits or SLA; docs point to self-hosting for production | Yes, for discovery | Rejected |

Trystero is built on native WebRTC and sits behind our `Transport` interface,
satisfying "native WebRTC or PeerJS behind a replaceable abstraction".
Relay URLs can be overridden in Settings without a redeploy. The defaults are
pinned (`DEFAULT_RELAYS` in `trystero-transport.ts`): Trystero's own pick for
our app id included a dead relay and one that rate-limits. WebRTC signaling
needs WebCrypto, which browsers only expose on HTTPS and localhost; on other
http pages (a phone opening the dev server by LAN address) the app installs a
pure-JS `crypto.subtle` built on @noble/hashes and @noble/ciphers, verified
byte-identical to native WebCrypto by `webcrypto-shim.test.ts`.

## 5. Room discovery and code resolution (spec §14.5)

There is **no room registry**. A room exists only while at least one peer is in it.

* **Create:** generate room code (6 chars), invite key (10 chars), expiry, and
  a 128-bit player id; join the relay topic `tk1-<code>`; bootstrap the log at
  epoch 1 with yourself as host.
* **Join:** link (`/#/join?r=CODE&k=KEY&e=EXPIRY` — the fragment never reaches
  any server) or manual code + key. The joiner subscribes to the topic,
  authenticates with every peer, then sends `join` until a host admits it
  (≤10, not closed, not kicked) and replies with a full state sync. It then connects to
  everyone (mesh) and appears in the lobby.
* **Expired invite:** refused client-side (convenience only — anyone with the
  key could edit the timestamp).
* **Abandoned / empty room:** nobody answers on the topic; after 12 s the UI says
  so and offers to re-open the room as host.
* **Closed room:** the host appends `close`; joiners get `join_rej: closed`.
* **Duplicate identity:** a second connection claiming a live player id is
  rejected by the Mesh. A reloaded tab is briefly "duplicate" until its old link
  expires; it keeps retrying and only gives up after 20 s.
* **Identity:** player id in `localStorage` per room (reopening the link restores
  you); a per-tab lock gives a second tab its own identity.

## 6. Host authority, migration and recovery (spec §14.6)

### The replicated log

All authoritative state is one deterministic state machine
(`coordinator/src/state.ts`) driven by an append-only log. Only the host
appends; everyone applies the same entries in the same order and reaches the
same state hash. Entries: `join, presence, leave, ready, cosmetics, start, go,
place, target, options, team, kick, next, end, rematch, close, noop`.
`options` holds the host's waiting-room settings (mode, rounds, public
listing, room name, bomb garbage). They are copied into the match at `start`,
so they can't change mid-game. Bomb positions are drawn from the
match RNG when garbage is ordered, so every peer gets the same board.

Every authoritative message carries **match id, host id, host epoch, sequence
numbers and a message id** (spec §6 "Host Epoch").

### Host-authoritative gameplay

* Each player simulates their own board locally and optimistically.
* On lock, the player sends a `Placement` (piece index, type, hold use, final
  x/y/rotation, last-move-was-rotation + SRS kick index, garbage chunk ids
  inserted). The host replays it on its **shadow copy using the identical
  engine code** and rejects it unless: correct piece from that player's seeded
  7-bag (hold transitions included), no collision, grounded, **reachable from
  spawn by BFS over SRS moves**, and any claimed rotation-into-place exists with
  that kick (so T-spins can't be faked). Line clears, T-spin kind, combo, B2B,
  perfect clear, attack and score are computed by the host, never trusted.
* Garbage: attacks cancel the attacker's own incoming queue oldest-first; the
  remainder goes to a target (random / manual / revenge, host-seeded RNG). After
  a 500 ms cancellation window, garbage is *commanded* on the target's next
  non-clearing lock (≤8 rows per lock); the target reports which commanded
  chunks it inserted, and withholding them for >6 pieces is rejected.
* Rejected placement → the player's board is reset to the authoritative copy.

**Simultaneous attacks and top-outs (spec §8):** the host processes placements
in arrival order, one at a time, and the log order is the truth. Of two players
who top out "at the same time", the one whose placement the host logs first is
eliminated first and places lower; if that leaves one player alive, the other
placement is rejected because the match has ended. Ties are therefore broken by
host arrival order — deterministic and identical on every peer.

### Commit index

The host tracks every member's acknowledged sequence (acks + heartbeats).
An entry is **committed** once a majority of voting members have it. "Victory"
is only shown as confirmed when the match-ending entry is committed.

### Election (deterministic, quorum-based)

1. **Detect:** host traffic silent for 2.5 s, its connection closes, or it
   says `leaving`. Peer enters *leaderless* and pauses its board.
2. **Order:** eligible = connected voting members minus the lost host, sorted
   by seat (join order, stable) then player id — never display names. Rank *r*
   waits *r* × 500 ms before standing.
3. **Pre-vote:** the candidate asks "would you vote for me in epoch e+1?"
   Peers say yes only if they also consider the host dead and know of no live
   higher-priority candidate. Without a pre-vote majority, the epoch is not
   bumped — so an isolated peer can't inflate epochs and disrupt the room later.
4. **Vote:** epoch increments; each peer votes at most once per epoch. **Every
   vote carries the voter's latest local snapshot plus its log suffix.**
5. **Win** at a majority of voting members. The winner adopts the most
   up-to-date state among the votes (later epoch, then longer log) — it does not
   assume it has the latest state — appends a `noop` in its new epoch (so older
   entries commit with it), marks unreachable players disconnected, broadcasts a
   full sync, and resumes play after 1.5 s.
6. **Retry:** an attempt that doesn't reach quorum within 2.5 s is dropped and
   retried with backoff.

**Why committed state is never lost:** a committed entry is on a majority; the
winner's votes come from a majority; two majorities intersect, so at least one
vote contains every committed entry, and the winner picks the most complete
log. Uncommitted entries may be dropped; a player whose own placement was
dropped still has it pending and resends it to the new host.

**Snapshots (spec §6 "State Recovery"):** every peer checkpoints its own copy
of the state every ~32 committed entries (roster, eliminations, placements,
garbage queues, pending/commanded attacks, scores, match clock, randomizer
state, epoch, last seq — the full serialized room state). Votes and syncs send
checkpoint + suffix, verified by replay and hash on receipt.

### Split-brain protection (spec §6)

* Only one host per epoch can exist: one vote per peer per epoch + majority quorum.
* Followers reject any message from an epoch older than their own (counted in
  `stats.staleRejected`; covered by a test).
* A host that cannot hear a majority for 3 s during a match **steps down** and
  pauses, so a minority partition can never keep playing or declare a winner.
* Quorum is a majority in **every phase**. (Early on, the lobby used a quorum
  of one; the randomized chaos test showed that a lone host could then "commit"
  the very entry that ends a match, because it flips the phase to `ended`.)
* Membership changes are applied one at a time (Raft single-server rule): a
  join/leave is appended only after the previous one commits.
* Conflicting elections time out and retry with a higher epoch.
* If no host can be established for 20 s mid-match, the match ends as
  **no result** on every peer; nobody invents a winner.

### Reconnection (spec §7)

* Disconnected players keep their identity and seat for 30 s (spec "reserved
  temporarily"); the host marks them `presence: disconnected`.
* Coming back (same link, same browser) re-authenticates the same player id; the
  host sends a full sync and their board is restored **bit-for-bit** from the
  log (tested by hash). Unacknowledged placements are resent.
* After 30 s, the host appends `leave(timeout)`: forfeit if mid-match.
* The original host reconnecting after a migration sees a higher epoch, syncs,
  and continues as a regular player — it never reclaims authority.
* Closing or reloading a tab does **not** forfeit (the identity is reserved); the
  explicit Leave button does.

### Ping

The Mesh sends a timestamped `ping` on `hb` every second, and the peer echoes
it back as `pong`. The result is smoothed (EWMA, α = 0.3) into a per-peer
round-trip time, which is cleared when the peer goes down. Each heartbeat also
carries the sender's ping to its host, so every player can show everyone's
**ping to the host** (`Coordinator.pingToHost`). That is the delay that
matters here: your own board is simulated locally and never waits, but
opponents' placements, garbage and KOs pass through the host before they
reach you.

### Teams and series

* **Teams.** Every roster entry carries a team (1 or 2), balanced on `join`;
  `team` entries move players (max 5 per side). When the room plays teams,
  `start` freezes a `pid → team` map into the match. With `teamPick` set to
  `random` (drawn once per series) or `round` (drawn before every round), the
  map comes from `drawTeams`: a Fisher–Yates shuffle seeded by the match seed,
  dealt alternately, so every peer computes the same even split without any
  extra messages. The draw is written back to the roster so the waiting room
  shows it. A series with redrawn teams is marked `mixed` and ranked by player. Target selection skips
  teammates, a manual `target` naming a teammate is rejected, a KO is never
  credited to a teammate, and the match ends when only one team has players
  alive (all its survivors share first place; `MatchResult.winnerTeam`).
* **Series.** `start` from the waiting room opens a `Series` of
  `options.rounds` rounds; every match end (knockout or no-contest) folds the
  round's rankings and points into replicated standings, so every peer shows
  the same table and a migrated host carries on mid-series. `next` starts the
  following round straight from the results screen (late joiners included,
  disconnected players sit it out). The host appends it after a 15 s
  intermission, measured from when the match end is committed; a new host
  restarts the timer. `rematch` before the last round ends the series early.
* **Kick.** `kick` removes a player like `leave` (forfeit mid-match) and adds
  them to a replicated `kicked` list; the host refuses their `join` from then on.
  It is a membership change, so it follows the one-at-a-time rule.

### Room chat

Advisory and never in the log, like callouts. `chat` (≤ 200 chars, control and
bidi-override characters stripped) goes out on `viz`, to everyone or, in team
rooms, only to teammates; receivers check roster membership and team, and
throttle each sender (5 per 5 s). Each peer keeps its own last 120 messages.
When the host admits a new member it sends `chat_hist` (the last 30 public
messages) on `crit`; only the host's copy is accepted, once.

### Public room directory ("waiting rooms")

`packages/net/src/directory.ts`. Still no server: the current host of a room
with `options.listed` re-announces `{code, key, title, players, mode, round…}`
every 4 s, and browsers drop listings not heard for 15 s (or on an explicit
withdrawal). Online rooms use signed **ephemeral** Nostr events (kind 21377,
tag `stack-knockout-rooms-v1`) sent straight to the relays over websockets —
no WebRTC, so browsing costs nothing for the listed rooms — and same-device
rooms use a BroadcastChannel. Every member runs the announcer and only the
current host publishes, so a migrated room stays listed. Listings are
validated like any payload.

### Coaching and callouts

Advisory only, and never in the log. `sug` (a hard-drop spot for a player's
piece *n*), `sug_ok` ("I used X's suggestion") and `call` (a short callout
code plus an optional named participant) go out on `viz`. Receivers check the
match id and the sender's roster membership. Only room members who are out of
the match may coach, and only players who are still alive can be coached.
Suggestions are kept per coach, per coached player, and lapse once piece *n*
locks or after 20 s. Callouts are throttled on both ends. Following a
suggestion only issues the player's own hold/rotate/shift/hard-drop commands,
so the resulting Placement goes through normal host validation. Tested in
`coaching.test.ts` and `apps/web/test/coach.test.ts`.

## 7. Limitations of backend-free networking (spec §14.7, §11)

* **Peer host ≠ trusted server.** The host validates everyone else's moves,
  but a modified client acting as host can fabricate state, garbage or results.
  Peers verify that syncs replay consistently, not that the host was honest.
  This is for friends, not ranked play.
* **Shared invite key.** Anyone with the link can join, and could impersonate
  the "room" to others. Player ids are bearer identities, not accounts.
* **Majority required during a match.** A match continues only while more than
  half of its voting members can reach each other. A 2-player match where the
  opponent's connection drops (rather than them pressing Leave) cannot tell a
  crash from a partition, so it waits for reconnection and then ends with no
  result. In a lobby, if the host vanishes and no majority remains, the room
  waits; the UI explains this.
* **No server time.** The match clock and garbage delay are host-measured;
  garbage timing shifts by up to one RTT per player.
* **Public signaling.** Nostr relays have no SLA. If they are all down, nobody
  can *join* (existing matches are unaffected). Firebase/Supabase strategies
  are the managed fallback.
* **NAT.** Without TURN, some connection pairs (symmetric NAT,
  some mobile carriers, strict corporate networks) fail outright.
* **Mesh scale.** Ten players = 45 connections; the host uploads each log
  entry nine times and every peer validates nine boards' worth of log. Fine
  for friends on decent connections; weak phones or uplinks feel it first at
  9–10 players. This is why the cap stops at 5 v 5.
* **Public listings.** A listed room's invite key is on public relays, so
  anyone can join it. A kicked player can return under a fresh identity (new
  browser profile); kicks bind to player ids, not people. Relays can drop or be
  flooded with fake listings; joining a fake one just finds nobody there.
* **Tab lifecycle.** Mobile browsers freeze background tabs; switching apps
  mid-match looks like a disconnect to everyone else.

## 8. Third-party services and pricing (spec §15)

Checked on 2026-10-31.

| Service | Role | Cost | Notes |
|---|---|---|---|
| Vercel (Hobby/Pro) | Static hosting | Free tier is fine | `vercel.json` at repo root; no functions used |
| Nostr public relays (Trystero default) | Signaling only | Free | No SLA; relay list overridable in Settings |
| `stun.cloudflare.com` / Trystero default STUN | NAT discovery | Free, unlimited (Cloudflare) | |
| Metered TURN | Optional relay | Free: 500 MB/month. Growth $99/mo (150 GB, then $0.40/GB); Business $199 (500 GB, $0.20/GB); Enterprise $499 (2 TB, $0.10/GB) | Credential-scoped API keys are documented as safe in front-end code — fits "no backend" |
| Cloudflare Realtime TURN | Optional relay | First 1,000 GB free, then $0.05/GB egress | Credentials expire ≤48 h and are minted via an API call the docs suggest doing server-side — would need a serverless function, which this architecture avoids |

**TURN volume estimate.** Per relayed player: heartbeats ~1 KB/s, log
broadcasts ~2–9 KB/s (host side is the heaviest), previews ~6 KB/s at 20 Hz → order of
10 KB/s, ≈ 1–3 MB per 3-minute match. Metered's free 500 MB covers on the order
of a couple hundred relayed player-matches a month. Only pairs that fail direct
connection use TURN at all.

## 9. Implementation phases and status (spec §14.8)

The order was changed as requested: host migration was built and tested
before any cosmetics.

| Phase | Status |
|---|---|
| 1 Engine (SRS, 7-bag, T-spin/mini, combos, B2B, PC, garbage, tests) | Done |
| 2 Peer networking (transports, auth mesh, liveness) | Done (Trystero + BroadcastChannel + simulator) |
| 3 Lobby (rooms, codes, links, identities, ready, host) | Done (functional UI) |
| 4 Multiplayer (local sim, sync, garbage, cancel, targeting, KOs, spectators) | Done |
| 5 Host migration (heartbeats, election, epochs, snapshots, reconciliation, reconnection, split-brain) | Done; 14 scenario tests + 50-seed randomized chaos test |
| 6 Customization & polish (skins, frames, effects, animations, sound, mobile feel) | Done — see §10 |
| 7 Deploy & real-device testing (Vercel, TURN config, 6 devices, mobile browsers) | Config ready; **needs real devices** |

### Required test scenarios (spec §13)

| # | Scenario | Where |
|---|---|---|
| 1 | Two players establish a match | `migration.test.ts` |
| 2–3 | Ten join; eleventh rejected | `migration.test.ts` |
| — | Teams, 5-per-side cap, series totals, auto next round, chat, kick | `rooms.test.ts`, `net/test/directory.test.ts` |
| 4–5 | Temporary disconnect / reconnect (and page reload) with board restored | `migration.test.ts` |
| 6 | Host closes tab | `migration.test.ts`, browser e2e |
| 7 | Host loses connectivity; rejoins as regular player | `migration.test.ts` |
| 8–9 | Automatic migration; new host reconstructs | `migration.test.ts`, chaos |
| 10 | Old-epoch messages rejected | `migration.test.ts` |
| 11 | Host + another drop simultaneously | `migration.test.ts` |
| 12 | Network partitions (3/3 and 4/2) | `migration.test.ts`, chaos |
| 13 | Play continues after migration | `migration.test.ts` |
| 14 | Elimination during migration | `migration.test.ts` |
| 15 | Last player wins (committed everywhere) | `migration.test.ts` |
| 16 | Rematch | `migration.test.ts` |
| 17 | Different cosmetics simultaneously | `migration.test.ts` (data path; skins not built yet) |
| 18 | Mobile browsers | **Manual, pending** |

The chaos test (`chaos.test.ts`) injects random crashes, reconnects and
partitions into a 6-player match and checks, every 100 ms of simulated time:
at most one host per epoch, no committed log position ever changes, no two
peers ever confirm different winners, and full convergence after healing.


## 10. Customization, effects and audio (Phase 6)

All of it lives in `apps/web` and is **render-only**: the engine and coordinator
never read cosmetic values (the coordinator stores the shared subset as opaque
strings, max 16 keys × 64 chars), so cosmetics cannot affect collision,
scoring, attacks or balance. `boundaries.test.ts` keeps rendering code out of
the lower layers.

| Area | Options | Shared with peers? |
|---|---|---|
| Block skins | Classic, Neon, Glass, Pixel, Gradient, Metallic, Cyber, Liquid (animated) | yes |
| Colours | 5 presets + per-piece custom colours | yes |
| Frames | Minimal, Arcade, Cyberpunk, Holographic (animated), Fire (animated), Ice, Space | yes |
| Effects | Neon pulse, Lightning, Fire explosion, Ice shatter, Pixel burst, Cosmic particles | yes (your clears, attacks and KOs use your effect on every screen) |
| Board | 6 backgrounds (3 animated), 5 ghost styles, 4 garbage styles | yes |
| Avatar | 20 emoji avatars | yes |
| UI theme | Midnight, Daylight, Synthwave, Terminal, Sakura | no (your screen only) |
| Sound | Arcade, Soft, Chiptune, Off | no |
| Music | Drift, Overdrive, Nocturne (original, synthesized), Off | no |

* **Storage:** `localStorage` (`tk.prefs`), validated on load; changes sync live
  to other tabs and, while in a room, to other players (`cosmetics` log entry).
  Peer values are untrusted and fall back to defaults if unknown.
* **Rendering:** static skins are pre-rendered per colour/size into small sprite
  canvases; only animated skins/backgrounds redraw per frame.
* **Effects:** one overlay canvas (`fx/fx.ts`): particle bursts per effect skin,
  attack projectiles flying from attacker to target board, KO bursts, row
  flashes, and decaying "trauma" shake on board elements. Feedback is tiered by
  importance (lock < single/double < triple/mini/combo < 4-line clear/T-spin/B2B <
  perfect clear/KO). Visual only: never pauses or alters the simulation.
* **Audio:** WebAudio synthesis only (no asset files): SFX bus + music bus →
  master → limiter. Perceptual volume curve, small pitch variation on repeats,
  music ducks under big moments, and a "danger" layer (extra hats, slight tempo
  lift) when your stack is high. Unlocked on the first tap/key (autoplay rules).
* **Accessibility:** reduce motion (no shake, 30% particles, still
  backgrounds, CSS animations off; defaults to the OS setting), reduce
  flashing (soft row flashes, no lightning bolts).
* **Mobile:** gestures on the board (drag = move, tap left/right half = rotate,
  swipe down = hard drop, slow drag down = soft drop, swipe up = hold), an
  on-screen pad with DAS/auto-repeat, haptics where supported; choose gestures,
  buttons or both in Settings. Touch is detected by touch points, not just
  `pointer: coarse`, which some browsers misreport.
* **Match HUD:** 3-2-1-GO countdown, rankings with KOs, your current target
  (◎) and who is targeting you (⚠), split incoming meter (queued vs. landing on
  your next lock), opponent boards in their owners' skins with live falling
  pieces, spectator view when eliminated or joining mid-match.


## 11. Progression and premium cosmetics

* **Profile** (`apps/web/src/progress/profile.ts`, localStorage `tk.profile`):
  career score, stats and achievements. Practice games and online matches add
  their final score once each (deduplicated by match id / practice game id);
  online results are counted only after the match-ending entry is committed.
* **Tiers** by career score: Rookie 0 · Bronze 10,000 · Silver 40,000 ·
  Gold 100,000 · Platinum 250,000 · Diamond 500,000. Each unlocks premium
  items (block skins Gold/Lava/Galaxy/Prism/Diamond, frames Royal/Prismatic/
  Celestial, effects Confetti/Supernova, backgrounds Nebula/Embers/Code rain,
  Sparkle pattern, Strong glow, Royal colours, 6 avatars).
* **Enforcement:** your own look is passed through `enforceUnlocks` whenever
  preferences load or change, so a locked item cannot be equipped. Peers'
  looks are rendered as sent (cosmetic and unverifiable by design), and your
  tier badge is shared as a self-reported cosmetic. localStorage is
  user-editable: this is for fun among friends, not anti-cheat. None of it can
  affect gameplay.
* **16 achievements** (first line, 4-line clear, T-Spin, T-Spin Triple,
  perfect clear, 5-combo, B2B×3, first KO, 25 KOs, first win, 10 wins, 6-player
  win, 10k and 50k single-game scores, 1,000 lines). Unlocks raise toasts.
* **Block shape options** apply to every skin: corners (sharp/soft/round),
  spacing (tight/normal/wide), pattern overlay (stripes, dots, scanlines,
  checker, sparkle) and baked glow. Animated skins are rendered as cached
  16-frame loops.
