/**
 * Golden regression contract — client-side half of the protected
 * alternative-review (substitute_review) decision lifecycle: Approve
 * Alternative / Reject Alternative / Custom Instruction (Phase 8.1). See
 * api/alternative-review-golden-contract.test.js for the server-side half.
 *
 * This suite exists because Phase 8.1 (the owner decision endpoint) has
 * several moving parts — a lease-fenced Postgres claim/reserve/complete
 * pipeline (supabase/migrations/20260710_quality_substitute_review.sql,
 * 20260712_approve_alternative_message_first.sql), a state machine
 * (src/lib/quality-lifecycle.ts) that decides when the Approve/Reject/Custom
 * Instruction UI appears, and a client helper
 * (src/lib/quality-substitute-decision.ts) whose only job is to faithfully
 * relay the server's real outcome — never fabricate success. No single test
 * suite previously locked the whole decision journey together, following the
 * same pattern the protected photo workflow used (see
 * src/lib/photo-workflow-golden-contract.test.ts). This file calls the real
 * production functions — not source-text scans — so a future change that
 * breaks any of these scenarios fails a future CI wiring of this suite,
 * regardless of which file changed.
 *
 * Scenario labels match the numbered behaviors in the task that created this
 * suite:
 *   2  — isQualitySubstituteReviewStatus / resolveQualityLifecycle correctly
 *        surface the Needs You decision UI for substitute_review specifically
 *   5  — Custom Instruction transmits the owner's exact instructionText
 *   8  — a duplicate/retry submitSubstituteDecision call never fabricates a
 *        different client-side outcome than what the server actually returns
 *   9  — submitSubstituteDecision never reports success on a failed
 *        underlying operation (missing auth, server error, network failure)
 *   10 — the real final task shape produced by each decision (traced in the
 *        server half from the Postgres completion functions) resolves to the
 *        correct lifecycle state on the client
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../types/task";

const h = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("./supabase", () => ({
  supabase: { auth: { getSession: h.getSession } },
}));

import { submitSubstituteDecision } from "./quality-substitute-decision";
import { isQualitySubstituteReviewStatus, resolveQualityLifecycle } from "./quality-lifecycle";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    user_id: "user-1",
    description: "buy TEREA Silver",
    type: "delegation",
    assigned_to: "Christopher",
    status: "pending",
    needs_follow_up: true,
    confirmation_url: "https://ra7etbal.com/confirm?task=task-1",
    confirmed_at: null,
    due_at: null,
    archived_at: null,
    created_at: "2026-07-10T00:00:00.000Z",
    qstash_message_id: null,
    followup_sent_at: null,
    escalated_at: null,
    image_path: "task-images/user-1/task-1/photo.jpg",
    proof_image_path: null,
    quality_review_status: null,
    quality_review_note: null,
    quality_reviewed_at: null,
    worker_reply: null,
    ...overrides,
  };
}

describe("Golden contract — alternative review decision lifecycle (client half, Phase 8.1 baseline)", () => {
  beforeEach(() => {
    h.getSession.mockReset();
    h.getSession.mockResolvedValue({ data: { session: { access_token: "jwt-golden" } } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("[2] isQualitySubstituteReviewStatus is true only for substitute_review — never uncertain, correction_required, or null", () => {
    expect(isQualitySubstituteReviewStatus("substitute_review")).toBe(true);
    expect(isQualitySubstituteReviewStatus("uncertain")).toBe(false);
    expect(isQualitySubstituteReviewStatus("correction_required")).toBe(false);
    expect(isQualitySubstituteReviewStatus("fraud_suspected")).toBe(false);
    expect(isQualitySubstituteReviewStatus("approved")).toBe(false);
    expect(isQualitySubstituteReviewStatus(null)).toBe(false);
  });

  it("[2] resolveQualityLifecycle surfaces the Needs You decision surface specifically for substitute_review: needs_owner_decision / \"Needs your review\" / needsOwnerReview: true", () => {
    const lifecycle = resolveQualityLifecycle(
      task({ proof_image_path: "task-images/u/t/proof/0.jpg", quality_review_status: "substitute_review" }),
    );
    expect(lifecycle.state).toBe("needs_owner_decision");
    expect(lifecycle.badge).toBe("Needs your review");
    expect(lifecycle.needsOwnerReview).toBe(true);
    expect(lifecycle.requiresNewProof).toBe(false);
    expect(lifecycle.blocksGenericFollowup).toBe(true);
  });

  it("[10] Approve Alternative's real final task shape — quality_review_status: \"approved\" while status stays \"pending\" (traced from api/task-confirm.js's markApprovedAlternativeConfirmationOnly, which never sets status: \"done\" — see the server-half migration source-guard) — resolves to the completed lifecycle state", () => {
    const lifecycle = resolveQualityLifecycle(
      task({ status: "pending", proof_image_path: "task-images/u/t/proof/0.jpg", quality_review_status: "approved" }),
    );
    expect(lifecycle.state).toBe("completed");
    expect(lifecycle.badge).toBe("Completed");
    expect(lifecycle.needsOwnerReview).toBe(false);
  });

  it("[10] Reject Alternative's real final task shape — quality_review_status: \"correction_required\" (set by the real complete_rejected_alternative Postgres function, supabase/migrations/20260710_quality_substitute_review.sql) — resolves to waiting for a new proof, not stuck in Needs You", () => {
    const lifecycle = resolveQualityLifecycle(
      task({ proof_image_path: "task-images/u/t/proof/0.jpg", quality_review_status: "correction_required" }),
    );
    expect(lifecycle.state).toBe("waiting_for_confirmation");
    expect(lifecycle.badge).toBe("Waiting for confirmation");
    expect(lifecycle.requiresNewProof).toBe(true);
    expect(lifecycle.needsOwnerReview).toBe(false);
  });

  it("[10] Custom Instruction's real final task shape — quality_review_status cleared to null while proof_image_path is left untouched (set by the real complete_custom_instruction Postgres function) — resolves to proof_submitted, not stuck in Needs You and not silently completed", () => {
    const lifecycle = resolveQualityLifecycle(
      task({ proof_image_path: "task-images/u/t/proof/0.jpg", quality_review_status: null }),
    );
    expect(lifecycle.state).toBe("proof_submitted");
    expect(lifecycle.badge).toBe("Proof submitted");
    expect(lifecycle.needsOwnerReview).toBe(false);
    expect(lifecycle.state).not.toBe("completed");
    expect(lifecycle.state).not.toBe("needs_owner_decision");
  });

  it("[9] missing auth token: never calls the network and never reports success", async () => {
    h.getSession.mockResolvedValue({ data: { session: null } });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await submitSubstituteDecision({ taskId: "task-1", decision: "approved_alternative" });

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("[9] server-reported failure (e.g. WhatsApp send failed, HTTP 502 from api/task-confirm.js): relays success: false with the server's real error, never fabricates success", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({ error: "Could not send WhatsApp message. Please retry." }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await submitSubstituteDecision({ taskId: "task-1", decision: "rejected_alternative" });

    expect(result).toEqual({ success: false, error: "Could not send WhatsApp message. Please retry." });
  });

  it("[9] server 200 with an error field (Supabase/RPC failure surfaced as 200 + error): still never reports success — the presence of data.error overrides res.ok", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ error: "Could not process this decision. Please try again." }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await submitSubstituteDecision({ taskId: "task-1", decision: "custom_instruction", instructionText: "Turquoise is fine." });

    expect(result.success).toBe(false);
    expect(result.error).toBe("Could not process this decision. Please try again.");
  });

  it("[9] network failure (fetch throws): never reports success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    const result = await submitSubstituteDecision({ taskId: "task-1", decision: "approved_alternative" });

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("[5] Custom Instruction: submitSubstituteDecision transmits the owner's exact typed instructionText in the request body — not a paraphrase, not a template default", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, outcome: "custom_instruction_sent" }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    const exactText = "No — get the EXACT brand, TEREA Amber, not Turquoise. Ask the cashier if unsure!!";
    const result = await submitSubstituteDecision({
      taskId: "task-1",
      decision: "custom_instruction",
      instructionText: exactText,
    });

    expect(result).toEqual({ success: true, outcome: "custom_instruction_sent" });
    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe("/api/task-confirm");
    expect(options.method).toBe("PATCH");
    const body = JSON.parse(options.body);
    expect(body.instructionText).toBe(exactText);
    expect(body.decision).toBe("custom_instruction");
    expect(body.taskId).toBe("task-1");
  });

  it("[8] a duplicate submitSubstituteDecision call (refresh/retry) never fabricates a client-side outcome — each call independently relays exactly what the server returned, including the server's own already_completed short-circuit", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true, outcome: "approved" }) })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ success: true, outcome: "approved", already_completed: true }),
      });
    vi.stubGlobal("fetch", fetchSpy);

    const first = await submitSubstituteDecision({ taskId: "task-1", decision: "approved_alternative" });
    const second = await submitSubstituteDecision({ taskId: "task-1", decision: "approved_alternative" });

    // The client makes no dedup decision of its own — the server's
    // idempotency guard (proven in the server half) is the single source of
    // truth, so both calls really do reach the network...
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    // ...but both report the same real outcome, never a duplicated or
    // diverging effect on the client side.
    expect(first).toEqual({ success: true, outcome: "approved" });
    expect(second.success).toBe(true);
    expect(second.outcome).toBe("approved");
  });
});
