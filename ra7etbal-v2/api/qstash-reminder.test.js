import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler, { resolveAppBaseUrl, scheduleAutomationRunWakeup } from "./qstash-reminder.js";
import { signReminderReceipt } from "./_reminder-delivery.js";

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("resolveAppBaseUrl", () => {
  it("defaults to https://ra7etbal.com when APP_BASE_URL is unset", () => {
    vi.stubEnv("APP_BASE_URL", "");
    expect(resolveAppBaseUrl()).toBe("https://ra7etbal.com");
  });

  it("adds a scheme when APP_BASE_URL is missing one", () => {
    vi.stubEnv("APP_BASE_URL", "ra7etbal.com");
    expect(resolveAppBaseUrl()).toBe("https://ra7etbal.com");
  });

  it("strips a trailing slash", () => {
    vi.stubEnv("APP_BASE_URL", "https://ra7etbal.com/");
    expect(resolveAppBaseUrl()).toBe("https://ra7etbal.com");
  });
});

// Regression: exact-time recurring reminder wake-ups. scheduleAutomationRunWakeup
// is the server-only helper imported directly by api/automations.js (after
// creation) and api/process-delegation-escalations.js (after a successful
// next_run_at advance) — never reached via HTTP, and never called from the
// browser (see the module header for why: no end-user JWT to verify in a
// server-to-server scheduling call).
describe("scheduleAutomationRunWakeup", () => {
  beforeEach(() => {
    vi.stubEnv("QSTASH_TOKEN", "qstash-token");
    vi.stubEnv("CRON_SECRET", "cron-secret");
  });

  it("publishes with the correct Upstash-Not-Before timestamp (nextRunAt as unix seconds)", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ messageId: "msg-1" }));
    vi.stubGlobal("fetch", fetchMock);

    await scheduleAutomationRunWakeup({
      appBaseUrl: "https://ra7etbal.com",
      automationId: "automation-1",
      nextRunAt: "2026-07-12T04:29:00.000Z",
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/publish/https://ra7etbal.com/api/process-delegation-escalations");
    expect(init.headers["Upstash-Not-Before"]).toBe(
      String(Math.ceil(new Date("2026-07-12T04:29:00.000Z").getTime() / 1000)),
    );
  });

  // CodeRabbit finding: flooring a fractional-second nextRunAt truncates it
  // to a value up to 999ms BEFORE the automation is actually due. Since
  // runAutomationsCore's own query is next_run_at<=now(), a wake-up that
  // fires even 1ms early finds nothing due yet and silently no-ops — the
  // exact cycle it was meant to catch falls through to the 10-minute cron
  // fallback instead of firing exactly, defeating the point of scheduling it
  // at all. Rounding up (never down) means it fires at or slightly after the
  // true due time, never before.
  it("rounds a fractional-second nextRunAt UP, never down — a wake-up must never fire before the automation is due", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ messageId: "msg-1" }));
    vi.stubGlobal("fetch", fetchMock);

    const fractionalNextRunAt = "2026-07-12T04:29:00.500Z";
    await scheduleAutomationRunWakeup({
      appBaseUrl: "https://ra7etbal.com",
      automationId: "automation-1",
      nextRunAt: fractionalNextRunAt,
    });

    const [, init] = fetchMock.mock.calls[0];
    const expectedNotBefore = Math.ceil(new Date(fractionalNextRunAt).getTime() / 1000);
    expect(init.headers["Upstash-Not-Before"]).toBe(String(expectedNotBefore));
    // A floored value would be one second earlier — explicitly rule it out.
    const flooredNotBefore = Math.floor(new Date(fractionalNextRunAt).getTime() / 1000);
    expect(init.headers["Upstash-Not-Before"]).not.toBe(String(flooredNotBefore));
  });

  it("uses the deterministic deduplication ID format automation-run-{automationId}-{nextRunAt epoch ms}, with no colons (QStash rejects them)", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ messageId: "msg-1" }));
    vi.stubGlobal("fetch", fetchMock);

    const nextRunAt = "2026-07-12T04:29:00.000Z";
    await scheduleAutomationRunWakeup({
      appBaseUrl: "https://ra7etbal.com",
      automationId: "automation-1",
      nextRunAt,
    });

    const [, init] = fetchMock.mock.calls[0];
    const expectedEpochMs = new Date(nextRunAt).getTime();
    expect(init.headers["Upstash-Deduplication-Id"]).toBe(
      `automation-run-automation-1-${expectedEpochMs}`,
    );
    expect(init.headers["Upstash-Deduplication-Id"]).not.toContain(":");
  });

  it("produces the same dedup ID for repeated calls with the same automationId/nextRunAt (duplicate publish is a safe no-op)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ messageId: "msg-1" }))
      .mockResolvedValueOnce(jsonResponse({ messageId: "msg-2" }));
    vi.stubGlobal("fetch", fetchMock);

    const args = {
      appBaseUrl: "https://ra7etbal.com",
      automationId: "automation-1",
      nextRunAt: "2026-07-12T04:29:00.000Z",
    };
    await scheduleAutomationRunWakeup(args);
    await scheduleAutomationRunWakeup(args);

    const firstDedupId = fetchMock.mock.calls[0][1].headers["Upstash-Deduplication-Id"];
    const secondDedupId = fetchMock.mock.calls[1][1].headers["Upstash-Deduplication-Id"];
    expect(firstDedupId).toBe(secondDedupId);
  });

  it("targets /api/process-delegation-escalations with a payload the handler never trusts for selection", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ messageId: "msg-1" }));
    vi.stubGlobal("fetch", fetchMock);

    await scheduleAutomationRunWakeup({
      appBaseUrl: "https://ra7etbal.com",
      automationId: "automation-1",
      nextRunAt: "2026-07-12T04:29:00.000Z",
    });

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ action: "run-automations" });
  });

  it("forwards CRON_SECRET via Upstash-Forward-Authorization, matching how the existing escalation wake-ups authenticate", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ messageId: "msg-1" }));
    vi.stubGlobal("fetch", fetchMock);

    await scheduleAutomationRunWakeup({
      appBaseUrl: "https://ra7etbal.com",
      automationId: "automation-1",
      nextRunAt: "2026-07-12T04:29:00.000Z",
    });

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers["Upstash-Forward-Authorization"]).toBe("Bearer cron-secret");
    expect(init.headers.Authorization).toBe("Bearer qstash-token");
  });

  it("throws (never silently no-ops) when QSTASH_TOKEN is not configured, without calling fetch", async () => {
    vi.unstubAllEnvs();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      scheduleAutomationRunWakeup({
        appBaseUrl: "https://ra7etbal.com",
        automationId: "automation-1",
        nextRunAt: "2026-07-12T04:29:00.000Z",
      }),
    ).rejects.toThrow(/QSTASH_TOKEN/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // CodeRabbit finding: without this warning, a missing CRON_SECRET produces
  // malformed forwarded auth (Bearer undefined) silently — the publish
  // itself still succeeds (QStash accepts it regardless of the forwarded
  // header's contents), so the auth failure only surfaces later, invisibly,
  // when the wake-up actually fires. Matches the existing warning already
  // present in the schedule-escalation HTTP handler.
  it("warns (but still publishes) when CRON_SECRET is not configured", async () => {
    vi.stubEnv("CRON_SECRET", "");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ messageId: "msg-1" }));
    vi.stubGlobal("fetch", fetchMock);

    await scheduleAutomationRunWakeup({
      appBaseUrl: "https://ra7etbal.com",
      automationId: "automation-1",
      nextRunAt: "2026-07-12T04:29:00.000Z",
    });

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("CRON_SECRET not set"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws on an invalid nextRunAt, without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      scheduleAutomationRunWakeup({
        appBaseUrl: "https://ra7etbal.com",
        automationId: "automation-1",
        nextRunAt: "not-a-date",
      }),
    ).rejects.toThrow(/Invalid nextRunAt/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // CodeRabbit finding: this call forwards CRON_SECRET via
  // Upstash-Forward-Authorization to appBaseUrl. process-delegation-
  // escalations.js passes raw process.env.APP_BASE_URL through, so a
  // misconfigured http:// deployment would send that secret in plaintext.
  // Enforced specifically here (not in the shared resolveAppBaseUrl(), which
  // stays unchanged) so the three pre-existing actions on the default HTTP
  // handler — none of which forward CRON_SECRET — keep their exact current
  // behavior.
  it("refuses to publish (and never forwards CRON_SECRET) when appBaseUrl is not https://, without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      scheduleAutomationRunWakeup({
        appBaseUrl: "http://ra7etbal.com",
        automationId: "automation-1",
        nextRunAt: "2026-07-12T04:29:00.000Z",
      }),
    ).rejects.toThrow(/https:\/\//);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("propagates a QStash-side publish failure as a thrown error", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ error: "boom" }, 500));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      scheduleAutomationRunWakeup({
        appBaseUrl: "https://ra7etbal.com",
        automationId: "automation-1",
        nextRunAt: "2026-07-12T04:29:00.000Z",
      }),
    ).rejects.toThrow(/boom/);
  });
});

