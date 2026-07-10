import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(__dirname, "Updates.tsx"), "utf-8");

/**
 * Clear My Head Inbox V1: a new "Inbox" tab in Updates, backed by the
 * ClearMyHeadInbox component. Source-scanning regression guard proving the
 * tab was added correctly and every pre-existing tab (Needs You / Waiting /
 * To-do / Notes / Automations / History) is untouched.
 */
describe("Updates.tsx — Clear My Head Inbox tab", () => {
  it("adds a tab labeled \"Inbox\" backed by ClearMyHeadInbox", () => {
    expect(SOURCE).toMatch(/\{ id: "clear-my-head",\s*label: "Inbox"\s*\}/);
    expect(SOURCE).toMatch(/import ClearMyHeadInbox from ["']\.\/ClearMyHeadInbox["']/);
    expect(SOURCE).toMatch(/\{activeTab === "clear-my-head" && <ClearMyHeadInbox headerless \/>\}/);
  });

  it("keeps every pre-existing tab untouched", () => {
    expect(SOURCE).toMatch(/\{ id: "needs-you",\s*label: "Needs You"\s*\}/);
    expect(SOURCE).toMatch(/\{ id: "waiting",\s*label: "Waiting"\s*\}/);
    expect(SOURCE).toMatch(/\{ id: "todo",\s*label: "To-do"\s*\}/);
    expect(SOURCE).toMatch(/\{ id: "inbox",\s*label: "Notes"\s*\}/);
    expect(SOURCE).toMatch(/\{ id: "routines",\s*label: "Automations"\s*\}/);
    expect(SOURCE).toMatch(/\{ id: "history",\s*label: "History"\s*\}/);
  });

  it("keeps the existing Notes tab rendering the pre-existing Inbox component (unrelated to Clear My Head)", () => {
    expect(SOURCE).toMatch(/\{activeTab === "inbox" && <Inbox headerless \/>\}/);
  });

  it("excludes the new tab from the tasks-store loading/error gates, like Notes/To-do/Automations", () => {
    expect(SOURCE).toMatch(/activeTab !== "clear-my-head"/);
  });
});

/**
 * Mobile tab reachability fix (2026-07-10): the chip row's own auto-scroll
 * caused a self-inflicted pause loop. Setting scrollLeft in tick() fires a
 * native `scroll` event indistinguishable from a user-driven one; the old
 * onScroll handler paused on every scroll event, including ones the
 * auto-scroll caused itself, so it nudged a fraction of a pixel, paused for
 * the whole resume cooldown, and repeated — reported as "moves once then
 * stops," and meaning the off-screen tabs (Inbox, Automations, History)
 * never actually cycled into view on an iPhone-width screen. Fixed with a
 * programmatic-scroll guard so onScroll can tell its own movement apart
 * from genuine (including keyboard-driven) user interaction.
 */
describe("Updates.tsx — chip auto-scroll does not self-pause", () => {
  it("all 7 tabs are present and doubled for the seamless auto-scroll loop", () => {
    const tabIds = ["needs-you", "waiting", "todo", "inbox", "clear-my-head", "routines", "history"];
    for (const id of tabIds) {
      const occurrences = SOURCE.match(new RegExp(`\\{ id: "${id}",`, "g")) ?? [];
      expect(occurrences.length).toBeGreaterThanOrEqual(1);
    }
    expect(SOURCE).toMatch(/\[\.\.\.TABS, \.\.\.TABS\]\.map/);
  });

  it("sets a programmatic-scroll guard immediately before mutating scrollLeft in the auto-scroll tick", () => {
    const tickSource = SOURCE.slice(SOURCE.indexOf("const tick = (ts: number) => {"), SOURCE.indexOf("rafId = window.requestAnimationFrame(tick);\n\n    return () => {"));
    expect(tickSource).toMatch(/chipProgrammaticScrollRef\.current = true;\s*\n\s*el\.scrollLeft = advanceChipScrollLeft\(/);
  });

  it("onScroll is routed through handleChipScroll, which skips pausing for self-caused scroll events", () => {
    expect(SOURCE).toMatch(/onScroll=\{handleChipScroll\}/);
    const handlerSource = SOURCE.slice(
      SOURCE.indexOf("function handleChipScroll()"),
      SOURCE.indexOf("function scheduleChipAutoScrollResume()"),
    );
    expect(handlerSource).toMatch(/if \(chipProgrammaticScrollRef\.current\)/);
    expect(handlerSource).toMatch(/chipProgrammaticScrollRef\.current = false/);
    expect(handlerSource).toMatch(/return;/);
    expect(handlerSource).toMatch(/pauseChipAutoScroll\(\);/);
  });

  it("genuine user-interaction handlers (pointer/touch/wheel) still pause directly, unaffected by the guard", () => {
    expect(SOURCE).toMatch(/onPointerDown=\{pauseChipAutoScroll\}/);
    expect(SOURCE).toMatch(/onTouchStart=\{pauseChipAutoScroll\}/);
    expect(SOURCE).toMatch(/onWheel=\{\(\) => \{ pauseChipAutoScroll\(\); scheduleChipAutoScrollResume\(\); \}\}/);
  });
});

/**
 * Re-audit (2026-07-10): the self-pause fix alone was not enough — real
 * iPhone testing still showed no visible cycling. The actual advance/wrap
 * math and gating conditions are now extracted to src/lib/chip-auto-scroll.ts
 * and covered there with real behavioral tests (not source-scanning). These
 * tests only verify Updates.tsx wires the tested functions in correctly and
 * that the speed was actually raised, since a source-scan test alone missed
 * the "not fast enough to perceive" and "self-pausing" failure modes before.
 */
describe("Updates.tsx — chip auto-scroll wiring after the real-device re-audit", () => {
  it("imports and uses the tested pure functions for advancing and gating, not inline math", () => {
    expect(SOURCE).toMatch(
      /import \{ advanceChipScrollLeft, shouldAdvanceChipAutoScroll \} from ["']\.\.\/lib\/chip-auto-scroll["']/,
    );
    expect(SOURCE).toMatch(/shouldAdvanceChipAutoScroll\(\{/);
    expect(SOURCE).toMatch(/el\.scrollLeft = advanceChipScrollLeft\(el\.scrollLeft, el\.scrollWidth, dt, PIXELS_PER_MS\)/);
  });

  it("gating passes through hidden, reducedMotion, and paused — no gate silently dropped", () => {
    const gatesSource = SOURCE.slice(
      SOURCE.indexOf("shouldAdvanceChipAutoScroll({"),
      SOURCE.indexOf("});", SOURCE.indexOf("shouldAdvanceChipAutoScroll({")),
    );
    expect(gatesSource).toMatch(/hidden: document\.hidden/);
    expect(gatesSource).toMatch(/reducedMotion: chipReducedMotionRef\.current/);
    expect(gatesSource).toMatch(/paused: chipAutoPausedRef\.current/);
  });

  it("raised the auto-scroll speed from the imperceptibly slow original (0.03px/ms)", () => {
    expect(SOURCE).toMatch(/const PIXELS_PER_MS = 0\.09;/);
    expect(SOURCE).not.toMatch(/const PIXELS_PER_MS = 0\.6 \/ 20;/);
  });

  it("still re-evaluates prefers-reduced-motion live via a change listener, not just once at mount", () => {
    expect(SOURCE).toMatch(/window\.matchMedia\?\.\("\(prefers-reduced-motion: reduce\)"\)/);
    expect(SOURCE).toMatch(/mq\?\.addEventListener\?\.\("change", handleMotionPrefChange\)/);
  });
});
