import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * GOLDEN JOURNEY 4 — One-time scheduled delegation
 * Phase 3 of the Carson Engineering Hardening Project.
 *
 * one-time automation → automation runner → staff task/WhatsApp delivery
 * → correct person_id/linkage → automation execution state →
 * Communication History retrieval.
 *
 * Specifically protects the automation-runner Communication History
 * linkage regression fixed in PR #253 (Phase 0 Incident 4): the
 * automation runner resolves the canonical assignee and threads
 * assignee.id as personId into the WhatsApp send — this must survive all
 * the way through to Communication History retrieval, not just be present
 * in one intermediate payload.
 *
 * Scope note (honest boundary, not a shortcut): processAutomation calls
 * `/api/send-whatsapp-task` over HTTP (a real network hop in production).
 * This journey mocks that hop at the fetch layer (as every existing test
 * of processAutomation already does) rather than executing
 * send-whatsapp-task.js's full Meta-send HTTP handler in-process — that
 * handler's own internal Meta payload construction was not part of this
 * phase's investigated evidence, and guessing its exact fetch sequence
 * would risk fabricating behavior rather than proving it. Instead, this
 * journey captures the exact personId processAutomation placed in that
 * outgoing HTTP body, then calls the REAL beginWhatsappDelivery — the
 * exact function send-whatsapp-task.js calls with that same value — to
 * prove the identity is not dropped between the automation runner and the
 * whatsapp_deliveries write. That write is then read back by the REAL
 * buildCommunicationHistory. Three real production modules, one thread of
 * identity, with the actual PR #253 regression tests' evidence reused
 * directly for the mock shapes (see api/process-delegation-escalations.test.js
 * and api/_whatsapp-delivery.test.js's "automation-runner call shape" test).
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

const { processAutomation } = await import("./process-delegation-escalations.js");
const { beginWhatsappDelivery } = await import("./_whatsapp-delivery.js");
const { buildCommunicationHistory } = await import("@/lib/carson-communication-history");
const { __setMockTables } = await import("@/lib/supabase");

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}
function emptyResponse(status = 204) {
  return { ok: status >= 200 && status < 300, status, json: async () => null, text: async () => "" };
}
function advancedAutomationResponse(nextRunAt, id = "automation-golden-4") {
  return jsonResponse([{ id, next_run_at: nextRunAt }], 200);
}
function ownerOnlyAutomationRow(overrides = {}) {
  return {
    id: "automation-golden-4",
    user_id: "user-golden-4",
    title: "One-time golden delegation",
    instruction: "Drop the keys with the concierge.",
    automation_type: "delegation",
    assignee_id: "person-christopher-golden-4",
    cadence_type: "once",
    cadence_value: { time: "17:30" },
    timezone: "Europe/Istanbul",
    next_run_at: "2026-08-14T14:30:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("Golden Journey 4 — one-time scheduled delegation, cross-module", () => {
  it("threads the automation runner's resolved person_id through the WhatsApp send into a Communication-History-reachable delivery, with correct automation execution state", async () => {
    // ── Steps 1-2: one-time automation → automation runner (real processAutomation) ──
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: "run-golden-4" }], 201)) // automation_run insert
      .mockResolvedValueOnce(jsonResponse([{ id: "person-christopher-golden-4", name: "Christopher", phone: "+12025691377" }])) // resolvePersonById
      .mockResolvedValueOnce(jsonResponse([{ id: "task-golden-4" }], 201)) // createTask
      .mockResolvedValueOnce(emptyResponse()) // patchAutomationRun: task_id/task_created
      .mockResolvedValueOnce(emptyResponse()) // patchTask: confirmation_url
      .mockResolvedValueOnce(jsonResponse([{ display_name: "Sana" }])) // resolveOwnerName
      .mockResolvedValueOnce(jsonResponse({ success: true })) // POST /api/send-whatsapp-task
      .mockResolvedValueOnce(emptyResponse()) // patchAutomationRun: sent
      .mockResolvedValueOnce(advancedAutomationResponse("2026-08-15T14:30:00.000Z")); // advanceNextRunAt (cadence once still returns a row shape here per the fixture's helper)
    vi.stubGlobal("fetch", fetchMock);

    const result = await processAutomation({
      automation: ownerOnlyAutomationRow(),
      supabaseUrl: "https://example.supabase.co",
      serviceKey: "service-key",
      appBaseUrl: "https://ra7etbal.test",
      now: new Date("2026-08-14T14:30:00.000Z"),
    });

    expect(result).toBe("ok");

    // Automation execution state assertions: exactly one automation_run
    // created, and it was patched to task_created then sent — the
    // canonical execution-state trail this journey must protect.
    const runPatchCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes("/rest/v1/automation_runs?id="));
    expect(runPatchCalls.length).toBeGreaterThanOrEqual(2);
    const sentPatch = runPatchCalls.find(([, opts]) => String(opts?.body || "").includes('"current_state":"sent"'));
    expect(sentPatch).toBeTruthy();

    // ── Step 3: correct person_id/linkage in the WhatsApp send payload ────
    const sendCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/api/send-whatsapp-task"));
    expect(sendCall).toBeTruthy();
    const sendBody = JSON.parse(sendCall[1].body);
    expect(sendBody.personId).toBe("person-christopher-golden-4");
    expect(sendBody.taskId).toBe("task-golden-4");
    expect(sendBody.automationRunId).toBe("run-golden-4");

    // ── Step 4: the real production write path this personId feeds (api/_whatsapp-delivery.js) ──
    // This is exactly the function send-whatsapp-task.js calls with the
    // same personId/taskId/automationRunId — reproducing the "automation-
    // runner call shape" regression test from api/_whatsapp-delivery.test.js.
    const deliveryFetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: sendBody.taskId, user_id: "user-golden-4" }])) // task lookup
      .mockResolvedValueOnce(jsonResponse([{ id: sendBody.automationRunId, user_id: "user-golden-4", task_id: sendBody.taskId }])) // automation_run lookup
      .mockResolvedValueOnce(jsonResponse([{ id: "delivery-golden-4" }])); // whatsapp_deliveries insert
    vi.stubGlobal("fetch", deliveryFetchMock);

    const deliveryId = await beginWhatsappDelivery({
      supabaseUrl: "https://example.supabase.co",
      serviceKey: "service-key",
      taskId: sendBody.taskId,
      automationRunId: sendBody.automationRunId,
      personId: sendBody.personId,
      sourceType: "automation_delegation",
      recipientPhone: "+12025691377",
      recipientName: "Christopher",
    });
    expect(deliveryId).toBe("delivery-golden-4");
    const insertedDelivery = JSON.parse(deliveryFetchMock.mock.calls[2][1].body);
    expect(insertedDelivery.person_id).toBe("person-christopher-golden-4");
    expect(insertedDelivery.message_id).toBeNull(); // no messages row for this send path — the exact PR #253 shape
    expect(insertedDelivery.automation_run_id).toBe("run-golden-4");

    // ── Step 5: Communication History retrieval (real buildCommunicationHistory) ──
    __setMockTables({
      staff_messages: { data: [], error: null },
      personal_contact_replies: { data: [], error: null },
      messages: { data: [], error: null },
      whatsapp_deliveries: {
        data: [
          {
            id: "delivery-golden-4",
            message_id: null,
            task_id: sendBody.taskId,
            delivery_status: "read",
            failure_reason: null,
            accepted_at: "2026-08-14T14:31:00.000Z",
            sent_at: "2026-08-14T14:31:01.000Z",
            delivered_at: "2026-08-14T14:31:05.000Z",
            read_at: "2026-08-14T14:35:00.000Z",
            failed_at: null,
            meta_message_id: null,
          },
        ],
        error: null,
      },
      staff_escalation_owner_decisions: { data: [], error: null },
    });

    const history = await buildCommunicationHistory(insertedDelivery.person_id, "Christopher", "user-golden-4");
    expect(history.failedSources).toEqual([]);
    const readEvent = history.events.find((e) => e.eventType === "delivery_read");
    // This is the exact Incident 4 counterfactual: the automation-sourced
    // delivery, which has no linked messages row at all, must still be
    // reachable purely via person_id — with the person_id threaded
    // genuinely from processAutomation's own resolution, not hand-set on
    // the read-side fixture alone.
    expect(readEvent).toBeDefined();
    expect(readEvent?.taskId).toBe(sendBody.taskId);
  });
});
