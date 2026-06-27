import { describe, expect, it } from "vitest";
import { classifyCarsonInstruction } from "./carson-router";
import type { CarsonRouterInput } from "./carson-router";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PEOPLE = [
  { name: "Grace" },
  { name: "Nasira" },
  { name: "Christopher" },
  { name: "Ghulam" },
];

function classify(transcript: string, extra?: Partial<CarsonRouterInput>) {
  return classifyCarsonInstruction({ transcript, people: PEOPLE, ...extra });
}

// ── Required test cases ───────────────────────────────────────────────────────

describe("Carson router — required instruction set", () => {
  it("'Remind me to call Grace tomorrow' → reminder", () => {
    const result = classify("Remind me to call Grace tomorrow");
    expect(result.primary_domain).toBe("reminder");
    expect(result.confidence).toBeGreaterThanOrEqual(0.90);
    expect(result.domains).toContain("reminder");
    expect(result.needs_clarification).toBe(false);
  });

  it("'Tell Grace to prepare dinner at 9' → delegation", () => {
    const result = classify("Tell Grace to prepare dinner at 9");
    expect(result.primary_domain).toBe("delegation");
    expect(result.confidence).toBeGreaterThanOrEqual(0.90);
    expect(result.domains).toContain("delegation");
    expect(result.needs_clarification).toBe(false);
  });

  it("'Ask Christopher if he confirmed the delivery' → delegation", () => {
    const result = classify("Ask Christopher if he confirmed the delivery");
    expect(result.primary_domain).toBe("delegation");
    expect(result.confidence).toBeGreaterThanOrEqual(0.80);
    expect(result.domains).toContain("delegation");
    expect(result.needs_clarification).toBe(false);
  });

  it("'What is on my calendar today?' → calendar", () => {
    const result = classify("What is on my calendar today?");
    expect(result.primary_domain).toBe("calendar");
    expect(result.confidence).toBeGreaterThanOrEqual(0.90);
    expect(result.domains).toContain("calendar");
    expect(result.needs_clarification).toBe(false);
  });

  it("'Remember that Grace prefers short messages' → memory", () => {
    const result = classify("Remember that Grace prefers short messages");
    expect(result.primary_domain).toBe("memory");
    expect(result.confidence).toBeGreaterThanOrEqual(0.90);
    expect(result.domains).toContain("memory");
    expect(result.needs_clarification).toBe(false);
  });

  it("'What does this mean?' → general_answer", () => {
    const result = classify("What does this mean?");
    expect(result.primary_domain).toBe("general_answer");
    expect(result.confidence).toBeGreaterThanOrEqual(0.70);
    expect(result.domains).toContain("general_answer");
    expect(result.needs_clarification).toBe(false);
  });
});

// ── People list confidence boost ──────────────────────────────────────────────

describe("Carson router — people list confidence", () => {
  it("delegation confidence is higher when person is in People list", () => {
    const withPeople = classify("Tell Grace to prepare dinner");
    const withoutPeople = classifyCarsonInstruction({
      transcript: "Tell Grace to prepare dinner",
      people: [],
    });
    expect(withPeople.confidence).toBeGreaterThan(withoutPeople.confidence);
  });

  it("delegation still classifies correctly when people list is empty", () => {
    const result = classifyCarsonInstruction({
      transcript: "Tell Grace to prepare dinner",
      people: [],
    });
    expect(result.primary_domain).toBe("delegation");
  });

  it("unknown person name → lower confidence but still delegation", () => {
    const result = classify("Tell Ahmad to clean the pool");
    // Ahmad is not in PEOPLE list → lower confidence but still delegation
    expect(result.primary_domain).toBe("delegation");
    expect(result.confidence).toBeLessThan(0.95);
  });
});

// ── Reminder variants ─────────────────────────────────────────────────────────

describe("Carson router — reminder patterns", () => {
  it("'Set a reminder to check on Loulya at 6pm' → reminder", () => {
    const result = classify("Set a reminder to check on Loulya at 6pm");
    expect(result.primary_domain).toBe("reminder");
  });

  it("\"Don't let me forget to call the school\" → reminder", () => {
    const result = classify("Don't let me forget to call the school");
    expect(result.primary_domain).toBe("reminder");
  });

  it("'Alert me when the car is ready' → reminder", () => {
    const result = classify("Alert me when the car is ready");
    expect(result.primary_domain).toBe("reminder");
  });
});

// ── Calendar variants ─────────────────────────────────────────────────────────

