import { describe, expect, it, vi } from "vitest";

vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: null }),
}));

vi.mock("../lib/routines", () => ({
  createRoutine: vi.fn(),
  deleteRoutine: vi.fn(),
  listRoutines: vi.fn(),
  toggleRoutine: vi.fn(),
}));

vi.mock("../lib/supabase", () => ({
  supabase: {},
}));

vi.mock("../stores/people", () => ({
  usePeopleStore: () => ({
    peopleItems: [],
    peopleStatus: "idle",
    loadPeople: vi.fn(),
    peopleLoadedFor: null,
  }),
}));

import {
  isOwnerOnlyAutomation,
  isUnsupportedRecurringWhatsappAutomation,
  LEGACY_ROUTINE_MANUAL_CREATION_ENABLED,
  resolveAutomationAssigneeName,
  resolveStateConfig,
} from "./Routines";

describe("owner-only automation UI status", () => {
  it("keeps manual legacy routine creation disabled", () => {
    expect(LEGACY_ROUTINE_MANUAL_CREATION_ENABLED).toBe(false);
  });

  it("identifies personal reminder/action automations", () => {
    expect(isOwnerOnlyAutomation({ assignee_id: null, automation_type: "delegation" })).toBe(true);
    expect(isOwnerOnlyAutomation({ assignee_id: "person-1", automation_type: "delegation" })).toBe(false);
    expect(isOwnerOnlyAutomation({ assignee_id: null, automation_type: "message" })).toBe(false);
  });

  it("identifies unsupported recurring WhatsApp automation cards", () => {
    expect(isUnsupportedRecurringWhatsappAutomation({
      assignee_id: "person-1",
      automation_type: "delegation",
      cadence_type: "weekly",
    })).toBe(true);
    expect(isUnsupportedRecurringWhatsappAutomation({
      assignee_id: "person-1",
      automation_type: "message",
      cadence_type: "daily",
    })).toBe(true);
    expect(isUnsupportedRecurringWhatsappAutomation({
      assignee_id: null,
      automation_type: "delegation",
      cadence_type: "weekly",
    })).toBe(false);
    expect(isUnsupportedRecurringWhatsappAutomation({
      assignee_id: "person-1",
      automation_type: "delegation",
      cadence_type: "once",
    })).toBe(false);
  });

  it("displays the person named by the automation text instead of a conflicting joined assignee", () => {
    const name = resolveAutomationAssigneeName(
      {
        title: "Every Fri: Ask Grace at 10:00 AM to send the flower inventory",
        instruction: "Ask Grace at 10:00 AM to send the flower inventory.",
        assignee_id: "ghulam-id",
        people: { name: "Ghulam" },
      },
      [{ name: "Grace" }, { name: "Ghulam" }],
    );

    expect(name).toBe("Grace");
  });

  it("still displays the automation assignee when the text has no conflicting person", () => {
    const name = resolveAutomationAssigneeName(
      {
        title: "Weekly Flower Inventory",
        instruction: "Send the flower inventory.",
        assignee_id: "grace-id",
        people: { name: "Grace" },
      },
      [{ name: "Grace" }, { name: "Ghulam" }],
    );

    expect(name).toBe("Grace");
  });

  it("shows Reminder created for sent owner-only automations", () => {
    const state = resolveStateConfig("sent", "delegation", true);

    expect(state.label).toBe("Reminder created");
    expect(state.label).not.toBe("Waiting for confirmation");
  });

  it("keeps delegated automation sent state waiting for confirmation", () => {
    const state = resolveStateConfig("sent", "delegation", false);

    expect(state.label).toBe("Waiting for confirmation");
  });
});
