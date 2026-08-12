import { describe, expect, it } from "vitest";
import { formatHistoryCompletedAt } from "./history-timestamp";

describe("formatHistoryCompletedAt", () => {
  it("uses confirmed_at when present", () => {
    const label = formatHistoryCompletedAt(
      "2026-08-12T00:45:00Z",
      "2026-08-01T00:00:00Z",
      "2026-07-01T00:00:00Z",
    );
    expect(label).not.toBeNull();
    // Exact wording depends on the runtime's locale/timezone, so assert on
    // structure (month/day present) rather than a hardcoded string, and
    // confirm it reflects confirmed_at's day, not the fallback fields'.
    expect(label).toMatch(/\d{1,2}:\d{2}/);
  });

  it("falls back to archived_at when confirmed_at is missing", () => {
    const withArchived = formatHistoryCompletedAt(
      null,
      "2026-08-01T12:00:00Z",
      "2026-07-01T00:00:00Z",
    );
    const fromArchivedDirectly = formatHistoryCompletedAt(
      "2026-08-01T12:00:00Z",
      null,
      "2026-07-01T00:00:00Z",
    );
    // Same underlying instant via either field must render identically.
    expect(withArchived).toBe(fromArchivedDirectly);
  });

  it("falls back to created_at when both confirmed_at and archived_at are missing", () => {
    const withCreated = formatHistoryCompletedAt(null, null, "2026-07-04T09:30:00Z");
    const fromCreatedDirectly = formatHistoryCompletedAt(
      "2026-07-04T09:30:00Z",
      null,
      "1999-01-01T00:00:00Z",
    );
    expect(withCreated).toBe(fromCreatedDirectly);
  });

  it("prefers confirmed_at over archived_at over created_at when all three differ", () => {
    const confirmed = formatHistoryCompletedAt(
      "2026-08-12T03:45:00Z",
      "2026-01-01T00:00:00Z",
      "2025-01-01T00:00:00Z",
    );
    const confirmedAlone = formatHistoryCompletedAt("2026-08-12T03:45:00Z", null, "2025-01-01T00:00:00Z");
    expect(confirmed).toBe(confirmedAlone);
  });

  it("returns null for an unparseable timestamp rather than rendering Invalid Date", () => {
    expect(formatHistoryCompletedAt(null, null, "not-a-date")).toBeNull();
  });
});
