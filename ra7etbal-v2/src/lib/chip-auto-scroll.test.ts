import { describe, expect, it } from "vitest";
import { advanceChipScrollLeft, shouldAdvanceChipAutoScroll } from "./chip-auto-scroll";

/**
 * Real behavioral tests for the Updates chip row auto-scroll math —
 * extracted specifically because a source-scan-only test suite failed to
 * catch a real-device regression where the row never visibly cycled at all
 * (2026-07-10), even after the self-pause fix. These test the actual
 * advance/wrap/gating behavior with concrete numbers, not just that certain
 * strings appear in the source.
 */
describe("advanceChipScrollLeft", () => {
  it("advances scrollLeft proportionally to elapsed time", () => {
    // 1000px scrollWidth -> 500px loop. 100ms at 0.1px/ms = 10px.
    expect(advanceChipScrollLeft(0, 1000, 100, 0.1)).toBe(10);
    expect(advanceChipScrollLeft(50, 1000, 100, 0.1)).toBe(60);
  });

  it("wraps around at half of scrollWidth (the row renders two back-to-back copies)", () => {
    // loopWidth = 500. Starting at 495, advancing by 10 should wrap to 5.
    expect(advanceChipScrollLeft(495, 1000, 100, 0.1)).toBe(5);
  });

  it("wraps exactly at the loop boundary, not past it", () => {
    // loopWidth = 500. Landing exactly on 500 must wrap to 0, not sit at 500
    // (500 is the start of the duplicated second copy, visually identical
    // to 0, but sitting there forever without wrapping would eventually
    // drift the visible duplicate set instead of looping the first one).
    expect(advanceChipScrollLeft(490, 1000, 100, 0.1)).toBe(0);
  });

  it("does not move when scrollWidth has not been laid out yet (0 or an odd/degenerate value)", () => {
    expect(advanceChipScrollLeft(10, 0, 100, 0.1)).toBe(10);
  });

  it("over many small frames, accumulates to the same total distance as one large frame", () => {
    // Sixty 16ms frames (~1 real second at 60fps) vs. one 960ms frame.
    let scrollLeft = 0;
    for (let i = 0; i < 60; i++) {
      scrollLeft = advanceChipScrollLeft(scrollLeft, 100_000, 16, 0.09);
    }
    const oneFrame = advanceChipScrollLeft(0, 100_000, 960, 0.09);
    expect(scrollLeft).toBeCloseTo(oneFrame, 5);
  });

  it("at the current production speed (0.09px/ms), a full loop completes well within 10 seconds", () => {
    // Regression context: the previous 0.03px/ms speed took ~25-30s for a
    // realistic ~800px loop width, which read as "not moving" over a short
    // glance. Assert the current speed clears a representative loop width
    // (7 tabs' worth of chips, ~800px) in under 10 real seconds of 60fps
    // frames.
    const scrollWidth = 1600; // loopWidth 800px
    let scrollLeft = 0;
    let elapsedMs = 0;
    const FRAME_MS = 16;
    while (scrollLeft < 799 && elapsedMs < 10_000) {
      scrollLeft = advanceChipScrollLeft(scrollLeft, scrollWidth, FRAME_MS, 0.09);
      elapsedMs += FRAME_MS;
    }
    expect(elapsedMs).toBeLessThan(10_000);
  });
});

describe("shouldAdvanceChipAutoScroll", () => {
  it("allows movement when nothing is gating it", () => {
    expect(shouldAdvanceChipAutoScroll({ hidden: false, reducedMotion: false, paused: false })).toBe(true);
  });

  it("blocks movement when the page is hidden", () => {
    expect(shouldAdvanceChipAutoScroll({ hidden: true, reducedMotion: false, paused: false })).toBe(false);
  });

  it("blocks movement when prefers-reduced-motion is set", () => {
    expect(shouldAdvanceChipAutoScroll({ hidden: false, reducedMotion: true, paused: false })).toBe(false);
  });

  it("blocks movement while paused for user interaction", () => {
    expect(shouldAdvanceChipAutoScroll({ hidden: false, reducedMotion: false, paused: true })).toBe(false);
  });

  it("blocks movement when any combination of gates is set", () => {
    expect(shouldAdvanceChipAutoScroll({ hidden: true, reducedMotion: true, paused: true })).toBe(false);
  });
});
