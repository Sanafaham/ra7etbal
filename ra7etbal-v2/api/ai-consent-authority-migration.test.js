import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(new URL("../supabase/migrations/20261004120000_ai_consent_authority_foundation.sql", import.meta.url), "utf8");
const rollback = readFileSync(new URL("../supabase/migrations/20261004120000_ai_consent_authority_foundation.rollback.sql", import.meta.url), "utf8");
const verification = readFileSync(new URL("../supabase/migrations/verification/ai_consent_authority_verification.sql", import.meta.url), "utf8");
const rollbackVerification = readFileSync(new URL("../supabase/migrations/verification/ai_consent_authority_rollback_verification.sql", import.meta.url), "utf8");
const tier1Workflow = readFileSync(new URL("../../.github/workflows/carson-tier1-db-contracts.yml", import.meta.url), "utf8");

describe("AI consent authority migration", () => {
  it("uses one immutable append-only event source", () => {
    expect(sql).toContain("CREATE TABLE public.ai_consent_events");
    expect(sql).toContain("BEFORE UPDATE OR DELETE ON public.ai_consent_events");
    expect(sql).toContain("ai_consent_events_are_immutable");
    expect(sql).not.toContain("ai_consent_current");
  });
  it("derives owner identity and accepts no client user id in grant/withdraw", () => {
    expect(sql).toContain("v_user_id uuid := auth.uid()");
    expect(sql).not.toMatch(/grant_ai_consent\s*\([^)]*p_user_id/i);
    expect(sql).not.toMatch(/withdraw_ai_consent\s*\([^)]*p_user_id/i);
  });
  it("provides owner-only reads and RPC-only writes", () => {
    expect(sql).toContain("USING ((SELECT auth.uid()) = user_id)");
    expect(sql).toContain("REVOKE ALL ON public.ai_consent_events FROM PUBLIC, anon, authenticated");
    expect(sql).toContain("GRANT SELECT ON public.ai_consent_events TO authenticated");
    expect(sql).not.toMatch(/GRANT (?:INSERT|UPDATE|DELETE).*authenticated/i);
  });
  it("makes service evaluation and supersession explicit and non-public", () => {
    expect(sql).toContain("TO service_role");
    expect(sql).toContain("evaluate_ai_consent_authority");
    expect(sql).toContain("supersede_ai_consent");
    expect(sql).toContain("FROM PUBLIC, anon, authenticated");
    expect(sql).toContain("'service', NULL");
    expect(sql).toContain("actor_kind = 'service' AND actor_user_id IS NULL");
  });
  it("has replay conflict checks and withdrawal precedence", () => {
    expect(sql).toContain("ON CONFLICT (id) DO NOTHING");
    expect(sql).toContain("ai_consent_event_conflict");
    expect(sql).toContain("x.event_type IN ('withdraw', 'supersede')");
  });
  it("contains no legal prose, duration, or active provider integration", () => {
    expect(sql).not.toMatch(/lawful basis|jurisdiction|minor|retention (?:day|month|year)|privacy policy/i);
    expect(sql).not.toMatch(/api\.anthropic|api\.openai|elevenlabs\.io/i);
  });
  it("has a bounded rollback", () => {
    expect(rollback).toContain("DROP FUNCTION IF EXISTS public.evaluate_ai_consent_authority");
    expect(rollback.trim().endsWith("DROP TABLE IF EXISTS public.ai_consent_events;")).toBe(true);
    expect(rollbackVerification).toContain("rollback altered unrelated schema/data");
  });
  it("defines real-Postgres proof for the complete privilege and authority matrix", () => {
    for (const proof of [
      "anonymous read unexpectedly succeeded",
      "anonymous grant unexpectedly succeeded",
      "cross-tenant read leaked A",
      "cross-tenant withdrawal unexpectedly succeeded",
      "authenticated direct insert unexpectedly succeeded",
      "authenticated update unexpectedly succeeded",
      "authenticated delete unexpectedly succeeded",
      "conflicting event-id replay unexpectedly succeeded",
      "valid exact authority denied",
      "missing grant authorized",
      "wrong provider authorized",
      "wrong purpose authorized",
      "missing category authorized",
      "broader category request authorized",
      "stale-version grant authorized",
      "withdrawn grant authorized",
      "superseded grant authorized",
      "historical update succeeded",
      "historical delete succeeded",
    ]) expect(verification).toContain(proof);
  });
  it("executes every consent proof stage inside the required Tier-1 job", () => {
    expect(tier1Workflow).toContain("AI_CONSENT_RELEVANT=$(printf");
    expect(tier1Workflow).toContain("createdb ai_consent_verify");
    for (const file of [
      "ai_consent_authority_bootstrap.sql",
      "20261004120000_ai_consent_authority_foundation.sql",
      "ai_consent_authority_verification.sql",
      "20261004120000_ai_consent_authority_foundation.rollback.sql",
      "ai_consent_authority_rollback_verification.sql",
    ]) expect(tier1Workflow).toContain(file);
    expect(tier1Workflow).not.toMatch(/continue-on-error:\s*true/);
  });
});