function mockReq({ method = "POST", body = {} } = {}) {
  return {
    method,
    body,
    headers: { authorization: "Bearer user-jwt" },
  };
}

function mockRes() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
}

// Protected behavior (item 9): a QStash scheduling failure must never be
// reported or persisted as a success. The default HTTP handler's 'schedule'
// action is the boundary between task creation (already succeeded by the
// time this is called — see src/lib/reminders.ts's fire-and-forget call) and
// QStash publish (best-effort, with pg_cron as the safety net). If the
// publish fails, the handler must return success:false AND must never write
// a qstash_message_id to the task row — persisting an ID for a publish that
// never actually happened would make the task row itself lie about being
// scheduled.
describe("qstash-reminder default handler — 'schedule' action (item 9 lock)", () => {
  beforeEach(() => {
    vi.stubEnv("SUPABASE_URL", "https://supabase.test");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role");
    vi.stubEnv("QSTASH_TOKEN", "qstash-token");
    vi.stubEnv("CRON_SECRET", "cron-secret");
    vi.stubEnv("APP_BASE_URL", "https://ra7etbal.test");
  });

  function queueAuthAndOwnership(fetchMock, { userId = "user-1", taskUserId = "user-1" } = {}) {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: userId })) // auth verify (GET /auth/v1/user)
      .mockResolvedValueOnce(
        jsonResponse([
          { id: "task-1", user_id: taskUserId, type: "reminder", status: "pending", qstash_message_id: null },
        ]),
      ); // ownership lookup (GET /rest/v1/tasks)
  }

  it("returns success:true and persists the QStash message ID when the publish succeeds", async () => {
    const fetchMock = vi.fn();
    queueAuthAndOwnership(fetchMock);
    fetchMock.mockResolvedValueOnce(jsonResponse({ messageId: "msg-ok" })); // QStash publish
    fetchMock.mockResolvedValueOnce(jsonResponse({})); // Supabase PATCH saving the message id
    vi.stubGlobal("fetch", fetchMock);
    const res = mockRes();

    await handler(
      mockReq({ body: { action: "schedule", taskId: "task-1", dueAt: "2026-07-27T09:00:00.000Z" } }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({ success: true, action: "scheduled", messageId: "msg-ok" });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const [patchUrl, patchInit] = fetchMock.mock.calls[3];
    expect(String(patchUrl)).toContain("/rest/v1/tasks?id=eq.task-1");
    expect(patchInit.method).toBe("PATCH");
    expect(JSON.parse(patchInit.body)).toEqual({
      qstash_message_id: "msg-ok",
      reminder_delivery_status: "scheduled",
      reminder_delivery_error: null,
    });
  });

  it("returns success:false and NEVER persists a message ID when the QStash publish fails", async () => {
    const fetchMock = vi.fn();
    queueAuthAndOwnership(fetchMock);
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "QStash is down" }, 500)); // QStash publish fails
    vi.stubGlobal("fetch", fetchMock);
    const res = mockRes();

    await handler(
      mockReq({ body: { action: "schedule", taskId: "task-1", dueAt: "2026-07-27T09:00:00.000Z" } }),
      res,
    );

    expect(res.statusCode).toBe(500);
    expect(res.payload.success).toBe(false);
    expect(res.payload.error).toMatch(/QStash is down/);
    expect(res.payload.action).toBeUndefined();
    expect(res.payload.messageId).toBeUndefined();
    // Exactly 3 calls: auth verify, ownership lookup, the failed QStash
    // publish attempt. A 4th call would be the Supabase PATCH that persists
    // qstash_message_id — it must never be reached on a failed publish.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("returns success:false and never persists a message ID when QStash responds OK but with no messageId in the body", async () => {
    const fetchMock = vi.fn();
    queueAuthAndOwnership(fetchMock);
    fetchMock.mockResolvedValueOnce(jsonResponse({})); // QStash 200 with an unexpected empty body
    vi.stubGlobal("fetch", fetchMock);
    const res = mockRes();

    await handler(
      mockReq({ body: { action: "schedule", taskId: "task-1", dueAt: "2026-07-27T09:00:00.000Z" } }),
      res,
    );

    expect(res.statusCode).toBe(500);
    expect(res.payload.success).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

// Owner completion push reliability — widened notification-receipt handler.
// Reminder-path tests here are the regression proof: identical inputs to
// what the already-deployed service worker sends today (no `kind` field)
// must behave exactly as before. Completion-path tests prove the new kind
// is validated against a real, independently-fetched DB fact (confirmed_at)
// with the same signed-receipt strength, not a weaker or trusting check.
describe("qstash-reminder 'notification-receipt' action — reminder vs. completion kind", () => {
  const CRON_SECRET = "cron-secret";

  beforeEach(() => {
    vi.stubEnv("SUPABASE_URL", "https://supabase.test");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role");
    vi.stubEnv("CRON_SECRET", CRON_SECRET);
  });

  function receiptBody({ kind, taskId = "task-1", userId = "user-1", subscriptionId = "sub-1", dueAt, stage, token }) {
    const fields = { taskId, userId, subscriptionId, dueAt };
    return {
      action: "notification-receipt",
      kind,
      taskId,
      subscriptionId,
      dueAt,
      stage,
      token: token ?? signReminderReceipt(fields, CRON_SECRET),
      swVersion: "test-sw",
    };
  }

  it("reminder receipt (no kind field, matching every already-deployed client): still validated by task.type==='reminder' && due_at, records the event", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: "task-1", user_id: "user-1", type: "reminder", due_at: "2026-08-12T09:00:00.000Z", confirmed_at: null }])) // task lookup
      .mockResolvedValueOnce(jsonResponse([{ id: "sub-1" }])) // subscription ownership
      .mockResolvedValueOnce(jsonResponse({}, 201)); // recordDeliveryEvent insert
    vi.stubGlobal("fetch", fetchMock);
    const res = mockRes();

    await handler(
      mockReq({
        body: receiptBody({ kind: undefined, dueAt: "2026-08-12T09:00:00.000Z", stage: "service_worker_received" }),
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({ success: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [, eventInit] = fetchMock.mock.calls[2];
    expect(JSON.parse(eventInit.body).metadata.kind).toBe("reminder");
  });

  it("reminder receipt: due_at mismatch is still rejected with 404 (unchanged)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: "task-1", user_id: "user-1", type: "reminder", due_at: "2026-08-12T09:00:00.000Z", confirmed_at: null }]));
    vi.stubGlobal("fetch", fetchMock);
    const res = mockRes();

    await handler(
      mockReq({
        body: receiptBody({ kind: undefined, dueAt: "2026-08-12T10:00:00.000Z", stage: "service_worker_received" }),
      }),
      res,
    );

    expect(res.statusCode).toBe(404);
    expect(res.payload.error).toBe("Reminder not found.");
  });

  it("reminder receipt: notification_clicked still auto-completes the task (unchanged)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: "task-1", user_id: "user-1", type: "reminder", due_at: "2026-08-12T09:00:00.000Z", confirmed_at: null }]))
      .mockResolvedValueOnce(jsonResponse([{ id: "sub-1" }]))
      .mockResolvedValueOnce(jsonResponse({}, 201))
      .mockResolvedValueOnce(jsonResponse({}, 200)); // the auto-complete PATCH
    vi.stubGlobal("fetch", fetchMock);
    const res = mockRes();

    await handler(
      mockReq({
        body: receiptBody({ kind: undefined, dueAt: "2026-08-12T09:00:00.000Z", stage: "notification_clicked" }),
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const [patchUrl, patchInit] = fetchMock.mock.calls[3];
    expect(String(patchUrl)).toContain("status=eq.pending");
    expect(JSON.parse(patchInit.body).confirmed_by).toBe("notification_click");
  });

  it("completion receipt: validated against confirmed_at (not due_at), any task type accepted, records the event with kind=completion", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: "task-1", user_id: "user-1", type: "delegation", due_at: null, confirmed_at: "2026-08-12T13:23:58.480Z" }]))
      .mockResolvedValueOnce(jsonResponse([{ id: "sub-1" }]))
      .mockResolvedValueOnce(jsonResponse({}, 201));
    vi.stubGlobal("fetch", fetchMock);
    const res = mockRes();

    await handler(
      mockReq({
        body: receiptBody({ kind: "completion", dueAt: "2026-08-12T13:23:58.480Z", stage: "service_worker_received" }),
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({ success: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [, eventInit] = fetchMock.mock.calls[2];
    expect(JSON.parse(eventInit.body).metadata.kind).toBe("completion");
  });

  it("completion receipt: confirmed_at mismatch is rejected with 404 — never trusts the client's claimed dueAt", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: "task-1", user_id: "user-1", type: "delegation", due_at: null, confirmed_at: "2026-08-12T13:23:58.480Z" }]));
    vi.stubGlobal("fetch", fetchMock);
    const res = mockRes();

    await handler(
      mockReq({
        body: receiptBody({ kind: "completion", dueAt: "2026-08-12T00:00:00.000Z", stage: "service_worker_received" }),
      }),
      res,
    );

    expect(res.statusCode).toBe(404);
    expect(res.payload.error).toBe("Completion event not found.");
  });

  it("completion receipt: tampered token fails closed with 401 — HMAC strength unchanged for the new kind", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: "task-1", user_id: "user-1", type: "delegation", due_at: null, confirmed_at: "2026-08-12T13:23:58.480Z" }]));
    vi.stubGlobal("fetch", fetchMock);
    const res = mockRes();

    await handler(
      mockReq({
        body: receiptBody({
          kind: "completion",
          dueAt: "2026-08-12T13:23:58.480Z",
          stage: "service_worker_received",
          token: "not-a-real-token",
        }),
      }),
      res,
    );

    expect(res.statusCode).toBe(401);
  });

  it("completion receipt: notification_clicked does NOT auto-complete the task — that semantic belongs only to reminders", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: "task-1", user_id: "user-1", type: "delegation", due_at: null, confirmed_at: "2026-08-12T13:23:58.480Z" }]))
      .mockResolvedValueOnce(jsonResponse([{ id: "sub-1" }]))
      .mockResolvedValueOnce(jsonResponse({}, 201));
    vi.stubGlobal("fetch", fetchMock);
    const res = mockRes();

    await handler(
      mockReq({
        body: receiptBody({ kind: "completion", dueAt: "2026-08-12T13:23:58.480Z", stage: "notification_clicked" }),
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    // Exactly 3 calls: task lookup, subscription ownership, event record —
    // no 4th PATCH attempting to re-complete an already-done task.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("duplicate receipts stay idempotent through the existing event_key mechanism — same stage+subscription always produces the same key", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: "task-1", user_id: "user-1", type: "delegation", due_at: null, confirmed_at: "2026-08-12T13:23:58.480Z" }]))
      .mockResolvedValueOnce(jsonResponse([{ id: "sub-1" }]))
      .mockResolvedValueOnce(jsonResponse({}, 201))
      .mockResolvedValueOnce(jsonResponse([{ id: "task-1", user_id: "user-1", type: "delegation", due_at: null, confirmed_at: "2026-08-12T13:23:58.480Z" }]))
      .mockResolvedValueOnce(jsonResponse([{ id: "sub-1" }]))
      .mockResolvedValueOnce(jsonResponse({}, 201));
    vi.stubGlobal("fetch", fetchMock);

    const body = receiptBody({ kind: "completion", dueAt: "2026-08-12T13:23:58.480Z", stage: "service_worker_received" });

    const res1 = mockRes();
    await handler(mockReq({ body }), res1);
    const res2 = mockRes();
    await handler(mockReq({ body }), res2);

    expect(res1.statusCode).toBe(200);
    expect(res2.statusCode).toBe(200);
    const firstEventKey = JSON.parse(fetchMock.mock.calls[2][1].body).event_key;
    const secondEventKey = JSON.parse(fetchMock.mock.calls[5][1].body).event_key;
    expect(firstEventKey).toBe(secondEventKey);
  });
});
