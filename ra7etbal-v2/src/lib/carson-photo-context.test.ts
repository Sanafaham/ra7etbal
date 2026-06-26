import { describe, expect, it } from "vitest";
import { appendPhotoContextDescription } from "./carson-photo-context";

describe("appendPhotoContextDescription", () => {
  it("returns the addition when there is no existing context", () => {
    expect(appendPhotoContextDescription(null, "Photo 1: a red bicycle.")).toBe(
      "Photo 1: a red bicycle.",
    );
  });

  it("returns the existing context unchanged when there is no addition", () => {
    expect(appendPhotoContextDescription("Photo 1: a red bicycle.", null)).toBe(
      "Photo 1: a red bicycle.",
    );
  });

  it("returns null when both are null", () => {
    expect(appendPhotoContextDescription(null, null)).toBeNull();
  });

  it("appends the new description on a new line after the existing one", () => {
    expect(
      appendPhotoContextDescription("Photo 1: a red bicycle.", "Photo 2: a wedding favor box."),
    ).toBe("Photo 1: a red bicycle.\nPhoto 2: a wedding favor box.");
  });

  it("never drops the original description when merging multiple late attachments", () => {
    const afterFirst = appendPhotoContextDescription(null, "Photo 1: a red bicycle.");
    const afterSecond = appendPhotoContextDescription(afterFirst, "Photo 2: a kitchen sink.");
    expect(afterSecond).toBe("Photo 1: a red bicycle.\nPhoto 2: a kitchen sink.");
  });
});
