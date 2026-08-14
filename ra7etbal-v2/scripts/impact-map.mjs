#!/usr/bin/env node
/**
 * Carson Impact-Aware CI — impact mapper.
 *
 * Phase 2 of the Carson Engineering Hardening Project. Reads the Phase 1
 * Protected Behavior Registry (carson-protected-registry.json) — the single
 * source of truth, not duplicated here — and maps a set of changed files to
 * the protected capabilities they can affect, so CI can automatically run
 * the relevant existing regression tests instead of relying on a developer
 * to remember which suites matter.
 *
 * Exported functions are pure and git-free so they can be unit tested
 * directly (see impact-map.test.mjs). Only main()/getChangedFilesFromGit()
 * touch git or process.argv, and only main() calls process.exit().
 *
 * CLI usage (as run by CI — see .github/workflows/carson-impact-aware-ci.yml):
 *   node scripts/impact-map.mjs --base=<git-ref-or-sha>
 *
 * The CLI always computes the changed-file list itself via `git diff
 * --name-only <base>...HEAD` — it never accepts a developer-supplied file
 * list as the source of truth for what changed, only a base ref to diff
 * against.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(__dirname, "..");

export const REGISTRY_PATH = resolve(repoRoot, "carson-protected-registry.json");
export const EXCLUSIONS_PATH = resolve(repoRoot, "carson-impact-exclusions.json");

// Directories under which a changed production file is required to map to
// at least one registered protected capability (or an explicit exclusion).
// Deliberately just the three surfaces named in the Phase 2 authorization —
// not every directory in the repo (src/components, scripts/, etc. are
// covered indirectly: any file already referenced by the registry, from
// any directory, still participates in mapping — this list only controls
// the *fail-closed* gate).
export const PROTECTED_SURFACE_PREFIXES = ["api/", "src/lib/", "supabase/migrations/"];

// Test files and DB verification fixtures are not "production" for the
// purpose of the fail-closed gate — they're already covered by the
// unconditional carson-protected-behaviors suite (test files) or are
// themselves regression-proof tooling (supabase/migrations/verification/),
// not business logic that needs a capability owner.
const NON_PRODUCTION_SUFFIXES = [".test.js", ".test.ts", ".test.tsx", ".rollback.sql"];
const NON_PRODUCTION_PREFIXES = ["supabase/migrations/verification/"];

/** Same normalization as scripts/validate-carson-registry.mjs. Kept in sync
 * intentionally (small enough not to warrant a shared import across two
 * independently-invoked CLI scripts). */
export function extractFilePath(entry) {
  const withoutParenthetical = String(entry).replace(/\s*\([^)]*\)\s*$/, "");
  return withoutParenthetical.split(":")[0].trim();
}

export function loadRegistry(registryPath = REGISTRY_PATH) {
  return JSON.parse(readFileSync(registryPath, "utf8"));
}

export function loadExclusions(exclusionsPath = EXCLUSIONS_PATH) {
  if (!existsSync(exclusionsPath)) return new Set();
  const data = JSON.parse(readFileSync(exclusionsPath, "utf8"));
  return new Set((data.excluded_files || []).map((e) => e.path));
}

/**
 * Builds a Map from normalized relative path -> Set of capability ids that
 * reference that path anywhere in files_functions, production_entry_points,
 * shared_dependencies, db.migrations, db.data_repairs, db_contract_tests, or
 * db_contract_workflow. db_contract_workflow entries are repo-root-relative
 * (e.g. ".github/workflows/...") — the same layout impact-map's CLI diff
 * output uses — so they are added to the index unmodified.
 */
export function buildPathIndex(registry) {
  const index = new Map();
  const add = (relPath, capId) => {
    if (!index.has(relPath)) index.set(relPath, new Set());
    index.get(relPath).add(capId);
  };
  for (const cap of registry.capabilities || []) {
    for (const field of ["files_functions", "production_entry_points", "shared_dependencies"]) {
      for (const entry of cap[field] || []) {
        add(extractFilePath(entry), cap.id);
      }
    }
    for (const relPath of (cap.db && cap.db.migrations) || []) add(relPath, cap.id);
    for (const relPath of (cap.db && cap.db.data_repairs) || []) add(relPath, cap.id);
    for (const relPath of cap.db_contract_tests || []) add(relPath, cap.id);
    if (cap.db_contract_workflow) add(cap.db_contract_workflow, cap.id);
  }
  return index;
}

/** Builds a Map from registered test path -> Set of capability ids, so a
 * changed test file can select its own capability's test set even when the
 * test itself isn't a "production" file. */
