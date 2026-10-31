import { gcm } from "@noble/ciphers/aes.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha1 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";

/**
 * Minimal pure-JS stand-in for `crypto.subtle`, covering exactly what Trystero
 * and @noble/secp256k1 call: digest (SHA-1, SHA-256), raw importKey, AES-GCM
 * encrypt/decrypt, and HMAC-SHA256 sign.
 *
 * Why: browsers only expose `crypto.subtle` on secure pages (https:// and
 * http://localhost). Opening the dev server from a phone at
 * http://192.168.x.x would otherwise break WebRTC signaling entirely. The
 * shim is installed ONLY when the native API is missing, so production
 * (Vercel, https) always uses the browser's own implementation. The
 * primitives are the audited @noble libraries, so encryption stays real.
 */

type AlgName = string | { name: string; hash?: string | { name: string } };

interface ShimKey {
  readonly __tkShimKey: true;
  readonly algorithm: string;
  readonly bytes: Uint8Array;
}

const nameOf = (a: AlgName): string => (typeof a === "string" ? a : a.name).toUpperCase();

function toBytes(data: BufferSource): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array(data as ArrayBuffer);
}

/** Return a standalone ArrayBuffer (callers wrap results in new Uint8Array(...)). */
function out(b: Uint8Array): ArrayBuffer {
  return b.slice().buffer as ArrayBuffer;
}

function asKey(k: unknown, algorithm: string): ShimKey {
  const key = k as ShimKey;
  if (!key || key.__tkShimKey !== true || key.algorithm !== algorithm) throw new DOMException("Invalid key", "InvalidAccessError");
  return key;
}

export const subtleShim = {
  async digest(algorithm: AlgName, data: BufferSource): Promise<ArrayBuffer> {
    const n = nameOf(algorithm);
    if (n === "SHA-256") return out(sha256(toBytes(data)));
    if (n === "SHA-1") return out(sha1(toBytes(data)));
    throw new DOMException(`Unsupported digest ${n}`, "NotSupportedError");
  },

  async importKey(format: string, keyData: BufferSource, algorithm: AlgName): Promise<ShimKey> {
    if (format !== "raw") throw new DOMException(`Unsupported key format ${format}`, "NotSupportedError");
    const n = nameOf(algorithm);
    if (n !== "AES-GCM" && n !== "HMAC") throw new DOMException(`Unsupported key algorithm ${n}`, "NotSupportedError");
    return { __tkShimKey: true, algorithm: n, bytes: toBytes(keyData).slice() };
  },

  async encrypt(algorithm: { name: string; iv: BufferSource }, key: unknown, data: BufferSource): Promise<ArrayBuffer> {
    if (nameOf(algorithm) !== "AES-GCM") throw new DOMException("Unsupported cipher", "NotSupportedError");
    const k = asKey(key, "AES-GCM");
    return out(gcm(k.bytes, toBytes(algorithm.iv)).encrypt(toBytes(data)));
  },

  async decrypt(algorithm: { name: string; iv: BufferSource }, key: unknown, data: BufferSource): Promise<ArrayBuffer> {
    if (nameOf(algorithm) !== "AES-GCM") throw new DOMException("Unsupported cipher", "NotSupportedError");
    const k = asKey(key, "AES-GCM");
    try {
      return out(gcm(k.bytes, toBytes(algorithm.iv)).decrypt(toBytes(data)));
    } catch {
      throw new DOMException("Decryption failed", "OperationError");
    }
  },

  async sign(algorithm: AlgName, key: unknown, data: BufferSource): Promise<ArrayBuffer> {
    if (nameOf(algorithm) !== "HMAC") throw new DOMException("Unsupported signature", "NotSupportedError");
    const k = asKey(key, "HMAC");
    return out(hmac(sha256, k.bytes, toBytes(data)));
  },
};

/** Installs the shim if (and only if) the browser hides crypto.subtle. Returns true if installed. */
export function ensureSubtleCrypto(): boolean {
  const c = globalThis.crypto as (Crypto & { subtle?: SubtleCrypto }) | undefined;
  if (!c || typeof c.getRandomValues !== "function") return false;
  if (c.subtle) return false;
  try {
    Object.defineProperty(c, "subtle", { value: subtleShim, configurable: true, enumerable: true });
  } catch {
    return false;
  }
  return !!c.subtle;
}
