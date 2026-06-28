import { beforeEach, describe, expect, it, vi } from "vitest";

const supabaseMocks = vi.hoisted(() => ({
  from: vi.fn(),
  getUser: vi.fn(),
}));

vi.mock("./supabase", () => ({
  supabase: {
    auth: {
      getUser: supabaseMocks.getUser,
    },
    from: supabaseMocks.from,
  },
}));

import {
  createRoutine,
  deleteRoutine,
  LEGACY_ROUTINE_CREATION_FROZEN_MESSAGE,
  listRoutines,
  toggleRoutine,
} from "./routines";

beforeEach(() => {
  supabaseMocks.from.mockReset();
  supabaseMocks.getUser.mockReset();
});

describe("legacy routines freeze", () => {
  it("blocks new routine creation before any Supabase insert", async () => {
    await expect(createRoutine({
      name: "Daily: Review priorities",
      type: "reminder",
      schedule: "daily",
      schedule_time: "09:00",
      payload: { title: "Review priorities" },
    })).rejects.toThrow(LEGACY_ROUTINE_CREATION_FROZEN_MESSAGE);

    expect(supabaseMocks.getUser).not.toHaveBeenCalled();
    expect(supabaseMocks.from).not.toHaveBeenCalled();
  });

  it("still lists existing legacy routines", async () => {
    const order = vi.fn(async () => ({
      data: [{ id: "routine-1", name: "Legacy reminder" }],
      error: null,
    }));
    const select = vi.fn(() => ({ order }));
    supabaseMocks.from.mockReturnValue({ select });

    const rows = await listRoutines();

    expect(rows).toEqual([{ id: "routine-1", name: "Legacy reminder" }]);
    expect(supabaseMocks.from).toHaveBeenCalledWith("routines");
    expect(select).toHaveBeenCalledWith("*");
    expect(order).toHaveBeenCalledWith("created_at", { ascending: false });
  });

  it("still allows existing legacy routines to be paused or resumed", async () => {
    const eq = vi.fn(async () => ({ error: null }));
    const update = vi.fn(() => ({ eq }));
    supabaseMocks.from.mockReturnValue({ update });

    await toggleRoutine("routine-1", false);

    expect(supabaseMocks.from).toHaveBeenCalledWith("routines");
    expect(update).toHaveBeenCalledWith({ enabled: false });
    expect(eq).toHaveBeenCalledWith("id", "routine-1");
  });

  it("still allows existing legacy routines to be deleted", async () => {
    const eq = vi.fn(async () => ({ error: null }));
    const deleteFn = vi.fn(() => ({ eq }));
    supabaseMocks.from.mockReturnValue({ delete: deleteFn });

    await deleteRoutine("routine-1");

    expect(supabaseMocks.from).toHaveBeenCalledWith("routines");
    expect(deleteFn).toHaveBeenCalledTimes(1);
    expect(eq).toHaveBeenCalledWith("id", "routine-1");
  });
});
