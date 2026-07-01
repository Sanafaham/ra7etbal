import { describe, expect, it } from "vitest";
import {
  filterSupportedOperationalAutomations,
  isSupportedOperationalAutomation,
  isUnsupportedRecurringWhatsappAutomation,
} from "./automation-support";

describe("automation support filters", () => {
  it("marks recurring delegated and message automations as unsupported legacy WhatsApp", () => {
    expect(isUnsupportedRecurringWhatsappAutomation({
      automation_type: "delegation",
      assignee_id: "person-1",
      cadence_type: "weekly",
    })).toBe(true);
    expect(isUnsupportedRecurringWhatsappAutomation({
      automation_type: "message",
      assignee_id: "person-1",
      cadence_type: "daily",
    })).toBe(true);
  });

  it("keeps owner-only and one-time automations operational", () => {
    expect(isSupportedOperationalAutomation({
      automation_type: "delegation",
      assignee_id: null,
      cadence_type: "weekly",
    })).toBe(true);
    expect(isSupportedOperationalAutomation({
      automation_type: "delegation",
      assignee_id: "person-1",
      cadence_type: "once",
    })).toBe(true);
  });

  it("filters unsupported legacy automations out of operational state", () => {
    const rows = [
      { id: "legacy-delegation", automation_type: "delegation", assignee_id: "person-1", cadence_type: "weekly" },
      { id: "legacy-message", automation_type: "message", assignee_id: "person-2", cadence_type: "daily" },
      { id: "owner-reminder", automation_type: "delegation", assignee_id: null, cadence_type: "weekly" },
      { id: "one-time", automation_type: "delegation", assignee_id: "person-3", cadence_type: "once" },
    ];

    expect(filterSupportedOperationalAutomations(rows).map((row) => row.id)).toEqual([
      "owner-reminder",
      "one-time",
    ]);
  });
});
