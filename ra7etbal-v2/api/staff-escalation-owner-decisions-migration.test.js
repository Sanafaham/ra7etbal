import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Static contract test for the Phase A owner-escalation migration.
 *
 * This migration has NOT been executed against any database (Supabase
 * branching is unavailable on the current plan, no local Postgres/Docker
 * exists in this environment — see RA7ETBAL_STATE.md / the PR for this
 * branch). These are source-text assertions against the committed SQL,
 * following this repo's existing convention for state transitions Vitest
 * cannot execute directly (see api/task-confirm.test.js's migration-source
 * reads for the quality_substitute_decisions completion functions). They
 * prove the SQL *says* the right thing; they do NOT prove it *runs*
 * correctly against a real Postgres engine. Real execution proof is
 * required before this PR may merge.
 */

const FORWARD_PATH = join(
  __dirname,
  "..",
  "supabase",
  "migrations",
  "20260726_staff_escalation_owner_decisions.sql",
);
const ROLLBACK_PATH = join(
  __dirname,
  "..",
  "supabase",
  "migrations",
  "20260726_staff_escalation_owner_decisions.rollback.sql",
);

const FORWARD = readFileSync(FORWARD_PATH, "utf-8");
const ROLLBACK = readFileSync(ROLLBACK_PATH, "utf-8");

function blockBetween(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  expect(start, `expected to find "${startNeedle}"`).toBeGreaterThan(-1);
  const end = source.indexOf(endNeedle, start);
  expect(end, `expected to find "${endNeedle}" after "${startNeedle}"`).toBeGreaterThan(start);
  return source.slice(start, end);
}

