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
 */
describe("clear_my_head_inbox → carson_notes migration", () => {
  it("is guarded against re-inserting a row that was already migrated", () => {
    expect(SQL).toContain("where not exists (");
    expect(SQL).toContain("n.user_id = c.user_id");
    expect(SQL).toContain("n.note = c.text");
    expect(SQL).toContain("n.source = 'clear_my_head_migration'");
  });

  it("preserves original text, timestamp, and ownership", () => {
    expect(SQL).toMatch(/select c\.user_id, c\.text, 'general', 'clear_my_head_migration', c\.created_at/);
  });

  it("does not drop or truncate the source table", () => {
    expect(SQL.toLowerCase()).not.toContain("drop table");
    expect(SQL.toLowerCase()).not.toContain("truncate");
    expect(SQL.toLowerCase()).not.toContain("delete from clear_my_head_inbox");
  });
});
