import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  evaluateDeploymentIdentity,
  evaluateAmbiguousBindings,
  evaluateConstraintExists,
  evaluatePersonIdContinuity,
  buildCanaryReport,
  HUMAN_ONLY_BOUNDARIES,
  redactAuthHeader,
} from "./carson-production-canary.mjs";

// Phase 7 of the Carson Engineering Hardening Project. These tests prove
// the production canary's own check logic against fixtures — the real,
// live production run against actual Vercel/Supabase data happened
// separately during Phase 7 (see RA7ETBAL_STATE.md's Phase 7 entry), since
// that requires live credentials this test suite deliberately does not
// depend on (so it runs identically in CI with no secrets configured).

const __dirname = dirname(fileURLToPath(import.meta.url));

function healthyDeployment(overrides = {}) {
  return {
    readyState: "READY",
    target: "production",
    aliasError: null,
    meta: { githubCommitSha: "a34e671b6e00c45fb88f1ad562eeccd3b449c5ce" },
    alias: ["www.ra7etbal.com", "ra7etbal.com", "ra7etbal-v2.vercel.app"],
    ...overrides,
  };
}

describe("evaluateDeploymentIdentity", () => {
  it("healthy fixture passes", () => {
    const result = evaluateDeploymentIdentity({
      expectedSha: "a34e671b6e00c45fb88f1ad562eeccd3b449c5ce",
      deployment: healthyDeployment(),
    });
    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it("wrong deployment SHA fails", () => {
    const result = evaluateDeploymentIdentity({
      expectedSha: "a34e671b6e00c45fb88f1ad562eeccd3b449c5ce",
      deployment: healthyDeployment({ meta: { githubCommitSha: "0000000000000000000000000000000000stale" } }),
    });
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.includes("does not match expected"))).toBe(true);
  });

  it("fails when readyState is not READY (e.g. still building or errored)", () => {
    const result = evaluateDeploymentIdentity({
      expectedSha: "abc",
      deployment: healthyDeployment({ readyState: "BUILDING", meta: { githubCommitSha: "abc" } }),
    });
    expect(result.ok).toBe(false);
  });

  it("fails when aliasError is set (domain not actually pointing at this deployment)", () => {
    const result = evaluateDeploymentIdentity({
      expectedSha: "abc",
      deployment: healthyDeployment({ aliasError: { code: "invalid" }, meta: { githubCommitSha: "abc" } }),
    });
    expect(result.ok).toBe(false);
  });

  it("fails when the canonical production alias is missing from the deployment's alias list", () => {
    const result = evaluateDeploymentIdentity({
      expectedSha: "abc",
      deployment: healthyDeployment({ alias: ["some-preview-branch.vercel.app"], meta: { githubCommitSha: "abc" } }),
    });
    expect(result.ok).toBe(false);
  });

  it("fails cleanly (not a throw) when no deployment object is returned at all", () => {
    const result = evaluateDeploymentIdentity({ expectedSha: "abc", deployment: null });
    expect(result.ok).toBe(false);
  });

  it("an unrelated healthy field (e.g. target=production with a non-canonical but present alias) does not cause a false failure", () => {
    const result = evaluateDeploymentIdentity({
      expectedSha: "abc",
      deployment: healthyDeployment({ meta: { githubCommitSha: "abc" }, alias: ["ra7etbal.com", "www.ra7etbal.com"] }),
    });
    expect(result.ok).toBe(true);
  });
});

