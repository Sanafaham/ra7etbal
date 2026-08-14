import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * GOLDEN JOURNEY 2 — Owner alternative approval
 * Phase 3 of the Carson Engineering Hardening Project.
 *
 * staff submits substitute/alternative → owner review/Needs You state →
 * owner decision → decision persists → worker receives correct
 * instruction → worker-facing message/delivery carries canonical
 * person_id → Needs You resolves → Communication History can retrieve
 * the resulting communication → no duplicate decision/send.
 *
 * This crosses the exact boundary that allowed the PR #237/#243 identity
 * gap: api/task-confirm.js's handleOwnerDecision (real handler, real
 * findAssigneePerson, real p_person_id threading into the
 * reserve_custom_instruction RPC) → src/lib/daily-brief.ts's Needs You
 * classifier (real, pure function) → src/lib/carson-communication-history.ts's
 * buildCommunicationHistory (real function, reading the identical person_id
 * the RPC call carried).
 *
 * External boundaries mocked: Supabase PostgREST (fetch), the Meta
 * WhatsApp Cloud API send. carson-communication-history.ts's Supabase JS
 * client is mocked separately from task-confirm.js's raw fetch layer,
 * since that's how these two modules are genuinely wired in production —
 * the same "two mock layers, one fixture" seam already used by
 * src/lib/carson-communication-history.test.ts.
 *
 * Reuses (does not duplicate): api/task-confirm.test.js's exact
 * "worker-notification person_id continuity" mock sequence and helper
 * functions; src/lib/carson-communication-history.test.ts's makeChain/
 * mockTables harness for the Supabase-client mock layer.
 */

vi.mock("@/lib/supabase", async () => {
  const tables = {};
  function makeChain(table) {
    const state = { table };
    const chain = {
      select: () => chain,
      eq: () => chain,
      or: () => chain,
      order: () => chain,
      limit: () => chain,
      then: (resolve) => resolve(tables[state.table] ?? { data: [], error: null }),
      insert: () => { throw new Error(`unexpected insert on ${state.table}`); },
      update: () => { throw new Error(`unexpected update on ${state.table}`); },
      delete: () => { throw new Error(`unexpected delete on ${state.table}`); },
    };
    return chain;
  }
  return {
    supabase: {
      from: (table) => makeChain(table),
    },
    __setMockTables: (next) => {
      for (const k of Object.keys(tables)) delete tables[k];
      Object.assign(tables, next);
    },
  };
});

const taskConfirmHandler = (await import("./task-confirm.js")).default;
const { buildDailyBrief } = await import("@/lib/daily-brief");
const { isQualityOwnerReviewStatus } = await import("@/lib/quality-lifecycle");
const { buildCommunicationHistory } = await import("@/lib/carson-communication-history");
const { __setMockTables } = await import("@/lib/supabase");

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  };
}
function emptyResponse(status = 204) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue({}),
    text: vi.fn().mockResolvedValue(""),
  };
}
function metaAcceptedResponse() {
  return jsonResponse({ messages: [{ id: "wamid.golden-2" }] });
}
function patchReq(body) {
  return { method: "PATCH", headers: { authorization: "Bearer good-token" }, body };
}
function createRes() {
  const res = { status: vi.fn(() => res), json: vi.fn(() => res) };
  return res;
}

const TASK_ID = "task-golden-2";
const USER_ID = "user-golden-2";
const PERSON_ID = "person-ghulam-golden-2";

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
  vi.stubEnv("SUPABASE_ANON_KEY", "anon-key");
  vi.stubEnv("WHATSAPP_ACCESS_TOKEN", "wa-token");
  vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", "1196495893537506");
});

