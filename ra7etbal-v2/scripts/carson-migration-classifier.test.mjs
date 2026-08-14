import { describe, it, expect } from "vitest";
import {
  classifyMigrationContent,
  isRollbackCiVerified,
  classifyMigration,
  classifyAllMigrations,
} from "./carson-migration-classifier.mjs";

// Phase 8 of the Carson Engineering Hardening Project.

describe("classifyMigrationContent", () => {
  it("classifies a purely additive migration (new table + index + RLS + permissive policy) as 1", () => {
    const sql = `
      create table public.widgets (id uuid primary key default gen_random_uuid());
      create index widgets_id_idx on public.widgets(id);
      alter table public.widgets enable row level security;
      create policy "widgets: owner can select" on public.widgets for select using (true);
      grant select on public.widgets to authenticated;
    `;
    const result = classifyMigrationContent(sql);
    expect(result.classification).toBe(1);
  });

  it("classifies a nullable ADD COLUMN as 1", () => {
    const sql = `alter table public.tasks add column if not exists foo text null;`;
    expect(classifyMigrationContent(sql).classification).toBe(1);
  });

  it("classifies DROP NOT NULL (relaxing) as 1", () => {
    const sql = `alter table public.staff_escalation_owner_decisions alter column staff_message_id drop not null;`;
    expect(classifyMigrationContent(sql).classification).toBe(1);
  });

  it("classifies DROP COLUMN as 4 (destructive)", () => {
    const sql = `alter table public.tasks drop column foo;`;
    expect(classifyMigrationContent(sql).classification).toBe(4);
  });

  it("classifies DROP TABLE as 4 (destructive)", () => {
    const sql = `drop table public.widgets;`;
    expect(classifyMigrationContent(sql).classification).toBe(4);
  });

  it("classifies SET NOT NULL (tightening) as 4 (destructive)", () => {
    const sql = `alter table public.tasks alter column foo set not null;`;
    expect(classifyMigrationContent(sql).classification).toBe(4);
  });

  it("classifies a new RESTRICTIVE RLS policy as 4 (changes existing authorization behavior)", () => {
    const sql = `
      alter table public.tasks enable row level security;
      create policy "tasks: reminders require server creation" on public.tasks as restrictive for insert to authenticated with check (type <> 'reminder');
    `;
    expect(classifyMigrationContent(sql).classification).toBe(4);
  });

  it("classifies an unrecognized/complex statement (e.g. a PL/pgSQL function body) as 5, never guessing safe", () => {
    const sql = `
      create or replace function public.do_something() returns void language plpgsql as $$
      begin
        if exists (select 1 from public.tasks) then
          update public.tasks set status = 'done';
        end if;
      end;
      $$;
    `;
    // The function body's internal statements (BEGIN/IF/UPDATE-inside-body) are
    // not confidently parsed apart from the outer CREATE FUNCTION — this must
    // fail closed to 5, not be guessed as 1.
    expect(classifyMigrationContent(sql).classification).toBe(5);
  });

  it("strips /** ... */ block comment headers before classifying (this repo's real migrations use them)", () => {
    const sql = `
      /**
       * Some migration header.
       * Multiple lines. Even mentions DROP COLUMN in prose, which must not
       * be mistaken for a real DROP COLUMN statement.
       */
      alter table public.tasks add column if not exists bar text null;
    `;
    expect(classifyMigrationContent(sql).classification).toBe(1);
  });

  it("classifies empty/comment-only content as 5", () => {
    expect(classifyMigrationContent("-- just a comment\n").classification).toBe(5);
  });
});

