import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler from "./automations.js";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = {
    ...ORIGINAL_ENV,
    SUPABASE_URL: "https://supabase.test",
    SUPABASE_SERVICE_ROLE_KEY: "service-role",
    SUPABASE_ANON_KEY: "anon-key",
  };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mockReq({ method = "DELETE", query = {}, body = {} } = {}) {
  return {
    method,
    query,
    body,
    headers: {
      authorization: "Bearer user-jwt",
    },
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

function jsonResponse(payload, ok = true, status = ok ? 200 : 500) {
  return {
    ok,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

describe("api/automations POST", () => {
  it("creates an owner-only automation on a valid request", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: "user-1" }))
      .mockResolvedValueOnce(jsonResponse([{ id: "automation-1" }]));
    vi.stubGlobal("fetch", fetchMock);
    const res = mockRes();

    await handler(
      mockReq({
        method: "POST",
        body: {
          title: "Daily: Check the Meta template approval",
          instruction: "Check the Meta template approval.",
          cadence_type: "daily",
          cadence_value: { time: "20:30" },
          next_run_at: "2026-07-12T17:30:00.000Z",
          timezone: "Europe/Istanbul",
          created_by: "carson",
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(201);
    // exactWakeupScheduled is false here because QSTASH_TOKEN is not stubbed
    // in this test (scheduleAutomationRunWakeup throws before any fetch) —
    // see the dedicated "exact-time wake-up scheduling" describe block below
    // for coverage of the actual scheduling behavior.
    expect(res.payload).toEqual({ automation: { id: "automation-1" }, exactWakeupScheduled: false });
    expect(fetchMock.mock.calls[1][0]).toContain("/rest/v1/automations");
    const insertedRow = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(insertedRow).toMatchObject({
      user_id: "user-1",
      assignee_id: null,
      cadence_type: "daily",
      automation_type: "delegation",
      status: "active",
    });
  });

  // Regression (Part D, API diagnostics): a live production 400 was
  // undiagnosable because handlePost never logged why a request was
  // rejected. Every rejection branch must now log privacy-safe structural
  // signals only — never the raw title/instruction text or request body.
  describe("rejection diagnostics", () => {
    it("logs a privacy-safe rejection reason when title is missing, without logging any request body content", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse({ id: "user-1" })));
      const res = mockRes();

      await handler(
        mockReq({
          method: "POST",
          body: {
            instruction: "This is the private reminder content nobody should log verbatim.",
            cadence_type: "daily",
            next_run_at: "2026-07-12T17:30:00.000Z",
          },
        }),
        res,
      );

      expect(res.statusCode).toBe(400);
      expect(res.payload).toEqual({ error: "title is required." });

      const rejectionLog = warnSpy.mock.calls.find(([label]) => label === "[automations POST] rejected");
      expect(rejectionLog).toBeTruthy();
      const [, details] = rejectionLog;
      expect(details).toMatchObject({
        reasonCode: "title_missing",
        ownerId: "user-1",
        cadenceType: "daily",
        hasAssigneeId: false,
        hasTitle: false,
        hasInstruction: true,
        hasNextRunAt: true,
      });
      // Never log the actual reminder content or raw body.
      const serialized = JSON.stringify(warnSpy.mock.calls);
      expect(serialized).not.toContain("private reminder content");
    });

    it("logs unsupported_recurring_whatsapp when a recurring request carries an assignee_id, with hasAssigneeId true", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse({ id: "user-1" })));
      const res = mockRes();

      await handler(
        mockReq({
          method: "POST",
          body: {
            title: "Daily check",
            instruction: "Check something.",
            cadence_type: "daily",
            next_run_at: "2026-07-12T17:30:00.000Z",
            assignee_id: "person-123",
          },
        }),
        res,
      );

      expect(res.statusCode).toBe(400);
      expect(res.payload).toEqual({
        error: "Recurring WhatsApp automations are currently disabled. Use one-time delegations or owner reminders instead.",
      });

      const rejectionLog = warnSpy.mock.calls.find(([label]) => label === "[automations POST] rejected");
      expect(rejectionLog).toBeTruthy();
      expect(rejectionLog[1]).toMatchObject({
        reasonCode: "unsupported_recurring_whatsapp",
        ownerId: "user-1",
        hasAssigneeId: true,
        cadenceType: "daily",
      });
    });

    it("does not log a rejection when the request is valid", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ id: "user-1" }))
        .mockResolvedValueOnce(jsonResponse([{ id: "automation-1" }]));
      vi.stubGlobal("fetch", fetchMock);
      const res = mockRes();

      await handler(
        mockReq({
          method: "POST",
          body: {
            title: "Daily check",
            instruction: "Check something.",
            cadence_type: "daily",
            next_run_at: "2026-07-12T17:30:00.000Z",
          },
        }),
        res,
      );

      expect(res.statusCode).toBe(201);
      expect(warnSpy.mock.calls.some(([label]) => label === "[automations POST] rejected")).toBe(false);
    });

    // CodeRabbit finding: automation_type/cadence_type are client-controlled
    // strings and must never be copied into logs verbatim — only logged when
    // they match a known allowlisted value.
    it("never logs an untrusted automation_type/cadence_type value verbatim", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse({ id: "user-1" })));
      const res = mockRes();

      await handler(
        mockReq({
          method: "POST",
          body: {
            title: "Daily check",
            instruction: "Check something.",
            cadence_type: "<script>alert(1)</script>",
            next_run_at: "2026-07-12T17:30:00.000Z",
            automation_type: "not-a-real-type",
          },
        }),
        res,
      );

      expect(res.statusCode).toBe(400);
      const rejectionLog = warnSpy.mock.calls.find(([label]) => label === "[automations POST] rejected");
      expect(rejectionLog).toBeTruthy();
      expect(rejectionLog[1]).toMatchObject({ cadenceType: null, automationType: null });
      const serialized = JSON.stringify(warnSpy.mock.calls);
      expect(serialized).not.toContain("<script>");
      expect(serialized).not.toContain("not-a-real-type");
    });
  });

  // Regression: exact-time recurring reminder wake-ups. IMPORTANT ARCHITECTURE
  // CORRECTION — the first wake-up must be scheduled server-side, right here
  // in handlePost, never by the browser after the fact. A closed app,
  // interrupted connection, or client crash right after the 201 response must
  // not leave a persisted automation without its exact wake-up.
  describe("exact-time wake-up scheduling", () => {
    beforeEach(() => {
      process.env.QSTASH_TOKEN = "qstash-token";
      process.env.CRON_SECRET = "cron-secret";
      process.env.APP_BASE_URL = "https://ra7etbal.com";
    });

    function qstashOkResponse() {
      return {
        ok: true,
        status: 200,
        json: async () => ({ messageId: "msg-1" }),
        text: async () => JSON.stringify({ messageId: "msg-1" }),
      };
    }

    function qstashFailResponse() {
      return {
        ok: false,
        status: 500,
        json: async () => ({ error: "QStash unavailable" }),
        text: async () => JSON.stringify({ error: "QStash unavailable" }),
      };
    }

    it("publishes the first wake-up only after the automation is confirmed persisted, and reports exactWakeupScheduled: true", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ id: "user-1" }))
        .mockResolvedValueOnce(jsonResponse([{ id: "automation-1", next_run_at: "2026-07-12T04:29:00.000Z" }]))
        .mockResolvedValueOnce(qstashOkResponse());
      vi.stubGlobal("fetch", fetchMock);
      const res = mockRes();

      await handler(
        mockReq({
          method: "POST",
          body: {
            title: "Daily mail check",
            instruction: "Check your mail for Google",
            cadence_type: "daily",
            cadence_value: { time: "04:29" },
            next_run_at: "2026-07-12T04:29:00.000Z",
            timezone: "Europe/Istanbul",
            created_by: "carson",
          },
        }),
        res,
      );

      expect(res.statusCode).toBe(201);
      expect(res.payload).toEqual({
        automation: { id: "automation-1", next_run_at: "2026-07-12T04:29:00.000Z" },
        exactWakeupScheduled: true,
      });

      // Wake-up publish is the third fetch — strictly after persistence (the
      // second call, the insert) — never before it.
      expect(fetchMock).toHaveBeenCalledTimes(3);
      const [qstashUrl, qstashInit] = fetchMock.mock.calls[2];
      expect(String(qstashUrl)).toContain("/api/process-delegation-escalations");
      expect(qstashInit.headers["Upstash-Deduplication-Id"]).toBe(
        "automation-run-automation-1-2026-07-12T04:29:00.000Z",
      );
    });

    it("does not block persistence when wake-up publishing fails — automation is still created, exactWakeupScheduled: false", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ id: "user-1" }))
        .mockResolvedValueOnce(jsonResponse([{ id: "automation-1", next_run_at: "2026-07-12T04:29:00.000Z" }]))
        .mockResolvedValueOnce(qstashFailResponse());
      vi.stubGlobal("fetch", fetchMock);
      const res = mockRes();

      await handler(
        mockReq({
          method: "POST",
          body: {
            title: "Daily mail check",
            instruction: "Check your mail for Google",
            cadence_type: "daily",
            cadence_value: { time: "04:29" },
            next_run_at: "2026-07-12T04:29:00.000Z",
          },
        }),
        res,
      );

      expect(res.statusCode).toBe(201);
      expect(res.payload).toEqual({
        automation: { id: "automation-1", next_run_at: "2026-07-12T04:29:00.000Z" },
        exactWakeupScheduled: false,
      });
    });

    it("logs a wake-up publish failure truthfully, without claiming exact scheduling succeeded", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ id: "user-1" }))
        .mockResolvedValueOnce(jsonResponse([{ id: "automation-1", next_run_at: "2026-07-12T04:29:00.000Z" }]))
        .mockResolvedValueOnce(qstashFailResponse());
      vi.stubGlobal("fetch", fetchMock);
      const res = mockRes();

      await handler(
        mockReq({
          method: "POST",
          body: {
            title: "Daily mail check",
            instruction: "Check your mail for Google",
            cadence_type: "daily",
            cadence_value: { time: "04:29" },
            next_run_at: "2026-07-12T04:29:00.000Z",
          },
        }),
        res,
      );

      const failureLog = errorSpy.mock.calls.find(
        ([label]) => label === "[automations POST] exact wake-up scheduling failed — cron fallback active",
      );
      expect(failureLog).toBeTruthy();
      expect(failureLog[1]).toMatchObject({ automationId: "automation-1" });
      expect(res.payload.exactWakeupScheduled).toBe(false);
    });

    it("schedules the wake-up for an owner-only recurring automation (assignee_id null)", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ id: "user-1" }))
        .mockResolvedValueOnce(jsonResponse([{ id: "automation-1", next_run_at: "2026-07-12T04:29:00.000Z" }]))
        .mockResolvedValueOnce(qstashOkResponse());
      vi.stubGlobal("fetch", fetchMock);
      const res = mockRes();

      await handler(
        mockReq({
          method: "POST",
          body: {
            title: "Daily mail check",
            instruction: "Check your mail for Google",
            cadence_type: "daily",
            cadence_value: { time: "04:29" },
            next_run_at: "2026-07-12T04:29:00.000Z",
          },
        }),
        res,
      );

      const insertedRow = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(insertedRow.assignee_id).toBeNull();
      expect(res.payload.exactWakeupScheduled).toBe(true);
    });

    it("returns 500 without attempting to schedule a wake-up when the insert response does not confirm an automation id", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ id: "user-1" }))
        .mockResolvedValueOnce(jsonResponse([]));
      vi.stubGlobal("fetch", fetchMock);
      const res = mockRes();

      await handler(
        mockReq({
          method: "POST",
          body: {
            title: "Daily mail check",
            instruction: "Check your mail for Google",
            cadence_type: "daily",
            cadence_value: { time: "04:29" },
            next_run_at: "2026-07-12T04:29:00.000Z",
          },
        }),
        res,
      );

      expect(res.statusCode).toBe(500);
      expect(res.payload).toEqual({ error: "Automation was not confirmed as saved." });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });
});

