import { describe, expect, it } from "vitest";
import {
  isOwnerPerspectiveError,
  OwnerPerspectiveError,
  ownerPerspectiveClarification,
  renderOwnerPerspective,
  resolveOwnerPerspective,
  type OwnerPerspectiveVoice,
} from "./direct-message-owner-normalization";

/**
 * Protected contract: the single owner-perspective boundary
 * (shared/owner-perspective.js). Replaces the retired leading-subject
 * normalizer (normalizeFirstPersonForOwner) and the blanket delegation /
 * follow-up pronoun rewriters.
 *
 * Expectations carried over unchanged from the retired normalizer keep their
 * exact input and output. Expectations that pinned the retired "leave it
 * unchanged" boundary are replaced below, each marked RETIRED PIN with the old
 * behaviour and the reason.
 */
const NEEDS = (reason: string) => `NEEDS_COMPOSITION:${reason}`;
function render(text: string, ownerName: string | null = "Sana", recipientName: string | null = "Grace", voice: OwnerPerspectiveVoice = "owner_to_recipient") {
  const r = resolveOwnerPerspective(text, { ownerName, recipientName, voice });
  return r.status === "needs_composition" ? NEEDS(r.reason ?? "") : r.text;
}

describe("owner perspective — carried over from the retired normalizer (unchanged expectations)", () => {
  it("rewrites a bare first-person statement (I have no Wi-Fi.)", () => {
    expect(render("I have no Wi-Fi.")).toBe("Sana has no Wi-Fi.");
  });

  it("rewrites the I'm contraction, including the on-my-way idiom (I'm on my way.) without inventing a gendered pronoun", () => {
    expect(render("I'm on my way.")).toBe("Sana is on the way.");
  });

  it("rewrites the uncontracted am form (I am running late.)", () => {
    expect(render("I am running late.")).toBe("Sana is running late.");
  });

  it("rewrites a leading possessive (My phone is not working.)", () => {
    expect(render("My phone is not working.")).toBe("Sana's phone is not working.");
  });

  it("rewrites the I'll contraction (I'll arrive in ten minutes.)", () => {
    expect(render("I'll arrive in ten minutes.")).toBe("Sana will arrive in ten minutes.");
  });

  it("leaves text without owner wording byte-for-byte unchanged", () => {
    expect(render("The meeting is at four.")).toBe("The meeting is at four.");
    expect(render("call the doctor.")).toBe("call the doctor.");
  });

  it("does not rewrite quoted first-person content", () => {
    const text = 'She texted "I am on my way" an hour ago.';
    expect(render(text)).toBe(text);
  });

  it("does not rewrite a second sentence that remains inside a quote spanning multiple clauses", () => {
    const text = 'She said, "I am leaving. I\'ll return later."';
    expect(render(text)).toBe(text);
  });

  it("does not hardcode the owner's name — uses whatever name is passed in", () => {
    expect(render("I have no Wi-Fi.", "Marcus")).toBe("Marcus has no Wi-Fi.");
  });

  it("handles the I've contraction", () => {
    expect(render("I've left the office.")).toBe("Sana has left the office.");
  });

  describe("object pronoun (confirmed production regression: Grace read 'call me now' as herself)", () => {
    it('rewrites "call me now." — the exact confirmed-regression phrase', () => {
      expect(render("call me now.")).toBe("call Sana now.");
    });
    it('rewrites "wait for me."', () => {
      expect(render("wait for me.")).toBe("wait for Sana.");
    });
    it('rewrites "contact me from the office."', () => {
      expect(render("contact me from the office.")).toBe("contact Sana from the office.");
    });
    it('rewrites the ditransitive "bring me the keys." preserving the intended meaning', () => {
      expect(render("bring me the keys.")).toBe("bring Sana the keys.");
    });
  });

  describe("multi-clause perspective consistency (confirmed production regression)", () => {
    it('normalizes both clauses of "Wait for me. I\'m on my way." to the same third person', () => {
      expect(render("Wait for me. I'm on my way.")).toBe("Wait for Sana. Sana is on the way.");
    });
    it('normalizes both clauses of "Tell him to call me. I\'ll speak to him later." — "him" is a third party and stays one', () => {
      expect(render("Tell him to call me. I'll speak to him later.")).toBe("Tell him to call Sana. Sana will speak to him later.");
    });
    it("does not split a sentence at an abbreviation's period (Mr.) and still normalizes the real sentence boundary", () => {
      expect(render("Tell Mr. Smith to wait for me. I'm on my way.")).toBe("Tell Mr. Smith to wait for Sana. Sana is on the way.");
    });
    it("does not split a decimal number (3.5) at a false sentence boundary", () => {
      expect(render("Bring me 3.5 kg of rice.")).toBe("Bring Sana 3.5 kg of rice.");
    });
    it("still leaves fully quoted first-person content unchanged across a multi-sentence message", () => {
      const text = 'She texted "I am on my way" an hour ago. Please wait for her.';
      expect(render(text)).toBe(text);
    });
  });
});

