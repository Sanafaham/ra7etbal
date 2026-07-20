import { describe, expect, it, vi, beforeEach } from "vitest";

const state: { selectResult: { data: unknown; error: unknown } } = {
  selectResult: { data: [], error: null },
};

const fromSpy = vi.fn();
const selectSpy = vi.fn();
const orderSpy = vi.fn();

vi.mock("./supabase", () => ({
  supabase: {
    from: (...args: unknown[]) => {
      fromSpy(...args);
      return {
        select: (...selectArgs: unknown[]) => {
          selectSpy(...selectArgs);
          return {
            order: (...orderArgs: unknown[]) => {
              orderSpy(...orderArgs);
              return Promise.resolve(state.selectResult);
            },
          };
        },
      };
    },
  },
}));

import { getStaffMessageDisplayState, listStaffMessages } from "./staff-messages";

beforeEach(() => {
  state.selectResult = { data: [], error: null };
  fromSpy.mockClear();
  selectSpy.mockClear();
  orderSpy.mockClear();
});

describe("listStaffMessages", () => {
  it("10. never adds its own user_id filter — relies entirely on the RLS SELECT policy, so cross-household data cannot be requested through the client query", async () => {
    await listStaffMessages();

    expect(fromSpy).toHaveBeenCalledWith("staff_messages");
    const selectArg = String(selectSpy.mock.calls[0][0]);
    // No caller-supplied filter of any kind exists on this query — nothing
    // to manipulate into requesting another household's rows. The only
    // scoping mechanism is the database's own RLS policy.
    expect(selectArg).not.toMatch(/user_id/i);
    // Never selects internal-only fields.
    expect(selectArg).not.toMatch(/processing_status|processing_error|external_message_id|\buser_id\b/);
  });

  it("returns rows as-is from the query result", async () => {
    state.selectResult = {
      data: [{ id: "1", staff_name: "Grace", inbound_text: "hi", user_facing_state: "Waiting" }],
      error: null,
    };
    const rows = await listStaffMessages();
    expect(rows).toHaveLength(1);
  });

  it("throws a friendly error instead of leaking a raw Supabase/RLS error message", async () => {
    state.selectResult = { data: null, error: { message: "permission denied for table staff_messages" } };
    await expect(listStaffMessages()).rejects.toThrow("You don't have permission to do that.");
  });
});

describe("getStaffMessageDisplayState", () => {
  it("shows Needs You when owner_attention_required is true, even if user_facing_state disagrees", () => {
    expect(
      getStaffMessageDisplayState({ owner_attention_required: true, user_facing_state: "Waiting" }),
    ).toBe("Needs You");
  });

  it("shows Needs You when user_facing_state is Needs You even if owner_attention_required is false", () => {
    expect(
      getStaffMessageDisplayState({ owner_attention_required: false, user_facing_state: "Needs You" }),
    ).toBe("Needs You");
  });

  it("passes through Waiting/Completed/In Progress unchanged when neither Needs You signal is present", () => {
    expect(getStaffMessageDisplayState({ owner_attention_required: false, user_facing_state: "Waiting" })).toBe("Waiting");
    expect(getStaffMessageDisplayState({ owner_attention_required: false, user_facing_state: "Completed" })).toBe("Completed");
    expect(getStaffMessageDisplayState({ owner_attention_required: false, user_facing_state: "In Progress" })).toBe("In Progress");
  });
});
