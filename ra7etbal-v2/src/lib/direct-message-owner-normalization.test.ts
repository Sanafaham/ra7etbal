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
function render(text: string, ownerName: string | null = "Sana", recipientName: string | null = "Grace", voice: OwnerPerspectiveVoice = "owner_to_recipient", currentInstruction: string | null = null) {
  const r = resolveOwnerPerspective(text, { ownerName, recipientName, voice, currentInstruction });
  return r.status === "needs_composition" ? NEEDS(r.reason ?? "") : r.text;
}
/** The message as the owner's own current instruction delivered it: "Tell <recipient> <text>". */
function told(text: string, recipientName: string) {
  return render(text, "Sana", recipientName, "owner_to_recipient", `Tell ${recipientName} ${text}`);
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
    // Recipient Loulya: sent to Grace herself it fails earlier, as the
    // recipient named as a third party (see "recipient is never a third party").
    expect(render("Grace said I would call back.", "Sana", "Loulya")).toBe(NEEDS("reported_speech_first_person"));
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
  it('renders "I need Grace to call me." consistently in third person (to someone other than Grace)', () => {
    expect(render("I need Grace to call me.", "Sana", "Loulya")).toBe("Sana needs Grace to call Sana.");
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
  const r = (t: string) => told(t, "Loulya");
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
    expect(told("I'd like her to meet my mother.", "Loulya")).toBe("Sana would like you to meet Sana's mother.");
    expect(told("I need him to call me back.", "Christopher")).toBe("Sana needs you to call Sana back.");
  });
  it("a third-party pronoun is never turned into the recipient or the owner", () => {
    expect(render("Tell him to call me.")).toBe("Tell him to call Sana.");
    expect(render("My mother called, ask her to wait.")).toBe(NEEDS("third_party_ambiguity_introduced"));
  });
  it("recipient as a subject (needs verb re-agreement) or a possessive-vs-object 'her' fails closed", () => {
    // Still fail closed. Since the checker review these stop earlier, at the stricter recipient anchor
    // (no "me"/"my" after the pronoun), instead of at the subject / possessive checks.
    expect(render("I'd like her to call when she lands.", "Sana", "Loulya")).toBe(NEEDS("recipient_reference_unanchored"));
    expect(render("I want to give her money.", "Sana", "Loulya")).toBe(NEEDS("recipient_reference_unanchored"));
    // The subject / possessive checks still apply inside the anchored shape.
    expect(told("I'd like her to call me when she lands.", "Loulya")).toBe(NEEDS("recipient_reference_unanchored"));
    expect(told("I want to give her my money.", "Loulya")).toBe(NEEDS("recipient_reference_ambiguous"));
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
      const once = told(t, "Loulya");
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

// Composed (model-written) text, verified — never rewritten.
function composed(text: string, declared: "rendered" | "unclear" | undefined = "rendered", recipientName = "Grace", ownerName: string | null = "Sana") {
  const r = resolveOwnerPerspective(text, { ownerName, recipientName, voice: "composed", declared });
  return r.status === "needs_composition" ? NEEDS(r.reason ?? "") : r.text;
}

describe("owner perspective — Arabic: frozen defense-in-depth tables (detected, never rendered)", () => {
  // The tables are a backstop, not the architecture: they run in every voice
  // and catch owner first person both in the owner's own words and in a
  // model's composed text that claims "rendered".
  it.each(["اتصلي فيني", "قول للوليا إني أبغاها تتصل فيني", "وأنا جاي"])("explicit marker fails closed: %s", (t) => {
    expect(render(t)).toBe(NEEDS("arabic_owner_first_person"));
    expect(composed(t)).toBe(NEEDS("arabic_owner_first_person"));
  });
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
    expect(composed(t)).toBe(NEEDS("arabic_owner_first_person"));
  });
  // Negative controls: the tables do not flag imperatives that look like
  // first-person forms, third-person and owner-named text, or nouns ending
  // like "me" — proven in composed voice, where Arabic is accepted.
  const AR_NEGATIVE = [
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
  ];
  it.each(AR_NEGATIVE)("tables do not flag (composed, declared rendered → unchanged): %s", (t) => {
    expect(composed(t)).toBe(t);
  });
  // No model call on deterministic paths: the owner's own Arabic words cannot
  // be verified, so they fail closed instead of being guessed at.
  it.each(AR_NEGATIVE)("deterministic voices fail closed on unverifiable Arabic: %s", (t) => {
    expect(render(t)).toBe(NEEDS("unverifiable_language"));
    expect(render(t, "Sana", "Grace", "task_text")).toBe(NEEDS("unverifiable_language"));
  });
  it("quoted Arabic is reported speech: not treated as the owner, and not unverifiable", () => {
    expect(render("Tell her «بروح السوق»")).toBe("Tell her «بروح السوق»");
    expect(render('He wrote "ابغاك تجي" yesterday')).toBe('He wrote "ابغاك تجي" yesterday');
  });
});

describe("owner perspective — Turkish: frozen defense-in-depth tables (detected, never rendered)", () => {
  it.each(["Beni ara lütfen", "Bana haber ver", "Ben eve geliyorum ve çok yorgunum"])("explicit marker fails closed: %s", (t) => {
    expect(render(t)).toBe(NEEDS("turkish_owner_first_person"));
    expect(composed(t)).toBe(NEEDS("turkish_owner_first_person"));
  });
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
    expect(composed(t)).toBe(NEEDS("turkish_owner_first_person"));
  });
  const TR_NEGATIVE = [
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
  ];
  it.each(TR_NEGATIVE)("tables do not flag (composed, declared rendered → unchanged): %s", (t) => {
    expect(composed(t)).toBe(t);
  });
  it.each(TR_NEGATIVE.filter((t) => t !== "Durum nedir" && t !== "Yorum yap"))(
    "deterministic voices fail closed on unverifiable Turkish: %s", (t) => {
      expect(render(t)).toBe(NEEDS("unverifiable_language"));
    });
  it.each(["Ben will drive you.", "Dim the lights.", "The victim of an interim plan.", "Tim is here.", "Park the car at the deli.", "Give the parameter."])(
    "English words that end like Turkish first person are neither flagged nor treated as Turkish: %s", (t) => {
      expect(render(t)).toBe(t);
    });
  it("quoted Turkish first person is reported speech and is not treated as the owner", () => {
    expect(render('She said "geliyorum" earlier')).toBe('She said "geliyorum" earlier');
  });
});