describe("api/automations DELETE", () => {
  it("deletes an owned unsupported legacy automation and its runs", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: "user-1" }))
      .mockResolvedValueOnce(jsonResponse([{ id: "automation-1" }]))
      .mockResolvedValueOnce(jsonResponse(null))
      .mockResolvedValueOnce(jsonResponse(null));
    vi.stubGlobal("fetch", fetchMock);
    const res = mockRes();

    await handler(mockReq({ query: { id: "automation-1" } }), res);

    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({ ok: true, deleted: true, id: "automation-1" });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[1][0]).toContain("/rest/v1/automations");
    expect(fetchMock.mock.calls[1][0]).toContain("id=eq.automation-1");
    expect(fetchMock.mock.calls[1][0]).toContain("user_id=eq.user-1");
    expect(fetchMock.mock.calls[2][0]).toContain("/rest/v1/automation_runs");
    expect(fetchMock.mock.calls[2][1]).toMatchObject({
      method: "DELETE",
      headers: expect.objectContaining({ Prefer: "return=minimal" }),
    });
    expect(fetchMock.mock.calls[3][0]).toContain("/rest/v1/automations");
    expect(fetchMock.mock.calls[3][1]).toMatchObject({
      method: "DELETE",
      headers: expect.objectContaining({ Prefer: "return=minimal" }),
    });
    expect(fetchMock.mock.calls[2][1].headers.Authorization).toBe("Bearer service-role");
    expect(fetchMock.mock.calls[3][1].headers.Authorization).toBe("Bearer service-role");
  });

  it("rejects delete without an id", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse({ id: "user-1" })));
    const res = mockRes();

    await handler(mockReq(), res);

    expect(res.statusCode).toBe(400);
    expect(res.payload).toEqual({ error: "id is required." });
  });

  it("does not delete another user's automation", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: "user-1" }))
      .mockResolvedValueOnce(jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    const res = mockRes();

    await handler(mockReq({ query: { id: "missing" } }), res);

    expect(res.statusCode).toBe(404);
    expect(res.payload).toEqual({ error: "Automation not found." });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
