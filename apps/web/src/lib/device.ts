/**
 * Touch detection for showing on-screen controls. `(pointer: coarse)` alone
 * misses some devices and emulators, so also check for touch points.
 */
export function isTouchDevice(): boolean {
  if (typeof window === "undefined") return false;
  return (
    (typeof matchMedia === "function" && (matchMedia("(pointer: coarse)").matches || matchMedia("(any-pointer: coarse)").matches)) ||
    (navigator.maxTouchPoints ?? 0) > 0 ||
    "ontouchstart" in window
  );
}
