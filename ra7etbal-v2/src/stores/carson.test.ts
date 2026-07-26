import { describe, expect, it } from "vitest";
import { useCarsonStore } from "./carson";

/**
 * pendingTypedDraft (2026-07-26): queues note text for "Send to Carson" (Note
 * cards) to appear in the typed input once a text session connects. A plain
 * zustand store, so — unlike the widget components in this codebase — this
 * is tested with real behavior, not source scanning.
 */
describe("useCarsonStore — pendingTypedDraft", () => {
  it("defaults to null", () => {
    expect(useCarsonStore.getState().pendingTypedDraft).toBeNull();
  });

  it("setPendingTypedDraft sets and clears the value", () => {
    useCarsonStore.getState().setPendingTypedDraft("Pay the electricity bill.");
    expect(useCarsonStore.getState().pendingTypedDraft).toBe("Pay the electricity bill.");

    useCarsonStore.getState().setPendingTypedDraft(null);
    expect(useCarsonStore.getState().pendingTypedDraft).toBeNull();
  });

  it("does not affect open/channel/callStatus — independent fields", () => {
    const before = {
      open: useCarsonStore.getState().open,
      channel: useCarsonStore.getState().channel,
      callStatus: useCarsonStore.getState().callStatus,
    };
    useCarsonStore.getState().setPendingTypedDraft("Some note text.");
    expect(useCarsonStore.getState().open).toBe(before.open);
    expect(useCarsonStore.getState().channel).toBe(before.channel);
    expect(useCarsonStore.getState().callStatus).toBe(before.callStatus);
    useCarsonStore.getState().setPendingTypedDraft(null);
  });
});