export function buildTestIndex(registry) {
  const index = new Map();
  const add = (relPath, capId) => {
    if (!index.has(relPath)) index.set(relPath, new Set());
    index.get(relPath).add(capId);
  };
  for (const cap of registry.capabilities || []) {
    for (const field of ["focused_tests", "golden_journey_tests"]) {
      for (const relPath of cap[field] || []) add(relPath, cap.id);
    }
  }
  return index;
}

export function isProductionSurfaceFile(relPath) {
  if (NON_PRODUCTION_SUFFIXES.some((suf) => relPath.endsWith(suf))) return false;
  if (NON_PRODUCTION_PREFIXES.some((pre) => relPath.startsWith(pre))) return false;
  return PROTECTED_SURFACE_PREFIXES.some((pre) => relPath.startsWith(pre));
}

/**
 * A supabase migration's .rollback.sql sibling is treated as mapping to
 * exactly the same capabilities as its forward migration (same logical
 * change, companion file by naming convention: "<name>.sql" /
 * "<name>.rollback.sql").
 */
function rollbackCompanion(relPath) {
  if (!relPath.endsWith(".rollback.sql")) return null;
  return relPath.slice(0, -".rollback.sql".length) + ".sql";
}

/**
 * Maps a list of changed (repo-root-relative) file paths to the set of
 * affected capabilities, the union of their required tests, and any
 * protected-surface file that mapped to zero capabilities and isn't
 * explicitly excluded.
 */
export function mapChangedFiles(changedFiles, registry, exclusions = new Set()) {
  const pathIndex = buildPathIndex(registry);
  const testIndex = buildTestIndex(registry);

  const affectedCapabilities = new Set();
  const unmappedProtectedFiles = [];
  const matchDetail = {};

  for (const rawPath of changedFiles) {
    const relPath = rawPath.trim();
    if (!relPath) continue;

    const caps = new Set();
    if (pathIndex.has(relPath)) {
      for (const c of pathIndex.get(relPath)) caps.add(c);
    }
    const companion = rollbackCompanion(relPath);
    if (companion && pathIndex.has(companion)) {
      for (const c of pathIndex.get(companion)) caps.add(c);
    }
    if (testIndex.has(relPath)) {
      for (const c of testIndex.get(relPath)) caps.add(c);
    }

    if (caps.size > 0) {
      matchDetail[relPath] = [...caps];
      for (const c of caps) affectedCapabilities.add(c);
      continue;
    }

    if (isProductionSurfaceFile(relPath) && !exclusions.has(relPath)) {
      unmappedProtectedFiles.push(relPath);
    }
  }

  const requiredTests = new Set();
  // Phase 4: DB-layer contract protection (real-Postgres SQL verification
  // scripts, run via a dedicated GitHub Actions workflow, never via vitest)
  // is surfaced here as informational output — this mapper cannot itself
  // spin up a Postgres service, so it reports which contracts/workflows
  // are relevant rather than "selecting tests to run" the way it does for
  // vitest-based focused_tests/golden_journey_tests.
  const affectedDbContractTests = new Set();
  const affectedDbContractWorkflows = new Set();
  for (const cap of registry.capabilities || []) {
    if (!affectedCapabilities.has(cap.id)) continue;
    for (const t of cap.focused_tests || []) requiredTests.add(t);
    for (const t of cap.golden_journey_tests || []) requiredTests.add(t);
    for (const t of cap.db_contract_tests || []) affectedDbContractTests.add(t);
    if (cap.db_contract_workflow) affectedDbContractWorkflows.add(cap.db_contract_workflow);
  }

  return {
    affectedCapabilities: [...affectedCapabilities].sort(),
    requiredTests: [...requiredTests].sort(),
    unmappedProtectedFiles: [...new Set(unmappedProtectedFiles)].sort(),
    matchDetail,
    affectedDbContractTests: [...affectedDbContractTests].sort(),
    affectedDbContractWorkflows: [...affectedDbContractWorkflows].sort(),
  };
}

/** Every path referenced anywhere in the registry (files_functions,
 * production_entry_points, shared_dependencies, migrations, data_repairs,
 * focused_tests, golden_journey_tests) must exist on disk. This mirrors
 * validate-carson-registry.mjs's own check — kept here too so the mapper
 * fails loudly if it's ever run against a registry that skipped
 * validation, rather than silently producing an empty/wrong mapping. */
