import { describe, expect, it } from "vitest";
import { pickReviewEmptyStateMessage, shouldShowPhotoControl } from "./review-selection";

describe("pickReviewEmptyStateMessage", () => {
  it("shows the 'nothing found' message when the review never had items", () => {
    expect(pickReviewEmptyStateMessage(false)).toMatch(/didn't find anything actionable/i);
  });

  it("shows a distinct 'you cleared everything' message when items existed and were all removed", () => {
    const msg = pickReviewEmptyStateMessage(true);
    expect(msg).toMatch(/cleared everything/i);
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