describe("owner perspective — retired 'leave unchanged' pins, replaced by the new contract", () => {
  // RETIRED PIN: "Grace said I would call back." → unchanged. The old
  // architecture could not tell whose "I" this is and sent it as-is. In
  // reported speech without quote marks "I" may be Grace or the owner, so the
  // contract fails closed instead of sending either reading.
  it("reported speech with first person fails closed (Grace said I would call back.)", () => {
    expect(render("Grace said I would call back.")).toBe(NEEDS("reported_speech_first_person"));
  });

  // RETIRED PIN: "she mentioned it to me yesterday." → unchanged (raw "me"
  // reached the recipient). Under a third party's reporting verb the owner
  // reference is not safely resolvable: fail closed.
  it("a first-person reference under a third party's reporting verb fails closed", () => {
    expect(render("she mentioned it to me yesterday.")).toBe(NEEDS("reported_speech_first_person"));
  });

  // RETIRED PIN: "I need Grace to call me." → unchanged, chosen only to avoid
  // the old mixed output. The new contract renders the whole sentence
  // consistently, with verb agreement.
  it('renders "I need Grace to call me." consistently in third person', () => {
    expect(render("I need Grace to call me.")).toBe("Sana needs Grace to call Sana.");
  });

  // RETIRED PIN: "My driver is waiting. Tell him I'm coming." →
  // "Sana's driver is waiting. Tell him I'm coming." (mixed perspective,
  // documented as an "intentional architecture boundary"). "him" is the
  // driver (a third party) and "I'm" is the owner.
  it("renders both owner references and keeps the third party (My driver is waiting. Tell him I'm coming.)", () => {
    expect(render("My driver is waiting. Tell him I'm coming.")).toBe("Sana's driver is waiting. Tell him Sana is coming.");
  });

  // RETIRED PIN: no owner name → input returned unchanged (raw owner first
  // person delivered). Without a name the owner reference cannot be
  // rendered: fail closed.
  it("fails closed when no owner name is available and the text references the owner", () => {
    for (const name of [null, "  "]) expect(render("I have no Wi-Fi.", name)).toBe(NEEDS("no_owner_name"));
    expect(render("The car is outside.", null)).toBe("The car is outside.");
  });
});

describe("owner perspective — the owner's required examples (direct-message voice, recipient Loulya)", () => {
  const r = (t: string) => render(t, "Sana", "Loulya");
  it.each([
    ["I would like her to call me.", "Sana would like you to call Sana."],
    ["I'd like you to call me.", "Sana would like you to call Sana."],
    ["I want you to call me.", "Sana wants you to call Sana."],
    ["I need you to call me.", "Sana needs you to call Sana."],
    ["meet me outside.", "meet Sana outside."],
    ["put it in my room.", "put it in Sana's room."],
    ["I'm running late.", "Sana is running late."],
    ["I'll call later.", "Sana will call later."],
    ["I've already done it.", "Sana has already done it."],
  ])("%s → %s", (input, expected) => {
    expect(r(input)).toBe(expected);
  });

  it('"I did it myself." fails closed (an owner reflexive needs a gendered pronoun; no gender data exists)', () => {
    expect(r("I did it myself.")).toBe(NEEDS("owner_reflexive"));
  });
  it('"Grace said I would call back." fails closed (reported speech)', () => {
    expect(r("Grace said I would call back.")).toBe(NEEDS("reported_speech_first_person"));
  });
  it('"She texted ‘I am on my way.’" is quoted speech and stays unchanged', () => {
    expect(r("She texted ‘I am on my way.’")).toBe("She texted ‘I am on my way.’");
  });
});