function functionBody(source, functionSignature) {
  const start = source.indexOf(`CREATE OR REPLACE FUNCTION public.${functionSignature}`);
  expect(start, `expected function public.${functionSignature}`).toBeGreaterThan(-1);
  const end = source.indexOf("\nEND;\n$$;", start);
  expect(end, `expected terminating END;/$$; for ${functionSignature}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("staff_escalation_owner_decisions — table shape", () => {
  it("creates the table with every required column", () => {
    const block = blockBetween(
      FORWARD,
      "CREATE TABLE IF NOT EXISTS public.staff_escalation_owner_decisions",
      "CREATE INDEX IF NOT EXISTS staff_escalation_owner_decisions_user_status_idx",
    );
    expect(block).toContain("id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid()");
    expect(block).toContain("staff_message_id      uuid        NOT NULL UNIQUE");
    expect(block).toContain("REFERENCES public.staff_messages(id) ON DELETE CASCADE");
    expect(block).toContain("user_id               uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE");
    expect(block).toContain("task_id               uuid        NULL REFERENCES public.tasks(id) ON DELETE SET NULL");
    expect(block).toContain(
      "CHECK (status IN ('open','answered','delivering','delivered_to_staff','failed'))",
    );
    expect(block).toContain("owner_reply_text      text        NULL");
    expect(block).toContain("CHECK (owner_reply_channel IS NULL OR owner_reply_channel IN ('app'))");
    expect(block).toContain("answered_at           timestamptz NULL");
    expect(block).toContain("deep_link_token       uuid        NOT NULL UNIQUE DEFAULT gen_random_uuid()");
    expect(block).toContain("delivery_token        uuid        NULL");
    expect(block).toContain("delivery_claimed_at   timestamptz NULL");
    expect(block).toContain("delivery_lease_until  timestamptz NULL");
    expect(block).toContain("delivered_at          timestamptz NULL");
    expect(block).toContain("delivery_failed_at    timestamptz NULL");
    expect(block).toContain("delivery_error        text        NULL");
    expect(block).toContain("created_at            timestamptz NOT NULL DEFAULT now()");
    expect(block).toContain("updated_at            timestamptz NOT NULL DEFAULT now()");
  });

  it("deep_link_token is separate from id and independently unique", () => {
    // Two distinct UNIQUE surfaces: the PK (id) and deep_link_token. The
    // deep-link interface (Phase C) must only ever be given the token, never id.
    const block = blockBetween(
      FORWARD,
      "CREATE TABLE IF NOT EXISTS public.staff_escalation_owner_decisions",
      "CREATE INDEX IF NOT EXISTS staff_escalation_owner_decisions_user_status_idx",
    );
    expect(block).toContain("id                    uuid        PRIMARY KEY");
    expect(block).toContain("deep_link_token       uuid        NOT NULL UNIQUE");
    expect(block.indexOf("id                    uuid        PRIMARY KEY")).not.toBe(
      block.indexOf("deep_link_token"),
    );
  });

  it("indexes and updated_at trigger are present", () => {
    expect(FORWARD).toContain("CREATE INDEX IF NOT EXISTS staff_escalation_owner_decisions_user_status_idx");
    expect(FORWARD).toContain("CREATE INDEX IF NOT EXISTS staff_escalation_owner_decisions_task_id_idx");
    expect(FORWARD).toContain("CREATE TRIGGER set_staff_escalation_owner_decisions_updated_at");
    expect(FORWARD).toContain("BEFORE UPDATE ON public.staff_escalation_owner_decisions");
  });
});

describe("staff_escalation_owner_decisions — RLS and grants", () => {
  it("enables RLS and grants owner-only SELECT, no direct write policy", () => {
    expect(FORWARD).toContain("ALTER TABLE public.staff_escalation_owner_decisions ENABLE ROW LEVEL SECURITY");
    expect(FORWARD).toContain('CREATE POLICY "staff_escalation_owner_decisions: owner can select"');
    expect(FORWARD).toContain("FOR SELECT");
    expect(FORWARD).toContain("USING (auth.uid() = user_id)");
    expect(FORWARD).toContain("GRANT SELECT ON public.staff_escalation_owner_decisions TO authenticated");
    // No INSERT/UPDATE/DELETE policy anywhere in the file for this table.
    expect(FORWARD).not.toMatch(/CREATE POLICY[^;]*staff_escalation_owner_decisions[^;]*FOR (INSERT|UPDATE|DELETE)/s);
  });

  it("revokes all five functions from PUBLIC/anon/authenticated and grants only service_role", () => {
    const grantsBlock = FORWARD.slice(FORWARD.indexOf("-- ── Execute grants: service_role only"));
    const functions = [
      "claim_escalation_owner_decision(uuid, uuid, uuid)",
      "answer_escalation_owner_decision(uuid, text)",
      "claim_escalation_answer_delivery(uuid, uuid, integer)",
      "complete_escalation_answer_delivery(uuid, uuid, uuid)",
      "fail_escalation_answer_delivery(uuid, uuid, uuid, text)",
    ];
    for (const fn of functions) {
      expect(grantsBlock).toContain(`REVOKE EXECUTE ON FUNCTION public.${fn} FROM PUBLIC, anon, authenticated`);
      expect(grantsBlock).toContain(`GRANT EXECUTE ON FUNCTION public.${fn} TO service_role`);
    }
  });
});

describe("claim_escalation_owner_decision — idempotency", () => {
  it("is SECURITY DEFINER, verifies ownership, and never creates a second row for the same staff_message_id", () => {
    const body = functionBody(FORWARD, "claim_escalation_owner_decision(");
    expect(body).toContain("SECURITY DEFINER");
    expect(body).toContain("v_msg.user_id IS DISTINCT FROM p_user_id");
    expect(body).toContain("RAISE EXCEPTION 'not_authorized'");
    expect(body).toContain("SELECT * INTO v_row FROM public.staff_escalation_owner_decisions");
    expect(body).toContain("WHERE staff_message_id = p_staff_message_id;\n  IF FOUND THEN\n    RETURN v_row;");
    expect(body).toContain("ON CONFLICT (staff_message_id) DO NOTHING");
  });
});

describe("answer_escalation_owner_decision — double-submit protection", () => {
  it("only transitions open -> answered and never overwrites an existing answer", () => {
    const body = functionBody(FORWARD, "answer_escalation_owner_decision(");
    expect(body).toContain("SECURITY DEFINER");
    expect(body).toContain("RAISE EXCEPTION 'empty_reply'");
    expect(body).toContain("IF v.status IN ('answered', 'delivering', 'delivered_to_staff') THEN\n    RETURN v;");
    expect(body).toContain("IF v.status <> 'open' THEN\n    RAISE EXCEPTION 'invalid_transition'");
    expect(body).toContain("SET status = 'answered'");
  });
});

describe("claim_escalation_answer_delivery — corrected retry semantics", () => {
  it("claims from answered, failed (explicit retry), or an expired delivering lease — never a live one", () => {
    const body = functionBody(FORWARD, "claim_escalation_answer_delivery(");
    expect(body).toContain("SECURITY DEFINER");
    // Terminal state first: nothing to claim once delivered.
    expect(body).toContain("IF v.status = 'delivered_to_staff' THEN");
    // The corrected claimable condition: answered OR failed OR expired-lease delivering.
    expect(body).toContain(
      "IF v.status = 'answered'\n     OR v.status = 'failed'\n     OR (v.status = 'delivering' AND v.delivery_lease_until <= now()) THEN",
    );
    // A fresh token is minted on every successful claim, invalidating any prior token.
    expect(body).toContain("delivery_token = v_token");
    // Falls through to "not claimable" for a live (non-expired) delivering lease —
    // no separate branch grants it, so the trailing catch-all return is the guard.
    expect(body).toContain("RETURN QUERY SELECT v.id, false, NULL::uuid, v.owner_reply_text, v.status;");
  });

  it("does not contain a separate retry_ function — retry is re-claiming a failed row through this same function", () => {
    expect(FORWARD).not.toContain("CREATE OR REPLACE FUNCTION public.retry_escalation");
  });
});

describe("complete_escalation_answer_delivery — atomic completion", () => {
  it("updates both staff_escalation_owner_decisions and staff_messages inside one function body", () => {
    const body = functionBody(FORWARD, "complete_escalation_answer_delivery(");
    expect(body).toContain("SECURITY DEFINER");
    expect(body).toContain("status = 'delivered_to_staff'");
    expect(body).toContain("AND status = 'delivering'\n    AND delivery_token = p_claim_token");
    expect(body).toContain("RAISE EXCEPTION 'stale_delivery_claim'");
    // Both tables' UPDATEs live in this one function — one call, one implicit
    // transaction, so a failure of the second can never leave the first
    // committed alone.
    expect(body).toContain("UPDATE public.staff_escalation_owner_decisions SET");
    expect(body).toContain("UPDATE public.staff_messages\n    SET user_facing_state = 'Completed',\n        escalation_resolved_at = v_now");
    expect(body.indexOf("UPDATE public.staff_escalation_owner_decisions SET")).toBeLessThan(
      body.indexOf("UPDATE public.staff_messages"),
    );
  });
});

describe("fail_escalation_answer_delivery — keeps Needs You open", () => {
  it("marks the escalation failed without touching staff_messages at all", () => {
    const body = functionBody(FORWARD, "fail_escalation_answer_delivery(");
    expect(body).toContain("SECURITY DEFINER");
    expect(body).toContain("status = 'failed'");
    expect(body).toContain("AND status = 'delivering'\n    AND delivery_token = p_claim_token");
    expect(body).toContain("RAISE EXCEPTION 'stale_delivery_claim'");
    // The defining property required by the spec: user_facing_state was never
    // advanced past 'Needs You' until complete_... runs, so simply never
    // touching staff_messages here is what leaves it open on failure.
    expect(body).not.toContain("staff_messages");
  });
});

describe("staff_messages — additive-only, no existing behavior changed", () => {
  it("adds exactly three new nullable/defaulted columns and nothing else on staff_messages", () => {
    const block = FORWARD.slice(FORWARD.indexOf("ALTER TABLE public.staff_messages"));
    expect(block).toContain("ADD COLUMN IF NOT EXISTS owner_notification_status text NOT NULL DEFAULT 'not_attempted'");
    expect(block).toContain("CHECK (owner_notification_status IN ('not_attempted','sent','skipped_no_phone','failed'))");
    expect(block).toContain("ADD COLUMN IF NOT EXISTS owner_notified_at timestamptz");
    expect(block).toContain("ADD COLUMN IF NOT EXISTS escalation_resolved_at timestamptz");
  });

  it("never redefines an existing staff_messages RPC or drops an existing constraint", () => {
    const existingFunctions = [
      "claim_staff_message",
      "complete_staff_message",
      "fail_staff_message",
      "retry_staff_message",
      "claim_staff_response_delivery",
      "complete_staff_response_delivery",
      "fail_staff_response_delivery",
    ];
    for (const fn of existingFunctions) {
      expect(FORWARD).not.toContain(`CREATE OR REPLACE FUNCTION public.${fn}`);
    }
    expect(FORWARD).not.toMatch(/DROP CONSTRAINT/);
    expect(FORWARD).not.toMatch(/ALTER COLUMN/);
  });
});

describe("rollback — exact symmetry with the forward migration", () => {
  it("drops the trigger, all five new functions with matching signatures, and the table", () => {
    expect(ROLLBACK).toContain(
      "DROP TRIGGER IF EXISTS set_staff_escalation_owner_decisions_updated_at ON public.staff_escalation_owner_decisions",
    );
    expect(ROLLBACK).toContain("DROP FUNCTION IF EXISTS public.set_staff_escalation_owner_decisions_updated_at()");
    expect(ROLLBACK).toContain("DROP FUNCTION IF EXISTS public.fail_escalation_answer_delivery(uuid, uuid, uuid, text)");
    expect(ROLLBACK).toContain("DROP FUNCTION IF EXISTS public.complete_escalation_answer_delivery(uuid, uuid, uuid)");
    expect(ROLLBACK).toContain("DROP FUNCTION IF EXISTS public.claim_escalation_answer_delivery(uuid, uuid, integer)");
    expect(ROLLBACK).toContain("DROP FUNCTION IF EXISTS public.answer_escalation_owner_decision(uuid, text)");
    expect(ROLLBACK).toContain("DROP FUNCTION IF EXISTS public.claim_escalation_owner_decision(uuid, uuid, uuid)");
    expect(ROLLBACK).toContain("DROP TABLE IF EXISTS public.staff_escalation_owner_decisions");
  });

  it("removes exactly the three additive staff_messages columns and nothing else on staff_messages", () => {
    const block = ROLLBACK.slice(ROLLBACK.indexOf("ALTER TABLE public.staff_messages"));
    expect(block).toContain("DROP COLUMN IF EXISTS owner_notification_status");
    expect(block).toContain("DROP COLUMN IF EXISTS owner_notified_at");
    expect(block).toContain("DROP COLUMN IF EXISTS escalation_resolved_at");
    expect(block).not.toContain("DROP TABLE IF EXISTS public.staff_messages");
  });

  it("never drops or redefines a pre-existing staff_messages function or column", () => {
    // The file header legitimately names these functions in prose (documenting
    // what is NOT touched), so the check must target actual DROP/CREATE
    // statements, not the mere presence of the name anywhere in the file.
    const preExisting = [
      "claim_staff_message",
      "complete_staff_message",
      "fail_staff_message",
      "retry_staff_message",
      "claim_staff_response_delivery",
      "complete_staff_response_delivery",
      "fail_staff_response_delivery",
    ];
    for (const fn of preExisting) {
      expect(ROLLBACK).not.toMatch(new RegExp(`(DROP|CREATE)[^;]*\\b${fn}\\b`));
    }
  });
});