describe("isRollbackCiVerified", () => {
  it("true when a workflow's run: line applies the exact rollback file via psql", () => {
    const workflow = `steps:\n  - run: psql -v ON_ERROR_STOP=1 -f "$MIGRATIONS/20260810_push_subscription_installation_identity.rollback.sql"`;
    expect(isRollbackCiVerified("20260810_push_subscription_installation_identity.rollback.sql", [workflow])).toBe(true);
  });

  it("false when the rollback file is only mentioned in a paths: filter, never actually applied via psql", () => {
    const workflow = `on:\n  pull_request:\n    paths:\n      - "supabase/migrations/20260810_push_subscription_installation_identity.rollback.sql"`;
    expect(isRollbackCiVerified("20260810_push_subscription_installation_identity.rollback.sql", [workflow])).toBe(false);
  });

  it("false when no workflow mentions it at all", () => {
    expect(isRollbackCiVerified("nonexistent.rollback.sql", ["some unrelated workflow content"])).toBe(false);
  });
});

describe("classifyMigration — combining content + CI evidence", () => {
  it("a rollback file that IS CI-verified always wins as class 2, even if content looks destructive", () => {
    const result = classifyMigration({
      forwardSql: "alter table public.foo drop column bar;",
      rollbackExists: true,
      rollbackFilename: "x.rollback.sql",
      workflowSources: [`run: psql -f "$MIGRATIONS/x.rollback.sql"`],
    });
    expect(result.classification).toBe(2);
  });

  it("destructive content with no CI-verified rollback stays class 4, even if a rollback.sql file exists unverified", () => {
    const result = classifyMigration({
      forwardSql: "alter table public.foo drop column bar;",
      rollbackExists: true,
      rollbackFilename: "x.rollback.sql",
      workflowSources: ["unrelated workflow, never applies x.rollback.sql"],
    });
    expect(result.classification).toBe(4);
  });

  it("additive content stays class 1 regardless of rollback file presence", () => {
    const result = classifyMigration({
      forwardSql: "create table public.foo (id uuid primary key);",
      rollbackExists: true,
      rollbackFilename: "x.rollback.sql",
      workflowSources: [],
    });
    expect(result.classification).toBe(1);
  });

  it("unknown content WITH an unverified rollback file becomes class 3, not silently 1 or 2", () => {
    const result = classifyMigration({
      forwardSql: "vacuum public.foo;",
      rollbackExists: true,
      rollbackFilename: "x.rollback.sql",
      workflowSources: [],
    });
    expect(result.classification).toBe(3);
  });

  it("unknown content with NO rollback file at all becomes class 5", () => {
    const result = classifyMigration({
      forwardSql: "vacuum public.foo;",
      rollbackExists: false,
      rollbackFilename: null,
      workflowSources: [],
    });
    expect(result.classification).toBe(5);
  });
});

describe("classifyAllMigrations — real repository data", () => {
  it("classifies every real migration file with no crash, and every entry has a classification in 1-5", () => {
    const result = classifyAllMigrations();
    const files = Object.keys(result);
    expect(files.length).toBeGreaterThan(50); // this repo has 77+ migrations as of Phase 8
    for (const file of files) {
      expect([1, 2, 3, 4, 5]).toContain(result[file].classification);
    }
  });

  it("real evidence: the CI-verified rollback migrations are class 2", () => {
    const result = classifyAllMigrations();
    expect(result["20260813_whatsapp_health_state_phone_number_unique.sql"].classification).toBe(2);
    expect(result["20260810_push_subscription_installation_identity.sql"].classification).toBe(2);
    expect(result["20260726_staff_escalation_owner_decisions.sql"].classification).toBe(2);
  });

  it("real evidence: the server-authoritative-reminder-inserts RLS migration is flagged class 4 (destructive/rollback-sensitive)", () => {
    const result = classifyAllMigrations();
    expect(result["20260812190000_server_authoritative_reminder_inserts.sql"].classification).toBe(4);
  });

  it("real evidence: purely additive recent migrations (new table, nullable column) are class 1", () => {
    const result = classifyAllMigrations();
    expect(result["20260811231000_owner_notifications.sql"].classification).toBe(1);
    expect(result["20260814180000_owner_notifications_soft_dismiss.sql"].classification).toBe(1);
  });
});
