import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CHAT_MAX_LEN, type ChatMessage, type Coordinator, type RoomState } from "@tk/coordinator";
import { audio } from "../audio/audio";
import { fromWire } from "../cosmetics/catalog";

/**
 * Team names, colours and emblems, shared by the whole room UI. Every team
 * marker pairs the colour with a shape (▲ / ■) so teams never rely on colour alone.
 */
export const TEAM_INFO = {
  1: { name: "Red Team", short: "Red", emblem: "▲", color: "var(--team1)" },
  2: { name: "Blue Team", short: "Blue", emblem: "■", color: "var(--team2)" },
} as const;

/** "▲ RED" pill in the team's colour. */
export function TeamBadge({ team, label = "short", className = "" }: { team: number | null | undefined; label?: "short" | "name" | "none"; className?: string }) {
  if (team !== 1 && team !== 2) return null;
  const t = TEAM_INFO[team];
  return (
    <span className={`team-badge ${className}`} style={{ ["--team" as string]: t.color }} title={t.name} aria-label={t.name}>
      <span aria-hidden>{t.emblem}</span>
      {label !== "none" && <span>{label === "name" ? t.name : t.short}</span>}
    </span>
  );
}

/** A room-event line mixed into the chat ("Sam joined", "Round 2 — Red Team wins"). */
export interface SystemLine {
  id: number;
  text: string;
  at: number;
  tone?: "good" | "warn";
}

type FeedItem = ({ kind: "msg"; m: ChatMessage } | { kind: "sys"; s: SystemLine }) & { at: number };

// System lines live per coordinator so they survive the screen switching between waiting room, match and results.
const systemLines = new WeakMap<Coordinator, SystemLine[]>();
const systemSubs = new WeakMap<Coordinator, Set<() => void>>();
let sysId = 0;

export function pushSystemLine(coord: Coordinator, text: string, tone?: SystemLine["tone"]): void {
  const list = systemLines.get(coord) ?? [];
  list.push({ id: ++sysId, text, at: performance.now(), tone });
  systemLines.set(coord, list.slice(-60));
  for (const f of systemSubs.get(coord) ?? []) f();
}

function useFeed(coord: Coordinator): FeedItem[] {
  const [, bump] = useState(0);
  useEffect(() => {
    const f = () => bump((x) => x + 1);
    let set = systemSubs.get(coord);
    if (!set) systemSubs.set(coord, (set = new Set()));
    set.add(f);
    const off = coord.on((e) => e.kind === "chat" && f());
    return () => {
      set!.delete(f);
      off();
    };
  }, [coord]);
  const items: FeedItem[] = [
    ...coord.chatMessages().map((m) => ({ kind: "msg" as const, m, at: m.at })),
    ...(systemLines.get(coord) ?? []).map((s) => ({ kind: "sys" as const, s, at: s.at })),
  ];
  // Both clocks are performance.now() based (the coordinator runs on realClock in the app).
  return items.sort((a, b) => a.at - b.at).slice(-150);
}

const QUICK = ["👋", "gg", "😂", "🔥", "👍", "😭", "🎉", "glhf"];

function Line({ item, st, me }: { item: FeedItem; st: RoomState; me: string }) {
  if (item.kind === "sys") return <li className={`chat-sys ${item.s.tone ?? ""}`}>{item.s.text}</li>;
  const m = item.m;
  const r = st.roster.find((x) => x.playerId === m.from);
  const team = st.options.teams || st.match?.teams ? (st.match?.teams?.[m.from] ?? r?.team) : undefined;
  return (
    <li className={`chat-msg ${m.from === me ? "mine" : ""}`}>
      <span className="chat-av" aria-hidden>{fromWire(r?.cosmetics).avatar}</span>
      <span className="chat-body">
        <span className="chat-name" style={team ? { color: TEAM_INFO[team].color } : undefined}>
          {team && <span aria-hidden>{TEAM_INFO[team].emblem}</span>}
          {r?.name ?? m.name}
          {m.team && <span className="chat-tag">TEAM</span>}
        </span>
        <span className="chat-text">{m.text}</span>
      </span>
    </li>
  );
}

/**
 * Room chat: a scrolling feed (messages plus room events) and an input.
 * In team rooms a toggle sends to your team only.
 */
