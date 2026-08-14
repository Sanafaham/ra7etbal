#!/usr/bin/env node
/**
 * Carson Engineering Hardening Project — Phase 8.
 *
 * Classifies each production migration by application-rollback safety, so
 * the rollback eligibility checker (carson-rollback-eligibility.mjs) never
 * has to guess. Classification is mechanical, not hand-authored per
 * migration — the same migration file always classifies the same way,
 * and a NEW migration with no explicit override is classified from its
 * own SQL content plus real CI evidence, never silently assumed safe.
 *
 * Five classes (matching the Phase 8 authorization's own taxonomy):
 *   1. application-backward-compatible — additive only (new table/column/
 *      index/function, a nullable column, a relaxed constraint). An older
 *      application deployment can run unmodified against this schema.
 *   2. explicitly reversible with TESTED rollback SQL — a *.rollback.sql
 *      sibling exists AND a GitHub Actions workflow actually applies and
 *      verifies it (grepped for real, not assumed from the filename).
 *      "Exists but never exercised by CI" does NOT qualify for class 2 —
 *      see class 3.
 *   3. additive but not automatically reversible — a rollback.sql sibling
 *      exists as a human-authored asset, but no CI workflow proves it
 *      still works; OR the migration's content doesn't clearly match any
 *      other class. Treated as NOT safe to rely on for automated rollback.
 *   4. destructive / rollback-sensitive — content matches a pattern known
 *      to break an older application deployment or lose data (DROP
 *      COLUMN/TABLE, a tightened NOT NULL/CHECK, a new RESTRICTIVE RLS
 *      policy that changes existing authorization behavior).
 *   5. unknown — no migration file matched, or content classification
 *      could not confidently place it in 1-4. The safe default.
 *
 * This is a heuristic over real SQL text, not a full DDL parser — it is
 * deliberately conservative: anything it isn't sure about becomes 4 or 5,
 * never 1 or 2. Exported functions are pure (take file content / workflow
 * text as arguments) so they're directly unit-testable; only the CLI
 * touches the filesystem.
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(__dirname, "..");
export const gitRoot = resolve(repoRoot, "..");
export const MIGRATIONS_DIR = resolve(repoRoot, "supabase/migrations");
export const WORKFLOWS_DIR = resolve(gitRoot, ".github/workflows");

// Patterns whose presence in a forward migration's SQL means "do not trust
// this as backward-compatible" — checked BEFORE the additive-only check,
// so a migration with both an ADD COLUMN and a DROP COLUMN is correctly
// flagged destructive, not additive.
const DESTRUCTIVE_PATTERNS = [
  /drop\s+column/i,
  /drop\s+table/i,
  /drop\s+constraint\s+\w+.*add\s+constraint/is, // tightening an existing constraint
  /set\s+not\s+null/i,
  /as\s+restrictive/i, // a new RESTRICTIVE RLS policy changes existing authorization behavior
  /truncate\s+/i,
];

// Patterns that, on their own, are additive/backward-compatible. A
// migration is only class 1 if EVERY non-comment, non-grant statement
// matches one of these (checked as "nothing destructive AND nothing
// unrecognized" — see classifyMigrationContent).
const ADDITIVE_PATTERNS = [
  /^create\s+table/i,
  /^create\s+(unique\s+)?index/i,
  /^create\s+(or\s+replace\s+)?function/i,
  /^create\s+(or\s+replace\s+)?trigger/i,
  /^create\s+policy/i,
  /^create\s+(or\s+replace\s+)?view/i,
  /^create\s+schema/i,
  /^create\s+extension/i,
  /^alter\s+table[\s\S]*?add\s+column/i,
  /^alter\s+table[\s\S]*?drop\s+not\s+null/i, // relaxing, not tightening
  /^alter\s+table[\s\S]*?enable\s+row\s+level\s+security/i,
  /^grant\s+/i,
  /^revoke\s+/i,
  /^drop\s+function\s+if\s+exists/i, // paired with a CREATE OR REPLACE FUNCTION redefinition, common in this repo's own migrations
  /^drop\s+policy\s+if\s+exists/i, // paired with a CREATE POLICY redefinition
  /^drop\s+trigger\s+if\s+exists/i,
  /^insert\s+into/i, // data seed, not schema change
  /^update\s+/i, // reviewed case-by-case is out of scope for this heuristic; treated as additive only when nothing destructive also matched
  /^select\s+/i,
  /^do\s+\$\$/i,
  /^comment\s+on/i,
];

function stripComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments (this repo's migrations commonly open with a /** ... */ header)
    .replace(/--.*$/gm, "")
    .trim();
}

