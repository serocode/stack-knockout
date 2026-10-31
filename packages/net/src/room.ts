import { randomBytes, randomHex } from "./crypto.js";

/**
 * Room identifiers and invitation credentials.
 *
 * - roomCode: short, human-typeable, NOT a credential (it is visible to the
 *   signaling relays as the room topic).
 * - secret: separate high-entropy invite key. It never touches a server: links
 *   carry it in the URL fragment (#...), which browsers do not send in HTTP
 *   requests, and it is used for SDP encryption and peer authentication.
 */
export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789"; // no I, L, O, U, 0, 1
export const ROOM_CODE_LENGTH = 6;
export const SECRET_LENGTH = 10;
export const DEFAULT_INVITE_TTL_MS = 12 * 60 * 60 * 1000;

function randomCode(len: number): string {
  // Rejection sampling avoids modulo bias.
  const out: string[] = [];
  const limit = 256 - (256 % CODE_ALPHABET.length);
  while (out.length < len) {
    for (const b of randomBytes(len * 2)) {
      if (b < limit && out.length < len) out.push(CODE_ALPHABET[b % CODE_ALPHABET.length]!);
    }
  }
  return out.join("");
}

export interface RoomCredentials {
  roomCode: string;
  secret: string;
  /** Epoch ms after which clients refuse to use the invite. Convenience, not security. */
  expiresAt: number;
}

export function createRoomCredentials(now = Date.now(), ttlMs = DEFAULT_INVITE_TTL_MS): RoomCredentials {
  return { roomCode: randomCode(ROOM_CODE_LENGTH), secret: randomCode(SECRET_LENGTH), expiresAt: now + ttlMs };
}

export function newPlayerId(): string {
  return randomHex(16);
}

export function normalizeCode(input: string, len: number): string | null {
  const c = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (c.length !== len) return null;
  for (const ch of c) if (!CODE_ALPHABET.includes(ch)) return null;
  return c;
}

export function formatSecret(secret: string): string {
  return `${secret.slice(0, 5)}-${secret.slice(5)}`;
}

export function buildInviteUrl(origin: string, creds: RoomCredentials): string {
  const params = new URLSearchParams({ r: creds.roomCode, k: creds.secret, e: String(creds.expiresAt) });
  return `${origin.replace(/\/$/, "")}/#/join?${params.toString()}`;
}

export type InviteParseResult = { ok: true; creds: RoomCredentials } | { ok: false; error: "malformed" | "expired" };

export function parseInvite(hash: string, now = Date.now()): InviteParseResult {
  const q = hash.indexOf("?");
  if (q < 0) return { ok: false, error: "malformed" };
  const params = new URLSearchParams(hash.slice(q + 1));
  const roomCode = normalizeCode(params.get("r") ?? "", ROOM_CODE_LENGTH);
  const secret = normalizeCode(params.get("k") ?? "", SECRET_LENGTH);
  const expiresAt = Number(params.get("e") ?? "0");
  if (!roomCode || !secret || !Number.isFinite(expiresAt) || expiresAt <= 0) return { ok: false, error: "malformed" };
  if (expiresAt < now) return { ok: false, error: "expired" };
  return { ok: true, creds: { roomCode, secret, expiresAt } };
}

/** Topic used on the signaling relay. Namespaced so codes never collide across app versions. */
export function signalingRoomId(roomCode: string): string {
  return `tk1-${roomCode}`;
}