describe("owner perspective — mixed language", () => {
  it("the owner's own mixed English/Arabic words fail closed on deterministic paths (never guessed)", () => {
    expect(render("Ask Ghulam يغسل السيارة before 5 and tell me")).toBe(NEEDS("unverifiable_language"));
    expect(render("Please tell her geliyorum", "Sana", "Loulya")).toBe(NEEDS("turkish_owner_first_person"));
  });
  it.each(["call me, اتصل فيني", "Ask Ghulam to wash the car, بروح بعدين", "Call me, ابغاك تجي", "Please tell Loulya geliyorum"])(
    "Arabic/Turkish first person inside English text fails the whole text closed: %s", (t) => {
      expect(render(t)).toMatch(/^NEEDS_COMPOSITION:(arabic|turkish)_owner_first_person$/);
    });
  it("composed mixed text the model declared rendered is accepted only when no owner first person remains", () => {
    expect(composed("Sana says الغدا جاهز at 8.")).toBe("Sana says الغدا جاهز at 8.");
    expect(composed("Sana is late, بروح بعدين")).toBe(NEEDS("arabic_owner_first_person"));
  });
});

describe("owner perspective — stored task records in Arabic or Turkish", () => {
  it("are never quoted, even without a detected marker (perspective cannot be verified)", () => {
    for (const t of ["الغدا جاهز", "Akşam yemeği hazır"]) {
      expect(render(t, "Sana", "Grace", "task_record")).toBe(NEEDS("unverifiable_language_in_task_record"));
    }
  });
});

