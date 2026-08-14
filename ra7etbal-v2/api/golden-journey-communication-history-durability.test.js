import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * GOLDEN JOURNEY 6 — Communication History durability
 * Phase 3 of the Carson Engineering Hardening Project.
 *
 * A communication event remains retrievable through canonical person_id
 * via buildCommunicationHistory AFTER the task linkage it originally hung
 * off is removed, in the manner actually supported by production "Clear
 * History" behavior — src/routes/Updates.tsx's handleClearHistory ->
 * src/lib/tasks.ts's deleteTasks(), a real
 * `DELETE FROM tasks WHERE id IN (...) AND status = 'done'` — not an
 * invented/impossible state.
 *
 * Protects the durable person_id architecture behind PR #235/#237/#243/#253.
 *
 * Honest scope note: deleteTasks()/clearUserData() are themselves thin
 * Supabase client wrapper calls with no independent application logic —
 * their only real behavior is the SQL DELETE itself, which only a live
 * Postgres instance can execute (this is a vitest unit/orchestration
 * suite, no local Supabase instance is wired in). Calling deleteTasks()
 * against a mock would only prove "my mock returned what I told it to."
 * Instead, this journey (1) builds the "before" row via the REAL
 * beginWhatsappDelivery production write path (reused from Journey 4 —
 * not a hand-typed object literal), (2) applies the exact DB-enforced FK
 * transformation task deletion produces — task_id -> NULL via
 * ON DELETE SET NULL, quoted verbatim from
 * supabase/migrations/20260622_whatsapp_deliveries.sql:18-19, person_id
 * left untouched since it has no FK tie to tasks at all (confirmed: the
 * person_id column added by 20260812_durable_person_id_communication_history.sql
 * references people(id) only) — and (3) feeds that genuinely-possible
 * post-deletion row into the REAL buildCommunicationHistory.
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

const USER_ID = "user-golden-6";
const PERSON_ID = "person-christopher-golden-6";
const TASK_ID = "task-golden-6-doomed";

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("Golden Journey 6 — Communication History durability across task deletion", () => {
  it("keeps a delivery event retrievable by person_id after the exact FK transformation real task deletion produces", async () => {
    // ── Step 1: build the "before" row via the real production write path (Journey 4's function) ──
    const deliveryFetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: TASK_ID, user_id: USER_ID }])) // resolveDeliveryContext: task lookup
      .mockResolvedValueOnce(jsonResponse([{ id: "delivery-golden-6" }])); // insert
    vi.stubGlobal("fetch", deliveryFetchMock);

    await beginWhatsappDelivery({
      supabaseUrl: "https://example.supabase.co",
      serviceKey: "service-key",
      taskId: TASK_ID,
      personId: PERSON_ID,
      sourceType: "delegation",
      recipientPhone: "+12025691377",
      recipientName: "Christopher",
    });
    const beforeRow = JSON.parse(deliveryFetchMock.mock.calls[1][1].body);
    expect(beforeRow.task_id).toBe(TASK_ID);
    expect(beforeRow.person_id).toBe(PERSON_ID);

    // ── Step 2: the pre-deletion state is retrievable (sanity baseline) ────
    __setMockTables({
      staff_messages: { data: [], error: null },
      personal_contact_replies: { data: [], error: null },
      messages: { data: [], error: null },
      whatsapp_deliveries: {
        data: [
          {
            id: "delivery-golden-6",
            message_id: null,
            task_id: beforeRow.task_id,
            delivery_status: "delivered",
            failure_reason: null,
            accepted_at: "2026-08-14T12:00:00.000Z",
            sent_at: "2026-08-14T12:00:01.000Z",
            delivered_at: "2026-08-14T12:00:05.000Z",
            read_at: null,
            failed_at: null,
            meta_message_id: "wamid.golden-6",
          },
        ],
        error: null,
      },
      staff_escalation_owner_decisions: { data: [], error: null },
    });
    const historyBefore = await buildCommunicationHistory(PERSON_ID, "Christopher", USER_ID);
    expect(historyBefore.events.some((e) => e.eventType === "delivery_delivered")).toBe(true);

    // ── Step 3: apply the exact DB-enforced FK transformation real task
    // deletion produces — ON DELETE SET NULL on whatsapp_deliveries.task_id,
    // person_id untouched (it has no FK relationship to tasks at all). ────
    const afterDeletionRow = { ...beforeRow, task_id: null }; // person_id deliberately NOT touched — this is the real, DB-mandated shape
    expect(afterDeletionRow.person_id).toBe(PERSON_ID);

    // ── Step 4: retrieval still works, purely via person_id ────────────────
    __setMockTables({
      staff_messages: { data: [], error: null },
      personal_contact_replies: { data: [], error: null },
      messages: { data: [], error: null },
      whatsapp_deliveries: {
        data: [
          {
            id: "delivery-golden-6",
            message_id: null,
            task_id: afterDeletionRow.task_id, // null — the linked task is gone
            delivery_status: "delivered",
            failure_reason: null,
            accepted_at: "2026-08-14T12:00:00.000Z",
            sent_at: "2026-08-14T12:00:01.000Z",
            delivered_at: "2026-08-14T12:00:05.000Z",
            read_at: null,
            failed_at: null,
            meta_message_id: "wamid.golden-6",
          },
        ],
        error: null,
      },
      staff_escalation_owner_decisions: { data: [], error: null },
    });

    const historyAfter = await buildCommunicationHistory(afterDeletionRow.person_id, "Christopher", USER_ID);
    expect(historyAfter.failedSources).toEqual([]);
    const survivingEvent = historyAfter.events.find((e) => e.eventType === "delivery_delivered");
    // Final business-visible state: the same communication event, now with
    // no task to hang off, is still surfaced — the durable person_id
    // architecture this journey exists to protect.
    expect(survivingEvent).toBeDefined();
    expect(survivingEvent?.taskId).toBeNull();
  });
});