export function ChatPanel({ coord, st, title = "Chat", autoFocus = false, onClose, inputRef }: { coord: Coordinator; st: RoomState; title?: string; autoFocus?: boolean; onClose?: () => void; inputRef?: React.RefObject<HTMLInputElement | null> }) {
  const feed = useFeed(coord);
  const [text, setText] = useState("");
  const [team, setTeam] = useState(false);
  const [cool, setCool] = useState(false);
  const listRef = useRef<HTMLOListElement>(null);
  const ownInput = useRef<HTMLInputElement>(null);
  const input = inputRef ?? ownInput;
  const teamOk = coord.teamChatAvailable();
  const me = coord.playerId;
  const stick = useRef(true);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [feed.length]);
  useEffect(() => {
    if (autoFocus) input.current?.focus();
  }, [autoFocus, input]);

  const send = (t: string) => {
    if (cool) return;
    if (coord.sendChat(t, team && teamOk)) {
      setText("");
      stick.current = true;
      audio.play("click");
    } else {
      // Throttled: give a moment before the next try.
      setCool(true);
      window.setTimeout(() => setCool(false), 900);
    }
  };

  return (
    <section className="chat panel" aria-label={title}>
      <div className="row between chat-head">
        <h3>{title}</h3>
        {onClose && <button className="ghost small" onClick={onClose} aria-label="Close chat">✕</button>}
      </div>
      <ol
        className="chat-feed"
        ref={listRef}
        aria-live="polite"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {feed.length === 0 && <li className="chat-sys">Say hi 👋 — messages go to everyone in this room.</li>}
        {feed.map((item) => (
          <Line key={item.kind === "msg" ? `m${item.m.id}` : `s${item.s.id}`} item={item} st={st} me={me} />
        ))}
      </ol>
      <div className="chat-quick" role="toolbar" aria-label="Quick messages">
        {QUICK.map((q) => (
          <button key={q} className="ghost small" disabled={cool} onClick={() => send(q)}>{q}</button>
        ))}
      </div>
      <form
        className="chat-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) send(text);
        }}
      >
        {teamOk && (
          <button type="button" className={`small chat-scope ${team ? "on" : "ghost"}`} onClick={() => setTeam(!team)} title="Send to your team only" aria-pressed={team}>
            {team ? "Team" : "All"}
          </button>
        )}
        <input
          ref={input}
          value={text}
          maxLength={CHAT_MAX_LEN}
          placeholder={team && teamOk ? "Message your team…" : "Message the room…"}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.currentTarget.blur();
              onClose?.();
            }
          }}
          aria-label="Chat message"
        />
        <button type="submit" className="small" disabled={!text.trim() || cool}>Send</button>
      </form>
    </section>
  );
}

/**
 * In-match chat: a button with an unread count that opens the panel, and the
 * latest messages flashing briefly above it. Press T to chat; your keys go
 * back to the game when the input loses focus.
 */
export function ChatDock({ coord, st }: { coord: Coordinator; st: RoomState }) {
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [peek, setPeek] = useState<ChatMessage[]>([]);
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    return coord.on((e) => {
      if (e.kind !== "chat" || e.message.from === coord.playerId) return;
      if (openRef.current) return;
      setUnread((n) => n + 1);
      const m = e.message;
      setPeek((p) => [...p.slice(-2), m]);
      window.setTimeout(() => setPeek((p) => p.filter((x) => x.id !== m.id)), 5000);
    });
  }, [coord]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.code === "KeyT" && !openRef.current) {
        e.preventDefault();
        setOpen(true);
        setUnread(0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className={`chat-dock ${open ? "open" : ""}`}>
      {open ? (
        <ChatPanel coord={coord} st={st} autoFocus onClose={() => setOpen(false)} />
      ) : (
        <>
          <ul className="chat-peek" aria-hidden>
            {peek.map((m) => {
              const r = st.roster.find((x) => x.playerId === m.from);
              return (
                <li key={m.id}>
                  <b>{fromWire(r?.cosmetics).avatar} {r?.name ?? m.name}{m.team ? " (team)" : ""}:</b> {m.text}
                </li>
              );
            })}
          </ul>
          <button
            className="chat-fab"
            onClick={() => {
              setOpen(true);
              setUnread(0);
            }}
            title="Chat (T)"
            aria-label={`Open chat${unread ? `, ${unread} unread` : ""}`}
          >
            💬{unread > 0 && <span className="chat-unread">{unread > 9 ? "9+" : unread}</span>}
          </button>
        </>
      )}
    </div>
  );
}
