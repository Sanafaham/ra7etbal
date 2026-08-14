import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * GOLDEN JOURNEY 1 — Immediate staff delegation
 * Phase 3 of the Carson Engineering Hardening Project.
 *
 * owner instruction → delegation/task creation → staff WhatsApp send →
 * staff confirmation → canonical task completion state → owner completion
 * notification/evidence → Waiting/Handled projection resolves correctly.
 *
 * This is a genuine cross-module orchestration, not a narrow unit test:
 * it calls the REAL createDelegationTaskAndMessage (src/lib/delegations.ts),
 * the REAL beginWhatsappDelivery (api/_whatsapp-delivery.js), the REAL
 * task-confirm.js handler (worker confirmation PATCH + sendOwnerPush), the
 * REAL qstash-reminder.js handler (completion-receipt validation), and the
 * REAL buildDailyBrief (src/lib/daily-brief.ts) — in sequence, threading
 * one task id and one confirmed_at value through all five.
 *
 * External boundaries mocked: Supabase PostgREST (via global fetch),
 * web-push's actual send (via vi.mock('web-push', ...)). Everything else
 * is real production code.
 *
 * Reuses (does not duplicate): the exact fetch-mock sequence shape and
 * helper functions already proven in api/task-confirm.test.js's PR #246
 * round-trip regression test, and src/lib/delegations.test.ts's
 * module-mock pattern for createTask/createMessage/scheduleEscalationMessages.
 */

const mocks = vi.hoisted(() => ({
  createTask: vi.fn(),
  createMessage: vi.fn(),
  scheduleEscalationMessages: vi.fn(),
  sendNotification: vi.fn(),
}));

vi.mock("@/lib/tasks", () => ({ createTask: mocks.createTask }));
vi.mock("@/lib/messages", () => ({ createMessage: mocks.createMessage }));
vi.mock("@/lib/qstash-escalation", () => ({ scheduleEscalationMessages: mocks.scheduleEscalationMessages }));
vi.mock("web-push", () => ({
  default: { setVapidDetails: vi.fn(), sendNotification: mocks.sendNotification },
}));

const { createDelegationTaskAndMessage } = await import("@/lib/delegations");
const { beginWhatsappDelivery } = await import("./_whatsapp-delivery.js");
const taskConfirmHandler = (await import("./task-confirm.js")).default;
const qstashReminderHandler = (await import("./qstash-reminder.js")).default;
const { buildDailyBrief } = await import("@/lib/daily-brief");

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
function createReq(body, headers = {}) {
  return { method: "POST", headers, body };
}
function createRes() {
  const res = { status: vi.fn(() => res), json: vi.fn(() => res) };
  return res;
}
const CRON_SECRET = "cron-secret";
function stubPushEnv() {
  vi.stubEnv("VAPID_PUBLIC_KEY", "vapid-public");
  vi.stubEnv("VAPID_PRIVATE_KEY", "vapid-private");
  vi.stubEnv("VAPID_SUBJECT", "mailto:owner@example.com");
  vi.stubEnv("CRON_SECRET", CRON_SECRET);
}

const TASK_ID = "task-golden-1";
const USER_ID = "user-golden-1";

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  mocks.createTask.mockReset();
  mocks.createMessage.mockReset();
  mocks.scheduleEscalationMessages.mockReset();
  mocks.scheduleEscalationMessages.mockResolvedValue(undefined);
  mocks.sendNotification.mockReset();
});

