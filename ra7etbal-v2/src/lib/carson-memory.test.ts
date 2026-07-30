import { describe, it, expect } from "vitest";
import {
  formatRecentMemory,
  isRecapRow,
  RECAP_PREFIX,
  SESSION_HISTORY_HEADER,
} from "./carson-memory-format";

/**
 * Regression guard for the session-recap memory feature.
 *
 * These invariants are the ones that broke in production (commits 338e3ff →
 * b7e8235). If any of them ever fails again, this suite fails loudly instead
 * of Carson silently reporting a stale durable fact as "our last session".
 */
describe("carson-memory recap labelling", () => {
  it("empty list yields the routing rule and safe fallback string", () => {
    expect(formatRecentMemory([])).toBe(
      `${SESSION_HISTORY_HEADER}\n\nNo previous sessions.`,
    );
  });

  it("always tells Carson to use recaps only for session-history questions", () => {
    const out = formatRecentMemory([
      { created_at: "2026-06-22T02:32:14Z", summary: `${RECAP_PREFIX} tested memory recall` },
    ]);
    expect(out).toContain("SESSION HISTORY ONLY:");
    expect(out).toContain(
      "Never use durable memory, saved notes, people, tasks, routines, or completions as session history.",
    );
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
    expect(out).not.toContain("Grace photographs the fridge");
  });

  it("keeps entity-level session action details in recent-memory context", () => {
    const out = formatRecentMemory([
      {
        created_at: "2026-06-22T02:32:14Z",
        summary: [
          `${RECAP_PREFIX} Handled household requests.`,
          "Session actions:",
          "* Delegated to Ghulam: have the cars clean and ready by 8 AM.",
          "* Created reminder: call insurance tomorrow at 10 AM.",
        ].join("\n"),
      },
    ]);

    expect(out).toContain("[Most recent session");
    expect(out).toContain("Delegated to Ghulam: have the cars clean and ready by 8 AM.");
    expect(out).toContain("Created reminder: call insurance tomorrow at 10 AM.");
  });

  it("supports last-session delegation questions from recent-memory context", () => {
    const out = formatRecentMemory([
      {
        created_at: "2026-06-22T02:32:14Z",
        summary: [
          `${RECAP_PREFIX} Sent household delegations.`,
          "Session actions:",
          "* Delegated to Ghulam: have the cars clean and ready by 8 AM.",
          "* Delegated to Grace: send the flower inventory.",
        ].join("\n"),
      },
    ]);

    const latestBlock = out.split("\n\n").find((block) => block.includes("[Most recent session"));
    expect(latestBlock).toContain("Ghulam");
    expect(latestBlock).toContain("Grace");
    expect(latestBlock).toContain("have the cars clean and ready by 8 AM");
    expect(latestBlock).toContain("send the flower inventory");
  });

  it("excludes durable rows even when they are globally newer than the latest recap", () => {
    const out = formatRecentMemory([
      { created_at: "2026-06-22T10:00:00Z", summary: "• Routine: newest durable fact" },
      { created_at: "2026-06-22T02:32:14Z", summary: `${RECAP_PREFIX} the real last conversation` },
    ]);
    const recapBlock = out.split("\n\n").find((b) => b.includes("the real last conversation"));
    expect(out).not.toContain("newest durable fact");
    expect(out).not.toContain("[Durable memory —");
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
    const label = out.split("\n").find((line) => line.startsWith("[Most recent session"));
    expect(label).toMatch(/\d:\d{2}/);
  });
});
