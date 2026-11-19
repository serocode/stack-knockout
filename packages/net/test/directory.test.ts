import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DIRECTORY_TTL_MS, MemoryDirectory, MemoryDirectoryHub, parseRoomAd, type RoomAd, type RoomListing } from "@tk/net";

const ad = (over: Partial<RoomAd> = {}): RoomAd => ({
  code: "ABC234",
  key: "KEY2345678",
  expiresAt: Date.now() + 3600_000,
  title: "Friday night",
  host: "ana",
  avatar: "🦊",
  players: 3,
  max: 10,
  teams: true,
  rounds: 3,
  round: 0,
  phase: "lobby",
  bombs: false,
  ...over,
});

describe("room directory", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("announces, refreshes, withdraws and expires listings", () => {
    const hub = new MemoryDirectoryHub();
    const host = new MemoryDirectory(hub);
    const browser = new MemoryDirectory(hub);
    let seen: RoomListing[] = [];
    browser.subscribe((l) => (seen = l));

    host.publish(ad());
    expect(seen.map((r) => r.code)).toEqual(["ABC234"]);
    host.publish(ad({ players: 4 }));
    expect(seen[0]!.players).toBe(4);

    // Kept alive by periodic re-announcements.
    vi.advanceTimersByTime(DIRECTORY_TTL_MS * 2);
    expect(seen).toHaveLength(1);

    // Withdrawn explicitly.
    host.publish(null);
    expect(seen).toHaveLength(0);

    // A host that vanishes silently drops off after the TTL.
    const other = new MemoryDirectory(hub);
    other.publish(ad({ code: "XYZ789" }));
    expect(seen).toHaveLength(1);
    hub.leave(other);
    vi.advanceTimersByTime(DIRECTORY_TTL_MS + 2000);
    expect(seen).toHaveLength(0);
    for (const d of [host, browser, other]) d.close();
  });

  it("a newly opened room list hears existing rooms at once, not on the next announce", () => {
    const hub = new MemoryDirectoryHub();
    const host = new MemoryDirectory(hub);
    host.publish(ad());
    vi.advanceTimersByTime(1500); // the host's last announce is now in the past
    const browser = new MemoryDirectory(hub);
    let seen: RoomListing[] = [];
    browser.subscribe((l) => (seen = l));
    expect(seen.map((r) => r.code)).toEqual(["ABC234"]);
    host.close();
    browser.close();
  });

  it("rejects malformed or expired listings and cleans text", () => {
    expect(parseRoomAd(ad())).not.toBeNull();
    expect(parseRoomAd({ ...ad(), code: "BAD!" })).toBeNull();
    expect(parseRoomAd({ ...ad(), key: "short" })).toBeNull();
    expect(parseRoomAd({ ...ad(), phase: "weird" })).toBeNull();
    expect(parseRoomAd({ ...ad(), players: -1 })).toBeNull();
    expect(parseRoomAd({ ...ad(), host: "\u0000\u0001" })).toBeNull();
    expect(parseRoomAd({ ...ad(), host: "a‮b", players: 50, max: 10 })).toMatchObject({ host: "ab", players: 10 });

    const hub = new MemoryDirectoryHub();
    const host = new MemoryDirectory(hub);
    const browser = new MemoryDirectory(hub);
    host.publish(ad({ expiresAt: Date.now() - 1 }));
    expect(browser.list()).toHaveLength(0);
    host.close();
    browser.close();
  });
});
