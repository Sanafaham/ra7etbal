import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";

const routinesMocks = vi.hoisted(() => ({
  createRoutine: vi.fn(async (input: any) => ({
    id: "routine-1",
    user_id: "user-1",
    ...input,
  })),
}));

const supabaseMocks = vi.hoisted(() => ({
  getSession: vi.fn(async () => ({
    data: { session: { access_token: "jwt-1" } },
  })),
}));

vi.mock("./routines", () => ({
  createRoutine: routinesMocks.createRoutine,
  LEGACY_ROUTINE_CREATION_FROZEN_MESSAGE:
    "New recurring work now lives in Automations. Existing routines still work here.",
}));

vi.mock("./supabase", () => ({
  supabase: {
    auth: {
      getSession: supabaseMocks.getSession,
    },
  },
}));

import {
  buildVoiceAutomationInput,
  detectAllRecurringSchedules,
  findPersonInInstruction,
  resolveRecurringAutomationPerson,
  createReminderRoutineFromInstruction,
  createVoiceRoutine,
} from "./routine-detection";
import type { Person } from "../types/person";

const CHRISTOPHER: Person = {
  id: "p1",
  name: "Christopher",
  role: "Friend",
  is_family: false,
  relationship: null,
} as unknown as Person;

const GRACE: Person = {
  id: "p2",
  name: "Grace",
  role: "Friend",
  is_family: false,
  relationship: null,
} as unknown as Person;

beforeEach(() => {
  routinesMocks.createRoutine.mockClear();
  supabaseMocks.getSession.mockClear();
  supabaseMocks.getSession.mockResolvedValue({
    data: { session: { access_token: "jwt-1" } },
  });
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    json: async () => ({ automation: { id: "automation-1", title: "Daily: Take my medication." } }),
  })));
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-28T05:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("findPersonInInstruction — self vs third-party detection", () => {
  it("finds no person for self-directed reminders", () => {
    expect(findPersonInInstruction("Remind me every day to take my medication.", [CHRISTOPHER, GRACE])).toBeNull();
    expect(findPersonInInstruction("Every Monday remind me to review insurance.", [CHRISTOPHER, GRACE])).toBeNull();
    expect(findPersonInInstruction("Every morning remind me to check passport renewal.", [CHRISTOPHER, GRACE])).toBeNull();
  });

  it("finds a person for third-party recurring instructions", () => {
    expect(findPersonInInstruction("Every morning ask Christopher for a lunch photo.", [CHRISTOPHER, GRACE])?.name).toBe(
      "Christopher",
    );
    expect(findPersonInInstruction("Every Friday remind Grace about flowers.", [CHRISTOPHER, GRACE])?.name).toBe("Grace");
  });
});

describe("createReminderRoutineFromInstruction", () => {
  it("creates an owner-only automation for a daily self-reminder", async () => {
    const schedules = detectAllRecurringSchedules("Remind me every day to take my medication.");
    expect(schedules.length).toBeGreaterThan(0);

    const summary = await createReminderRoutineFromInstruction(
      "Remind me every day to take my medication.",
      schedules[0],
    );

    expect(summary).toBeTruthy();
    expect(summary).toContain("You can manage it in Automations.");
    expect(routinesMocks.createRoutine).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(init?.headers).toMatchObject({ Authorization: "Bearer jwt-1" });
    const payload = JSON.parse(String(init?.body));
    expect(payload).toMatchObject({
      title: "Daily: Take my medication.",
      instruction: "Take my medication.",
      cadence_type: "daily",
      cadence_value: { time: "09:00" },
      assignee_id: null,
      proof_required: false,
      proof_type: null,
      automation_type: "delegation",
    });
    expect(new Date(payload.next_run_at).getTime()).not.toBeNaN();
  });

  it("creates an owner-only automation for a weekly self-reminder", async () => {
    const schedules = detectAllRecurringSchedules("Every Monday remind me to review insurance.");
    expect(schedules.length).toBeGreaterThan(0);

    const summary = await createReminderRoutineFromInstruction(
      "Every Monday remind me to review insurance.",
      schedules[0],
    );

    expect(summary).toBeTruthy();
    expect(routinesMocks.createRoutine).not.toHaveBeenCalled();
    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    const payload = JSON.parse(String(init?.body));
    expect(payload.cadence_type).toBe("weekly");
    expect(payload.cadence_value).toMatchObject({ time: "09:00", day: 1 });
    expect(payload.assignee_id).toBeNull();
  });

  it("creates an owner-only automation for 'every morning' self-reminder", async () => {
    const schedules = detectAllRecurringSchedules("Every morning remind me to check passport renewal.");
    expect(schedules.length).toBeGreaterThan(0);

    const summary = await createReminderRoutineFromInstruction(
      "Every morning remind me to check passport renewal.",
      schedules[0],
    );

    expect(summary).toBeTruthy();
    expect(routinesMocks.createRoutine).not.toHaveBeenCalled();
    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    const payload = JSON.parse(String(init?.body));
    expect(payload.instruction.toLowerCase()).toContain("passport renewal");
    expect(payload.cadence_type).toBe("daily");
    expect(payload.assignee_id).toBeNull();
  });

  it("freezes the old delegated recurring routine helper without creating a routine", async () => {
    const summary = await createVoiceRoutine({
      rawInstruction: "Every morning ask Christopher to send a lunch photo.",
      schedule: { schedule: "daily" },
      people: [CHRISTOPHER, GRACE],
      userId: "user-1",
      displayName: "Sana",
    });

    expect(summary).toBe("New recurring work now lives in Automations. Existing routines still work here.");
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(routinesMocks.createRoutine).not.toHaveBeenCalled();
  });
});

describe("third-party recurring automation routing", () => {
  it("uses the person named in stale recurring source over the current one-time tool recipient", () => {
    const person = resolveRecurringAutomationPerson(
      "Every Friday ask Grace at 10:00 AM to send the flower inventory.",
      [CHRISTOPHER, GRACE],
      CHRISTOPHER,
    );

    expect(person.name).toBe("Grace");
  });

  it("keeps new third-party recurring delegations on the automation input path", () => {
    const schedules = detectAllRecurringSchedules("Every morning ask Christopher to send a lunch photo.");
    const input = buildVoiceAutomationInput(
      "Every morning ask Christopher to send a lunch photo.",
      schedules[0],
      [CHRISTOPHER, GRACE],
    );

    expect(input).toMatchObject({
      assigneeId: "p1",
      personName: "Christopher",
      cleanMessage: "Send a lunch photo.",
      cadenceType: "daily",
      cadenceValue: { time: "09:00" },
      automationType: "delegation",
    });
    expect(routinesMocks.createRoutine).not.toHaveBeenCalled();
  });
});
