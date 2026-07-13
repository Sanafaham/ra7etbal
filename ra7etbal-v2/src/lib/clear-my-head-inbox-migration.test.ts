import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SQL = readFileSync(
  join(
    __dirname,
    "../../supabase/migrations/20260714_migrate_clear_my_head_inbox_to_notes.sql",
  ),
  "utf-8",
);

/**
 * The one-time backfill of clear_my_head_inbox rows into carson_notes must
 * be safe to re-run (no duplicate notes created) and must not drop the
 * source table (data-safety rule: no irreversible schema change without
 * explicit approval).
 *
 * Idempotency is keyed to the source row's own primary key via a
 * migrated_at marker column, not to matching user_id/text — two distinct
 * rows with identical text must both survive migration exactly once each,
 * never collapse into a single note (CodeRabbit finding on the first
 * version of this migration, which deduplicated on content instead of row
 * identity).
 */
describe("clear_my_head_inbox → carson_notes migration", () => {
  it("keys idempotency to the source row's own identity (migrated_at), not content matching", () => {
    expect(SQL).toContain("add column if not exists migrated_at timestamptz");
    expect(SQL).toContain("where c.migrated_at is null");
    expect(SQL).toContain("set migrated_at = now()");
    expect(SQL).toContain("where migrated_at is null");
  });

  it("preserves original text, timestamp, and ownership", () => {
    expect(SQL).toMatch(/select c\.user_id, c\.text, 'general', 'clear_my_head_migration', c\.created_at/);
  });

  it("does not drop, truncate, or delete rows from the source table", () => {
    const lower = SQL.toLowerCase();
    expect(lower).not.toContain("drop table");
    expect(lower).not.toContain("truncate");
    expect(lower).not.toMatch(/delete\s+from\s+(public\.)?clear_my_head_inbox/);
  });
});
