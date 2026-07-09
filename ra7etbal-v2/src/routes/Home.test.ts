import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
