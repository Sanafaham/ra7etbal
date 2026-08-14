import { describe, it, expect } from "vitest";
import { mapChangedFiles, loadRegistry, loadExclusions } from "./impact-map.mjs";

/**
 * Phase 2 counterfactual verification (Carson Engineering Hardening Project,
 * mandatory per the Phase 2 authorization). Runs the real impact mapper
 * against the REAL, current carson-protected-registry.json — not a fixture —
 * using the changed-file sets that match each Phase 0 root-cause incident's
 * actual bad-change location (per the Phase 0 forensic reports).
 *
 * These do not claim the incident would have been "stopped" by CI alone —
 * that requires the selected test to actually assert the specific regressed
 * behavior, which is a property of the test file's own contents, not of the
 * mapper. What these prove, mechanically, is: given the file(s) the real bad
 * change touched, does the mapper select the capability whose focused_tests
 * include the file that DOES contain the regression's exact fixture? Where
 * that test is confirmed (by file inspection, not assumption) to contain the
 * specific fixture, it's noted below.
 */

const registry = loadRegistry();
const exclusions = loadExclusions();

function mapped(files) {
  return mapChangedFiles(files, registry, exclusions);
}

describe("Phase 2 counterfactual verification — Phase 0 incidents against the real registry", () => {
  it("Incident 1 — WhatsApp canonical-binding contamination (recordWebhookHeartbeat, api/whatsapp-webhook.js)", () => {
    const result = mapped(["api/whatsapp-webhook.js"]);
    expect(result.unmappedProtectedFiles).toEqual([]);
    expect(result.affectedCapabilities).toContain("owner_whatsapp_canonical_routing");
    // api/whatsapp-webhook.js is shared infrastructure — also touches the
    // WhatsApp delivery identity-continuity capability. Fan-out, not just
    // the nearest capability.
    expect(result.affectedCapabilities).toContain("whatsapp_delivery_person_identity_continuity");
    expect(result.requiredTests).toContain("api/whatsapp-webhook.test.js");
    // api/whatsapp-webhook.test.js contains the exact PR #244 regression
    // tests: "never invents a cross-account ownership binding" (3 tests)
    // and the account_not_unique fail-closed tests in
    // api/_owner-whatsapp-routing.test.js, also selected via the same file.
    expect(result.affectedCapabilities.length).toBeGreaterThanOrEqual(2);
  });

  it("Incident 2 — owner completion push confirmed_at mismatch (api/task-confirm.js:sendOwnerPush)", () => {
    const result = mapped(["api/task-confirm.js"]);
    expect(result.unmappedProtectedFiles).toEqual([]);
    expect(result.affectedCapabilities).toContain("owner_completion_push");
    expect(result.requiredTests).toContain("api/task-confirm.test.js");
    // api/task-confirm.test.js contains PR #246's exact round-trip
    // regression test proving the receipt dueAt binds to the real
    // PostgREST-returned confirmed_at, never new Date().toISOString().
  });

  it("Incident 3 — worker person_id continuity gap (api/task-confirm.js:handleOwnerDecision / findAssigneePerson)", () => {
    const result = mapped(["api/task-confirm.js", "api/_staff-decision-message.js"]);
    expect(result.unmappedProtectedFiles).toEqual([]);
    expect(result.affectedCapabilities).toContain("owner_decision_lifecycle");
    expect(result.requiredTests).toContain("api/task-confirm.test.js");
    expect(result.requiredTests).toContain("api/_staff-decision-message.test.js");
  });

  it("Incident 4 — automation-runner Communication History linkage gap (fan-out across three shared files)", () => {
    const result = mapped([
      "api/process-delegation-escalations.js",
      "api/send-whatsapp-task.js",
      "api/_whatsapp-delivery.js",
    ]);
    expect(result.unmappedProtectedFiles).toEqual([]);
    // This is the incident that specifically motivates broad shared-dependency
    // fan-out (Phase 0 §5 Impact-Aware CI design): api/_whatsapp-delivery.js
    // alone is depended on by owner_decision_lifecycle, staff_delegation,
    // direct_staff_communication, automation_execution_confirmation, and
    // communication_history. All must be selected, not just the nearest one.
    expect(result.affectedCapabilities).toContain("automation_execution_confirmation");
    expect(result.affectedCapabilities).toContain("communication_history");
    expect(result.affectedCapabilities).toContain("staff_delegation");
    expect(result.affectedCapabilities).toContain("direct_staff_communication");
    expect(result.affectedCapabilities).toContain("owner_decision_lifecycle");
    expect(result.affectedCapabilities.length).toBeGreaterThanOrEqual(5);
    expect(result.requiredTests).toContain("api/process-delegation-escalations.test.js");
    expect(result.requiredTests).toContain("src/lib/carson-communication-history.test.ts");
  });

  it("Incident 5 — hosting confirmation-recall timing collision (src/lib/ops-intelligence.ts)", () => {
    const result = mapped(["src/lib/ops-intelligence.ts"]);
    expect(result.unmappedProtectedFiles).toEqual([]);
    expect(result.affectedCapabilities).toContain("hosting_operations");
    expect(result.requiredTests).toContain("src/lib/ops-intelligence.test.ts");
    // Notable: hosting_operations.protected_suite is false (Tier
    // classification unresolved per the registry's own "unresolved" note),
    // so src/lib/ops-intelligence.test.ts is NOT in package.json's
    // unconditional test:carson-protected list. Impact-Aware CI selects and
    // runs it anyway whenever ops-intelligence.ts changes — this is a real
    // protection improvement over the Phase 0 baseline (where this test's
    // exact PR #251 timing-phrasing fixtures could regress silently on any
    // PR that didn't happen to touch the always-run required suite).
  });

  it("a genuinely new, unregistered production file (the actual failure shape behind Incident 6 in spirit — an unmapped change silently landing) is caught, not silently passed", () => {
    const result = mapped(["api/brand-new-carson-feature-nobody-registered.js"]);
    expect(result.unmappedProtectedFiles).toEqual(["api/brand-new-carson-feature-nobody-registered.js"]);
  });
});
