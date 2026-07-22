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

  it("still renders the greeting and Talk to Carson hero", () => {
    expect(SOURCE).toContain("home-greeting");
    expect(SOURCE).toContain("home-talk-to-carson-button");
    expect(SOURCE).toContain("Talk to Carson");
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

  it("shows Waiting from brief.waitingOnOthers exactly once, capped at two items", () => {
    expect(SOURCE).toContain('data-testid="home-waiting"');
    const block = SOURCE.slice(
      SOURCE.indexOf('data-testid="home-waiting"'),
      SOURCE.indexOf('data-testid="home-handled"'),
    );
    expect(block).toContain("brief.waitingOnOthers.slice(0, 2)");
    // Exactly one Waiting section — not duplicated through a separate tile.
    expect((SOURCE.match(/data-testid="home-waiting"/g) ?? []).length).toBe(1);
  });

  it("shows Handled from brief.done, capped at two items, no new completion logic", () => {
    const block = SOURCE.slice(
      SOURCE.indexOf('data-testid="home-handled"'),
      SOURCE.indexOf("Talk to Carson — visual hero"),
    );
    expect(block).toContain("brief.done.length");
    expect(block).toContain("brief.done.slice(0, 2)");
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
