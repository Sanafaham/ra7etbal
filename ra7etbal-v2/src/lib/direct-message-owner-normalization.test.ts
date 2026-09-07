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

  it("does not rewrite a second sentence that remains inside a quote spanning multiple clauses", () => {
    const text = 'She said, "I am leaving. I\'ll return later."';
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

    // CodeRabbit finding: a leading "I" not covered by LEADING_SUBJECT_RULES
    // ("I need...") combined with a later object-pronoun "me" would
    // otherwise produce mixed-person output ("I need Grace to call Sana.").
    // Left entirely unchanged instead of guessing a conjugation.
    it('leaves the whole sentence unchanged rather than producing mixed-person output ("I need Grace to call me.")', () => {
      const text = "I need Grace to call me.";
      expect(normalizeFirstPersonForOwner(text, "Sana")).toBe(text);
    });
  });

  // Confirmed production regression: "Carson, ask Saeed to wait for me.
  // Tell him I'm on my way." produced "Wait for Sana. I'm on my way." on
  // Saeed's phone — the object-pronoun pass (global) rewrote clause 1's
  // "wait for me", but the leading-subject pass never reached clause 2's
  // "I'm" because it was anchored to the start of the whole message, not
  // the start of each sentence.
  describe("multi-clause perspective consistency (confirmed production regression)", () => {
    it('normalizes both clauses of "Wait for me. I\'m on my way." to the same third person', () => {
      expect(
        normalizeFirstPersonForOwner("Wait for me. I'm on my way.", "Sana"),
      ).toBe("Wait for Sana. Sana is on the way.");
    });

    it('normalizes both clauses of "Tell him to call me. I\'ll speak to him later."', () => {
      expect(
        normalizeFirstPersonForOwner(
          "Tell him to call me. I'll speak to him later.",
          "Sana",
        ),
      ).toBe("Tell him to call Sana. Sana will speak to him later.");
    });

    it('normalizes the leading possessive clause of "My driver is waiting. Tell him I\'m coming." — the second clause\'s "I\'m" is mid-sentence (not the clause\'s leading subject), so it is left untouched by the same deliberate mid-sentence/quoted-content guard proven by "does not rewrite a first-person reference embedded mid-sentence" above; this is an intentional architecture boundary, not a residual bug', () => {
      expect(
        normalizeFirstPersonForOwner(
          "My driver is waiting. Tell him I'm coming.",
          "Sana",
        ),
      ).toBe("Sana's driver is waiting. Tell him I'm coming.");
    });

    it("does not split a sentence at an abbreviation's period (Mr.) and still normalizes the real sentence boundary", () => {
      expect(
        normalizeFirstPersonForOwner(
          "Tell Mr. Smith to wait for me. I'm on my way.",
          "Sana",
        ),
      ).toBe("Tell Mr. Smith to wait for Sana. Sana is on the way.");
    });

    it("does not split a decimal number (3.5) at a false sentence boundary", () => {
      const text = "Bring me 3.5 kg of rice.";
      expect(normalizeFirstPersonForOwner(text, "Sana")).toBe(
        "Bring Sana 3.5 kg of rice.",
      );
    });

    it("preserves existing single-clause behavior exactly (no accidental clause-splitting side effect)", () => {
      expect(normalizeFirstPersonForOwner("I'm on my way.", "Sana")).toBe(
        "Sana is on the way.",
      );
      expect(normalizeFirstPersonForOwner("wait for me.", "Sana")).toBe(
        "wait for Sana.",
      );
    });

    it('still leaves fully quoted first-person content unchanged across a multi-sentence message', () => {
      const text =
        'She texted "I am on my way" an hour ago. Please wait for her.';
      expect(normalizeFirstPersonForOwner(text, "Sana")).toBe(text);
    });
  });
});
