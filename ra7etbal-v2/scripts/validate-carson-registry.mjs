#!/usr/bin/env node
/**
 * Carson Protected Behavior Registry — validation.
 *
 * Phase 1 of the Carson Engineering Hardening Project (see RA7ETBAL_STATE.md
 * and the Phase 0 root-cause investigation). This script is the small,
 * deterministic guard the locked hardening order calls for: it does not
 * decide *what* is protected (that's the registry's job, populated from real
 * repository evidence) — it only proves the registry itself is not lying.
 *
 * Fails CI when:
 *   1. carson-protected-registry.json is missing or is not valid JSON.
 *   2. The top-level shape or a capability entry is missing a required field
 *      or has the wrong type.
 *   3. A capability id is duplicated.
 *   4. A registered focused test file (or golden-journey test file) does not
 *      exist on disk.
 *   5. A registered production path in files_functions,
 *      production_entry_points, or shared_dependencies does not exist on
 *      disk. Each entry is normalized first: a trailing parenthetical note
 *      ("path/to/file.js (some description)") is stripped, then the
 *      substring before the first ":" is taken, so "path:functionName",
 *      "path (note)", and bare "path" all resolve to the same file check.
 *   6. A registered db migration / data-repair path does not exist on disk.
 *   7. A Tier 1 capability (protected_suite !== false and no explicit
 *      "unresolved" note excusing it) has zero focused_tests AND zero
 *      golden_journey_tests — i.e. a capability claiming protection with no
 *      identifiable test evidence at all.
 *   8. A capability marked protected_suite: true lists a focused_tests or
 *      golden_journey_tests file that is NOT actually present in either of
 *      package.json's pretest:carson-protected or test:carson-protected
 *      script strings — i.e. the registry claims a test is enforced by the
 *      required CI gate when it would not actually run there. An existing,
 *      passing, but uncalled test must not be able to satisfy
 *      protected_suite: true.
 *   9. (Phase 4) A registered db_contract_tests entry does not exist on
 *      disk, or a db_contract_workflow entry does not exist on disk.
 *   10. (Phase 9) A capability's db_contract_workflow / db_contract_workflows
 *       entries must each resolve to a job whose name is an actual required
 *       branch-protection status check on `main` — see REQUIRED_MERGE_GATE_CHECKS
 *       below. A capability cannot claim DB-contract protection through a
 *       workflow that would not actually block a bad merge. This is Phase 9's
 *       mechanical answer to "does this depend only on optional CI, or a
 *       non-required test" for the DB-contract dimension specifically.
 *   11. (Phase 9) production_canary_required: true must be backed by an
 *       actual production_canary object with a valid classification (A,
 *       "A (partial)", B, or C) and a non-empty "proves" statement — the
 *       same mechanical-not-documentary bar, for the production-canary
 *       dimension.
 *
 * Deliberately NOT enforced here (left for a future phase, not guessed at):
 *   - Whether a focused test file's assertions actually exercise the named
 *     production function (that's what the tests themselves prove).
 *   - Whether every changed production file maps to a registry entry
 *     (Impact-Aware CI, Phase 2 — this script only validates the registry's
 *     own internal consistency, not PR diffs).
 *
 * Usage: node scripts/validate-carson-registry.mjs
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const registryPath = resolve(repoRoot, "carson-protected-registry.json");
const packageJsonPath = resolve(repoRoot, "package.json");

/**
 * Normalizes a registry path-bearing entry down to just its file path.
 * Handles three shapes seen in the registry:
 *   "path/to/file.ts:functionName"        -> "path/to/file.ts"
 *   "path/to/file.js (some description)"  -> "path/to/file.js"
 *   "path/to/file.js"                     -> "path/to/file.js"
 */
function extractFilePath(entry) {
  const withoutParenthetical = String(entry).replace(/\s*\([^)]*\)\s*$/, "");
  return withoutParenthetical.split(":")[0].trim();
}

