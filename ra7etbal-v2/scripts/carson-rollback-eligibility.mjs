#!/usr/bin/env node
/**
 * Carson Engineering Hardening Project — Phase 8.
 *
 * Deterministic, fail-closed rollback eligibility checker. Given the set
 * of migrations that exist between a rollback target and the current
 * release (each with its Phase 8 classification from
 * carson-migration-classifier.mjs), decides whether an APPLICATION-ONLY
 * rollback is safe, and separately whether an APPLICATION+DATABASE
 * rollback is safe. Never automatically classifies an unknown migration
 * as safe — a migration missing from the classification data blocks both
 * paths, the same as an explicitly unsafe one.
 *
 * Two independent paths, because they have different risk profiles:
 *   - "applicationOnly": roll the app back to an older commit while
 *     leaving the database schema exactly as it is now. Only safe if
 *     EVERY migration introduced since the target is class 1
 *     (backward-compatible) — the older app must be able to run
 *     unmodified against today's schema.
 *   - "applicationPlusDatabase": also revert the database schema to the
 *     target's shape. Safe only if every migration since the target is
 *     class 1 OR class 2 (tested rollback SQL) — class 3/4/5 block this
 *     path too, since their reversal is unproven or known-destructive.
 *
 * This module never runs any SQL, git command, or deployment action
 * itself — see carson-rollback-dry-run.mjs for the read-only reporting
 * CLI that gathers real data and calls these pure functions.
 */

/**
 * `migrations`: array of { file, classification } for every migration
 * introduced between the rollback target and the current release.
 */
export function evaluateRollbackEligibility(migrations) {
  const list = migrations || [];

  const applicationOnlyBlocking = list.filter((m) => m.classification !== 1);
  const applicationPlusDatabaseBlocking = list.filter((m) => m.classification !== 1 && m.classification !== 2);

  return {
    applicationOnly: {
      safe: applicationOnlyBlocking.length === 0,
      decision: applicationOnlyBlocking.length === 0 ? "SAFE_TO_ROLLBACK_APPLICATION" : "ROLLBACK_BLOCKED_MANUAL_REVIEW_REQUIRED",
      blocking: applicationOnlyBlocking,
    },
    applicationPlusDatabase: {
      safe: applicationPlusDatabaseBlocking.length === 0,
      decision: applicationPlusDatabaseBlocking.length === 0 ? "SAFE_TO_ROLLBACK_APPLICATION_AND_DATABASE" : "ROLLBACK_BLOCKED_MANUAL_REVIEW_REQUIRED",
      blocking: applicationPlusDatabaseBlocking,
      // Even when "safe", class-2 migrations still require actually
      // running their real rollback SQL in order — this list is what a
      // human/operator would need to apply, in reverse chronological
      // order, never auto-executed here.
      rollbacksToApply: list.filter((m) => m.classification === 2).map((m) => m.file).reverse(),
    },
  };
}

/**
 * Cross-references migration filenames against the Protected Behavior
 * Registry's db.tables to report which protected capabilities are
 * potentially affected by a rollback touching those migrations — purely
 * informational (for the dry-run report), not part of the safety
 * decision itself. `migrationTableHints` is a map of filename -> array of
 * table names the migration touches (derived from its own SQL by the
 * caller); `registryCapabilities` is carson-protected-registry.json's
 * `capabilities` array.
 */
export function affectedCapabilities(migrationTableHints, registryCapabilities) {
  const tableToCapabilities = new Map();
  for (const cap of registryCapabilities || []) {
    for (const table of (cap.db && cap.db.tables) || []) {
      if (!tableToCapabilities.has(table)) tableToCapabilities.set(table, new Set());
      tableToCapabilities.get(table).add(cap.id);
    }
  }

  const result = {};
  for (const [file, tables] of Object.entries(migrationTableHints || {})) {
    const caps = new Set();
    for (const table of tables) {
      for (const capId of tableToCapabilities.get(table) || []) caps.add(capId);
    }
    result[file] = [...caps].sort();
  }
  return result;
}

/**
 * Direct lookup via the registry's own `db.migrations` arrays (each
 * capability already lists the exact migration files it depends on) —
 * more precise than inferring from table names, since it reflects a
 * human-reviewed mapping rather than a text-matching guess. A migration
 * file the registry doesn't explicitly list under any capability maps to
 * an empty array here, not omitted — that's itself useful dry-run
 * information (an unmapped migration touching production data with no
 * registered capability owner).
 */
export function capabilitiesForMigrationFiles(migrationFiles, registryCapabilities) {
  const result = {};
  for (const file of migrationFiles || []) {
    const relPath = `supabase/migrations/${file}`;
    const caps = (registryCapabilities || [])
      .filter((cap) => ((cap.db && cap.db.migrations) || []).includes(relPath))
      .map((cap) => cap.id)
      .sort();
    result[file] = caps;
  }
  return result;
}
