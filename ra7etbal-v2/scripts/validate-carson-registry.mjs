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
 *   5. A registered production path in files_functions does not exist on
 *      disk (checked as the substring before the first ":", so
 *      "path/to/file.ts:functionName" and bare "path/to/file.ts" both work).
 *   6. A registered db migration / data-repair path does not exist on disk.
 *   7. A Tier 1 capability (protected_suite !== false and no explicit
 *      "unresolved" note excusing it) has zero focused_tests AND zero
 *      golden_journey_tests — i.e. a capability claiming protection with no
 *      identifiable test evidence at all.
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

  // --- 3. Duplicate ids ---------------------------------------------
  if (typeof cap.id === "string") {
    if (seenIds.has(cap.id)) {
      fail(`duplicate capability id "${cap.id}"`);
    }
    seenIds.add(cap.id);
  }

  // --- 4/5/6. Referenced paths must exist on disk --------------------
  const pathFieldsToCheck = [
    ["focused_tests", cap.focused_tests],
    ["golden_journey_tests", cap.golden_journey_tests],
    ["db.migrations", cap.db && cap.db.migrations],
    ["db.data_repairs", cap.db && cap.db.data_repairs],
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

  if (Array.isArray(cap.files_functions)) {
    for (const entry of cap.files_functions) {
      const relPath = String(entry).split(":")[0].trim();
      const abs = resolve(repoRoot, relPath);
      if (!existsSync(abs)) {
        fail(`${label}: files_functions references nonexistent production path "${relPath}" (from "${entry}")`);
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