export function findMissingRegistryPaths(registry) {
  const missing = [];
  for (const cap of registry.capabilities || []) {
    const allPaths = [
      ...(cap.files_functions || []).map(extractFilePath),
      ...(cap.production_entry_points || []).map(extractFilePath),
      ...(cap.shared_dependencies || []).map(extractFilePath),
      ...((cap.db && cap.db.migrations) || []),
      ...((cap.db && cap.db.data_repairs) || []),
      ...(cap.focused_tests || []),
      ...(cap.golden_journey_tests || []),
    ];
    for (const p of allPaths) {
      if (!existsSync(resolve(repoRoot, p))) {
        missing.push(`${cap.id}: ${p}`);
      }
    }
  }
  return missing;
}

// --- CLI --------------------------------------------------------------

export function getChangedFilesFromGit(baseRef) {
  // The actual git repository root is one directory above repoRoot
  // (ra7etbal-v2/ is a subdirectory of the repo that also contains
  // top-level AGENTS.md/RA7ETBAL_STATE.md/.github/). `git diff --name-only`
  // always returns paths relative to the repo root, not the cwd — without
  // `--relative` every path would come back prefixed "ra7etbal-v2/..." and
  // silently fail to match anything in the registry (which stores paths
  // relative to ra7etbal-v2/). `--relative` (run with cwd: repoRoot) makes
  // git both scope to and report paths relative to ra7etbal-v2/ itself,
  // which is exactly what the registry expects — a change to a top-level
  // file like RA7ETBAL_STATE.md is out of this mapper's scope by design
  // (see the separate, not-yet-built stale_state_doc_integrity capability).
  const out = execFileSync(
    "git",
    ["diff", "--relative", "--name-only", `${baseRef}...HEAD`],
    { cwd: repoRoot, encoding: "utf8" }
  );
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(arg);
    if (m) args[m[1]] = m[2];
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const base = args.base || "origin/main";

  const registry = loadRegistry();
  const missing = findMissingRegistryPaths(registry);
  if (missing.length > 0) {
    console.error(`impact-map: registry references ${missing.length} nonexistent path(s) — run npm run validate:carson-registry first:`);
    for (const m of missing) console.error(`  - ${m}`);
    process.exit(1);
  }

  const exclusions = loadExclusions();

  let changedFiles;
  try {
    changedFiles = getChangedFilesFromGit(base);
  } catch (err) {
    console.error(`impact-map: failed to compute changed files against base "${base}": ${err.message}`);
    process.exit(1);
  }

  const result = mapChangedFiles(changedFiles, registry, exclusions);

  console.log(`impact-map: base=${base}`);
  console.log(`impact-map: ${changedFiles.length} changed file(s)`);
  console.log(`impact-map: affected capabilities (${result.affectedCapabilities.length}): ${result.affectedCapabilities.join(", ") || "(none)"}`);
  console.log(`impact-map: required tests (${result.requiredTests.length}):`);
  for (const t of result.requiredTests) console.log(`  - ${t}`);
  if (result.affectedDbContractTests.length > 0) {
    console.log(`impact-map: relevant real-Postgres DB contract tests (${result.affectedDbContractTests.length}, run via a dedicated workflow, not vitest):`);
    for (const t of result.affectedDbContractTests) console.log(`  - ${t}`);
    console.log(`impact-map: relevant DB contract workflow(s): ${result.affectedDbContractWorkflows.join(", ")}`);
  }

  if (args["tests-out"]) {
    writeFileSync(resolve(repoRoot, args["tests-out"]), result.requiredTests.join("\n") + (result.requiredTests.length ? "\n" : ""));
  }
  if (args["summary-out"]) {
    writeFileSync(resolve(repoRoot, args["summary-out"]), JSON.stringify(result, null, 2) + "\n");
  }

  if (result.unmappedProtectedFiles.length > 0) {
    console.error(`impact-map: ${result.unmappedProtectedFiles.length} protected production file(s) map to ZERO registered capabilities:`);
    for (const f of result.unmappedProtectedFiles) console.error(`  - ${f}`);
    console.error(
      "impact-map: this means the Protected Behavior Registry is incomplete for a file that was just changed. " +
        "The correct repair is to add this file to the relevant capability's files_functions/production_entry_points/" +
        "shared_dependencies in carson-protected-registry.json (or, if it genuinely contains no Carson protected-capability " +
        "logic, add a narrowly-justified entry to carson-impact-exclusions.json) — not to bypass this check."
    );
    process.exit(1);
  }

  process.exit(0);
}

const isMainModule = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  main();
}