/**
 * Phase 9 — the fixed set of GitHub branch-protection required_status_checks
 * contexts on `main`, as of the date below. This is a maintained constant,
 * not a live lookup: CI has no network access to the GitHub API, and a
 * registry validator must be deterministic. Last verified against
 * `gh api repos/Sanafaham/ra7etbal/branches/main/protection/required_status_checks`
 * on 2026-08-24 (9 checks, all present — attention-summary-rls-proof added
 * this date so its DB-contract proof cannot silently disappear later). If
 * branch protection changes, this list must be updated in the same PR — a
 * stale list here would silently stop catching the exact failure class
 * Phase 9 exists to catch.
 */
const REQUIRED_MERGE_GATE_CHECKS = new Set([
  "carson-protected-behaviors",
  "carson-impact-aware-ci",
  "carson-tier1-db-contracts",
  "carson-state-doc-integrity",
  "push-subscription-installation-identity-verification",
  "staff-escalation-migration-verification",
  "real-postgres-rls-proof",
  "owner-reminder-whatsapp-claim-verification",
  "attention-summary-rls-proof",
]);

/**
 * Extracts the `name:` of the (first, top-level) job in a GitHub Actions
 * workflow file — this is the string that appears as the check's context
 * in branch protection, which is not always the same as the workflow's own
 * top-level `name:` (e.g. server-authoritative-reminder-rls-verification.yml's
 * job is named `real-postgres-rls-proof`). Returns null if not found.
 */
function extractWorkflowJobName(workflowSource) {
  const jobsIndex = workflowSource.indexOf("\njobs:");
  if (jobsIndex === -1) return null;
  const afterJobs = workflowSource.slice(jobsIndex);
  const match = afterJobs.match(/\n {4}name:\s*(.+)/);
  return match ? match[1].trim() : null;
}

/** Every db_contract_workflow path a capability declares, singular + plural fields combined. */
function dbContractWorkflowPaths(cap) {
  const paths = [];
  if (typeof cap.db_contract_workflow === "string") paths.push(cap.db_contract_workflow);
  if (Array.isArray(cap.db_contract_workflows)) paths.push(...cap.db_contract_workflows);
  return paths;
}

/**
 * Extracts the set of test files that will actually run under the required
 * `carson-protected-behaviors` CI check — i.e. every file listed in either
 * package.json's `pretest:carson-protected` (an npm pre-hook that runs
 * automatically before `test:carson-protected`) or `test:carson-protected`
 * script strings themselves.
 */
function loadRequiredCiTestFiles() {
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const scripts = pkg.scripts || {};
  const files = new Set();
  for (const key of ["pretest:carson-protected", "test:carson-protected"]) {
    const script = scripts[key];
    if (typeof script !== "string") continue;
    for (const token of script.split(/\s+/)) {
      if (token.endsWith(".test.js") || token.endsWith(".test.ts") || token.endsWith(".test.tsx")) {
        files.add(token);
      }
    }
  }
  return files;
}

const errors = [];
const warnings = [];

function fail(msg) {
  errors.push(msg);
}

function warn(msg) {
  warnings.push(msg);
}

// --- 1. File exists and is valid JSON ---------------------------------

if (!existsSync(registryPath)) {
  fail(`carson-protected-registry.json not found at ${registryPath}`);
  report();
}

let registry;
try {
  registry = JSON.parse(readFileSync(registryPath, "utf8"));
} catch (err) {
  fail(`carson-protected-registry.json is not valid JSON: ${err.message}`);
  report();
}

// --- 2. Top-level shape -------------------------------------------------

if (!Array.isArray(registry.capabilities)) {
  fail(`registry.capabilities must be an array (got ${typeof registry.capabilities})`);
  report();
}

const REQUIRED_STRING_FIELDS = [
  "id",
  "contract",
  "business_importance",
  "rollback_risk",
  "verification_status",
];
const REQUIRED_ARRAY_FIELDS = [
  "production_entry_points",
  "files_functions",
  "shared_dependencies",
  "external_boundaries",
  "focused_tests",
  "golden_journey_tests",
  "unresolved",
];
const REQUIRED_BOOLEAN_FIELDS = [
  "protected_suite",
  "golden_journey_required",
  "production_canary_required",
];

