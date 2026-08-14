import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * GOLDEN JOURNEY 3 — Reminder lifecycle
 * Phase 3 of the Carson Engineering Hardening Project.
 *
 * create reminder → scheduling state → due execution → push/delivery
 * evidence → receipt/acknowledgement path → correct final reminder/task
 * state.
 *
 * Genuine cross-module chain: api/qstash-reminder.js's real
 * "create-and-schedule" handler (real task INSERT + real QStash publish
 * shape) → api/send-push-for-task.js's real handler (real push send +
 * real reminder_delivery_events recording) → api/qstash-reminder.js's real
 * "notification-receipt" handler (kind: 'reminder', validated against
 * task.due_at) using the real signReminderReceipt/verifyReminderReceipt
 * from api/_reminder-delivery.js (not mocked — pure HMAC) → the real
 * notification_clicked → status:'done' transition.
 *
 * Scope note (honest boundary): the browser Service Worker's own push
 * handler (public/sw.js) cannot be genuinely executed here — there is no
 * fake-`self`/PushEvent/ExtendableEvent harness anywhere in this repo
 * (public/sw.test.js itself only does source-text `.toContain()` checks,
 * never instantiates the SW runtime), and building one from scratch would
 * be new test infrastructure, not composition of what already exists.
 * This journey's "receipt" step therefore starts from the receipt shape
 * public/sw.js's `reportDelivery()` is documented (by source, cited above)
 * to send, and drives it through the real server-side validation chain —
 * it does not claim to execute the Service Worker itself.
 *
 * External boundaries mocked: Supabase PostgREST (fetch), QStash's actual
 * publish API, web-push's actual send, Upstash's Receiver.verify signature
 * check, and the two unrelated owner-notification helper modules
 * send-push-for-task.js also touches (reused exactly as
 * api/send-push-for-task.test.js already mocks them).
 */

const mocks = vi.hoisted(() => ({
  sendNotification: vi.fn(),
  verify: vi.fn(),
  deliverOwnerReminderWhatsapp: vi.fn(),
  getOrCreateOwnerNotification: vi.fn(),
}));

vi.mock("web-push", () => ({
  default: { setVapidDetails: vi.fn(), sendNotification: mocks.sendNotification },
}));
vi.mock("@upstash/qstash", () => ({
  Receiver: vi.fn().mockImplementation(() => ({ verify: mocks.verify })),
}));
vi.mock("./_owner-reminder-whatsapp.js", () => ({
  deliverOwnerReminderWhatsapp: mocks.deliverOwnerReminderWhatsapp,
}));
vi.mock("./_owner-notifications.js", async (importOriginal) => ({
  ...(await importOriginal()),
  getOrCreateOwnerNotification: mocks.getOrCreateOwnerNotification,
}));

const qstashReminderHandler = (await import("./qstash-reminder.js")).default;
const sendPushForTaskHandler = (await import("./send-push-for-task.js")).default;
const { signReminderReceipt } = await import("./_reminder-delivery.js");

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}
function emptyResponse(status = 204) {
  return { ok: status >= 200 && status < 300, status, json: async () => null, text: async () => "" };
}
function mockReq({ method = "POST", body = {}, headers = { authorization: "Bearer user-jwt" } } = {}) {
  return { method, body, headers };
}
function mockRes() {
  return { statusCode: 200, payload: null, status(c) { this.statusCode = c; return this; }, json(p) { this.payload = p; return this; } };
}
function pushReq(body) {
  return { method: "POST", headers: { "upstash-signature": "signature" }, body };
}
function pushRes() {
  const res = { status: vi.fn(() => res), json: vi.fn(() => res) };
  return res;
}

const CRON_SECRET = "receipt-secret";
const TASK_ID = "5b8f3c39-7b8f-43f6-9085-0b4b64905bf8";
const USER_ID = "user-golden-3";
const DUE_AT = "2026-08-14T13:00:00.000Z";

