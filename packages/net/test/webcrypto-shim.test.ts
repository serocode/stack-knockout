import { describe, expect, it } from "vitest";
import { webcrypto } from "node:crypto";
import { subtleShim } from "../src/webcrypto-shim.js";

/**
 * The shim must be byte-for-byte compatible with real WebCrypto, because a
 * phone using the shim (insecure http page) talks to a laptop using native
 * crypto (localhost / https). Compare every operation against Node's WebCrypto.
 */
const native = webcrypto.subtle;
const enc = (s: string) => new TextEncoder().encode(s);
const hex = (b: ArrayBuffer) => Buffer.from(b).toString("hex");

describe("WebCrypto shim matches native WebCrypto", () => {
  it("digest SHA-1 / SHA-256 (string and object algorithm forms)", async () => {
    for (const msg of ["", "abc", "trystero:stack-knockout-v1:tk1-ABCDEF", "x".repeat(1000)]) {
      expect(hex(await subtleShim.digest("SHA-1", enc(msg)))).toBe(hex(await native.digest("SHA-1", enc(msg))));
      expect(hex(await subtleShim.digest({ name: "SHA-256" }, enc(msg)))).toBe(hex(await native.digest("SHA-256", enc(msg))));
    }
  });

  it("AES-GCM with Trystero's 16-byte IV interoperates in both directions", async () => {
    const raw = new Uint8Array(await native.digest("SHA-256", enc("SECRET:app:room")));
    const nk = await native.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    const sk = await subtleShim.importKey("raw", raw, { name: "AES-GCM" });
    const iv = webcrypto.getRandomValues(new Uint8Array(16));
    const plain = enc(JSON.stringify({ type: "offer", sdp: "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n".repeat(20) }));
    const fromShim = await subtleShim.encrypt({ name: "AES-GCM", iv }, sk, plain);
    const fromNative = await native.encrypt({ name: "AES-GCM", iv }, nk, plain);
    expect(hex(fromShim)).toBe(hex(fromNative));
    expect(hex(await native.decrypt({ name: "AES-GCM", iv }, nk, fromShim))).toBe(hex(plain.buffer));
    expect(hex(await subtleShim.decrypt({ name: "AES-GCM", iv }, sk, fromNative))).toBe(hex(plain.buffer));
  });

  it("AES-GCM rejects tampered ciphertext", async () => {
    const sk = await subtleShim.importKey("raw", new Uint8Array(32).fill(7), { name: "AES-GCM" });
    const iv = new Uint8Array(16);
    const ct = new Uint8Array(await subtleShim.encrypt({ name: "AES-GCM", iv }, sk, enc("hello")));
    ct[0]! ^= 1;
    await expect(subtleShim.decrypt({ name: "AES-GCM", iv }, sk, ct)).rejects.toThrow();
  });

  it("HMAC-SHA256 sign", async () => {
    const key = enc("Jefe");
    const msg = enc("what do ya want for nothing?");
    const nk = await native.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sk = await subtleShim.importKey("raw", key, { name: "HMAC", hash: "SHA-256" });
    expect(hex(await subtleShim.sign("HMAC", sk, msg))).toBe(hex(await native.sign("HMAC", nk, msg)));
  });
});
