/**
 * Pure, DOM-free logic for the Updates chip row's idle auto-scroll marquee.
 * Extracted so the actual advance/wrap/gating behavior can be unit-tested
 * directly — a source-scan test proved insufficient to catch a real-device
 * regression where the row never visibly cycled at all (2026-07-10).
 */

/** Advances scrollLeft by `pixelsPerMs * dtMs`, wrapping at half of scrollWidth
 * (the row renders two back-to-back copies of the tab list for a seamless loop). */
export function advanceChipScrollLeft(
  scrollLeft: number,
  scrollWidth: number,
  dtMs: number,
  pixelsPerMs: number,
): number {
  const loopWidth = scrollWidth / 2;
  if (loopWidth <= 0) return scrollLeft;
  let next = scrollLeft + pixelsPerMs * dtMs;
  if (next >= loopWidth) next -= loopWidth;
  return next;
}

export interface ChipAutoScrollGates {
  hidden: boolean;
  reducedMotion: boolean;
  paused: boolean;
}

/** True only when every gate allows movement — page visible, motion not
 * reduced, and not paused for user interaction. */
export function shouldAdvanceChipAutoScroll(gates: ChipAutoScrollGates): boolean {
  return !gates.hidden && !gates.reducedMotion && !gates.paused;
}
