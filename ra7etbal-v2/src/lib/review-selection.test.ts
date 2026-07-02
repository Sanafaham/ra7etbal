import { describe, expect, it } from "vitest";
import type { ItemType } from "../types/extraction";
import { pickReviewEmptyStateMessage, reviewDisplayLabel, shouldShowPhotoControl } from "./review-selection";

const ALL_ITEM_TYPES: ItemType[] = [
  "action",
  "reminder",
  "message",
  "delegation",
  "decision",
  "followup",
  "errand",
  "parked",
  "todo",
];

describe("reviewDisplayLabel — Clear My Head badges never read like a real Carson object", () => {
  it("never renders 'To-do' (or any variant of it) for the todo type", () => {
    expect(reviewDisplayLabel("todo")).not.toMatch(/to-?do/i);
  });

  it("never renders any real Carson object-type name for any item type", () => {
    const OPERATIONAL_WORDS = /to-?do|reminder|delegation|message|note/i;
    for (const type of ALL_ITEM_TYPES) {
      expect(reviewDisplayLabel(type)).not.toMatch(OPERATIONAL_WORDS);
    }
  });

  it("labels a parked item as a 'Thought' — not a saved note", () => {
    expect(reviewDisplayLabel("parked")).toBe("Thought");
  });

  it("labels everything else as 'Detected' — not an existing task/reminder/delegation", () => {
    for (const type of ALL_ITEM_TYPES.filter((t) => t !== "parked")) {
      expect(reviewDisplayLabel(type)).toBe("Detected");
    }
  });
});

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