describe("owner perspective — recipient is never a third party in their own message", () => {
  // Demonstrated defect: Clear My Head's message item "Tell Sarah I'm running
  // late." became "Hi Sarah, could you tell Sarah Sana is running late?".
  it.each([
    ["Hi Sarah, could you tell Sarah Sana is running late? Let Sana know when done.", "Sarah"],
    ["Tell Sarah I'm running late.", "Sarah"],
    ["Tell Loulya I love her.", "Loulya"],
    ["Hi Loulya, could you tell Loulya Sana loves her? Let Sana know when done.", "Loulya"],
    ["Put it in Grace's room.", "Grace"],
    ["I need Grace to call me.", "Grace"],
    ["Grace said I would call back.", "Grace"],
  ])("fails closed in every voice: %s", (t, recipient) => {
    for (const voice of ["owner_to_recipient", "task_text", "task_record"] as const) {
      expect(render(t, "Sana", recipient, voice)).toBe(NEEDS("recipient_named_as_third_party"));
    }
    expect(composed(t, "rendered", recipient)).toBe(NEEDS("recipient_named_as_third_party"));
  });
  it.each([
    ["Sarah, Sana is running late.", "Sarah"],
    ["Hi Sarah, Sana is running late tonight.", "Sarah"],
    ["Thanks, Grace.", "Grace"],
    ["Hi Grace, could you buy flowers? Let Sana know when done.", "Grace"],
    ["Loulya, Sana loves you.", "Loulya"],
  ])("the recipient as addressee is allowed: %s", (t, recipient) => {
    expect(composed(t, "rendered", recipient)).toBe(t);
    expect(render(t, "Sana", recipient)).toBe(t);
  });
  it("other people stay third parties", () => {
    expect(render("Take Loulya to her appointment and call me after.", "Sana", "Grace", "task_text"))
      .toBe("Take Loulya to her appointment and call Sana after.");
  });
});

