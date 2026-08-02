/**
 * Tests for freshness evaluation in the session memory formatter.
 *
 * COS Ch. 19.5: freshness must be evaluated before memory is used for reasoning.
 * Sessions older than SESSION_STALE_THRESHOLD_DAYS must be labeled as
 * "Older context" to prevent stale sessions from being treated as recent events.
 *
 * Covers:
 * - Recent session → [Most recent session] label
 * - Session 10 days ago → [Earlier session] label
 * - Session older than threshold → [Older context] label
 * - Multiple sessions — only newest gets "Most recent"
 * - No sessions → "No previous sessions."
 * - Non-recap rows are excluded regardless of age
 */

import { describe, it, expect } from "vitest";
import { formatRecentMemory } from "./carson-memory-format";
import { SESSION_STALE_THRESHOLD_DAYS } from "./carson-epistemic-gate";

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

const RECAP = "• Session recap: delegated flowers to Grace";

describe("formatRecentMemory — freshness labeling", () => {
  it("labels a session from today as the most recent session", () => {
    const rows = [{ created_at: daysAgoIso(0), summary: RECAP }];
    const result = formatRecentMemory(rows);
    expect(result).toContain("[Most recent session");
    expect(result).not.toContain("[Older context");
  });

  it("labels a session 10 days ago as an earlier session", () => {
    const today = daysAgoIso(0);
    const rows = [
      { created_at: today, summary: RECAP },
      { created_at: daysAgoIso(10), summary: RECAP },
    ];
    const result = formatRecentMemory(rows);
    expect(result).toContain("[Most recent session");
    expect(result).toContain("[Earlier session");
    expect(result).not.toContain("[Older context");
  });

  it("labels a session older than the stale threshold as older context", () => {
    const today = daysAgoIso(0);
    const old = daysAgoIso(SESSION_STALE_THRESHOLD_DAYS + 5);
    const rows = [
      { created_at: today, summary: RECAP },
      { created_at: old, summary: RECAP },
    ];
    const result = formatRecentMemory(rows);
    expect(result).toContain("[Most recent session");
    expect(result).toContain("[Older context");
    expect(result).toContain("treat as background only");
    expect(result).not.toContain("[Earlier session");
  });

  it("does not label the newest session as older context even if it is old", () => {
    const old = daysAgoIso(SESSION_STALE_THRESHOLD_DAYS + 5);
    const rows = [{ created_at: old, summary: RECAP }];
    const result = formatRecentMemory(rows);
    // The single session is always [Most recent session]
    expect(result).toContain("[Most recent session");
    expect(result).not.toContain("[Older context");
  });

  it("returns 'No previous sessions.' when there are no recap rows", () => {
    const result = formatRecentMemory([]);
    expect(result).toContain("No previous sessions.");
    expect(result).not.toContain("[Most recent session");
  });

  it("excludes non-recap rows from output", () => {
    const rows = [
      { created_at: daysAgoIso(0), summary: "This is NOT a recap row" },
    ];
    const result = formatRecentMemory(rows);
    expect(result).toContain("No previous sessions.");
  });

  it("includes the SESSION HISTORY ONLY header in all outputs", () => {
    const rows = [{ created_at: daysAgoIso(0), summary: RECAP }];
    expect(formatRecentMemory(rows)).toContain("SESSION HISTORY ONLY:");
    expect(formatRecentMemory([])).toContain("SESSION HISTORY ONLY:");
  });
});
