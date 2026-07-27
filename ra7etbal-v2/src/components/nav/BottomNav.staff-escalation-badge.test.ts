import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(__dirname, "BottomNav.tsx"), "utf-8");

/**
 * Phase C — the What's Happening badge counts open staff escalations
 * (Phase B) alongside real needsAttention tasks, deduped against any
 * staff escalation whose linked task is already counted — same shared
 * helper Home.tsx and Updates.tsx use, so the three surfaces can never
 * drift from each other.
 */
describe("BottomNav.tsx — Phase C staff escalations counted in the What's Happening badge", () => {
  it("2. imports the shared staff-escalation hook and dedup helper", () => {
    expect(SOURCE).toContain('import { useOpenStaffEscalations } from "../../hooks/useOpenStaffEscalations";');
    expect(SOURCE).toContain(
      'import { filterVisibleStaffEscalations } from "../../lib/needs-you-staff-escalations";',
    );
  });

  it("2. sums real needsAttention tasks and visible staff escalations for the badge", () => {
    expect(SOURCE).toMatch(
      /return brief\.needsAttention\.length \+ visible\.length;/,
    );
  });
});