describe("owner perspective — recipient, third-party and grammar rules", () => {
  it("recipient referred to in the third person becomes 'you' only with no other possible antecedent", () => {
    expect(render("I'd like her to meet my mother.", "Sana", "Loulya")).toBe("Sana would like you to meet Sana's mother.");
    expect(render("I need him to call me back.", "Sana", "Christopher")).toBe("Sana needs you to call Sana back.");
  });
  it("a third-party pronoun is never turned into the recipient or the owner", () => {
    expect(render("Tell him to call me.")).toBe("Tell him to call Sana.");
    expect(render("My mother called, ask her to wait.")).toBe(NEEDS("third_party_ambiguity_introduced"));
  });
  it("recipient as a subject (needs verb re-agreement) or a possessive-vs-object 'her' fails closed", () => {
    expect(render("I'd like her to call when she lands.", "Sana", "Loulya")).toBe(NEEDS("recipient_subject_reference"));
    expect(render("I want to give her money.", "Sana", "Loulya")).toBe(NEEDS("recipient_reference_ambiguous"));
  });
  it("mixed genders and unknown verbs fail closed", () => {
    expect(render("Tell him I'd like her to call me.")).toBe(NEEDS("third_party_reference_ambiguous"));
    expect(render("I reckon it's fine.")).toBe(NEEDS("unresolved_owner_verb"));
  });
  it("model-composed text that already names the owner is left alone; adding owner first person to it fails closed", () => {
    expect(render("Sana would like you to call her.", "Sana", "Loulya")).toBe("Sana would like you to call her.");
    expect(render("Sana asked me to tell you she is late.")).toMatch(/^NEEDS_COMPOSITION:/);
  });
  it("verb agreement: am/are→is, have→has, do→does, don't→doesn't, -s/-es endings; modals and past unchanged", () => {
    expect(render("I don't need a lift.")).toBe("Sana doesn't need a lift.");
    expect(render("I miss you.")).toBe("Sana misses you.");
    expect(render("I really hope you can come.")).toBe("Sana really hopes you can come.");
    expect(render("I could not find the keys.")).toBe("Sana could not find the keys.");
    expect(render("I called the plumber.")).toBe("Sana called the plumber.");
    expect(render("I'd better leave.")).toBe("Sana had better leave.");
  });
  it("is idempotent: rendered text passes through again unchanged", () => {
    for (const t of ["I would like her to call me.", "put it in my room.", "Wait for me. I'm on my way."]) {
      const once = render(t, "Sana", "Loulya");
      expect(render(once, "Sana", "Loulya")).toBe(once);
    }
  });
});

describe("owner perspective — task-text voice (task text being created for an assignee)", () => {
  const task = (t: string) => render(t, "Sana", "Grace", "task_text");
  it("first person is the owner; 'you' is the assignee and stays", () => {
    expect(task("put it in my room")).toBe("put it in Sana's room");
    expect(task("let me know when you're done")).toBe("let Sana know when you're done");
    expect(task("call me if you need anything")).toBe("call Sana if you need anything");
    expect(task("Ask her to send you the photo.")).toBe("Ask her to send you the photo.");
  });
  it("third parties stay third parties; a pronoun the owner's name would make ambiguous fails closed", () => {
    expect(task("Take Loulya to her appointment and call me after.")).toBe("Take Loulya to her appointment and call Sana after.");
    expect(task("Tell Loulya I love her.")).toBe("Tell Loulya Sana loves her.");
    expect(task("Call me and tell her the plan.")).toBe(NEEDS("third_party_ambiguity_introduced"));
  });
  it("already-rendered and owner-named task text is unchanged", () => {
    expect(task("Call Sana.")).toBe("Call Sana.");
    expect(task("put it in Sana's room")).toBe("put it in Sana's room");
  });
});