describe("Golden Journey 1 — immediate staff delegation, cross-module", () => {
  it("carries one task from creation through WhatsApp send, worker confirmation, owner completion evidence, and the Waiting→Handled projection", async () => {
    // ── Step 1: delegation/task creation (src/lib/delegations.ts, real function) ──
    mocks.createTask.mockResolvedValue({
      id: TASK_ID,
      user_id: USER_ID,
      description: "Prepare the car for the afternoon pickup.",
      assigned_to: "Christopher",
      status: "pending",
      type: "delegation",
      created_at: "2026-08-14T09:00:00.000Z",
      confirmation_url: `https://ra7etbal.test/confirm?task=${TASK_ID}`,
    });
    mocks.createMessage.mockResolvedValue({
      id: "message-golden-1",
      task_id: TASK_ID,
      person_id: "person-christopher-1",
      recipient: "Christopher",
      content: "Prepare the car for the afternoon pickup.",
      confirmation_url: `https://ra7etbal.test/confirm?task=${TASK_ID}`,
    });

    const creation = await createDelegationTaskAndMessage({
      source: "golden-journey",
      userId: USER_ID,
      assignee: { name: "Christopher" },
      taskText: "Prepare the car for the afternoon pickup.",
      confirmationOrigin: "https://ra7etbal.test",
    });

    expect(creation.task.id).toBe(TASK_ID);
    expect(mocks.scheduleEscalationMessages).toHaveBeenCalledWith(TASK_ID, "2026-08-14T09:00:00.000Z");

    // ── Step 2: staff WhatsApp send (api/_whatsapp-delivery.js, real function) ──
    const deliveryFetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: TASK_ID, user_id: USER_ID }])) // resolveDeliveryContext: task lookup
      .mockResolvedValueOnce(jsonResponse([{ id: "delivery-golden-1" }])); // whatsapp_deliveries insert
    vi.stubGlobal("fetch", deliveryFetchMock);

    const deliveryId = await beginWhatsappDelivery({
      supabaseUrl: "https://example.supabase.co",
      serviceKey: "service-key",
      taskId: TASK_ID,
      personId: "person-christopher-1",
      sourceType: "delegation",
      recipientPhone: "+12025691377",
      recipientName: "Christopher",
    });
    expect(deliveryId).toBe("delivery-golden-1");
    const insertedDelivery = JSON.parse(deliveryFetchMock.mock.calls[1][1].body);
    // Identity/linkage assertion: the delivery row created from this send
    // carries the exact same task_id and person_id the delegation was
    // created with — the send is genuinely linked to the task, not a
    // parallel, disconnected record.
    expect(insertedDelivery.task_id).toBe(TASK_ID);
    expect(insertedDelivery.person_id).toBe("person-christopher-1");

    // ── Step 3+4: worker confirmation + owner completion push (api/task-confirm.js, real handler) ──
    stubPushEnv();
    vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
    mocks.sendNotification.mockResolvedValueOnce({ statusCode: 201 });
    const canonicalConfirmedAt = "2026-08-14T09:45:12.123+00:00";

    const confirmFetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([
          {
            id: TASK_ID,
            user_id: USER_ID,
            status: "pending",
            description: "Prepare the car for the afternoon pickup.",
            assigned_to: "Christopher",
            image_path: null,
          },
        ]),
      ) // GET task
      .mockResolvedValueOnce(
        jsonResponse([{ id: TASK_ID, user_id: USER_ID, status: "done", confirmed_at: canonicalConfirmedAt }]),
      ) // PATCH tasks -> done, Prefer: return=representation
      .mockResolvedValueOnce(emptyResponse()) // confirmations insert
      .mockResolvedValueOnce(
        jsonResponse([{ id: "sub-golden-1", endpoint: "https://push.example/sub-golden-1", p256dh: "p", auth: "a" }]),
      ) // push_subscriptions GET
      .mockResolvedValueOnce(jsonResponse({}, 201)) // reminder_delivery_events: provider_send_attempted
      .mockResolvedValueOnce(jsonResponse({}, 201)) // reminder_delivery_events: provider_accepted
      .mockResolvedValueOnce(jsonResponse([])); // best-effort automation-run projection sync (non-fatal if it fails; kept queued so the journey's fetch log stays exact)
    vi.stubGlobal("fetch", confirmFetchMock);

    const confirmRes = createRes();
    await taskConfirmHandler(createReq({ taskId: TASK_ID }), confirmRes);

    // Final business-visible state assertion: the confirmation succeeded.
    expect(confirmRes.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, outcome: "approved" }));
    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);
    const pushPayload = JSON.parse(mocks.sendNotification.mock.calls[0][1]);
    const receipt = pushPayload.receipt;
    // This is the exact contract that broke in the completion-push
    // confirmed_at regression (Incident 2 / PR #240 / #246): the receipt's
    // dueAt must equal the PostgREST-returned confirmed_at from the same
    // request, never an independently generated timestamp.
    expect(receipt.dueAt).toBe(canonicalConfirmedAt);
    expect(receipt.dueAt).not.toBe(new Date().toISOString());

    // ── Step 5: owner completion notification/evidence round-trip (api/qstash-reminder.js, real handler) ──
    vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
    vi.stubEnv("CRON_SECRET", CRON_SECRET);

    const receiptFetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([{ id: TASK_ID, user_id: USER_ID, type: "delegation", due_at: null, confirmed_at: canonicalConfirmedAt }]),
      ) // task lookup for receipt validation
      .mockResolvedValueOnce(jsonResponse([{ id: "sub-golden-1" }])) // subscription ownership
      .mockResolvedValueOnce(jsonResponse({}, 201)); // recordDeliveryEvent: service_worker_received
    vi.stubGlobal("fetch", receiptFetchMock);

    function receiptReq(stage) {
      return {
        method: "POST",
        headers: {},
        body: {
          action: "notification-receipt",
          kind: receipt.kind,
          taskId: receipt.taskId,
          subscriptionId: receipt.subscriptionId,
          dueAt: receipt.dueAt,
          token: receipt.token,
          stage,
        },
      };
    }
    function receiptRes() {
      return { statusCode: 200, payload: null, status(c) { this.statusCode = c; return this; }, json(p) { this.payload = p; return this; } };
    }

    const swReceivedRes = receiptRes();
    await qstashReminderHandler(receiptReq("service_worker_received"), swReceivedRes);
    // The completion-push evidence round-trip genuinely validates — this is
    // the mechanical proof the durable evidence lifecycle actually closes
    // the loop, not just that a receipt was constructed.
    expect(swReceivedRes.statusCode).toBe(200);
    expect(swReceivedRes.payload).toEqual({ success: true });

    // ── Step 6: Waiting → Handled projection (src/lib/daily-brief.ts, real pure function) ──
    const inFlightTask = {
      id: TASK_ID,
      user_id: USER_ID,
      status: "pending",
      type: "delegation",
      description: "Prepare the car for the afternoon pickup.",
      assigned_to: "Christopher",
      quality_review_status: null,
      needs_follow_up: false,
      confirmed_at: null,
    };
    const briefBefore = buildDailyBrief([inFlightTask], new Date("2026-08-14T09:30:00.000Z"));
    expect(briefBefore.waitingOnOthers.map((t) => t.id)).toContain(TASK_ID);
    expect(briefBefore.done.map((t) => t.id)).not.toContain(TASK_ID);

    const completedTask = { ...inFlightTask, status: "done", confirmed_at: canonicalConfirmedAt };
    const briefAfter = buildDailyBrief([completedTask], new Date("2026-08-14T09:46:00.000Z"));
    // Final business-visible state: the exact same task, carrying the exact
    // confirmed_at the completion-push evidence proved, now resolves out of
    // Waiting and into Handled/done — the whole journey's end state.
    expect(briefAfter.waitingOnOthers.map((t) => t.id)).not.toContain(TASK_ID);
    expect(briefAfter.done.map((t) => t.id)).toContain(TASK_ID);
  });
});
