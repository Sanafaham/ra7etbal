#!/usr/bin/env node
/**
 * Carson Engineering Hardening Project — Phase 8.
 *
 * A release only becomes "known good" when there is durable evidence for
 * it, not merely because a merge happened. This module defines that
 * evidence shape (the release manifest) and the pure eligibility check
 * over it. The durable record itself lives in
 * carson-known-good-release.json (repo root, git-tracked, updated through
 * a normal protected PR — the same convention carson-protected-registry.json
 * already established, not a new parallel system).
 *
 * Exported functions are pure; only the CLI touches git/network.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(__dirname, "..");
export const gitRoot = resolve(repoRoot, "..");
export const KNOWN_GOOD_PATH = resolve(gitRoot, "carson-known-good-release.json");

/**
 * Builds a release manifest from already-gathered evidence. Every field
 * Phase 8 requires: commit SHA, Vercel deployment identity, production
 * alias, timestamp, previous known-good reference, migrations introduced
 * since the previous known-good release (each with its Phase 8
 * classification), required canaries and their result, and human-only
 * acceptance requirements (never silently marked complete).
 */
export function buildReleaseManifest({
  gitSha,
  deployment,
  previousKnownGoodSha,
  migrationsSincePrevious,
  canaryReport,
  humanAcceptanceRequired,
}) {
  return {
    generated_at: new Date().toISOString(),
    git_sha: gitSha,
    vercel_deployment_id: deployment && deployment.id,
    vercel_project_id: deployment && deployment.project && deployment.project.id,
    production_alias: (deployment && Array.isArray(deployment.alias) && deployment.alias.find((a) => a === "www.ra7etbal.com")) || null,
    deployment_ready_state: deployment && deployment.readyState,
    deployment_target: deployment && deployment.target,
    deployment_alias_error: deployment ? deployment.aliasError : "unknown",
    previous_known_good_sha: previousKnownGoodSha || null,
    migrations_since_previous: migrationsSincePrevious || [],
    canary_report: canaryReport || null,
    human_acceptance_required: humanAcceptanceRequired || [],
  };
}

/**
 * Determines whether a manifest's release qualifies as KNOWN GOOD.
 * Fail-closed: any missing or unhealthy required field blocks eligibility,
 * never defaults to true. A merge alone (no deployment/canary evidence) is
 * never sufficient — see this function's own reasons array for exactly
 * why, every time.
 */
export function evaluateKnownGoodEligibility(manifest) {
  const reasons = [];

  if (!manifest || !manifest.git_sha) {
    return { eligible: false, reasons: ["no manifest or git_sha provided"] };
  }
  if (manifest.deployment_ready_state !== "READY") {
    reasons.push(`deployment_ready_state is "${manifest.deployment_ready_state}", expected "READY"`);
  }
  if (manifest.deployment_target !== "production") {
    reasons.push(`deployment_target is "${manifest.deployment_target}", expected "production"`);
  }
  if (manifest.deployment_alias_error) {
    reasons.push(`deployment_alias_error is set: ${JSON.stringify(manifest.deployment_alias_error)}`);
  }
  if (!manifest.production_alias) {
    reasons.push("canonical production alias (www.ra7etbal.com) not present on the deployment");
  }
  if (!manifest.canary_report) {
    reasons.push("no production canary report attached — a merge alone is never sufficient evidence");
  } else if (manifest.canary_report.ok !== true) {
    reasons.push("production canary report is not ok:true");
  } else if (manifest.canary_report.deploymentSha !== manifest.git_sha) {
    reasons.push(`canary report's deploymentSha (${manifest.canary_report.deploymentSha}) does not match this manifest's git_sha (${manifest.git_sha}) — the canary may have run against a different release`);
  }

  const incompleteHumanBoundaries = (manifest.human_acceptance_required || []).filter((b) => !b.completed);
  if (incompleteHumanBoundaries.length > 0) {
    reasons.push(
      `${incompleteHumanBoundaries.length} required human-only acceptance boundary(ies) not marked completed: ${incompleteHumanBoundaries.map((b) => b.capability).join(", ")} — never silently treated as done`
    );
  }

  return { eligible: reasons.length === 0, reasons };
}

export function loadKnownGoodRelease() {
  if (!existsSync(KNOWN_GOOD_PATH)) return null;
  return JSON.parse(readFileSync(KNOWN_GOOD_PATH, "utf8"));
}

/**
 * Lists migration filenames added between two SHAs (git-tracked,
 * read-only — never applies or reverts anything). Reused by both the
 * manifest builder and the rollback dry-run tool so "what migrations
 * changed" is computed exactly once.
 */
export function migrationsBetween(fromSha, toSha) {
  const out = execFileSync("git", ["diff", "--name-only", "--diff-filter=A", `${fromSha}...${toSha}`, "--", "ra7etbal-v2/supabase/migrations/"], {
    cwd: gitRoot,
    encoding: "utf8",
  });
  return out
    .split("\n")
    .map((l) => l.trim())
    // Git's pathspec glob crosses "/" boundaries, so a naive
    // "migrations/*.sql" pattern also matches migrations/verification/*.sql
    // (CI fixture/test SQL, never applied to production) — filter those out
    // explicitly rather than relying on the pathspec alone.
    .filter((l) => l && l.endsWith(".sql") && !l.endsWith(".rollback.sql") && !l.includes("/verification/"))
    .map((l) => l.replace(/^ra7etbal-v2\/supabase\/migrations\//, ""));
}
