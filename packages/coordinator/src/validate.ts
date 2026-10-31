import { isPieceType, type Placement } from "@tk/engine";

/** Minimal structural validators. Every network payload passes through these. */
export type Obj = Record<string, unknown>;

export const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
export const isStr = (v: unknown, max = 64): v is string => typeof v === "string" && v.length <= max;
export const isBool = (v: unknown): v is boolean => typeof v === "boolean";
export const isInt = (v: unknown, min = -Infinity, max = Infinity): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
export const isPid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8,64}$/.test(v);

export type Cosmetics = Record<string, string>;

export function isCosmetics(v: unknown): v is Cosmetics {
  if (!isObj(v)) return false;
  const keys = Object.keys(v);
  if (keys.length > 16) return false;
  // Opaque to the coordinator: cosmetics never reach game logic. 64 chars fits a 7-colour custom palette.
  return keys.every((k) => /^[a-zA-Z]{1,24}$/.test(k) && isStr(v[k], 64));
}

export function cleanName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 20);
  return s.length > 0 ? s : null;
}

export function isPlacement(v: unknown): v is Placement {
  if (!isObj(v)) return false;
  return (
    isInt(v.pieceIndex, 0, 1_000_000) &&
    isPieceType(v.type) &&
    isBool(v.usedHold) &&
    isInt(v.x, -4, 13) &&
    isInt(v.y, -4, 44) &&
    isInt(v.rot, 0, 3) &&
    isBool(v.lastMoveRotate) &&
    isInt(v.kickIndex, -1, 4) &&
    Array.isArray(v.garbageIds) &&
    v.garbageIds.length <= 64 &&
    v.garbageIds.every((g) => isStr(g, 24))
  );
}
