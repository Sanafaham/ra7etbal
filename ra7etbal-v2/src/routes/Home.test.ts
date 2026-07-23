import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(__dirname, "Home.tsx"), "utf-8");

/**
 * Clear My Head (the capture textarea/photo-attach/submit flow on Home) was
 * removed from the product. Capture now always goes through Talk to
 * Carson / Type to Carson, which decide Note vs To-do themselves.
 */
describe("Home.tsx — Clear My Head removed", () => {
  it("no longer renders the Clear My Head section, textarea, or submit button", () => {
    expect(SOURCE).not.toContain("home-clear-my-head-section");
    expect(SOURCE).not.toContain("home-clear-my-head-textarea");
    expect(SOURCE).not.toContain("home-submit-button");
    expect(SOURCE).not.toContain("home-sticky-cta");
    expect(SOURCE).not.toContain("home-attach-button");
    expect(SOURCE).not.toContain("Clear My Head");
  });

  it("no longer imports the extraction pipeline or draft store", () => {
    expect(SOURCE).not.toContain("useExtractionStore");
    expect(SOURCE).not.toContain("useDraftStore");
    expect(SOURCE).not.toContain("describeImageForTextCarson");
  });

  it("still renders the greeting and Tell Carson hero", () => {
    expect(SOURCE).toContain("home-greeting");
    expect(SOURCE).toContain("home-talk-to-carson-button");
    expect(SOURCE).toContain("Tell Carson");
  });
});

/**
 * V1 two-layer simplification: Home becomes Layer 1 (simple daily control —
 * Needs You, Waiting, Handled, Tell Carson, View What's Happening). The
 * stats grid, Upcoming, all-time Completed, and the calendar preview move
 * out of Home; the full operating picture stays reachable one tap away at
 * What's Happening (/updates), unchanged underneath.
 */
describe("Home.tsx — V1 two-layer simplification", () => {
  it("no longer renders the stats grid", () => {
    expect(SOURCE).not.toContain("home-stats-grid");
  });

  it("no longer shows Upcoming reminders on Home", () => {
    expect(SOURCE).not.toContain("Upcoming");
    expect(SOURCE).not.toContain("getUpcomingReminderTasks");
  });

  it("no longer renders the calendar AwarenessCard preview", () => {
    expect(SOURCE).not.toContain("AwarenessCard");
    expect(SOURCE).not.toContain("fetchCalendarEvents");
  });

  it("does not show an all-time Completed total", () => {
    expect(SOURCE).not.toContain("completedCount");
    expect(SOURCE).not.toContain("Completed");
  });

  it("shows Needs You from brief.needsAttention exactly once, with a calm empty state", () => {
    expect(SOURCE).toContain('data-testid="home-needs-you"');
    expect(SOURCE).toContain("brief.needsAttention.length");
    expect(SOURCE).toContain("brief.needsAttention[0].description");
    expect(SOURCE).toContain("Nothing needs you right now.");
    // Exactly one Needs You section — not duplicated through a separate tile.
    expect((SOURCE.match(/data-testid="home-needs-you"/g) ?? []).length).toBe(1);
  });

  it("shows Waiting from brief.waitingOnOthers.length exactly once, as a compact summary", () => {
    expect(SOURCE).toContain('data-testid="home-waiting"');
    const block = SOURCE.slice(
      SOURCE.indexOf('data-testid="home-waiting"'),
      SOURCE.indexOf('data-testid="home-handled"'),
    );
    expect(block).toContain("brief.waitingOnOthers.length");
    expect(block).toContain("buildWaitingSummary(brief.waitingOnOthers.length)");
    // Exactly one Waiting section — not duplicated through a separate tile.
    expect((SOURCE.match(/data-testid="home-waiting"/g) ?? []).length).toBe(1);
  });

  it("shows Handled from brief.done.length exactly once, as a compact summary, no new completion logic", () => {
    const block = SOURCE.slice(
      SOURCE.indexOf('data-testid="home-handled"'),
      SOURCE.indexOf("Tell Carson — visual hero"),
    );
    expect(block).toContain("brief.done.length");
    expect(block).toContain("buildHandledSummary(brief.done.length)");
  });

  it("Tell Carson still calls the existing Carson open action", () => {
    expect(SOURCE).toContain('import { useCarsonStore } from "../stores/carson"');
    expect(SOURCE).toContain("const openCarson = useCarsonStore((s) => s.setOpen)");
    expect(SOURCE).toContain("onClick={() => openCarson(true)}");
  });

  it("View What's Happening navigates to /updates", () => {
    const block = SOURCE.slice(
      SOURCE.indexOf('data-testid="home-view-whats-happening"'),
      SOURCE.indexOf("</button>", SOURCE.indexOf('data-testid="home-view-whats-happening"')),
    );
    expect(block).toContain('onClick={() => navigate("/updates")}');
    expect(block).toContain("View What's Happening");
  });
});

