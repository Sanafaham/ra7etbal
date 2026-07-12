import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAppBaseUrl, scheduleAutomationRunWakeup } from "./qstash-reminder.js";

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
      String(Math.floor(new Date("2026-07-12T04:29:00.000Z").getTime() / 1000)),
    );
  });

  it("uses the deterministic deduplication ID format automation-run-{automationId}-{nextRunAt}", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ messageId: "msg-1" }));
    vi.stubGlobal("fetch", fetchMock);

    await scheduleAutomationRunWakeup({
      appBaseUrl: "https://ra7etbal.com",
      automationId: "automation-1",
      nextRunAt: "2026-07-12T04:29:00.000Z",
    });

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers["Upstash-Deduplication-Id"]).toBe(
      "automation-run-automation-1-2026-07-12T04:29:00.000Z",
    );
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
