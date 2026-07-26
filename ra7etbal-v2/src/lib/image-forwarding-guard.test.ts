import { describe, expect, it } from "vitest";
import { shouldForwardAttachedImage } from "./image-forwarding-guard";

/**
 * Confirmed production bug (2026-07-26): a handwritten note's photo (buy
 * groceries / call the doctor / tell Grace guests arrive at 7 PM) was
 * forwarded to Christopher in full, alongside the correctly-extracted "buy
 * groceries" text, exposing unrelated personal items. These tests lock the
 * default-private / explicit-or-necessary-forward decision.
 */
describe("shouldForwardAttachedImage", () => {
  it("denies by default — a private note referenced only by its extracted task text", () => {
    expect(shouldForwardAttachedImage("Ask Christopher to buy groceries")).toBe(false);
  });

  it("denies for a multi-item note instruction with no reference to the photo itself", () => {
    expect(
      shouldForwardAttachedImage(
        "Ask Christopher to buy groceries, and tell Grace the guests arrive at 7 PM",
      ),
    ).toBe(false);
  });

  it("denies when the demonstrative refers to the note/photo itself, not its subject", () => {
    expect(shouldForwardAttachedImage("Ask Christopher to buy groceries from this note")).toBe(false);
    expect(shouldForwardAttachedImage("Send Christopher what's in this screenshot")).toBe(true); // explicit "send" still authorizes
  });

  it("allows when the instruction references the photographed subject as the task itself", () => {
    expect(shouldForwardAttachedImage("Tell Christopher to make this pizza")).toBe(true);
  });

  it("allows a bare trailing demonstrative with no following noun", () => {
    expect(shouldForwardAttachedImage("Tell Christopher to prepare these")).toBe(true);
    expect(shouldForwardAttachedImage("Ask Christopher to make this")).toBe(true);
  });

  it("allows an explicit request to send/share/forward/show the photo itself", () => {
    expect(shouldForwardAttachedImage("Send this photo to Christopher")).toBe(true);
    expect(shouldForwardAttachedImage("Share the picture with Christopher")).toBe(true);
    expect(shouldForwardAttachedImage("Forward this image to Grace")).toBe(true);
    expect(shouldForwardAttachedImage("Show Christopher this screenshot")).toBe(true);
  });

  it("verbs like handle/prepare/make/check/review/respond do not by themselves authorize forwarding", () => {
    expect(shouldForwardAttachedImage("Ask Christopher to handle it")).toBe(false);
    expect(shouldForwardAttachedImage("Ask Christopher to prepare the room")).toBe(false);
    expect(shouldForwardAttachedImage("Ask Christopher to check on it")).toBe(false);
    expect(shouldForwardAttachedImage("Ask Christopher to review it")).toBe(false);
    expect(shouldForwardAttachedImage("Ask Christopher to respond to it")).toBe(false);
  });

  it("handles empty/null/undefined input safely", () => {
    expect(shouldForwardAttachedImage("")).toBe(false);
    expect(shouldForwardAttachedImage("   ")).toBe(false);
    expect(shouldForwardAttachedImage(null)).toBe(false);
    expect(shouldForwardAttachedImage(undefined)).toBe(false);
  });
});