/**
 * Follow-up from Sana's live production review: full Waiting/Handled
 * records already exist inside What's Happening, so Home shows a compact
 * count summary only — never individual task titles or descriptions.
 * Needs You, Tell Carson, and View What's Happening are untouched.
 */
describe("Home.tsx — Waiting/Handled compact summaries (no individual task text)", () => {
  function waitingBlock(): string {
    return SOURCE.slice(
      SOURCE.indexOf('data-testid="home-waiting"'),
      SOURCE.indexOf('data-testid="home-handled"'),
    );
  }

  function handledBlock(): string {
    return SOURCE.slice(
      SOURCE.indexOf('data-testid="home-handled"'),
      SOURCE.indexOf("Tell Carson — visual hero"),
    );
  }

  it("no longer renders individual Waiting task descriptions", () => {
    const block = waitingBlock();
    // Variable-name-agnostic: catches per-item rendering under any loop
    // variable name (t, task, item, ...), not just the one used at the time
    // this test was written.
    expect(block).not.toMatch(/\.map\(/);
    expect(block).not.toContain(".description");
    expect(block).not.toContain("more waiting");
  });

  it("shows the Waiting count and one compact summary sentence", () => {
    const block = waitingBlock();
    expect(block).toContain("Waiting{brief.waitingOnOthers.length > 0");
    expect(block).toContain("buildWaitingSummary");
    expect(SOURCE).toContain(
      'return count === 1 ? "Carson is handling 1 thing." : `Carson is handling ${count} things.`;',
    );
  });

  it("tapping Waiting opens /updates?tab=waiting", () => {
    const block = waitingBlock();
    expect(block).toContain('onClick={() => navigate("/updates?tab=waiting")}');
  });

  it("no longer renders individual Handled task descriptions", () => {
    const block = handledBlock();
    expect(block).not.toMatch(/\.map\(/);
    expect(block).not.toContain(".description");
  });

  it("shows the Handled count and one compact summary sentence", () => {
    const block = handledBlock();
    expect(block).toContain("Handled{brief.done.length > 0");
    expect(block).toContain("buildHandledSummary");
    expect(SOURCE).toContain(
      'return count === 1 ? "1 thing completed today." : `${count} things completed today.`;',
    );
  });

  it("tapping Handled opens /updates?tab=history", () => {
    const block = handledBlock();
    expect(block).toContain('onClick={() => navigate("/updates?tab=history")}');
  });

  it("Needs You is unchanged", () => {
    expect(SOURCE).toContain("brief.needsAttention[0].description");
    expect(SOURCE).toContain("Nothing needs you right now.");
  });

  it("Tell Carson is unchanged", () => {
    expect(SOURCE).toContain("onClick={() => openCarson(true)}");
    expect(SOURCE).toContain("Tell Carson");
  });

  it("View What's Happening is unchanged", () => {
    expect(SOURCE).toContain('onClick={() => navigate("/updates")}');
    expect(SOURCE).toContain("View What's Happening");
  });
});