const seenIds = new Set();
const requiredCiTestFiles = loadRequiredCiTestFiles();

for (const [index, cap] of registry.capabilities.entries()) {
  const label = cap && typeof cap.id === "string" ? cap.id : `capabilities[${index}]`;

  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof cap[field] !== "string" || cap[field].length === 0) {
      fail(`${label}: missing or empty required string field "${field}"`);
    }
  }
  for (const field of REQUIRED_ARRAY_FIELDS) {
    if (!Array.isArray(cap[field])) {
      fail(`${label}: missing or invalid required array field "${field}"`);
    }
  }
  for (const field of REQUIRED_BOOLEAN_FIELDS) {
    if (typeof cap[field] !== "boolean") {
      fail(`${label}: missing or invalid required boolean field "${field}"`);
    }
  }
  if (typeof cap.db !== "object" || cap.db === null) {
    fail(`${label}: missing or invalid required object field "db"`);
  } else {
    for (const field of ["tables", "rpcs", "migrations"]) {
      if (!Array.isArray(cap.db[field])) {
        fail(`${label}: db.${field} must be an array`);
      }
    }
    if (cap.db.data_repairs !== undefined && !Array.isArray(cap.db.data_repairs)) {
      fail(`${label}: db.data_repairs, if present, must be an array`);
    }
  }

  // --- Phase 4: db_contract_tests / db_contract_workflow, if present -------
  if (cap.db_contract_tests !== undefined && !Array.isArray(cap.db_contract_tests)) {
    fail(`${label}: db_contract_tests, if present, must be an array`);
  }
  if (cap.db_contract_workflow !== undefined && typeof cap.db_contract_workflow !== "string") {
    fail(`${label}: db_contract_workflow, if present, must be a string`);
  }
  if (cap.db_contract_workflows !== undefined && !Array.isArray(cap.db_contract_workflows)) {
    fail(`${label}: db_contract_workflows, if present, must be an array`);
  }

  // --- 3. Duplicate ids ---------------------------------------------
  if (typeof cap.id === "string") {
    if (seenIds.has(cap.id)) {
      fail(`duplicate capability id "${cap.id}"`);
    }
    seenIds.add(cap.id);
  }

  // --- 4/5/6/9. Referenced paths must exist on disk --------------------
  const pathFieldsToCheck = [
    ["focused_tests", cap.focused_tests],
    ["golden_journey_tests", cap.golden_journey_tests],
    ["db.migrations", cap.db && cap.db.migrations],
    ["db.data_repairs", cap.db && cap.db.data_repairs],
    ["db_contract_tests", cap.db_contract_tests],
  ];
  for (const [fieldName, list] of pathFieldsToCheck) {
    if (!Array.isArray(list)) continue;
    for (const relPath of list) {
      const abs = resolve(repoRoot, relPath);
      if (!existsSync(abs)) {
        fail(`${label}: ${fieldName} references nonexistent path "${relPath}"`);
      }
    }
  }
  for (const workflowPath of dbContractWorkflowPaths(cap)) {
    // db_contract_workflow(s) paths are relative to the actual git repo root
    // (one directory above repoRoot — see impact-map.mjs's identical note
    // on this layout), not repoRoot itself, since .github/ lives there.
    const abs = resolve(repoRoot, "..", workflowPath);
    if (!existsSync(abs)) {
      fail(`${label}: db_contract_workflow references nonexistent path "${workflowPath}"`);
      continue;
    }

    // --- 10. A claimed DB-contract protection must be an actual required
    // merge gate, not merely an existing-and-passing-but-optional workflow.
    const jobName = extractWorkflowJobName(readFileSync(abs, "utf8"));
    if (!jobName) {
      fail(`${label}: could not determine the job name of db_contract_workflow "${workflowPath}" (expected a 4-space-indented "name:" under jobs:)`);
    } else if (!REQUIRED_MERGE_GATE_CHECKS.has(jobName)) {
      fail(
        `${label}: db_contract_workflow "${workflowPath}" resolves to job "${jobName}", which is not in REQUIRED_MERGE_GATE_CHECKS — this capability claims DB-contract protection through a workflow that would not actually block a bad merge`
      );
    }
  }

  // --- 11. (Phase 9) production_canary_required: true must be backed by an
  // actual, classified production_canary object — a capability cannot claim
  // "a production canary is required for this" while leaving the object
  // that would describe what it proves entirely absent, which would be
  // exactly the "documentation says it is protected" failure Phase 9 exists
  // to catch, just for the canary dimension instead of the DB-contract one.
  if (cap.production_canary_required === true) {
    const pc = cap.production_canary;
    const validClassifications = new Set(["A", "A (partial)", "B", "C"]);
    if (typeof pc !== "object" || pc === null) {
      fail(`${label}: production_canary_required is true but production_canary is missing`);
    } else if (!validClassifications.has(pc.classification)) {
      fail(`${label}: production_canary.classification "${pc.classification}" is not one of A / A (partial) / B / C`);
    } else if (typeof pc.proves !== "string" || pc.proves.length === 0) {
      fail(`${label}: production_canary is missing a non-empty "proves" statement`);
    }
  }

  const filePathFieldsToCheck = [
    ["files_functions", cap.files_functions],
    ["production_entry_points", cap.production_entry_points],
    ["shared_dependencies", cap.shared_dependencies],
  ];
  for (const [fieldName, list] of filePathFieldsToCheck) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const relPath = extractFilePath(entry);
      const abs = resolve(repoRoot, relPath);
      if (!existsSync(abs)) {
        fail(`${label}: ${fieldName} references nonexistent production path "${relPath}" (from "${entry}")`);
      }
    }
  }

  // --- 7. A capability claiming protection needs identifiable protection --
  const hasAnyTest =
    (Array.isArray(cap.focused_tests) && cap.focused_tests.length > 0) ||
    (Array.isArray(cap.golden_journey_tests) && cap.golden_journey_tests.length > 0);
  const hasExplicitUnresolvedExcuse =
    Array.isArray(cap.unresolved) && cap.unresolved.length > 0;

  if (cap.protected_suite === true && !hasAnyTest) {
    fail(`${label}: protected_suite is true but focused_tests and golden_journey_tests are both empty — no identifiable protection`);
  }
  if (cap.protected_suite === false && !hasAnyTest && !hasExplicitUnresolvedExcuse) {
    fail(`${label}: not in the protected suite and has no focused_tests/golden_journey_tests, but also gives no "unresolved" explanation — a Tier 1 capability with no identifiable protection and no acknowledgement is exactly what this validator exists to catch`);
  }

  // --- 8. protected_suite: true must be backed by the real required CI gate --
  if (cap.protected_suite === true) {
    const allTests = [
      ...(Array.isArray(cap.focused_tests) ? cap.focused_tests : []),
      ...(Array.isArray(cap.golden_journey_tests) ? cap.golden_journey_tests : []),
    ];
    for (const testPath of allTests) {
      if (!requiredCiTestFiles.has(testPath)) {
        fail(
          `${label}: protected_suite is true and lists "${testPath}", but that file is not present in package.json's pretest:carson-protected or test:carson-protected script — it would not actually run in the required carson-protected-behaviors CI check`
        );
      }
    }
  }
}

report();

function report() {
  if (warnings.length > 0) {
    console.warn(`carson-protected-registry.json: ${warnings.length} warning(s):`);
    for (const w of warnings) console.warn(`  - ${w}`);
  }
  if (errors.length > 0) {
    console.error(`carson-protected-registry.json: ${errors.length} error(s):`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(
    `carson-protected-registry.json: OK (${registry.capabilities.length} capabilities validated)`
  );
  process.exit(0);
}