describe("evaluateAmbiguousBindings — owner_whatsapp_canonical_routing (Incident 1 shape)", () => {
  it("healthy fixture (one row per phone_number_id) passes", () => {
    const result = evaluateAmbiguousBindings([{ phone_number_id: "p1" }, { phone_number_id: "p2" }]);
    expect(result.ok).toBe(true);
    expect(result.ambiguous).toEqual([]);
  });

  it("ambiguous owner binding (two rows for the same phone_number_id) fails", () => {
    const result = evaluateAmbiguousBindings([
      { phone_number_id: "p1" },
      { phone_number_id: "p1" },
      { phone_number_id: "p2" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.ambiguous).toEqual([{ phone_number_id: "p1", count: 2 }]);
  });

  it("empty table (no bindings at all) does not false-positive", () => {
    const result = evaluateAmbiguousBindings([]);
    expect(result.ok).toBe(true);
  });
});

describe("evaluateConstraintExists — schema invariant", () => {
  it("healthy fixture (constraint present) passes", () => {
    const result = evaluateConstraintExists([{ conname: "whatsapp_health_state_phone_number_id_unique" }], "whatsapp_health_state_phone_number_id_unique");
    expect(result.ok).toBe(true);
  });

  it("missing required DB invariant (constraint absent) fails", () => {
    const result = evaluateConstraintExists([{ conname: "some_other_constraint" }], "whatsapp_health_state_phone_number_id_unique");
    expect(result.ok).toBe(false);
    expect(result.findings[0]).toMatch(/not found in pg_constraint/);
  });

  it("empty rows fails cleanly, not silently", () => {
    const result = evaluateConstraintExists([], "whatsapp_health_state_phone_number_id_unique");
    expect(result.ok).toBe(false);
  });
});

describe("evaluatePersonIdContinuity — automation-runner Communication History linkage (Incidents 3/4 shape)", () => {
  it("healthy fixture (person_id populated wherever resolvable) passes — no violating rows to begin with", () => {
    const result = evaluatePersonIdContinuity([], new Map(), new Map());
    expect(result.ok).toBe(true);
  });

  it("broken identity/linkage invariant fails: a delivery is missing person_id despite a resolvable assignee", () => {
    const deliveryRows = [{ id: "d1", created_at: "2026-08-14T00:00:00Z", automation_run_id: "run1" }];
    const automationRunsById = new Map([["run1", { automation_id: "auto1" }]]);
    const automationsById = new Map([["auto1", { assignee_id: "person1" }]]);
    const result = evaluatePersonIdContinuity(deliveryRows, automationRunsById, automationsById);
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([{ id: "d1", created_at: "2026-08-14T00:00:00Z", automation_run_id: "run1" }]);
  });

  it("unrelated healthy state does not cause a false failure: a delivery missing person_id but with NO resolvable assignee is correct, not a violation", () => {
    const deliveryRows = [{ id: "d1", created_at: "2026-08-14T00:00:00Z", automation_run_id: "run1" }];
    const automationRunsById = new Map([["run1", { automation_id: "auto1" }]]);
    const automationsById = new Map([["auto1", { assignee_id: null }]]); // ambiguous/unresolvable assignee — null person_id is the CORRECT behavior
    const result = evaluatePersonIdContinuity(deliveryRows, automationRunsById, automationsById);
    expect(result.ok).toBe(true);
  });

  it("a delivery whose automation_run_id doesn't resolve at all (e.g. race with a delete) is skipped, not falsely flagged", () => {
    const deliveryRows = [{ id: "d1", created_at: "2026-08-14T00:00:00Z", automation_run_id: "run-does-not-exist" }];
    const result = evaluatePersonIdContinuity(deliveryRows, new Map(), new Map());
    expect(result.ok).toBe(true);
  });

  it("also works with plain objects instead of Maps (matches how the CLI actually builds these from fetched rows)", () => {
    const deliveryRows = [{ id: "d1", created_at: "2026-08-14T00:00:00Z", automation_run_id: "run1" }];
    const automationRunsById = { run1: { automation_id: "auto1" } };
    const automationsById = { auto1: { assignee_id: "person1" } };
    const result = evaluatePersonIdContinuity(deliveryRows, automationRunsById, automationsById);
    expect(result.ok).toBe(false);
  });
});

describe("buildCanaryReport", () => {
  it("ok=true when every check passes, and humanOnlyBoundaries is still reported (not omitted just because everything passed)", () => {
    const report = buildCanaryReport({
      deploymentSha: "abc",
      checks: [{ name: "check_a", capability: "cap_a", result: { ok: true } }],
      humanOnlyBoundaries: HUMAN_ONLY_BOUNDARIES,
    });
    expect(report.ok).toBe(true);
    expect(report.failures).toEqual([]);
    expect(report.humanOnlyBoundaries.length).toBeGreaterThan(0);
  });

  it("ok=false when any check fails, and the failing check's detail is included for investigation", () => {
    const report = buildCanaryReport({
      deploymentSha: "abc",
      checks: [
        { name: "check_a", capability: "cap_a", result: { ok: true } },
        { name: "check_b", capability: "cap_b", result: { ok: false, findings: ["something broke"] } },
      ],
      humanOnlyBoundaries: [],
    });
    expect(report.ok).toBe(false);
    expect(report.failures).toEqual([{ name: "check_b", capability: "cap_b", detail: { ok: false, findings: ["something broke"] } }]);
  });

  it("unsupported/unverifiable human-only boundaries are reported truthfully, never marked as a PASS check", () => {
    const report = buildCanaryReport({
      deploymentSha: "abc",
      checks: [],
      humanOnlyBoundaries: HUMAN_ONLY_BOUNDARIES,
    });
    // Human-only boundaries must never appear inside `checks` (which implies
    // an automated PASS/FAIL verdict) — only in their own separate field.
    for (const boundary of report.humanOnlyBoundaries) {
      expect(report.checks.some((c) => c.capability === boundary.capability)).toBe(false);
    }
    expect(report.humanOnlyBoundaries.find((b) => b.capability === "notifications_inbox_durable_lifecycle")).toBeTruthy();
  });
});

describe("secrets are never printed", () => {
  it("evaluateDeploymentIdentity's output never contains a bearer/token-shaped string even given one in the input", () => {
    const result = evaluateDeploymentIdentity({
      expectedSha: "abc",
      deployment: healthyDeployment({ meta: { githubCommitSha: "abc" }, apiToken: "vercel_secret_token_should_never_appear" }),
    });
    expect(JSON.stringify(result)).not.toContain("vercel_secret_token_should_never_appear");
  });

  it("the module source contains no hardcoded secret-shaped literal (only env var names)", () => {
    const source = readFileSync(resolve(__dirname, "carson-production-canary.mjs"), "utf8");
    expect(source).not.toMatch(/Bearer [A-Za-z0-9_-]{20,}/);
    expect(source).toMatch(/redactAuthHeader/); // the redaction helper must exist and be used
  });

  it("redactAuthHeader redacts BOTH Authorization and apikey — fetchSupabaseTable sends the same raw service-role key in both headers at once, so redacting only one would still leak it in an error message", () => {
    const headers = { Authorization: "Bearer service-role-secret-value", apikey: "service-role-secret-value", "Content-Type": "application/json" };
    const redacted = redactAuthHeader(headers);
    expect(redacted.Authorization).toBe("[redacted]");
    expect(redacted.apikey).toBe("[redacted]");
    expect(redacted["Content-Type"]).toBe("application/json"); // unrelated headers pass through untouched
    expect(JSON.stringify(redacted)).not.toContain("service-role-secret-value");
  });
});

describe("cannot mutate protected business state — static source scan", () => {
  it("the canary module never calls a Supabase/PostgREST mutation method or HTTP verb", () => {
    const source = readFileSync(resolve(__dirname, "carson-production-canary.mjs"), "utf8");
    // Forbidden: any Supabase client mutation call, or a fetch with a
    // non-GET method (PostgREST mutations always require POST/PATCH/PUT/
    // DELETE — a plain GET, which is all this file ever issues, cannot
    // mutate anything).
    expect(source).not.toMatch(/\.insert\(|\.update\(|\.delete\(|\.upsert\(|\.rpc\(/);
    expect(source).not.toMatch(/method:\s*["'](POST|PATCH|PUT|DELETE)["']/i);
  });
});
