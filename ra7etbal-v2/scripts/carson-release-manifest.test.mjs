import { describe, it, expect } from "vitest";
import { buildReleaseManifest, evaluateKnownGoodEligibility, migrationsBetween } from "./carson-release-manifest.mjs";

// Phase 8 of the Carson Engineering Hardening Project.

function healthyDeployment(overrides = {}) {
  return {
    id: "dpl_abc",
    project: { id: "prj_abc" },
    readyState: "READY",
    target: "production",
    aliasError: null,
    alias: ["www.ra7etbal.com", "ra7etbal.com"],
    ...overrides,
  };
}

function healthyCanaryReport(sha) {
  return { ok: true, deploymentSha: sha, checks: [], failures: [], humanOnlyBoundaries: [] };
}

describe("buildReleaseManifest", () => {
  it("captures every Phase 8 required field", () => {
    const manifest = buildReleaseManifest({
      gitSha: "abc123",
      deployment: healthyDeployment(),
      previousKnownGoodSha: "old456",
      migrationsSincePrevious: [{ file: "x.sql", classification: 1 }],
      canaryReport: healthyCanaryReport("abc123"),
      humanAcceptanceRequired: [{ capability: "notifications_inbox_durable_lifecycle", completed: false }],
    });
    expect(manifest.git_sha).toBe("abc123");
    expect(manifest.vercel_deployment_id).toBe("dpl_abc");
    expect(manifest.production_alias).toBe("www.ra7etbal.com");
    expect(manifest.previous_known_good_sha).toBe("old456");
    expect(manifest.migrations_since_previous).toEqual([{ file: "x.sql", classification: 1 }]);
    expect(manifest.human_acceptance_required).toHaveLength(1);
  });

  it("tolerates a missing deployment object without throwing", () => {
    const manifest = buildReleaseManifest({ gitSha: "abc123", deployment: null });
    expect(manifest.git_sha).toBe("abc123");
    expect(manifest.vercel_deployment_id).toBeNull();
  });
});

describe("evaluateKnownGoodEligibility — fail-closed", () => {
  it("a fully healthy manifest is eligible", () => {
    const manifest = buildReleaseManifest({
      gitSha: "abc123",
      deployment: healthyDeployment(),
      canaryReport: healthyCanaryReport("abc123"),
      humanAcceptanceRequired: [],
    });
    const result = evaluateKnownGoodEligibility(manifest);
    expect(result.eligible).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("a merge with no manifest at all is never eligible", () => {
    expect(evaluateKnownGoodEligibility(null).eligible).toBe(false);
  });

  it("no canary report attached blocks eligibility — a merge alone is never sufficient", () => {
    const manifest = buildReleaseManifest({ gitSha: "abc123", deployment: healthyDeployment(), canaryReport: null });
    const result = evaluateKnownGoodEligibility(manifest);
    expect(result.eligible).toBe(false);
    expect(result.reasons.some((r) => r.includes("no production canary report"))).toBe(true);
  });

  it("a canary report that failed blocks eligibility", () => {
    const manifest = buildReleaseManifest({
      gitSha: "abc123",
      deployment: healthyDeployment(),
      canaryReport: { ok: false, deploymentSha: "abc123" },
    });
    expect(evaluateKnownGoodEligibility(manifest).eligible).toBe(false);
  });

  it("a canary report from a DIFFERENT SHA blocks eligibility — it doesn't prove THIS release", () => {
    const manifest = buildReleaseManifest({
      gitSha: "abc123",
      deployment: healthyDeployment(),
      canaryReport: healthyCanaryReport("some-other-sha"),
    });
    const result = evaluateKnownGoodEligibility(manifest);
    expect(result.eligible).toBe(false);
    expect(result.reasons.some((r) => r.includes("does not match"))).toBe(true);
  });

  it("deployment not READY blocks eligibility", () => {
    const manifest = buildReleaseManifest({
      gitSha: "abc123",
      deployment: healthyDeployment({ readyState: "BUILDING" }),
      canaryReport: healthyCanaryReport("abc123"),
    });
    expect(evaluateKnownGoodEligibility(manifest).eligible).toBe(false);
  });

  it("an incomplete required human-only acceptance boundary blocks eligibility, never silently marked done", () => {
    const manifest = buildReleaseManifest({
      gitSha: "abc123",
      deployment: healthyDeployment(),
      canaryReport: healthyCanaryReport("abc123"),
      humanAcceptanceRequired: [{ capability: "notifications_inbox_durable_lifecycle", completed: false }],
    });
    const result = evaluateKnownGoodEligibility(manifest);
    expect(result.eligible).toBe(false);
    expect(result.reasons.some((r) => r.includes("notifications_inbox_durable_lifecycle"))).toBe(true);
  });

  it("a COMPLETED human-only acceptance boundary does not block eligibility", () => {
    const manifest = buildReleaseManifest({
      gitSha: "abc123",
      deployment: healthyDeployment(),
      canaryReport: healthyCanaryReport("abc123"),
      humanAcceptanceRequired: [{ capability: "notifications_inbox_durable_lifecycle", completed: true }],
    });
    expect(evaluateKnownGoodEligibility(manifest).eligible).toBe(true);
  });
});

describe("migrationsBetween — real repository history", () => {
  it("excludes migrations/verification/*.sql (CI fixtures, never applied to production) despite git's pathspec glob crossing '/' boundaries", () => {
    // Real range: just before PR #244 (which added the real production
    // migration 20260813_whatsapp_health_state_phone_number_unique.sql)
    // through Phase 7's close — also spans Phase 4's PR #260, which added
    // several supabase/migrations/verification/*.sql fixture files. Those
    // must NOT appear in the result.
    const files = migrationsBetween("ff55cfb8e9313c7ecb346acfae0b7c321647052b^", "e3218bbcdfdd2fa695f5545b175c1b2420f04154");
    expect(files).toContain("20260813_whatsapp_health_state_phone_number_unique.sql");
    expect(files.some((f) => f.includes("verification/"))).toBe(false);
    expect(files.every((f) => f.endsWith(".sql") && !f.endsWith(".rollback.sql"))).toBe(true);
  });
});