describe("owner perspective — task-record voice (stored descriptions quoted by follow-ups)", () => {
  const rec = (t: string) => render(t, "Sana", "Grace", "task_record");
  // RETIRED RULE: the old follow-up rewriter turned every "you" in a stored
  // description into the owner ("text you in one minute" → "text Sana in one
  // minute"). A stored record cannot tell whether "you" meant the owner (older
  // paraphrased rows) or the assignee (owner's own words), so the contract
  // refuses to pick one: the follow-up then does not quote the task.
  it("second person in a stored record is ambiguous and fails closed", () => {
    expect(rec("text you in one minute")).toBe(NEEDS("second_person_in_task_record"));
    expect(rec("let Sana know when you're done")).toBe(NEEDS("second_person_in_task_record"));
  });
  it("first person is the owner; owner-named records are unchanged", () => {
    expect(rec("put it in my room")).toBe("put it in Sana's room");
    expect(rec("Call Sana.")).toBe("Call Sana.");
    expect(rec("Take Loulya to her appointment and call me after.")).toBe("Take Loulya to her appointment and call Sana after.");
  });
});

describe("owner perspective — Arabic (detected, never rendered: fail closed)", () => {
  // Explicit first-person markers (already covered before this slice).
  it.each(["اتصلي فيني", "قول للوليا إني أبغاها تتصل فيني", "وأنا جاي"])("explicit marker fails closed: %s", (t) => {
    expect(render(t)).toBe(NEEDS("arabic_owner_first_person"));
  });
  // Owner first person carried only by the verb form, an object suffix or a
  // possessive — the gap this slice closes.
  it.each([
    "بروح السوق بعدين",      // future first person (ب + stem)
    "باتصل فيك الحين",
    "ابغاك تتصل علي",        // first-person verb + object suffix
    "ابيك تجيب الاغراض",
    "اكلمك بعدين",
    "أحتاج المفاتيح",        // first-person present
    "أرجو تنظيف المطبخ",     // "I request" is still the owner speaking
    "كلمني لما توصل",        // object "me"
    "خبرني اذا خلصت",
    "جيبه لي",
    "رحت البيت",             // I/you past (not third-person feminine)
    "جيت متأخرة",
    "حطيه في غرفتي",         // my-possessive
    "سيارتي برا",
  ])("verb/suffix-only first person fails closed: %s", (t) => {
    expect(render(t)).toBe(NEEDS("arabic_owner_first_person"));
  });
  // Negative controls: imperatives that look like first-person forms,
  // third-person and owner-named text, and nouns ending like "me".
  it.each([
    "الغدا جاهز",
    "تعالي بكرة الساعة ٥",
    "سنا تبغاك تتصل عليها",
    "اتصل على سنا",
    "ارسل الصور لسنا",
    "انتظر عند الباب",
    "اغسل السيارة",
    "اعرف كم السعر",
    "اوصل الاغراض للبيت",
    "سنا وصلت البيت",
    "اللي في المطبخ",
    "يعني بكرة",
    "الثاني على اليمين",
    "أحمد جاي",
    "التوصيل مجاني",
  ])("negative control passes unchanged: %s", (t) => {
    expect(render(t)).toBe(t);
  });
  it("quoted Arabic first person is reported speech and is not treated as the owner", () => {
    expect(render("Tell her «بروح السوق»")).toBe("Tell her «بروح السوق»");
    expect(render('He wrote "ابغاك تجي" yesterday')).toBe('He wrote "ابغاك تجي" yesterday');
  });
});

