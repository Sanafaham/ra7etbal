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

import { isOwnerOnlyAutomation, resolveStateConfig } from "./Routines";

describe("owner-only automation UI status", () => {
  it("identifies personal reminder/action automations", () => {
    expect(isOwnerOnlyAutomation({ assignee_id: null, automation_type: "delegation" })).toBe(true);
    expect(isOwnerOnlyAutomation({ assignee_id: "person-1", automation_type: "delegation" })).toBe(false);
    expect(isOwnerOnlyAutomation({ assignee_id: null, automation_type: "message" })).toBe(false);
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
