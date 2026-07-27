import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(__dirname, "BottomNav.tsx"), "utf-8");

/**
 * Phase C — the What's Happening badge counts open staff escalations
 * (Phase B) alongside real needsAttention tasks, via the same shared
 * helper Home.tsx and Updates.tsx use, so the three surfaces can never
 * drift from each other. That helper no longer deduplicates by task_id
 * (fixed: PR #90 re-review) — task_id alone is not a reliable
 * shared-decision identifier, so every open escalation counts.
 */
describe("BottomNav.tsx — Phase C staff escalations counted in the What's Happening badge", () => {
  it("2. imports the shared staff-escalation hook and helper", () => {
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