describe("owner perspective — Turkish (detected, never rendered: fail closed)", () => {
  it.each(["Beni ara lütfen", "Bana haber ver", "Ben eve geliyorum ve çok yorgunum"])("explicit marker fails closed: %s", (t) => {
    expect(render(t)).toBe(NEEDS("turkish_owner_first_person"));
  });
  // First person carried only by a verb suffix or possessive — the gap this slice closes.
  it.each([
    "Eve geliyorum",          // -yorum, present continuous
    "geliyorum",
    "Yarın geleceğim",        // -eceğim, future
    "Geç kaldım",             // -dım, past
    "Biraz geç kalmışım",     // -mışım, reported past
    "Gitmeliyim",             // -meliyim, necessity
    "Hazırım",                // -ım, "I am ready"
    "Teşekkür ederim",        // "I thank" is still the owner speaking
    "Evdeyim",                // -deyim, "I am at home"
    "Yoldayim",               // ASCII-typed
    "hazirim, simdi geliyorum",
    "Iyiyim abi",
    "Annem geliyor",          // my-possessive
    "Araba annemde",          // my-possessive + case ending
    "Odama koy",
    "Arabami getir",
  ])("suffix-only first person fails closed: %s", (t) => {
    expect(render(t)).toBe(NEEDS("turkish_owner_first_person"));
  });
  it.each([
    "Akşam yemeği hazır",
    "Tamam",
    "Lütfen kapıyı kapat",
    "Yardım et lütfen",
    "Durum nedir",
    "Yorum yap",
    "Yarım saat sonra gel",
    "Program yarın",
    "Lütfen Sana'yı ara",
    "Sana bir mesaj var",
  ])("negative control passes unchanged: %s", (t) => {
    expect(render(t)).toBe(t);
  });
  it.each(["Ben will drive you.", "Dim the lights.", "The victim of an interim plan.", "Tim is here.", "Park the car at the deli.", "Give the parameter."])(
    "English words that end like Turkish first person are not flagged: %s", (t) => {
      expect(render(t)).toBe(t);
    });
  it("quoted Turkish first person is reported speech and is not treated as the owner", () => {
    expect(render('She said "geliyorum" earlier')).toBe('She said "geliyorum" earlier');
  });
});

describe("owner perspective — mixed language", () => {
  it("English owner references render when no Arabic/Turkish owner first person is present", () => {
    expect(render("Ask Ghulam يغسل السيارة before 5 and tell me")).toBe("Ask Ghulam يغسل السيارة before 5 and tell Sana");
  });
  it.each(["call me, اتصل فيني", "Ask Ghulam to wash the car, بروح بعدين", "Call me, ابغاك تجي", "Please tell Grace geliyorum"])(
    "unresolved Arabic/Turkish first person inside English text fails the whole text closed: %s", (t) => {
      expect(render(t)).toMatch(/^NEEDS_COMPOSITION:(arabic|turkish)_owner_first_person$/);
    });
});

describe("owner perspective — stored task records in Arabic or Turkish", () => {
  it("are never quoted, even without a detected marker (perspective cannot be verified)", () => {
    for (const t of ["الغدا جاهز", "Akşam yemeği hazır"]) {
      expect(render(t, "Sana", "Grace", "task_record")).toBe(NEEDS("unverifiable_language_in_task_record"));
    }
  });
});

describe("owner perspective — fail-closed API", () => {
  it("renderOwnerPerspective throws OwnerPerspectiveError carrying an owner-facing clarification", () => {
    let caught: unknown;
    try {
      renderOwnerPerspective("Grace said I would call back.", { ownerName: "Sana", recipientName: "Loulya", voice: "owner_to_recipient" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OwnerPerspectiveError);
    expect(isOwnerPerspectiveError(caught)).toBe(true);
    expect((caught as Error).message).toBe(ownerPerspectiveClarification("Loulya"));
    expect((caught as Error).message).toMatch(/^I didn't send anything to Loulya\./);
  });
  it("rejects an unknown voice", () => {
    expect(() => resolveOwnerPerspective("x", { ownerName: "Sana", voice: "other" as OwnerPerspectiveVoice })).toThrow(/unknown voice/);
  });
});
