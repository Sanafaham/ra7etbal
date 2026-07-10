import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computeKeyboardInset } from "./Home";

const SOURCE = readFileSync(join(__dirname, "Home.tsx"), "utf-8");

/**
 * Regression guard for the Clear My Head duplicate submit button on iPhone
 * PWA: the inline "Clear My Head" button and the keyboard-avoiding sticky
 * CTA button were both mounted whenever `keyboardOpen` was true, so two
 * submit buttons were visible on screen at once. The inline button must be
 * gated by `!keyboardOpen` so exactly one submit control shows at a time,
 * and the sticky CTA (gated by `keyboardOpen`) must stay in place so the
 * button remains reachable above the iOS keyboard.
 */
describe("Home.tsx — single Clear My Head submit button", () => {
  it("gates the inline submit button on !keyboardOpen", () => {
    const submitButtonBlock = SOURCE.slice(
      SOURCE.indexOf('data-testid="home-submit-button"') - 200,
      SOURCE.indexOf('data-testid="home-submit-button"') + 50,
    );
    expect(submitButtonBlock).toMatch(/\{!keyboardOpen && \(/);
  });

  it("keeps the sticky keyboard-avoiding CTA gated on keyboardOpen", () => {
    const stickyBlock = SOURCE.slice(
      SOURCE.indexOf('data-testid="home-sticky-cta"') - 50,
      SOURCE.indexOf('data-testid="home-sticky-cta-button"') + 50,
    );
    expect(stickyBlock).toMatch(/\{keyboardOpen && \(/);
  });

  it("only ever mounts one of the two submit buttons (mutually exclusive gates)", () => {
    expect(SOURCE).toMatch(/\{!keyboardOpen && \(\s*<button\s*\n\s*data-testid="home-submit-button"/);
    expect(SOURCE).toMatch(/\{keyboardOpen && \(\s*<div\s*\n\s*data-testid="home-sticky-cta"/);
  });
});

/**
 * Regression guard for the sticky CTA positioning bug: the button used a
 * static `bottom: calc(env(safe-area-inset-bottom) + 132px)` offset that
 * guessed at the iOS keyboard's height, so it was too low / partly hidden
 * behind taller keyboards (QuickType bar, emoji, third-party keyboards)
 * and visibly jumped as the visual viewport panned while the keyboard was
 * open. computeKeyboardInset() now derives the real gap between the
 * layout and visual viewports (including how far the page has panned) so
 * the CTA can track the actual keyboard edge instead of a guessed constant.
 */
describe("Home.tsx — sticky CTA keyboard positioning", () => {
  it("computeKeyboardInset returns 0 when no keyboard is open (full-height viewport)", () => {
    expect(computeKeyboardInset(800, 800, 0)).toBe(0);
  });

  it("computeKeyboardInset returns the real keyboard height, not a guessed constant", () => {
    // A compact keyboard (~216px) and a tall keyboard with QuickType/emoji
    // (~346px) must both be reflected exactly — a static 132px guess would
    // undershoot both.
    expect(computeKeyboardInset(800, 584, 0)).toBe(216);
    expect(computeKeyboardInset(800, 454, 0)).toBe(346);
  });

  it("computeKeyboardInset accounts for visual viewport panning (offsetTop) while a focused input is scrolled into view", () => {
    // Keyboard is 300px tall, and the page has additionally panned 40px to
    // keep the focused textarea visible above it.
    expect(computeKeyboardInset(800, 500, 40)).toBe(260);
  });

  it("computeKeyboardInset never returns a negative inset", () => {
    expect(computeKeyboardInset(800, 800, 50)).toBe(0);
  });

  it("wires keyboardInset into the visualViewport compute effect instead of a hardcoded threshold", () => {
    expect(SOURCE).toMatch(
      /const inset = computeKeyboardInset\(window\.innerHeight, vv\.height, vv\.offsetTop\)/,
    );
    expect(SOURCE).toMatch(/setViewportShrunk\(inset > 120\)/);
    expect(SOURCE).toMatch(/setKeyboardInset\(inset\)/);
  });

  it("positions the sticky CTA using the dynamic keyboardInset, not a static pixel guess", () => {
    const stickyStyleBlock = SOURCE.slice(
      SOURCE.indexOf('data-testid="home-sticky-cta"'),
      SOURCE.indexOf('data-testid="home-sticky-cta-button"'),
    );
    expect(stickyStyleBlock).toMatch(
      /bottom: `calc\(env\(safe-area-inset-bottom\) \+ \$\{keyboardInset \+ 16\}px\)`/,
    );
    expect(stickyStyleBlock).not.toMatch(/132px/);
  });
});

/**
 * Regression guard (2026-07-10): the sticky CTA appeared on Home with the
 * keyboard closed and the textarea never focused, floating over the stats
 * section. `viewportShrunk` is a visualViewport-derived heuristic that has
 * been observed to read true on iOS PWA without any real keyboard —
 * previously this alone (`textareaFocused || viewportShrunk`) was enough to
 * open the sticky CTA. keyboardOpen must now require the textarea to have
 * been focused — currently, or within a short grace window after blur (so
 * the CTA doesn't flicker away mid focus→blur→keyboard-closing transitions,
 * e.g. tapping the attach-photo button) — so viewportShrunk alone, with no
 * focus event ever having happened, can never open it.
 */
describe("Home.tsx — sticky CTA requires the textarea to have been focused", () => {
  it("keyboardOpen is textareaFocused OR (recentlyFocused AND viewportShrunk) — never viewportShrunk alone", () => {
    expect(SOURCE).toMatch(
      /const keyboardOpen = textareaFocused \|\| \(recentlyFocused && viewportShrunk\);/,
    );
    expect(SOURCE).not.toMatch(/const keyboardOpen = textareaFocused \|\| viewportShrunk;/);
  });

  it("focusing the textarea sets both textareaFocused and recentlyFocused", () => {
    const fnSource = SOURCE.slice(
      SOURCE.indexOf("function handleTextareaFocus()"),
      SOURCE.indexOf("function handleTextareaBlur()"),
    );
    expect(fnSource).toMatch(/setTextareaFocused\(true\)/);
    expect(fnSource).toMatch(/setRecentlyFocused\(true\)/);
  });

  it("blurring the textarea clears textareaFocused immediately but only clears recentlyFocused after a grace-window timeout", () => {
    const fnSource = SOURCE.slice(
      SOURCE.indexOf("function handleTextareaBlur()"),
      SOURCE.indexOf("useEffect(() => {\n    return () => {\n      if (recentlyFocusedTimerRef.current)"),
    );
    expect(fnSource).toMatch(/setTextareaFocused\(false\)/);
    expect(fnSource).toMatch(/window\.setTimeout\(\(\) => \{\s*setRecentlyFocused\(false\);\s*\}, 600\)/);
  });

  it("wires the textarea's onFocus/onBlur to the gated handlers, not raw setTextareaFocused calls", () => {
    expect(SOURCE).toMatch(/onFocus=\{handleTextareaFocus\}/);
    expect(SOURCE).toMatch(/onBlur=\{handleTextareaBlur\}/);
    expect(SOURCE).not.toMatch(/onFocus=\{\(\) => setTextareaFocused\(true\)\}/);
    expect(SOURCE).not.toMatch(/onBlur=\{\(\) => setTextareaFocused\(false\)\}/);
  });
});
