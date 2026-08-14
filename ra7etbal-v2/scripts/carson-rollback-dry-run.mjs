#!/usr/bin/env node
/**
 * Carson Engineering Hardening Project — Phase 8.
 *
 * Read-only rollback dry-run report. Combines the known-good release
 * ledger (carson-known-good-release.json), real git history, the Phase 8
 * migration classifier, the rollback eligibility checker, and the
 * Protected Behavior Registry into one report answering: if we rolled
 * back from the current release to a target release, would it be safe,
 * and what would it actually take?
 *
 * THIS SCRIPT NEVER MUTATES ANYTHING. It runs no `psql`, no `git push`,
 * no `git reset`, no Vercel promote/rollback call, no database write of
 * any kind. It only reads git history and prints a report. Executing an
 * actual rollback (application redeploy, and/or the listed rollback SQL
 * files in order, in an isolated environment first) remains a deliberate
 * human/operator action outside this tool's scope — see this repo's own
 * standing safety rules on destructive operations.
 *
 * Usage:
 *   node scripts/carson-rollback-dry-run.mjs --target=<sha> [--current=<sha>]
 *   node scripts/carson-rollback-dry-run.mjs   (with no args: reads target
 *     from carson-known-good-release.json, current defaults to HEAD)
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadKnownGoodRelease, migrationsBetween, repoRoot, gitRoot } from "./carson-release-manifest.mjs";
import { classifyAllMigrations } from "./carson-migration-classifier.mjs";
import { evaluateRollbackEligibility, capabilitiesForMigrationFiles } from "./carson-rollback-eligibility.mjs";

function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(arg);
    if (m) args[m[1]] = m[2];
  }
  return args;
}

function loadRegistry() {
  return JSON.parse(readFileSync(resolve(repoRoot, "carson-protected-registry.json"), "utf8"));
}

function commitsBetween(fromSha, toSha) {
  const out = execFileSync("git", ["log", "--oneline", `${fromSha}..${toSha}`], { cwd: gitRoot, encoding: "utf8" });
  return out.split("\n").filter(Boolean);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const current = args.current || execFileSync("git", ["rev-parse", "HEAD"], { cwd: gitRoot, encoding: "utf8" }).trim();

  let target = args.target;
  let targetSource = "explicit --target argument";
  if (!target) {
    const knownGood = loadKnownGoodRelease();
    if (!knownGood || !knownGood.sha) {
      console.error("carson-rollback-dry-run: no --target given and no carson-known-good-release.json exists yet — nothing to compare against.");
      process.exit(2);
    }
    target = knownGood.sha;
    targetSource = "carson-known-good-release.json";
  }

  const registry = loadRegistry();
  const classifications = classifyAllMigrations();
  const migrationFiles = migrationsBetween(target, current);
  const migrationsWithClassification = migrationFiles.map((file) => ({
    file,
    classification: classifications[file] ? classifications[file].classification : 5,
    reason: classifications[file] ? classifications[file].reason : "migration file not found by the classifier — treated as unknown",
  }));

  const eligibility = evaluateRollbackEligibility(migrationsWithClassification);
  const capabilitiesByMigration = capabilitiesForMigrationFiles(migrationFiles, registry.capabilities);

  const report = {
    generated_at: new Date().toISOString(),
    current_release_sha: current,
    proposed_rollback_target_sha: target,
    target_source: targetSource,
    commits_between: commitsBetween(target, current),
    migrations_between: migrationsWithClassification,
    protected_capabilities_potentially_affected: capabilitiesByMigration,
    eligibility,
    note: "READ-ONLY dry run. No SQL, git, or deployment mutation was performed. rollbacksToApply (if any) must be run manually, in an isolated test Postgres first, before ever touching production.",
  };

  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