describe("owner perspective — composed voice (existing extraction call, declared status)", () => {
  it("missing, invalid or unclear status fails closed even for clean text", () => {
    const missing = resolveOwnerPerspective("Sana is running late.", { ownerName: "Sana", recipientName: "Grace", voice: "composed" });
    expect(missing).toMatchObject({ status: "needs_composition", reason: "composition_status_missing" });
    expect(composed("Sana is running late.", "unclear")).toBe(NEEDS("composition_unclear"));
    expect(composed("Sana is running late.", "maybe" as never)).toBe(NEEDS("composition_status_missing"));
  });
  it("the declaration is not proof: owner first person left in 'rendered' text fails closed", () => {
    expect(composed("I'm running late.")).toBe(NEEDS("composed_owner_first_person"));
    expect(composed("Call me when you're done.")).toBe(NEEDS("composed_owner_first_person"));
  });
  it("Loulya class: a he/she whose only possible referent is the recipient fails closed", () => {
    expect(composed("Sana loves her.", "rendered", "Loulya")).toBe(NEEDS("composed_pronoun_without_antecedent"));
    expect(composed("Hi Loulya, Sana misses her.", "rendered", "Loulya")).toBe(NEEDS("composed_pronoun_without_antecedent"));
    expect(composed("Please call her back.", "rendered", "Loulya")).toBe(NEEDS("composed_pronoun_without_antecedent"));
  });
  it("is verified, never rewritten: owner, recipient and third parties keep their referents", () => {
    for (const t of [
      "Sana loves you.",
      "Sana is running late tonight.",
      "Sana is on her way.",
      "Sana misses you and would love to hear from you. Could you give her a call?",
      "Take Loulya to her appointment and call Sana after.",
      "Your mother called; please call her back.",
      "Ali said: \"I will come at 5.\"",
    ]) expect(composed(t, "rendered", "Grace")).toBe(t);
  });
  it("quoted speech keeps its speaker; unquoted reported speech the model marks unclear fails closed", () => {
    expect(composed("Ali said: “I'll come at 5.”")).toBe("Ali said: “I'll come at 5.”");
    expect(composed("Ali said Sana would come.", "unclear")).toBe(NEEDS("composition_unclear"));
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

// Independent checker review of PR #430 (2026-10-02): B1, M1, M2, M3. Each input below was reproduced
// against the pre-fix boundary and produced the wrong text shown in its test name.
describe("owner perspective — checker regressions (he/him/her, inverted questions, language detection)", () => {
  it.each([
    "Maria is sick. I need her to rest.", // was "…Sana needs you to rest." (Maria's rest assigned to Grace)
    "maria is sick. i need her to rest.",
    "The plumber is coming at 3. I need him to fix the sink.", // was "…Sana needs you to fix the sink."
    "Christopher, I need him to call me.", // was "Christopher, Sana needs you to call Sana."
    "Yes let her in, I want her to clean the kitchen.", // was "Yes let you in, Sana wants you to clean the kitchen."
  ])("B1: %j — a he/him/her with no provable referent is never turned into the recipient; fails closed", (input) => {
    expect(render(input)).toBe(NEEDS("recipient_reference_unanchored"));
  });

  it.each([
    "I want her to call Maria and ask her to come.", // was "…call Maria and ask you to come."
    "I need her to take Maria to school and wait for her.", // was "…and wait for you."
    "I need her to take maria to school and wait for her.",
    "I need him to call Ali and tell him to wait.", // was "…call Ali and tell you to wait."
    "I want her to call the guest. Ask her to come at 5.", // was "…Ask you to come at 5."
    "I will call her. Maria is with her.", // was "Sana will call you. Maria is with you."
    "I need him in bed by 8.", // was "Sana needs you in bed by 8." (to a nanny, about a child)
    "I want him to stay.", // was "Sana wants you to stay."
  ])("B1 re-review: %j — only one pronoun may become the recipient, and only when it points back to the owner; fails closed", (input) => {
    expect(render(input)).toBe(NEEDS("recipient_reference_unanchored"));
  });

  it.each([
    "The groceries are in the car, aldım.",
    "You can leave at 5, döndüm.",
    "It is fine, the bread is on the table, yaptım.",
  ])("M2 side effect: %j — Turkish owner first person inside English text is still refused", (input) => {
    expect(render(input)).toBe(NEEDS("turkish_owner_first_person"));
  });

  it("B1: the provable shape still reaches the recipient as 'you' when the current instruction names them ('Tell Loulya I would like her to call me')", () => {
    expect(told("I would like her to call me.", "Loulya")).toBe("Sana would like you to call Sana.");
    expect(told("I need him to call me back.", "Christopher")).toBe("Sana needs you to call Sana back.");
  });

  // Owner ruling 2026-10-03: a him/her that the CURRENT instruction does not resolve is never turned into the
  // recipient — it may have been named outside it (an earlier Talk turn, a child the recipient knows about).
  it.each([
    ["I need him to call me back.", "Christopher", null],
    ["I need her to call me back.", "Loulya", null],
    ["I need him to call me back.", "Christopher", "I need him to call me back."],
    ["I need him to call me back.", "Christopher", "Message Christopher."],
    ["I need her to call me back.", "Loulya", "Maria is sick. Tell Loulya I need her to call me back."],
    ["I need him to call me back.", "Christopher", "Tell Grace I need him to call me back."],
    ["I would like her to call me.", "Loulya", "Tell Loulya I would like her to call me soon."],
  ])("outside context: %j to %s with instruction %j is not reinterpreted as the recipient; fails closed", (text, recipient, instruction) => {
    expect(render(text, "Sana", recipient, "owner_to_recipient", instruction)).toBe(NEEDS("recipient_reference_unanchored"));
  });

  it("B1: when the caller says he/him/her can never mean the recipient, the pronoun stays a third party", () => {
    const r = resolveOwnerPerspective("Yes let her in, I want her to clean the kitchen.", {
      ownerName: "Sana", recipientName: "Grace", voice: "owner_to_recipient", thirdPersonMayMeanRecipient: false,
    });
    expect(r).toMatchObject({ status: "rendered", text: "Yes let her in, Sana wants her to clean the kitchen." });
  });

  it.each([
    "Can I call you later?", // was "Can Sana calls you later?"
    "What time should I come?", // was "…should Sana comes?"
    "Do I need to bring anything?", // was "Do Sana needs…"
    "Did I leave my keys there?", // was "Did Sana leaves Sana's keys there?"
    "You and I need to talk.", // was "You and Sana needs to talk."
  ])("M1: %j — 'I' after an auxiliary or 'and' has no safe verb agreement; fails closed", (input) => {
    expect(render(input)).toBe(NEEDS("unresolved_owner_verb"));
  });

  it.each([
    "I love you and miss you.", // was "Sana loves you and miss you."
    "I am home and need dinner.", // was "Sana is home and need dinner."
    "I don't know and don't care.", // was "Sana doesn't know and don't care."
    "I get home at 5 and leave at 6.", // was "…and leave at 6."
    "I'm home and need dinner.",
  ])("M-1 (third review): %j — a second owner verb after and/or/but that needs agreement fails closed", (input) => {
    expect(render(input)).toBe(NEEDS("unresolved_owner_verb"));
  });

  it.each([
    ["I need you to pick up the kids and bring them home.", "Sana needs you to pick up the kids and bring them home."],
    ["I want you to wait and call me later.", "Sana wants you to wait and call Sana later."],
    ["I need you to come at 5 and wait outside.", "Sana needs you to come at 5 and wait outside."],
    ["I want you to clean the kitchen and take out the trash.", "Sana wants you to clean the kitchen and take out the trash."],
    ["I would like her to call me and tell me.", "Sana would like you to call Sana and tell Sana."],
    ["I am late, please start and call me.", "Sana is late, please start and call Sana."],
    ["I am late and you need to start dinner.", "Sana is late and you need to start dinner."],
  ])("M-1b (final review): %j — verbs after 'to' or in another clause are not the owner's; renders %j", (input, expected) => {
    expect(input.includes("her") ? told(input, "Loulya") : render(input)).toBe(expected);
  });

  it.each([
    "I am going to the market and need the car.", // was sent as "Sana is going to the market and need the car."
    "I go to work and come back at 6.",
    "I come to the house and wait.",
    "I went to the bank and need the receipt.",
    "I am close to home and need the gate open.",
    "I want to go home and need the car.",
    "I need to rest and want quiet.",
    "I like to cook and want fresh fish.",
    "I love you, and miss you.",
    "I need the car, and want it clean.",
  ])("M-1b confirmation: %j — a preposition or the owner's own 'to' does not end the owner's clause; fails closed", (input) => {
    expect(render(input)).toBe(NEEDS("unresolved_owner_verb"));
  });

  it.each([
    ["I want Ali to come and wait outside.", "Sana wants Ali to come and wait outside."],
    ["I need the driver to come and wait.", "Sana needs the driver to come and wait."],
    ["I need the plumber to come and check the sink.", "Sana needs the plumber to come and check the sink."],
    ["I want the kids to wait and call me.", "Sana wants the kids to wait and call Sana."],
    ["I want the guests to arrive and wait.", "Sana wants the guests to arrive and wait."],
    ["I want everyone to wait and stay calm.", "Sana wants everyone to wait and stay calm."],
  ])("M-1b confirmation: %j — someone else's infinitive owns the verbs after it; renders %j", (input, expected) => {
    expect(render(input)).toBe(expected);
  });

  it.each([
    "I take Maria to school and need the car.", // was "Sana takes Maria to school and need the car."
    "I take my son to school and need the car.",
    "I send them to you and want a reply.",
    "I am ready to go and need the car.",
  ])("M-1b confirmation: %j — a preposition 'to' after another person keeps the owner's clause open; fails closed", (input) => {
    expect(render(input)).toBe(NEEDS("unresolved_owner_verb"));
  });

  it("M-1b: task text keeps the recipient's coordinated verbs", () => {
    expect(render("I need you to buy milk and bring it home.", "Sana", "Grace", "task_text")).toBe("Sana needs you to buy milk and bring it home.");
  });

  it.each(["I love you but hate the noise.", "I know it and accept it.", "I need it and want it now."])(
    "M-1: %j — a second owner verb in the owner's own clause still fails closed", (input) => {
      expect(render(input)).toBe(NEEDS("unresolved_owner_verb"));
    });

  it("M-1: coordination that needs no second agreement still renders", () => {
    expect(render("I need milk and bread.")).toBe("Sana needs milk and bread.");
    expect(render("I'll come and see you.")).toBe("Sana will come and see you.");
    expect(render("I miss you and Loulya.")).toBe("Sana misses you and Loulya.");
  });

  it("M2: one Turkish-looking name in clearly English text does not make it Turkish", () => {
    expect(render("Please give the keys to Gökhan.")).toBe("Please give the keys to Gökhan.");
    const composed = resolveOwnerPerspective("Sana is running late tonight.", {
      ownerName: "Sana", recipientName: "Grace", voice: "composed", declared: "rendered", sourceText: "Tell Ayşe I am running late tonight",
    });
    expect(composed.status).not.toBe("needs_composition");
  });

  it("M2: real Turkish is still detected and refused on no-model paths", () => {
    expect(render("Akşam yemeği hazır")).toBe(NEEDS("unverifiable_language"));
    expect(render("Tamam")).toBe(NEEDS("unverifiable_language"));
  });

  it.each([
    ["Tell Grace to buy خبز and tell Christopher dinner is at 9", "Can you please have dinner ready by 9?", false],
    ["خلي قريس تجيب السيارة الساعة ٥", "Please bring the car at 5, قريس.", true],
    ["خلي قريس تجيب الأغراض لغرفتي", "Bring the groceries to Sana's room.", true],
  ])("M3: source %j → composed %j refused=%s (Arabic judged by share of letters, not one token)", (sourceText, out, refused) => {
    const r = resolveOwnerPerspective(out, { ownerName: "Sana", recipientName: "Grace", voice: "composed", declared: "rendered", sourceText });
    expect(r.status === "needs_composition" && r.reason === "composition_language_changed").toBe(refused);
  });
});
