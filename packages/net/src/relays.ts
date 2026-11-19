/**
 * Relays every peer uses unless overridden in Settings. Trystero's default is
 * 5 relays picked from a long list by app id; for our app id that pick
 * included one dead relay and one that rate-limits (checked 2026-10-31), so
 * we pin relays that answered quickly instead (offchain.pub was dropped: it
 * rejects unknown keys). All peers must share at least
 * one working relay to find each other. The public room directory uses the
 * same relays.
 */
export const DEFAULT_RELAYS = [
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://relay.snort.social",
  "wss://nostr.mom",
  "wss://relay.piazza.today",
  "wss://relay.nostr.blockhenge.com",
];
