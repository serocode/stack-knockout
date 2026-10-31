import { describe, expect, it } from "vitest";
import { Mesh, SimClock, SimNetwork, hmacHex, sha256, toHex, utf8, parseInvite, buildInviteUrl, createRoomCredentials, type MeshMessage } from "@tk/net";

describe("crypto", () => {
  it("matches SHA-256 test vectors", () => {
    expect(toHex(sha256(utf8("")))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(toHex(sha256(utf8("abc")))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(toHex(sha256(utf8("a".repeat(1000))))).toBe("41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3");
  });
  it("matches HMAC-SHA256 RFC 4231 case 2", () => {
    expect(hmacHex("Jefe", "what do ya want for nothing?")).toBe("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
  });
});

describe("invites", () => {
  it("round-trips and rejects expired links", () => {
    const creds = createRoomCredentials(1000, 5000);
    const url = buildInviteUrl("https://tk.example", creds);
    const hash = url.slice(url.indexOf("#") + 1);
    expect(parseInvite(hash, 2000)).toEqual({ ok: true, creds });
    expect(parseInvite(hash, 999999)).toEqual({ ok: false, error: "expired" });
    expect(parseInvite("/join?r=AAAAAA", 0)).toEqual({ ok: false, error: "malformed" });
  });
});

function setup(secrets: Record<string, string>, pids?: Record<string, string>) {
  const clock = new SimClock();
  const net = new SimNetwork(clock, { latencyMs: 20, linkTimeoutMs: 8000 });
  const meshes: Record<string, Mesh> = {};
  const inbox: Record<string, MeshMessage[]> = {};
  for (const [name, secret] of Object.entries(secrets)) {
    const pid = pids?.[name] ?? name.padEnd(8, "0").replace(/[^0-9a-f]/g, "a");
    const m = new Mesh({ transport: net.createTransport(`t-${name}`), clock, roomId: "R", secret, playerId: pid });
    inbox[name] = [];
    m.on("message", (msg) => inbox[name]!.push(msg));
    meshes[name] = m;
  }
  return { clock, net, meshes, inbox };
}

describe("mesh", () => {
  it("authenticates peers that know the secret and rejects those that do not", () => {
    const { clock, meshes } = setup({ a: "S", b: "S", c: "WRONG" });
    clock.advance(1000);
    expect(meshes.a!.connectedPlayers()).toEqual([meshes.b!.playerId]);
    expect(meshes.c!.connectedPlayers()).toEqual([]);
    expect(meshes.a!.stats.rejected).toBeGreaterThan(0);
  });

  it("rejects a second connection claiming a live player id", () => {
    const { clock, meshes } = setup({ a: "S", b: "S", impostor: "S" }, { a: "aaaaaaaa", b: "bbbbbbbb", impostor: "bbbbbbbb" });
    clock.advance(2000);
    expect(meshes.a!.connectedPlayers()).toEqual(["bbbbbbbb"]);
    expect(meshes.a!.stats.rejected).toBeGreaterThan(0);
    expect(meshes.b!.connectedPlayers()).toEqual(["aaaaaaaa"]);
  });

  it("delivers messages with the authenticated sender id and drops duplicates/malformed input", () => {
    const { clock, meshes, inbox, net } = setup({ a: "S", b: "S" });
    clock.advance(1000);
    meshes.a!.send("crit", "hello", { x: 1 });
    clock.advance(100);
    expect(inbox.b!.map((m) => [m.type, m.from])).toEqual([["hello", meshes.a!.playerId]]);
    // replay the same raw frame
    const raw = JSON.stringify({ t: "dup", i: "same-id", p: 1 });
    net.deliver("t-a", "t-b", "crit", raw);
    net.deliver("t-a", "t-b", "crit", raw);
    net.deliver("t-a", "t-b", "crit", "{not json");
    net.deliver("t-a", "t-b", "viz", "x".repeat(5000));
    clock.advance(100);
    expect(inbox.b!.filter((m) => m.type === "dup")).toHaveLength(1);
    expect(meshes.b!.stats.duplicates).toBe(1);
    expect(meshes.b!.stats.malformed).toBe(2);
  });

  it("rate-limits floods", () => {
    const { clock, meshes, inbox, net } = setup({ a: "S", b: "S" });
    clock.advance(1000);
    for (let i = 0; i < 500; i++) net.deliver("t-a", "t-b", "viz", JSON.stringify({ t: "spam", i: `s${i}`, p: i }));
    clock.advance(100);
    expect(inbox.b!.length).toBeLessThan(100);
    expect(meshes.b!.stats.rateLimited).toBeGreaterThan(400);
  });

  it("reports peers down on silence and up again when the link heals", () => {
    const { clock, net, meshes } = setup({ a: "S", b: "S" });
    const events: string[] = [];
    meshes.a!.on("peerDown", (p, r) => events.push(`down:${r}`));
    meshes.a!.on("peerUp", () => events.push("up"));
    clock.advance(1000);
    net.setOnline("t-b", false);
    clock.advance(4000);
    expect(events).toContain("down:timeout");
    net.setOnline("t-b", true);
    clock.advance(1500);
    expect(events.at(-1)).toBe("up");
    expect(meshes.a!.isConnected(meshes.b!.playerId)).toBe(true);
  });
});
