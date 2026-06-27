import { describe, it, expect, vi, beforeEach } from "vitest";

const routinesMocks = vi.hoisted(() => ({
  createRoutine: vi.fn(async (input: any) => ({
    id: "routine-1",
    user_id: "user-1",
    ...input,
  })),
}));

vi.mock("./routines", () => ({
  createRoutine: routinesMocks.createRoutine,
}));

import {
  detectAllRecurringSchedules,
  findPersonInInstruction,
  createReminderRoutineFromInstruction,
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
  it("creates a routines.reminder for a daily self-reminder", async () => {
    const schedules = detectAllRecurringSchedules("Remind me every day to take my medication.");
    expect(schedules.length).toBeGreaterThan(0);

    const summary = await createReminderRoutineFromInstruction(
      "Remind me every day to take my medication.",
      schedules[0],
    );

    expect(summary).toBeTruthy();
    expect(routinesMocks.createRoutine).toHaveBeenCalledTimes(1);
    const payload = routinesMocks.createRoutine.mock.calls[0][0];
    expect(payload.type).toBe("reminder");
    expect(payload.payload?.title?.toLowerCase()).toContain("take my medication");
  });

  it("creates a routines.reminder for a weekly self-reminder", async () => {
    const schedules = detectAllRecurringSchedules("Every Monday remind me to review insurance.");
    expect(schedules.length).toBeGreaterThan(0);

    const summary = await createReminderRoutineFromInstruction(
      "Every Monday remind me to review insurance.",
      schedules[0],
    );

    expect(summary).toBeTruthy();
    expect(routinesMocks.createRoutine).toHaveBeenCalledTimes(1);
    const payload = routinesMocks.createRoutine.mock.calls[0][0];
    expect(payload.type).toBe("reminder");
    expect(payload.schedule).toBe(schedules[0].schedule);
  });

  it("creates a routines.reminder for 'every morning' self-reminder", async () => {
    const schedules = detectAllRecurringSchedules("Every morning remind me to check passport renewal.");
    expect(schedules.length).toBeGreaterThan(0);

    const summary = await createReminderRoutineFromInstruction(
      "Every morning remind me to check passport renewal.",
      schedules[0],
    );

    expect(summary).toBeTruthy();
    const payload = routinesMocks.createRoutine.mock.calls[0][0];
    expect(payload.type).toBe("reminder");
    expect(payload.payload?.title?.toLowerCase()).toContain("passport renewal");
  });
});
