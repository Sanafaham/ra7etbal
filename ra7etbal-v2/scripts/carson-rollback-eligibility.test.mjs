import { describe, it, expect } from "vitest";
import { evaluateRollbackEligibility, affectedCapabilities, capabilitiesForMigrationFiles } from "./carson-rollback-eligibility.mjs";

// Phase 8 of the Carson Engineering Hardening Project.

describe("evaluateRollbackEligibility", () => {
  it("no migrations between target and current: both paths safe", () => {
    const result = evaluateRollbackEligibility([]);
    expect(result.applicationOnly.safe).toBe(true);
    expect(result.applicationPlusDatabase.safe).toBe(true);
  });

  it("only class-1 (backward-compatible) migrations: both paths safe", () => {
    const result = evaluateRollbackEligibility([
      { file: "a.sql", classification: 1 },
      { file: "b.sql", classification: 1 },
    ]);
    expect(result.applicationOnly.safe).toBe(true);
    expect(result.applicationPlusDatabase.safe).toBe(true);
  });

  it("a class-2 (tested rollback) migration blocks application-only, but not application+database", () => {
    const result = evaluateRollbackEligibility([{ file: "a.sql", classification: 2 }]);
    expect(result.applicationOnly.safe).toBe(false);
    expect(result.applicationOnly.blocking).toEqual([{ file: "a.sql", classification: 2 }]);
    expect(result.applicationPlusDatabase.safe).toBe(true);
    expect(result.applicationPlusDatabase.rollbacksToApply).toEqual(["a.sql"]);
  });

  it("a class-3 (unverified rollback asset) migration blocks BOTH paths", () => {
    const result = evaluateRollbackEligibility([{ file: "a.sql", classification: 3 }]);
    expect(result.applicationOnly.safe).toBe(false);
    expect(result.applicationPlusDatabase.safe).toBe(false);
  });

  it("a class-4 (destructive) migration blocks BOTH paths", () => {
    const result = evaluateRollbackEligibility([{ file: "a.sql", classification: 4 }]);
    expect(result.applicationOnly.safe).toBe(false);
    expect(result.applicationPlusDatabase.safe).toBe(false);
    expect(result.applicationOnly.decision).toBe("ROLLBACK_BLOCKED_MANUAL_REVIEW_REQUIRED");
    expect(result.applicationPlusDatabase.decision).toBe("ROLLBACK_BLOCKED_MANUAL_REVIEW_REQUIRED");
  });

  it("a class-5 (unknown) migration blocks BOTH paths — never treated as safe by default", () => {
    const result = evaluateRollbackEligibility([{ file: "a.sql", classification: 5 }]);
    expect(result.applicationOnly.safe).toBe(false);
    expect(result.applicationPlusDatabase.safe).toBe(false);
  });

  it("rollbacksToApply lists class-2 migrations in reverse chronological order (last-in-first-reverted)", () => {
    const result = evaluateRollbackEligibility([
      { file: "20260101_a.sql", classification: 2 },
      { file: "20260102_b.sql", classification: 2 },
      { file: "20260103_c.sql", classification: 2 },
    ]);
    expect(result.applicationPlusDatabase.rollbacksToApply).toEqual(["20260103_c.sql", "20260102_b.sql", "20260101_a.sql"]);
  });

  it("a mix of class 1 and one class 4: application-only is blocked by the class-4 alone", () => {
    const result = evaluateRollbackEligibility([
      { file: "a.sql", classification: 1 },
      { file: "b.sql", classification: 4 },
      { file: "c.sql", classification: 1 },
    ]);
    expect(result.applicationOnly.blocking).toEqual([{ file: "b.sql", classification: 4 }]);
  });
});

describe("affectedCapabilities", () => {
  const registry = [
    { id: "cap_a", db: { tables: ["table_x", "table_y"] } },
    { id: "cap_b", db: { tables: ["table_y"] } },
    { id: "cap_c", db: { tables: [] } },
  ];

  it("maps a migration's touched tables to every capability that owns one of them", () => {
    const result = affectedCapabilities({ "m1.sql": ["table_x"] }, registry);
    expect(result["m1.sql"]).toEqual(["cap_a"]);
  });

  it("a shared table fans out to every owning capability", () => {
    const result = affectedCapabilities({ "m1.sql": ["table_y"] }, registry);
    expect(result["m1.sql"]).toEqual(["cap_a", "cap_b"]);
  });

  it("a table no capability owns maps to an empty array, not omitted or guessed", () => {
    const result = affectedCapabilities({ "m1.sql": ["unregistered_table"] }, registry);
    expect(result["m1.sql"]).toEqual([]);
  });
});

describe("capabilitiesForMigrationFiles — direct registry db.migrations lookup", () => {
  const registry = [
    { id: "cap_a", db: { migrations: ["supabase/migrations/m1.sql", "supabase/migrations/m2.sql"] } },
    { id: "cap_b", db: { migrations: ["supabase/migrations/m2.sql"] } },
  ];

  it("maps a migration to every capability that explicitly lists it", () => {
    const result = capabilitiesForMigrationFiles(["m2.sql"], registry);
    expect(result["m2.sql"]).toEqual(["cap_a", "cap_b"]);
  });

  it("a migration no capability explicitly lists maps to an empty array, surfacing it as unmapped rather than omitting it", () => {
    const result = capabilitiesForMigrationFiles(["m_unlisted.sql"], registry);
    expect(result["m_unlisted.sql"]).toEqual([]);
  });
});
