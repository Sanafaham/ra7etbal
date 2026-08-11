import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(__dirname, "Updates.tsx"), "utf-8");

/**
 * Clear My Head and the internal Inbox tab were removed from the product.
 * Updates now has exactly 6 tabs: Needs You / Waiting / To-do / Notes /
 * Automations / History.
 *
 * Staff tab removed (2026-07-26): the owner-facing Staff tab (Owner
 * Visibility V1) duplicated information already available through push
 * notifications, History, Waiting, Handled, and People, so it was removed
 * from navigation. StaffUpdates.tsx, staff-messages.ts, and all backend
 * staff-messaging/delegation/WhatsApp behavior are untouched — this was a
 * navigation-only removal, not a data or backend change.
 */
describe("Updates.tsx — Clear My Head Inbox tab removed", () => {
  it("no longer has a tab labeled \"Inbox\" or the clear-my-head tab id", () => {
    expect(SOURCE).not.toMatch(/id: "clear-my-head"/);
    expect(SOURCE).not.toContain("ClearMyHeadInbox");
    expect(SOURCE).not.toMatch(/label: "Inbox"/);
  });

  it("keeps every remaining tab intact", () => {
    expect(SOURCE).toMatch(/\{ id: "needs-you",\s*label: "Needs You"\s*\}/);
    expect(SOURCE).toMatch(/\{ id: "waiting",\s*label: "Waiting"\s*\}/);
    expect(SOURCE).toMatch(/\{ id: "todo",\s*label: "To-do"\s*\}/);
    expect(SOURCE).toMatch(/\{ id: "inbox",\s*label: "Notes"\s*\}/);
    expect(SOURCE).toMatch(/\{ id: "routines",\s*label: "Automations"\s*\}/);
    expect(SOURCE).toMatch(/\{ id: "history",\s*label: "History"\s*\}/);
  });

  it("keeps the Notes tab rendering the pre-existing Inbox component", () => {
    expect(SOURCE).toMatch(/\{activeTab === "inbox" && <Inbox headerless \/>\}/);
  });

  it("the Staff tab is removed from navigation — no tab id/label, no StaffUpdates import or render, no dead activeTab comparisons left behind", () => {
    expect(SOURCE).not.toMatch(/id: "staff"/);
    expect(SOURCE).not.toMatch(/label: "Staff"/);
    expect(SOURCE).not.toContain("StaffUpdates");
    expect(SOURCE).not.toMatch(/activeTab === "staff"/);
    expect(SOURCE).not.toMatch(/activeTab !== "staff"/);
  });

  it("an old /updates?tab=staff deep link falls back to the default tab instead of exposing a broken screen", () => {
    // isValidTab only accepts a value present in TABS; "staff" is no longer
    // in TABS, so isValidTab("staff") is false and activeTab falls back to
    // the existing "needs-you" default — the same pre-existing fallback
    // mechanism every unrecognized tab param already goes through.
    expect(SOURCE).toMatch(/const activeTab: Tab = isValidTab\(rawTab\) \? rawTab : "needs-you";/);
    expect(SOURCE).toMatch(/function isValidTab\(v: string \| null\): v is Tab \{\s*return TABS\.some\(\(t\) => t\.id === v\);\s*\}/);
  });
});

