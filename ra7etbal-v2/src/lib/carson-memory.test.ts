import { describe, it, expect } from "vitest";
import {
  formatRecentMemory,
  isRecapRow,
  RECAP_PREFIX,
} from "./carson-memory-format";

/**
 * Regression guard for the session-recap memory feature.
 *
 * These invariants are the ones that broke in production (commits 338e3ff →
 * b7e8235). If any of them ever fails again, this suite fails loudly instead
 * of Carson silently reporting a stale durable fact as "our last session".
 */
describe("carson-memory recap labelling", () => {
  it("empty list yields the safe fallback string", () => {
    expect(formatRecentMemory([])).toBe("No previous sessions.");
  });

  it("recognises a recap row by prefix", () => {
    expect(isRecapRow(`${RECAP_PREFIX} talked about X`)).toBe(true);
    expect(isRecapRow("• Routine: every Friday do X")).toBe(false);
    // Tolerate leading whitespace before the bullet.
    expect(isRecapRow(`  ${RECAP_PREFIX} y`)).toBe(true);
  });

  it("labels the newest recap as the Most recent session", () => {
    const out = formatRecentMemory([
      { created_at: "2026-06-22T02:32:14Z", summary: `${RECAP_PREFIX} tested memory recall` },
      { created_at: "2026-06-20T17:15:20Z", summary: "• Routine: Grace photographs the fridge at 9 AM" },
    ]);
    expect(out).toContain("[Most recent session —");
    // The recap text must be present and attached to the Most-recent label.
    const block = out.split("\n\n").find((b) => b.includes("[Most recent session"));
    expect(block).toContain("tested memory recall");
  });

  it("never labels a durable row as a session, even when it is the globally newest row", () => {
    // Durable fact saved AFTER the recap (later timestamp) must still be
    // "Durable memory", and the older recap must still own "Most recent session".
    const out = formatRecentMemory([
      { created_at: "2026-06-22T10:00:00Z", summary: "• Routine: newest durable fact" },
      { created_at: "2026-06-22T02:32:14Z", summary: `${RECAP_PREFIX} the real last conversation` },
    ]);
    const durableBlock = out.split("\n\n").find((b) => b.includes("newest durable fact"));
    const recapBlock = out.split("\n\n").find((b) => b.includes("the real last conversation"));
    expect(durableBlock).toContain("[Durable memory —");
    expect(durableBlock).not.toContain("Most recent session");
    expect(recapBlock).toContain("[Most recent session —");
  });

  it("labels older recaps as Earlier session", () => {
    const out = formatRecentMemory([
      { created_at: "2026-06-22T02:00:00Z", summary: `${RECAP_PREFIX} newest session` },
      { created_at: "2026-06-21T09:00:00Z", summary: `${RECAP_PREFIX} older session` },
    ]);
    const older = out.split("\n\n").find((b) => b.includes("older session"));
    expect(older).toContain("[Earlier session —");
  });

  it("includes a local clock time in every label (not date-only)", () => {
    const out = formatRecentMemory([
      { created_at: "2026-06-22T02:32:14Z", summary: `${RECAP_PREFIX} x` },
    ]);
    // Time component renders as h:mm with an AM/PM or a colon — assert a colon
    // is present inside the label so the date-only regression can't return.
    const label = out.split("\n")[0];
    expect(label).toMatch(/\d:\d{2}/);
  });
});