beforeEach(() => {
  vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
  vi.stubEnv("QSTASH_TOKEN", "qstash-token");
  vi.stubEnv("QSTASH_CURRENT_SIGNING_KEY", "current-key");
  vi.stubEnv("QSTASH_NEXT_SIGNING_KEY", "next-key");
  vi.stubEnv("CRON_SECRET", CRON_SECRET);
  vi.stubEnv("APP_BASE_URL", "https://ra7etbal.test");
  vi.stubEnv("VAPID_PUBLIC_KEY", "public-key");
  vi.stubEnv("VAPID_PRIVATE_KEY", "private-key");
  vi.stubEnv("VAPID_SUBJECT", "mailto:owner@example.com");
  mocks.verify.mockResolvedValue(true);
  mocks.sendNotification.mockReset().mockResolvedValue({});
  mocks.deliverOwnerReminderWhatsapp.mockReset().mockResolvedValue({ attempted: false, status: "skipped" });
  mocks.getOrCreateOwnerNotification.mockReset().mockResolvedValue({
    created: true,
    notification: { id: "notification-golden-3", title: "Ra7etBal", body: "Call the vet", target_url: "/updates?tab=todo" },
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Golden Journey 3 — reminder lifecycle, cross-module", () => {
  it("carries one reminder from creation through due execution, push evidence, and receipt validation to its final state", async () => {
    // ── Step 1: create reminder + scheduling state (api/qstash-reminder.js, real "create-and-schedule") ──
    const createdTask = {
      id: TASK_ID,
      user_id: USER_ID,
      description: "Call the vet",
      type: "reminder",
      due_at: DUE_AT,
      status: "pending",
    };
    const createFetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: USER_ID })) // auth verify
      .mockResolvedValueOnce(jsonResponse([createdTask], 201)) // task insert
      .mockResolvedValueOnce(jsonResponse({ messageId: "qstash-msg-golden-3" })) // QStash publish
      .mockResolvedValueOnce(jsonResponse({})); // PATCH saving qstash_message_id
    vi.stubGlobal("fetch", createFetchMock);

    const createRes = mockRes();
    await qstashReminderHandler(
      mockReq({
        body: {
          action: "create-and-schedule",
          description: "Call the vet",
          dueAt: DUE_AT,
          creationContract: { contract_version: "reminder-creation-v1", source: "inbox", operation_id: TASK_ID },
        },
      }),
      createRes,
    );

    expect(createRes.statusCode).toBe(201);
    expect(createRes.payload.task).toMatchObject({ id: TASK_ID, qstash_message_id: "qstash-msg-golden-3" });
    // The genuine external boundary (QStash's real scheduling API) was
    // mocked, never actually called over the network.
    expect(createFetchMock.mock.calls.some(([url]) => String(url).includes("qstash.upstash.io/v2/publish"))).toBe(true);

    // ── Step 2: due execution + push/delivery evidence (api/send-push-for-task.js, real handler) ──
    const patches = [];
    const events = [];
    const dueFetchMock = vi.fn(async (url, options = {}) => {
      const value = String(url);
      if (value.includes("/rest/v1/tasks?select=")) {
        return jsonResponse([
          { ...createdTask, last_push_sent_at: null, archived_at: null, reminder_delivery_status: "scheduled" },
        ]);
      }
      if (value.includes("/rest/v1/push_subscriptions")) {
        return jsonResponse([{ id: "sub-golden-3", endpoint: "https://push.example/golden-3", p256dh: "p", auth: "a" }]);
      }
      if (value.includes("/rest/v1/reminder_delivery_events")) {
        events.push(JSON.parse(options.body));
        return emptyResponse();
      }
      if (value.includes("/rest/v1/tasks") && options.method === "PATCH") {
        patches.push(JSON.parse(options.body));
        return options.headers.Prefer === "return=representation" ? jsonResponse([{ id: TASK_ID }]) : emptyResponse();
      }
      throw new Error(`Unexpected fetch in due-execution step: ${value}`);
    });
    vi.stubGlobal("fetch", dueFetchMock);

    const dueRes = pushRes();
    await sendPushForTaskHandler(pushReq({ taskId: TASK_ID }), dueRes);

    expect(dueRes.status).toHaveBeenCalledWith(200);
    expect(dueRes.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, sent: 1, failed: 0 }));
    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);
    // Final-state guard already established by this handler's own suite,
    // reused here: a provider-accepted push never marks the reminder done
    // or confirmed on its own — only a real receipt (step 3) can.
    expect(patches.flatMap(Object.keys)).not.toContain("status");
    expect(patches.flatMap(Object.keys)).not.toContain("confirmed_at");
    expect(events.filter((e) => e.stage === "provider_accepted")).toHaveLength(1);

    const pushPayload = JSON.parse(mocks.sendNotification.mock.calls[0][1]);
    const receipt = pushPayload.receipt;
    expect(receipt.taskId).toBe(TASK_ID);
    expect(receipt.dueAt).toBe(DUE_AT);

    // ── Step 3: receipt/acknowledgement (api/qstash-reminder.js, real "notification-receipt") ──
    // Uses the real, unmocked HMAC signing/verification — proves the
    // receipt public/sw.js would have reported is genuinely accepted by
    // the real server-side validator, not a fixture the test invented.
    function receiptFields(stage) {
      return { taskId: receipt.taskId, userId: USER_ID, subscriptionId: receipt.subscriptionId, dueAt: receipt.dueAt };
    }
    function receiptBody(stage) {
      return {
        action: "notification-receipt",
        kind: undefined, // every already-deployed client omits kind — must still validate as a reminder receipt
        taskId: receipt.taskId,
        subscriptionId: receipt.subscriptionId,
        dueAt: receipt.dueAt,
        stage,
        token: signReminderReceipt(receiptFields(stage), CRON_SECRET),
      };
    }

    const receiptFetchMock1 = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: TASK_ID, user_id: USER_ID, type: "reminder", due_at: DUE_AT, confirmed_at: null }])) // task lookup
      .mockResolvedValueOnce(jsonResponse([{ id: receipt.subscriptionId }])) // subscription ownership
      .mockResolvedValueOnce(jsonResponse({}, 201)); // recordDeliveryEvent
    vi.stubGlobal("fetch", receiptFetchMock1);

    const receivedRes = mockRes();
    await qstashReminderHandler(mockReq({ body: receiptBody("service_worker_received") }), receivedRes);
    expect(receivedRes.statusCode).toBe(200);
    expect(receivedRes.payload).toEqual({ success: true });

    // ── Step 4: correct final reminder/task state — tapping the notification means "done" ──
    let finalPatchBody = null;
    const receiptFetchMock2 = vi.fn(async (url, options = {}) => {
      const value = String(url);
      if (value.includes("/rest/v1/tasks?select=") && (options.method ?? "GET") === "GET") {
        return jsonResponse([{ id: TASK_ID, user_id: USER_ID, type: "reminder", due_at: DUE_AT, confirmed_at: null }]);
      }
      if (value.includes("/rest/v1/push_subscriptions")) return jsonResponse([{ id: receipt.subscriptionId }]);
      if (value.includes("/rest/v1/reminder_delivery_events")) return emptyResponse();
      if (value.includes("/rest/v1/tasks?id=eq.") && options.method === "PATCH") {
        finalPatchBody = JSON.parse(options.body);
        return emptyResponse();
      }
      throw new Error(`Unexpected fetch in receipt step: ${value}`);
    });
    vi.stubGlobal("fetch", receiptFetchMock2);

    const clickedRes = mockRes();
    await qstashReminderHandler(mockReq({ body: receiptBody("notification_clicked") }), clickedRes);
    expect(clickedRes.statusCode).toBe(200);
    // Final business-visible state: the reminder task genuinely transitions
    // to done, confirmed by the tap, with a truthful confirmed_by marker —
    // the end state this entire journey exists to prove is reachable.
    expect(finalPatchBody).toMatchObject({
      status: "done",
      confirmed_by: "notification_click",
      reminder_delivery_status: "interacted",
    });
    expect(finalPatchBody.confirmed_at).toEqual(expect.any(String));
  });
});