describe("Updates.tsx — notification reminder destination and Pending clarity", () => {
  it("labels the unresolved catch-all section Pending instead of Later", () => {
    expect(SOURCE).toContain(">Pending</span>");
    expect(SOURCE).not.toContain(">Later</span>");
  });

  it("opens Pending and scrolls to the exact task ID from a notification deep link", () => {
    expect(SOURCE).toContain('const targetTaskId = searchParams.get("task");');
    expect(SOURCE).toContain("pendingDetailsRef.current.open = true");
    expect(SOURCE).toContain('scrollIntoView({ behavior: "smooth", block: "center" })');
    expect(SOURCE).toContain("task.id !== targetTaskId");
    expect(SOURCE).toContain("lastScrolledTaskIdRef.current === targetTaskId");
  });

  it("renders the targeted reminder through the existing TaskCard actions", () => {
    expect(SOURCE).toMatch(/laterFiltered\.map\(\(task\) => \([\s\S]*?taskTargetProps\(task\)[\s\S]*?<TaskCard/);
    expect(SOURCE).toContain("onToggleDone: handleToggleDone");
    expect(SOURCE).toContain("onDelete: handleDelete");
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
  it("TABS is exactly these 6 entries, in order, with no seventh tab silently added back", () => {
    const tabsBlock = SOURCE.slice(
      SOURCE.indexOf("const TABS: { id: Tab; label: string }[] = ["),
      SOURCE.indexOf("];", SOURCE.indexOf("const TABS: { id: Tab; label: string }[] = [")),
    );
    const ids = [...tabsBlock.matchAll(/\{ id: "([a-z-]+)",/g)].map((m) => m[1]);
    expect(ids).toEqual(["needs-you", "waiting", "todo", "inbox", "routines", "history"]);
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

/**
 * Phase 8.1 production Bug #1 fix (2026-07-10): the Needs You and Waiting
 * lists were gated on `tasksStatus === "ready"` alone. Every background
 * refresh (useTaskList's 15s poll + focus/visibilitychange, and the separate
 * 60s safety-net poll in tasks-live-refresh.ts) flips tasksStatus to
 * "loading" for the duration of the fetch — even though cached tasks are
 * already on screen — which unmounted and remounted the whole list on every
 * tick. That wiped any local state inside a task card, most visibly the
 * Custom Instruction textarea in SubstituteReviewCard, before the owner
 * could finish typing. Fixed by keeping the list mounted through a
 * background "loading" tick once tasks are already cached.
 */
describe("Updates.tsx — Needs You / Waiting stay mounted through background refreshes (Bug #1)", () => {
  it("derives a listReady flag that stays true during a background loading tick once tasks are cached", () => {
    expect(SOURCE).toMatch(
      /const listReady = tasksStatus === "ready" \|\| \(tasksStatus === "loading" && tasks\.length > 0\);/,
    );
  });

  it("Needs You and Waiting render gates use listReady, not a bare tasksStatus === \"ready\" check", () => {
    expect(SOURCE).toMatch(/\{activeTab === "needs-you" && !initialLoading && listReady && \(/);
    expect(SOURCE).toMatch(/\{activeTab === "waiting" && !initialLoading && listReady && \(/);
    expect(SOURCE).not.toMatch(/activeTab === "needs-you" && !initialLoading && tasksStatus === "ready"/);
    expect(SOURCE).not.toMatch(/activeTab === "waiting" && !initialLoading && tasksStatus === "ready"/);
  });

  it("the true first-load spinner gate (initialLoading) is untouched — still requires loading with zero cached tasks", () => {
    expect(SOURCE).toMatch(/const initialLoading = tasksStatus === "loading" && tasks\.length === 0;/);
  });
});

/**
 * Phase C — open staff escalations (Phase B) appear inside the existing
 * Needs You list, without restoring the removed Staff tab and without
 * duplicating a staff escalation already represented by its linked task.
 */
describe("Updates.tsx — Phase C staff escalations inside the existing Needs You list", () => {
  it("1. renders open staff escalations via the shared hook and card, inside the needs-you tab", () => {
    expect(SOURCE).toContain('import { useOpenStaffEscalations } from "../hooks/useOpenStaffEscalations";');
    expect(SOURCE).toContain('import StaffEscalationCard from "../components/tasks/StaffEscalationCard";');
    expect(SOURCE).toMatch(/visibleStaffEscalations\.map\(\(escalation\) => \(/);
  });

  it("5. routes staff escalations through the shared filterVisibleStaffEscalations helper — never suppresses one by task_id alone (fixed: PR #90 re-review)", () => {
    expect(SOURCE).toContain(
      'import { filterVisibleStaffEscalations } from "../lib/needs-you-staff-escalations";',
    );
    expect(SOURCE).toMatch(/filterVisibleStaffEscalations\(staffEscalations, brief\.needsAttention\.map/);
    // The old, unsafe "dedup" framing must not reappear in this file.
    expect(SOURCE).not.toMatch(/dropped here to avoid showing the same decision twice/);
  });

  it("the empty state only shows when both real tasks and staff escalations are empty", () => {
    expect(SOURCE).toMatch(
      /brief\.needsAttention\.length === 0 && visibleStaffEscalations\.length === 0/,
    );
  });

  it("does not restore the removed Staff tab — no tab id/label reappears", () => {
    expect(SOURCE).not.toMatch(/id: "staff"/);
    expect(SOURCE).not.toMatch(/label: "Staff"/);
  });

  it("6. real task-based Needs You cards are still rendered via the unmodified TaskCard, unchanged by this addition", () => {
    expect(SOURCE).toMatch(/\{brief\.needsAttention\.map\(\(task\) => \(/);
    expect(SOURCE).toMatch(/<TaskCard\s/);
  });
});
