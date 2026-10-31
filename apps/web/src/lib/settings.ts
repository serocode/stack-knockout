/** Local-only preferences (spec: LocalStorage, no accounts). */
export interface Settings {
  dasMs: number;
  arrMs: number;
  /** Optional managed TURN server, e.g. turn:global.relay.metered.ca:80 */
  turnUrl: string;
  turnUser: string;
  turnCredential: string;
  /** Optional whitespace-separated Nostr relay URLs overriding Trystero defaults. */
  relayUrls: string;
}

export const DEFAULT_SETTINGS: Settings = { dasMs: 133, arrMs: 10, turnUrl: "", turnUser: "", turnCredential: "", relayUrls: "" };

export function loadSettings(): Settings {
  try {
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(localStorage.getItem("tk.settings") ?? "{}") as Partial<Settings>) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem("tk.settings", JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
}
