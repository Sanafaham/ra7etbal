import { describe, expect, it } from "vitest";
import { normalizeFirstPersonForOwner } from "./direct-message-owner-normalization";

describe("normalizeFirstPersonForOwner", () => {
  it("rewrites a bare first-person statement (I have no Wi-Fi.)", () => {
    expect(normalizeFirstPersonForOwner("I have no Wi-Fi.", "Sana")).toBe(
      "Sana has no Wi-Fi.",
    );
  });

  it("rewrites the I'm contraction, including the on-my-way idiom (I'm on my way.) without inventing a gendered pronoun", () => {
    expect(normalizeFirstPersonForOwner("I'm on my way.", "Sana")).toBe(
      "Sana is on the way.",
    );
  });

  it("rewrites the uncontracted am form (I am running late.)", () => {
    expect(normalizeFirstPersonForOwner("I am running late.", "Sana")).toBe(
      "Sana is running late.",
    );
  });

  it("rewrites a leading possessive (My phone is not working.)", () => {
    expect(normalizeFirstPersonForOwner("My phone is not working.", "Sana")).toBe(
      "Sana's phone is not working.",
    );
  });

  it("rewrites the I'll contraction (I'll arrive in ten minutes.)", () => {
    expect(normalizeFirstPersonForOwner("I'll arrive in ten minutes.", "Sana")).toBe(
      "Sana will arrive in ten minutes.",
    );
  });

  it("leaves text without leading first-person wording unchanged", () => {
    const text = "The meeting is at four.";
    expect(normalizeFirstPersonForOwner(text, "Sana")).toBe(text);
  });

  it("does not rewrite a first-person reference embedded mid-sentence (not the owner's own leading voice)", () => {
    const text = "Grace said I would call back.";
    expect(normalizeFirstPersonForOwner(text, "Sana")).toBe(text);
  });

  it("does not rewrite quoted first-person content", () => {
    const text = 'She texted "I am on my way" an hour ago.';
    expect(normalizeFirstPersonForOwner(text, "Sana")).toBe(text);
  });

  it("returns the input unchanged when no owner name is available", () => {
    expect(normalizeFirstPersonForOwner("I have no Wi-Fi.", null)).toBe(
      "I have no Wi-Fi.",
    );
    expect(normalizeFirstPersonForOwner("I have no Wi-Fi.", undefined)).toBe(
      "I have no Wi-Fi.",
    );
    expect(normalizeFirstPersonForOwner("I have no Wi-Fi.", "  ")).toBe(
      "I have no Wi-Fi.",
    );
  });

  it("does not hardcode the owner's name — uses whatever name is passed in", () => {
    expect(normalizeFirstPersonForOwner("I have no Wi-Fi.", "Marcus")).toBe(
      "Marcus has no Wi-Fi.",
    );
  });

  it("handles the I've contraction", () => {
    expect(normalizeFirstPersonForOwner("I've left the office.", "Sana")).toBe(
      "Sana has left the office.",
    );
  });

  // Confirmed production regression: "Ask Grace to call me now." sent Grace
  // the literal text "call me now" — "me" is an object pronoun referring to
  // the owner (Sana), not the leading subject, so the existing
  // LEADING_SUBJECT_RULES pass never touched it. Grace read "me" as herself.
  describe("mid-sentence object pronoun (confirmed production regression)", () => {
    it('rewrites "call me now." — the exact confirmed-regression phrase', () => {
      expect(normalizeFirstPersonForOwner("call me now.", "Sana")).toBe(
        "call Sana now.",
      );
    });

    it('rewrites "wait for me."', () => {
      expect(normalizeFirstPersonForOwner("wait for me.", "Sana")).toBe(
        "wait for Sana.",
      );
    });

    it('rewrites "contact me from the office."', () => {
      expect(normalizeFirstPersonForOwner("contact me from the office.", "Sana")).toBe(
        "contact Sana from the office.",
      );
    });

    it('rewrites the ditransitive "bring me the keys." preserving the intended meaning', () => {
      expect(normalizeFirstPersonForOwner("bring me the keys.", "Sana")).toBe(
        "bring Sana the keys.",
      );
    });

    it('leaves third-party wording ("call the doctor.") unchanged', () => {
      const text = "call the doctor.";
      expect(normalizeFirstPersonForOwner(text, "Sana")).toBe(text);
    });

    it("does not rewrite unrelated mid-sentence \"me\" outside the curated verb list", () => {
      const text = "she mentioned it to me yesterday.";
      expect(normalizeFirstPersonForOwner(text, "Sana")).toBe(text);
    });
  });
});