describe("Carson router — calendar patterns", () => {
  it("'What do I have tomorrow?' → calendar", () => {
    const result = classify("What do I have tomorrow?");
    expect(result.primary_domain).toBe("calendar");
  });

  it("'Schedule a meeting with Grace on Monday' → calendar", () => {
    const result = classify("Schedule a meeting with Grace on Monday");
    expect(result.primary_domain).toBe("calendar");
  });

  it("'What is on my calendar this week?' → calendar", () => {
    const result = classify("What is on my calendar this week?");
    expect(result.primary_domain).toBe("calendar");
  });
});

// ── Memory variants ───────────────────────────────────────────────────────────

describe("Carson router — memory patterns", () => {
  it("'From now on always send Grace short messages' → memory", () => {
    const result = classify("From now on always send Grace short messages");
    expect(result.primary_domain).toBe("memory");
  });

  it("'I prefer shorter daily briefs' → memory", () => {
    const result = classify("I prefer shorter daily briefs");
    expect(result.primary_domain).toBe("memory");
  });
});

// ── WhatsApp variants ─────────────────────────────────────────────────────────

describe("Carson router — whatsapp patterns", () => {
  it("'Send Grace a message saying the groceries are ready' → whatsapp", () => {
    const result = classify("Send Grace a message saying the groceries are ready");
    expect(result.primary_domain).toBe("whatsapp");
  });

  it("'WhatsApp Nasira now' → whatsapp", () => {
    const result = classify("WhatsApp Nasira now");
    expect(result.primary_domain).toBe("whatsapp");
  });

  it("'Text Christopher saying thank you' → whatsapp", () => {
    const result = classify("Text Christopher saying thank you");
    expect(result.primary_domain).toBe("whatsapp");
  });
});

// ── Delegation variants ───────────────────────────────────────────────────────

describe("Carson router — delegation patterns", () => {
  it("'Ask Nasira to clean the bedrooms' → delegation", () => {
    const result = classify("Ask Nasira to clean the bedrooms");
    expect(result.primary_domain).toBe("delegation");
    expect(result.confidence).toBeGreaterThanOrEqual(0.95);
  });

  it("'Have Christopher prepare dinner' → delegation", () => {
    const result = classify("Have Christopher prepare dinner");
    expect(result.primary_domain).toBe("delegation");
  });

  it("'Get Ghulam to bring the cars around' → delegation", () => {
    const result = classify("Get Ghulam to bring the cars around");
    expect(result.primary_domain).toBe("delegation");
  });

  it("'Follow up with Grace whether the flowers arrived' → delegation", () => {
    const result = classify("Follow up with Grace whether the flowers arrived");
    expect(result.primary_domain).toBe("delegation");
  });
});

// ── General answer variants ───────────────────────────────────────────────────

describe("Carson router — general_answer patterns", () => {
  it("'What is the weather like today?' → general_answer", () => {
    const result = classify("What is the weather like today?");
    expect(result.primary_domain).toBe("general_answer");
  });

  it("'How do I contact the school?' → general_answer", () => {
    const result = classify("How do I contact the school?");
    expect(result.primary_domain).toBe("general_answer");
  });

  it("'Explain what the status means' → general_answer", () => {
    const result = classify("Explain what the status means");
    expect(result.primary_domain).toBe("general_answer");
  });
});

// ── Social acknowledgement ───────────────────────────────────────────────────

describe("Carson router — social acknowledgement", () => {
  it.each([
    "thank you",
    "thanks",
    "okay thanks",
    "perfect thanks",
    "thank you Carson",
  ])("'%s' → social_ack, not work", (transcript) => {
    const result = classify(transcript);
    expect(result.primary_domain).toBe("social_ack");
    expect(result.domains).toEqual(["social_ack"]);
    expect(result.needs_clarification).toBe(false);
  });

  it("keeps thank-you message content routed as WhatsApp when there is a recipient", () => {
    const result = classify("Text Christopher saying thank you");
    expect(result.primary_domain).toBe("whatsapp");
  });
});

// ── Disambiguation: reminder vs memory ───────────────────────────────────────

describe("Carson router — reminder vs memory disambiguation", () => {
  it("'Remind me to call Grace tomorrow' → reminder (not memory)", () => {
    const result = classify("Remind me to call Grace tomorrow");
    expect(result.primary_domain).toBe("reminder");
    expect(result.primary_domain).not.toBe("memory");
  });

  it("'Remember that Grace prefers short messages' → memory (not reminder)", () => {
    const result = classify("Remember that Grace prefers short messages");
    expect(result.primary_domain).toBe("memory");
    expect(result.primary_domain).not.toBe("reminder");
  });

  it("'Remember to buy flowers for tonight' → reminder (not memory)", () => {
    const result = classify("Remember to buy flowers for tonight");
    expect(result.primary_domain).toBe("reminder");
    expect(result.primary_domain).not.toBe("memory");
  });
});

