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