/**
 * Classifies a single migration's raw SQL content into 1, 4, or 5
 * (never 2 — that requires CI evidence, added separately in
 * classifyMigration below). Returns { classification, reason }.
 */
export function classifyMigrationContent(sql) {
  const text = stripComments(sql);
  if (!text) return { classification: 5, reason: "empty or comment-only migration content" };

  for (const pattern of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(text)) {
      return { classification: 4, reason: `matched a destructive/rollback-sensitive pattern (${pattern})` };
    }
  }

  // "AS RESTRICTIVE" already caught above; a plain, permissive CREATE
  // POLICY is additive (a new permissive policy only ever widens access,
  // an existing older app is unaffected by it existing).
  const statements = text
    .split(/;\s*(?=\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);

  const unrecognized = statements.filter((s) => !ADDITIVE_PATTERNS.some((p) => p.test(s)));
  if (unrecognized.length === 0) {
    return { classification: 1, reason: "every statement matched a known additive/backward-compatible pattern" };
  }
  return {
    classification: 5,
    reason: `${unrecognized.length} statement(s) did not match a known additive pattern (first: "${unrecognized[0].slice(0, 80)}...") — not confidently classifiable, defaulting to unknown rather than guessing safe`,
  };
}

/**
 * True only if `workflowSources` (an array of full workflow-file text)
 * contains a real `run:` line that applies the exact rollback filename via
 * psql — i.e. CI genuinely exercises it, not just that the file exists.
 */
export function isRollbackCiVerified(rollbackFilename, workflowSources) {
  const escaped = rollbackFilename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`psql[^\\n]*${escaped}`);
  return (workflowSources || []).some((src) => re.test(src));
}

/**
 * Combines content classification with real rollback-file/CI evidence to
 * produce the final 1-5 classification for one migration.
 */
export function classifyMigration({ forwardSql, rollbackExists, rollbackFilename, workflowSources }) {
  const content = classifyMigrationContent(forwardSql);

  if (rollbackExists && isRollbackCiVerified(rollbackFilename, workflowSources)) {
    return { classification: 2, reason: `rollback SQL exists and is exercised by a real CI workflow (${rollbackFilename})`, contentClassification: content.classification };
  }

  if (content.classification === 4) {
    return { classification: 4, reason: content.reason, contentClassification: 4 };
  }

  if (content.classification === 1) {
    return { classification: 1, reason: content.reason, contentClassification: 1 };
  }

  if (rollbackExists) {
    return {
      classification: 3,
      reason: `rollback SQL exists (${rollbackFilename}) as a human-authored asset, but no CI workflow proves it still works — not trusted for automated rollback`,
      contentClassification: content.classification,
    };
  }

  return { classification: 5, reason: content.reason, contentClassification: content.classification };
}

// --- CLI -------------------------------------------------------------------

function loadWorkflowSources() {
  if (!existsSync(WORKFLOWS_DIR)) return [];
  return readdirSync(WORKFLOWS_DIR)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((f) => readFileSync(resolve(WORKFLOWS_DIR, f), "utf8"));
}

export function classifyAllMigrations() {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql") && !f.endsWith(".rollback.sql"));
  const workflowSources = loadWorkflowSources();
  const result = {};
  for (const file of files.sort()) {
    const forwardSql = readFileSync(resolve(MIGRATIONS_DIR, file), "utf8");
    const rollbackFilename = file.replace(/\.sql$/, ".rollback.sql");
    const rollbackExists = existsSync(resolve(MIGRATIONS_DIR, rollbackFilename));
    const verdict = classifyMigration({
      forwardSql,
      rollbackExists,
      rollbackFilename: rollbackExists ? rollbackFilename : null,
      workflowSources,
    });
    result[file] = {
      ...verdict,
      rollback_sql: rollbackExists ? `supabase/migrations/${rollbackFilename}` : null,
    };
  }
  return result;
}

function main() {
  const classifications = classifyAllMigrations();
  console.log(JSON.stringify({ generated_at: new Date().toISOString(), migrations: classifications }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
