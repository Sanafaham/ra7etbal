import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(__dirname, "ElevenLabsAgentWidget.tsx"), "utf8");
const CALENDAR_SOURCE = readFileSync(join(__dirname, "../../lib/calendar.ts"), "utf8");
const API_SOURCE = readFileSync(join(__dirname, "../../../api/google-calendar.js"), "utf8");

function blockBetween(startNeedle: string, endNeedle: string): string {
  const start = SOURCE.indexOf(startNeedle);
  const end = SOURCE.indexOf(endNeedle, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

describe("ElevenLabsAgentWidget — dedicated historical calendar tool", () => {
  it("registers search_calendar_history separately from get_calendar_events", () => {
    expect(SOURCE).toContain("search_calendar_history:");
    expect(SOURCE).toContain('guardCurrentToolInvocation("search_calendar_history")');
    expect(SOURCE).toContain('runDirectToolWithDiagnostic("search_calendar_history"');
  });

  it("never reads or falls back to the future planning cache", () => {
    const block = blockBetween(
      "const searchCalendarHistoryTool = useCallback(",
      "// ------------------------------------------------------------------\n  // Client tool: create_calendar_event",
    );
    expect(block).toContain("searchCalendarHistory({");
    expect(block).not.toContain("planningCalendarEventsRef");
    expect(block).not.toContain("getCalendarEvents(");
    expect(block).not.toContain("filterCalendarEventsByRange");
  });

  it("prevents duplicate network calls for the same search while allowing a deliberate wider key", () => {
    const block = blockBetween(
      "const searchCalendarHistoryTool = useCallback(",
      "// ------------------------------------------------------------------\n  // Client tool: create_calendar_event",
    );
    expect(block).toContain("historicalSearchCacheRef.current.get(cacheKey)");
    expect(block).toContain("if (cachedResult) return cachedResult");
    expect(block).toContain("historicalSearchCacheRef.current.set(cacheKey, response)");
    expect(block).toContain("start_date: startDate");
    expect(block).toContain("end_date: endDate");
  });

  it("keeps the existing upcoming tool implementation and registration intact", () => {
    expect(SOURCE).toContain("const getCalendarEvents = useCallback(");
    expect(SOURCE).toContain("filterCalendarEventsByRange(cached, safeRange)");
    expect(SOURCE).toContain("get_calendar_events:");
  });

  it("forces all historical retrieval through the authenticated Ra7etBal route", () => {
    expect(CALENDAR_SOURCE).toContain("range: \"historical\"");
    expect(CALENDAR_SOURCE).toContain("Authorization: `Bearer ${jwt}`");
    expect(CALENDAR_SOURCE).not.toContain("googleapis.com/calendar/v3");
    expect(API_SOURCE).toContain('range === "historical"');
    expect(API_SOURCE).toContain("www.googleapis.com/calendar/v3/calendars/primary/events");
  });

  it("preserves existing calendar create, update, and delete routes", () => {
    expect(API_SOURCE).toContain('req.method === "POST"');
    expect(API_SOURCE).toContain('req.method === "PATCH"');
    expect(API_SOURCE).toContain('req.method === "DELETE"');
    expect(SOURCE).toContain("create_calendar_event:");
    expect(SOURCE).toContain("update_calendar_event:");
    expect(SOURCE).toContain("delete_calendar_event:");
  });
});