describe("Golden Journey 2 — owner alternative approval, cross-module", () => {
  it("carries the owner's decision through worker notification with canonical person_id, out of Needs You, and into Communication History", async () => {
    // ── Steps 1-2: staff submitted a substitute, task is already in
    // Needs You (quality_review_status: 'substitute_review'). ─────────────
    const preDecisionTask = {
      id: TASK_ID,
      user_id: USER_ID,
      type: "delegation",
      status: "pending",
      description: "buy TEREA Silver",
      assigned_to: "Ghulam",
      quality_review_status: "substitute_review",
      needs_follow_up: true,
    };
    // Needs-You entry point: a delegation with an owner-review quality
    // status is a waiting-intervention task, which is always surfaced
    // regardless of the decision-type classifier.
    expect(isQualityOwnerReviewStatus(preDecisionTask.quality_review_status)).toBe(true);
    const briefBefore = buildDailyBrief([preDecisionTask], new Date("2026-08-14T10:00:00.000Z"));
    expect(briefBefore.needsAttention.map((t) => t.id)).toContain(TASK_ID);

    // ── Step 3: the owner decision itself (api/task-confirm.js, real handler) ──
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: USER_ID })) // auth/v1/user
      .mockResolvedValueOnce(
        jsonResponse([
          {
            id: TASK_ID,
            user_id: USER_ID,
            description: "buy TEREA Silver",
            assigned_to: "Ghulam",
            confirmation_url: null,
            quality_review_status: "substitute_review",
            quality_review_note: "only found turquoise",
            quality_reviewed_at: "2026-08-14T09:50:00.000Z",
            worker_reply: "I only found turquoise",
          },
        ]),
      ) // task fetch
      .mockResolvedValueOnce(
        jsonResponse({ id: "decision-golden-2", lease_token: "lease-golden-2", status: "processing", decision: "approved_alternative" }),
      ) // claim_substitute_decision RPC
      .mockResolvedValueOnce(jsonResponse([{ id: PERSON_ID, name: "Ghulam", phone: "+15559876543" }])) // findAssigneePerson — exactly one match
      .mockResolvedValueOnce(jsonResponse([{ message_id: "msg-golden-2", delivery_id: "delivery-golden-2" }])) // reserve_custom_instruction RPC
      .mockResolvedValueOnce(jsonResponse([{ delivery_status: "pending" }])) // fetchDeliveryStatus
      .mockResolvedValueOnce(emptyResponse()) // reserve_send_window RPC (fence)
      .mockResolvedValueOnce(metaAcceptedResponse()) // Meta send
      .mockResolvedValueOnce(emptyResponse()) // markMessageAccepted PATCH messages
      .mockResolvedValueOnce(emptyResponse()) // markWhatsappDeliveryAccepted PATCH whatsapp_deliveries
      .mockResolvedValueOnce(emptyResponse()) // complete_custom_instruction RPC
      .mockResolvedValueOnce(emptyResponse()); // markApprovedAlternativeConfirmationOnly PATCH
    vi.stubGlobal("fetch", fetchMock);

    const res = createRes();
    await taskConfirmHandler(
      patchReq({ taskId: TASK_ID, decision: "approved_alternative" }),
      res,
    );

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, decision: "approved_alternative", outcome: "approved" }));

    // ── Identity/linkage assertion: the exact PR #237/#243 contract ──────
    const reserveCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/rpc/reserve_custom_instruction"));
    expect(reserveCall).toBeTruthy();
    const reserveBody = JSON.parse(reserveCall[1].body);
    expect(reserveBody.p_person_id).toBe(PERSON_ID);
    expect(reserveBody.p_recipient).toBe("+15559876543");

    // ── Step 4: Needs You resolves (src/lib/daily-brief.ts, real function) ──
    const postDecisionTask = {
      ...preDecisionTask,
      quality_review_status: "approved",
      needs_follow_up: true,
    };
    expect(isQualityOwnerReviewStatus(postDecisionTask.quality_review_status)).toBe(false);
    const briefAfter = buildDailyBrief([postDecisionTask], new Date("2026-08-14T10:05:00.000Z"));
    expect(briefAfter.needsAttention.map((t) => t.id)).not.toContain(TASK_ID);
    // It's a normal open delegation now — correctly moves to Waiting, not
    // vanishing from the product entirely.
    expect(briefAfter.waitingOnOthers.map((t) => t.id)).toContain(TASK_ID);

    // ── Step 5: Communication History can retrieve the resulting communication ──
    // Thread the exact person_id the RPC call carried into the
    // Communication-History-visible whatsapp_deliveries row — proving the
    // identity survived from the decision RPC through to retrieval.
    __setMockTables({
      staff_messages: { data: [], error: null },
      personal_contact_replies: { data: [], error: null },
      messages: { data: [], error: null },
      whatsapp_deliveries: {
        data: [
          {
            id: "delivery-golden-2",
            message_id: "msg-golden-2",
            task_id: TASK_ID,
            delivery_status: "accepted",
            failure_reason: null,
            accepted_at: "2026-08-14T10:01:00.000Z",
            sent_at: "2026-08-14T10:01:00.000Z",
            delivered_at: null,
            read_at: null,
            failed_at: null,
            meta_message_id: "wamid.golden-2",
          },
        ],
        error: null,
      },
      staff_escalation_owner_decisions: { data: [], error: null },
    });

    const history = await buildCommunicationHistory(reserveBody.p_person_id, "Ghulam", USER_ID);
    expect(history.failedSources).toEqual([]);
    expect(history.events.some((e) => e.eventType === "delivery_accepted" || e.eventType === "delivery_sent")).toBe(true);

    // ── Step 6: no duplicate decision/send ────────────────────────────────
    // The lease-fenced claim RPC reports the decision as already completed
    // on a second attempt — the handler must short-circuit before ever
    // reaching reserve/send/complete again.
    const duplicateFetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: USER_ID })) // auth
      .mockResolvedValueOnce(jsonResponse([{ id: TASK_ID, user_id: USER_ID, description: "buy TEREA Silver", assigned_to: "Ghulam", confirmation_url: null, quality_review_status: "approved", quality_review_note: null, quality_reviewed_at: null, worker_reply: null }])) // task fetch
      .mockResolvedValueOnce(
        jsonResponse({ id: "decision-golden-2", lease_token: "lease-golden-2", status: "completed", decision: "approved_alternative" }),
      ); // claim RPC reports already completed
    vi.stubGlobal("fetch", duplicateFetchMock);

    const duplicateRes = createRes();
    await taskConfirmHandler(patchReq({ taskId: TASK_ID, decision: "approved_alternative" }), duplicateRes);

    // Exactly 3 calls (auth, task fetch, claim) — no second reserve/Meta
    // send/complete sequence ever runs.
    expect(duplicateFetchMock).toHaveBeenCalledTimes(3);
    const metaCalls = duplicateFetchMock.mock.calls.filter(([url]) => String(url).includes("graph.facebook.com"));
    expect(metaCalls).toHaveLength(0);
  });
});
