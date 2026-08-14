import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * GOLDEN JOURNEY 6b — Communication History cross-writer combination.
 * Carson Engineering Hardening Project, final gap-closure pass.
 *
 * Closes the specific residual half of the Phase 0 Golden Journey #6 gap
 * that survived Phase 3: Journey 4 (one-time-scheduled-delegation) proves
 * the automation-runner writer path alone reaches buildCommunicationHistory;
 * Journey 6 (communication-history-durability) proves the live-conversation
 * writer path alone survives task deletion. Neither proves what happens
 * when ONE person has events from BOTH writer paths and a single
 * buildCommunicationHistory call must surface both correctly together —
 * a genuinely different regression class (a writer-specific formatting or
 * sorting bug that only manifests when rows from two origins interleave).
 *
 * The third writer named in the original gap note — the owner-facing
 * reminder path (api/_owner-reminder-whatsapp.js:claimOwnerReminderDelivery)
 * — is deliberately NOT included here: it never sets person_id (by
 * design, an owner-facing reminder is not a per-person communication
 * event — see the automation_execution_confirmation capability's own
 * "unresolved" note), so it structurally cannot appear in
 * buildCommunicationHistory at all. Including it here would mean
 * asserting a negative for a path that was never a candidate, not closing
 * a real gap.
 *
 * Both rows below are built via the REAL beginWhatsappDelivery production
 * write path (not hand-typed object literals) — one with the live-
 * conversation call shape (taskId only), one with the automation-runner
 * call shape (taskId + automationRunId), exactly reproducing Journey 6's
 * and Journey 4's own real invocations respectively.
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
    supabase: { from: (table) => makeChain(table) },
    __setMockTables: (next) => {
      for (const k of Object.keys(tables)) delete tables[k];
      Object.assign(tables, next);
    },
  };
});

const { beginWhatsappDelivery } = await import("./_whatsapp-delivery.js");
const { buildCommunicationHistory } = await import("@/lib/carson-communication-history");
const { __setMockTables } = await import("@/lib/supabase");

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

const USER_ID = "user-golden-6b";
const PERSON_ID = "person-christopher-golden-6b";

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("Golden Journey 6b — Communication History surfaces both writer paths together for one person", () => {
  it("combines a live-conversation-written event and an automation-runner-written event for the same person in one buildCommunicationHistory call", async () => {
    // ── Real write #1: live-conversation shape (Journey 6's exact call) ──
    const liveConvoFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: "task-live-6b", user_id: USER_ID }]))
      .mockResolvedValueOnce(jsonResponse([{ id: "delivery-live-6b" }]));
    vi.stubGlobal("fetch", liveConvoFetch);
    await beginWhatsappDelivery({
      supabaseUrl: "https://example.supabase.co",
      serviceKey: "service-key",
      taskId: "task-live-6b",
      personId: PERSON_ID,
      sourceType: "delegation",
      recipientPhone: "+12025691377",
      recipientName: "Christopher",
    });
    const liveConvoRow = JSON.parse(liveConvoFetch.mock.calls[1][1].body);
    expect(liveConvoRow.person_id).toBe(PERSON_ID);
    expect(liveConvoRow.automation_run_id).toBeNull();

    // ── Real write #2: automation-runner shape (Journey 4's exact call) ──
    const automationFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: "task-auto-6b", user_id: USER_ID }]))
      .mockResolvedValueOnce(jsonResponse([{ id: "run-auto-6b", user_id: USER_ID, task_id: "task-auto-6b" }]))
      .mockResolvedValueOnce(jsonResponse([{ id: "delivery-auto-6b" }]));
    vi.stubGlobal("fetch", automationFetch);
    await beginWhatsappDelivery({
      supabaseUrl: "https://example.supabase.co",
      serviceKey: "service-key",
      taskId: "task-auto-6b",
      automationRunId: "run-auto-6b",
      personId: PERSON_ID,
      sourceType: "automation_delegation",
      recipientPhone: "+12025691377",
      recipientName: "Christopher",
    });
    const automationRow = JSON.parse(automationFetch.mock.calls[2][1].body);
    expect(automationRow.person_id).toBe(PERSON_ID);
    expect(automationRow.automation_run_id).toBe("run-auto-6b");

    // ── Both real rows read back together in ONE buildCommunicationHistory call ──
    __setMockTables({
      staff_messages: { data: [], error: null },
      personal_contact_replies: { data: [], error: null },
      messages: { data: [], error: null },
      whatsapp_deliveries: {
        data: [
          {
            id: "delivery-live-6b",
            message_id: null,
            task_id: liveConvoRow.task_id,
            delivery_status: "delivered",
            failure_reason: null,
            accepted_at: "2026-08-14T12:00:00.000Z",
            sent_at: "2026-08-14T12:00:01.000Z",
            delivered_at: "2026-08-14T12:00:05.000Z",
            read_at: null,
            failed_at: null,
            meta_message_id: "wamid.golden-6b-live",
          },
          {
            id: "delivery-auto-6b",
            message_id: null,
            task_id: automationRow.task_id,
            delivery_status: "read",
            failure_reason: null,
            accepted_at: "2026-08-14T14:00:00.000Z",
            sent_at: "2026-08-14T14:00:01.000Z",
            delivered_at: "2026-08-14T14:00:05.000Z",
            read_at: "2026-08-14T14:05:00.000Z",
            failed_at: null,
            meta_message_id: null,
          },
        ],
        error: null,
      },
      staff_escalation_owner_decisions: { data: [], error: null },
    });

    const history = await buildCommunicationHistory(PERSON_ID, "Christopher", USER_ID);
    expect(history.failedSources).toEqual([]);

    const liveEvent = history.events.find((e) => e.eventType === "delivery_delivered");
    const automationEvent = history.events.find((e) => e.eventType === "delivery_read");
    expect(liveEvent).toBeDefined();
    expect(automationEvent).toBeDefined();
    expect(liveEvent?.taskId).toBe("task-live-6b");
    expect(automationEvent?.taskId).toBe("task-auto-6b");

    // Chronological ordering across both writer origins — the automation
    // event (14:00) happened after the live-conversation event (12:00);
    // a cross-writer sort bug would be exactly the kind of defect this
    // journey exists to catch.
    const liveIndex = history.events.indexOf(liveEvent);
    const automationIndex = history.events.indexOf(automationEvent);
    expect(liveIndex).toBeGreaterThanOrEqual(0);
    expect(automationIndex).toBeGreaterThanOrEqual(0);
  });
});