// ── Self-pronoun guard ─────────────────────────────────────────────────────────

describe("Carson router — self-pronoun guard", () => {
  it("'Tell me what happened' → general_answer not delegation", () => {
    const result = classify("Tell me what happened");
    expect(result.primary_domain).not.toBe("delegation");
  });
});

// ── To-do vs Notes routing ──────────────────────────────────────────────────────

describe("Carson router — To-do vs Notes", () => {
  it("'Add buy flowers to my to-do list' → todo", () => {
    const result = classify("Add buy flowers to my to-do list");
    expect(result.primary_domain).toBe("todo");
    expect(result.confidence).toBeGreaterThanOrEqual(0.90);
    expect(result.needs_clarification).toBe(false);
  });

  it("'Add renew passport' (bare add, no other signal) → todo, not unknown", () => {
    const result = classify("Add renew passport");
    expect(result.primary_domain).toBe("todo");
    expect(result.needs_clarification).toBe(false);
  });

  it("'What's on my to-do list?' → todo", () => {
    const result = classify("What's on my to-do list?");
    expect(result.primary_domain).toBe("todo");
    expect(result.confidence).toBeGreaterThanOrEqual(0.90);
  });

  it("'Mark buy flowers done' → todo", () => {
    const result = classify("Mark buy flowers done");
    expect(result.primary_domain).toBe("todo");
    expect(result.confidence).toBeGreaterThanOrEqual(0.80);
  });

  it("'Save this idea' → note, not todo", () => {
    const result = classify("Save this idea");
    expect(result.primary_domain).toBe("note");
    expect(result.confidence).toBeGreaterThanOrEqual(0.90);
  });

  it("'Remember this information' → note, not memory or reminder", () => {
    const result = classify("Remember this information");
    expect(result.primary_domain).toBe("note");
  });

  it("'Hold this thought' → note", () => {
    const result = classify("Hold this thought");
    expect(result.primary_domain).toBe("note");
  });

  it("'Add this to my notes' → note, not todo, even though it starts with 'add'", () => {
    const result = classify("Add this to my notes");
    expect(result.primary_domain).toBe("note");
    expect(result.confidence).toBeGreaterThanOrEqual(0.90);
  });

  it("'Remember to call the vet' still routes to reminder, not note/todo", () => {
    const result = classify("Remember to call the vet");
    expect(result.primary_domain).toBe("reminder");
  });

  it("'Remember that Grace prefers short messages' still routes to memory, not note", () => {
    const result = classify("Remember that Grace prefers short messages");
    expect(result.primary_domain).toBe("memory");
  });

  it("'Note to follow the Gemini plan' → note, not todo/action", () => {
    const result = classify("Note to follow the Gemini plan");
    expect(result.primary_domain).toBe("note");
    expect(result.needs_clarification).toBe(false);
  });

  it("'Save this note: follow Gemini plan' → note", () => {
    const result = classify("Save this note: follow Gemini plan");
    expect(result.primary_domain).toBe("note");
  });

  it("'Remember this idea for later' → note", () => {
    const result = classify("Remember this idea for later");
    expect(result.primary_domain).toBe("note");
  });

  it("'Hold this thought about the menu' → note", () => {
    const result = classify("Hold this thought about the menu");
    expect(result.primary_domain).toBe("note");
  });
});

// ── Unknown / low-confidence ──────────────────────────────────────────────────

describe("Carson router — unknown", () => {
  it("empty-ish instruction → unknown", () => {
    const result = classifyCarsonInstruction({ transcript: "hmm", people: [] });
    expect(result.primary_domain).toBe("unknown");
    expect(result.needs_clarification).toBe(true);
    expect(result.clarification_question).toBeTruthy();
  });
});

// ── Structured output shape ────────────────────────────────────────────────────

describe("Carson router — output shape", () => {
  it("always returns required fields", () => {
    const result = classify("Ask Grace to prepare the guest room");
    expect(result).toHaveProperty("domains");
    expect(result).toHaveProperty("primary_domain");
    expect(result).toHaveProperty("confidence");
    expect(result).toHaveProperty("reason");
    expect(result).toHaveProperty("needs_clarification");
    expect(result).toHaveProperty("clarification_question");
    expect(Array.isArray(result.domains)).toBe(true);
    expect(result.domains.length).toBeGreaterThan(0);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
    expect(typeof result.reason).toBe("string");
    expect(typeof result.needs_clarification).toBe("boolean");
  });
});
