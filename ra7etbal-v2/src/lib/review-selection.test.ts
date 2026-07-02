import { describe, expect, it } from "vitest";
import {
  canSaveAndSend,
  getReviewSendableCheck,
  hasSendableMessages,
  pickReviewEmptyStateMessage,
  shouldShowPhotoControl,
} from "./review-selection";

function sendableDelegation(overrides: Record<string, unknown> = {}) {
  return {
    type: "delegation",
    assignedTo: "Grace",
    suggestedMessage: "Please pick up dry cleaning.",
    ...overrides,
  };
}

describe("getReviewSendableCheck / hasSendableMessages", () => {
  it("a delegation with a real recipient and message text is sendable", () => {
    expect(getReviewSendableCheck(sendableDelegation()).isSendable).toBe(true);
  });

  it("a personal reminder (assigned to __me__) is never sendable", () => {
    const check = getReviewSendableCheck({
      type: "reminder",
      assignedTo: "__me__",
      suggestedMessage: "irrelevant",
    });
    expect(check.isSendable).toBe(false);
    expect(check.isPersonalReminder).toBe(true);
  });

  it("an item with no message text is not sendable", () => {
    expect(getReviewSendableCheck({ type: "delegation", assignedTo: "Grace" }).isSendable).toBe(false);
  });

  it("hasSendableMessages is true if ANY item in the list is sendable", () => {
    expect(hasSendableMessages([{ type: "todo" }, sendableDelegation()])).toBe(true);
  });

  it("hasSendableMessages is false when no items are sendable", () => {
    expect(hasSendableMessages([{ type: "todo" }, { type: "parked" }])).toBe(false);
  });

  it("hasSendableMessages is false for an empty list", () => {
    expect(hasSendableMessages([])).toBe(false);
  });
});

// ── Requirement 3/4: Save & Send only ever sees currently-present items ─────
describe("canSaveAndSend — 'Save & Send processes only remaining items' / disabled-when-empty", () => {
  it("is true when at least one item remains", () => {
    expect(canSaveAndSend([{ type: "todo" }])).toBe(true);
  });

  it("is false once the review list is empty (all items removed)", () => {
    expect(canSaveAndSend([])).toBe(false);
  });

  it("reflects removal directly: starting with 3, 'removing' down to 1 via filtering stays enabled", () => {
    const full = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const afterRemovingTwo = full.filter((i) => i.id === "a");
    expect(canSaveAndSend(afterRemovingTwo)).toBe(true);
    expect(afterRemovingTwo).toHaveLength(1);
  });

  it("reflects removal directly: removing every item disables Save & Send", () => {
    const full = [{ id: "a" }, { id: "b" }];
    const afterRemovingAll = full.filter(() => false);
    expect(canSaveAndSend(afterRemovingAll)).toBe(false);
  });
});

describe("pickReviewEmptyStateMessage", () => {
  it("shows the 'nothing found' message when the review never had items", () => {
    expect(pickReviewEmptyStateMessage(false)).toMatch(/didn't find anything actionable/i);
  });

  it("shows a distinct 'you removed everything' message when items existed and were all removed", () => {
    const msg = pickReviewEmptyStateMessage(true);
    expect(msg).toMatch(/removed everything/i);
    expect(msg).not.toMatch(/didn't find anything actionable/i);
  });
});

describe("shouldShowPhotoControl", () => {
  it("shows the control for photo-relevant types (delegation, message, action, errand, followup)", () => {
    for (const type of ["delegation", "message", "action", "errand", "followup"] as const) {
      expect(shouldShowPhotoControl({ type, imageFile: null })).toBe(true);
    }
  });

  it("hides the control for types where a photo is rarely relevant", () => {
    for (const type of ["reminder", "decision", "todo", "parked"] as const) {
      expect(shouldShowPhotoControl({ type, imageFile: null })).toBe(false);
    }
  });

  it("never hides an already-attached photo, even for an otherwise-hidden type", () => {
    const file = new File(["x"], "photo.jpg", { type: "image/jpeg" });
    expect(shouldShowPhotoControl({ type: "reminder", imageFile: file })).toBe(true);
  });
});
