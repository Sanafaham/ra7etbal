import { describe, expect, it } from "vitest";
import {
  planCarsonInstruction,
  delegationAgent,
  reminderAgent,
  whatsappAgent,
  calendarAgent,
  memoryAgent,
  generalAnswerAgent,
  taskAgent,
} from "./carson-planner";
import type { CarsonPlanInput } from "./carson-planner";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PEOPLE: CarsonPlanInput["people"] = [
  { name: "Grace",       phone: "+971500000001", whatsapp_opted_in: true },
  { name: "Nasira",      phone: "+971500000002", whatsapp_opted_in: true },
  { name: "Christopher", phone: "+971500000003", whatsapp_opted_in: true },
  { name: "Ghulam",      phone: "+971500000004", whatsapp_opted_in: true },
];

function plan(transcript: string, extra?: Partial<CarsonPlanInput>) {
  return planCarsonInstruction({ transcript, people: PEOPLE, ...extra });
}

// ── Required test cases ───────────────────────────────────────────────────────

describe("planCarsonInstruction — reminder only", () => {
  it("produces a single reminderAgent plan", () => {
    const result = plan("Remind me to call Grace tomorrow");
    expect(result.router_result.primary_domain).toBe("reminder");
    expect(result.agent_plans).toHaveLength(1);
    expect(result.agent_plans[0]!.agent_name).toBe("reminderAgent");
  });

  it("extracts reminder text", () => {
    const result = plan("Remind me to call Grace tomorrow");
    const agent = result.agent_plans[0]!;
    const textEntity = agent.required_entities.find(e => e.name === "reminder_text");
    expect(textEntity?.found).toBe(true);
    expect(textEntity?.value).toBeTruthy();
  });

  it("extracts time expression 'tomorrow'", () => {
    const result = plan("Remind me to call Grace tomorrow");
    const agent = result.agent_plans[0]!;
    const timeEntity = agent.required_entities.find(e => e.name === "time_expression");
    expect(timeEntity?.found).toBe(true);
    expect(timeEntity?.value).toMatch(/tomorrow/i);
  });

  it("is safe to execute when time is present", () => {
    const result = plan("Remind me to call Grace tomorrow");
    expect(result.agent_plans[0]!.safe_to_execute).toBe(true);
    expect(result.safe_to_execute).toBe(true);
    expect(result.blockers).toHaveLength(0);
  });

  it("plan has all required output fields", () => {
    const result = plan("Remind me to call Grace tomorrow");
    expect(result).toMatchObject({
      agent_plans: expect.any(Array),
      combined_summary: expect.any(String),
      blockers: expect.any(Array),
      safe_to_execute: expect.any(Boolean),
      requires_human_approval: expect.any(Boolean),
    });
  });
});

// ── Multi-domain: delegation + whatsapp + reminder ────────────────────────────

describe("planCarsonInstruction — delegation + whatsapp + reminder", () => {
  // This instruction naturally triggers all three domains:
  //   delegation: "Ask Grace to prepare dinner"
  //   whatsapp:   "send Nasira a message saying everything is ready"
  //   reminder:   "remind me to follow up tomorrow"
  const MULTI = "Ask Grace to prepare dinner, send Nasira a message saying everything is ready, and remind me to follow up tomorrow";

  it("router returns all three domains", () => {
    const result = plan(MULTI);
    expect(result.router_result.domains).toContain("delegation");
    expect(result.router_result.domains).toContain("whatsapp");
    expect(result.router_result.domains).toContain("reminder");
  });

  it("produces three agent plans", () => {
    const result = plan(MULTI);
    const names = result.agent_plans.map(p => p.agent_name);
    expect(names).toContain("delegationAgent");
    expect(names).toContain("whatsappAgent");
    expect(names).toContain("reminderAgent");
  });

  it("delegationAgent resolves Grace correctly", () => {
    const result = plan(MULTI);
    const agent = result.agent_plans.find(p => p.agent_name === "delegationAgent")!;
    const personEntity = agent.required_entities.find(e => e.name === "person_name");
    expect(personEntity?.found).toBe(true);
    expect(personEntity?.value).toMatch(/grace/i);
  });

  it("whatsappAgent resolves Nasira correctly", () => {
    const result = plan(MULTI);
    const agent = result.agent_plans.find(p => p.agent_name === "whatsappAgent")!;
    const recipientEntity = agent.required_entities.find(e => e.name === "recipient_name");
    expect(recipientEntity?.found).toBe(true);
    expect(recipientEntity?.value).toMatch(/nasira/i);
  });

  it("reminderAgent finds 'tomorrow'", () => {
    const result = plan(MULTI);
    const agent = result.agent_plans.find(p => p.agent_name === "reminderAgent")!;
    const timeEntity = agent.required_entities.find(e => e.name === "time_expression");
    expect(timeEntity?.found).toBe(true);
    expect(timeEntity?.value).toMatch(/tomorrow/i);
  });

  it("combined_summary is non-empty", () => {
    const result = plan(MULTI);
    expect(result.combined_summary.length).toBeGreaterThan(0);
  });
});

// ── Calendar question ─────────────────────────────────────────────────────────

describe("planCarsonInstruction — calendar question", () => {
  it("produces a calendarAgent plan", () => {
    const result = plan("What is on my calendar today?");
    expect(result.router_result.primary_domain).toBe("calendar");
    const agent = result.agent_plans.find(p => p.agent_name === "calendarAgent");
    expect(agent).toBeDefined();
  });

  it("proposes query_calendar with range today", () => {
    const result = plan("What is on my calendar today?");
    const agent = result.agent_plans.find(p => p.agent_name === "calendarAgent")!;
    expect(agent.proposed_actions[0]!.type).toBe("query_calendar");
    expect(agent.proposed_actions[0]!.range).toBe("today");
  });

  it("is safe to execute", () => {
    const result = plan("What is on my calendar today?");
    expect(result.safe_to_execute).toBe(true);
    expect(result.requires_human_approval).toBe(false);
    expect(result.blockers).toHaveLength(0);
  });

  it("query for 'tomorrow' uses tomorrow range", () => {
    const result = plan("What do I have tomorrow?");
    const agent = result.agent_plans.find(p => p.agent_name === "calendarAgent")!;
    expect(agent.proposed_actions[0]!.range).toBe("tomorrow");
  });
});

// ── Memory instruction ────────────────────────────────────────────────────────

describe("planCarsonInstruction — memory instruction", () => {
  it("produces a memoryAgent plan", () => {
    const result = plan("Remember that Grace prefers short messages");
    expect(result.router_result.primary_domain).toBe("memory");
    const agent = result.agent_plans.find(p => p.agent_name === "memoryAgent");
    expect(agent).toBeDefined();
  });

  it("extracts instruction text from 'remember that'", () => {
    const result = plan("Remember that Grace prefers short messages");
    const agent = result.agent_plans.find(p => p.agent_name === "memoryAgent")!;
    const entity = agent.required_entities.find(e => e.name === "instruction_text");
    expect(entity?.found).toBe(true);
    expect(entity?.value).toMatch(/grace prefers short messages/i);
  });

  it("proposes save_instruction action", () => {
    const result = plan("Remember that Grace prefers short messages");
    const agent = result.agent_plans.find(p => p.agent_name === "memoryAgent")!;
    expect(agent.proposed_actions[0]!.type).toBe("save_instruction");
  });

  it("is safe to execute", () => {
    const result = plan("Remember that Grace prefers short messages");
    expect(result.safe_to_execute).toBe(true);
    expect(result.requires_human_approval).toBe(false);
  });

  it("'from now on' instruction extracts correctly", () => {
    const result = plan("From now on always send Grace short messages");
    const agent = result.agent_plans.find(p => p.agent_name === "memoryAgent")!;
    expect(agent.required_entities[0]!.found).toBe(true);
    expect(agent.proposed_actions[0]!.type).toBe("save_instruction");
  });
});

// ── General answer ────────────────────────────────────────────────────────────

describe("planCarsonInstruction — general answer", () => {
  it("produces a generalAnswerAgent plan", () => {
    const result = plan("What does this mean?");
    expect(result.router_result.primary_domain).toBe("general_answer");
    const agent = result.agent_plans.find(p => p.agent_name === "generalAnswerAgent");
    expect(agent).toBeDefined();
  });

  it("proposes answer_question action", () => {
    const result = plan("What does this mean?");
    const agent = result.agent_plans.find(p => p.agent_name === "generalAnswerAgent")!;
    expect(agent.proposed_actions[0]!.type).toBe("answer_question");
  });

  it("is always safe to execute", () => {
    const result = plan("What does this mean?");
    expect(result.safe_to_execute).toBe(true);
    expect(result.blockers).toHaveLength(0);
  });

  it("'how do' question maps to general_answer", () => {
    const result = plan("How do I contact the school?");
    expect(result.router_result.primary_domain).toBe("general_answer");
    expect(result.safe_to_execute).toBe(true);
  });
});

// ── Social acknowledgement ───────────────────────────────────────────────────

describe("planCarsonInstruction — social acknowledgement", () => {
  it.each([
    "thank you",
    "thanks",
    "okay thanks",
    "perfect thanks",
    "thank you Carson",
  ])("'%s' produces no executable agent plans", (transcript) => {
    const result = plan(transcript);
    expect(result.router_result.primary_domain).toBe("social_ack");
    expect(result.agent_plans).toHaveLength(0);
    expect(result.blockers).toHaveLength(0);
    expect(result.safe_to_execute).toBe(false);
    expect(result.requires_human_approval).toBe(false);
    expect(result.combined_summary).toMatch(/Social acknowledgement/i);
  });
});

// ── Unknown instruction ────────────────────────────────────────────────────────

describe("planCarsonInstruction — unknown instruction", () => {
  it("produces no agent plans for gibberish", () => {
    const result = plan("hmm");
    expect(result.router_result.primary_domain).toBe("unknown");
    expect(result.agent_plans).toHaveLength(0);
  });

  it("is not safe to execute", () => {
    const result = plan("hmm");
    expect(result.safe_to_execute).toBe(false);
  });

  it("requires human approval", () => {
    const result = plan("hmm");
    expect(result.requires_human_approval).toBe(true);
  });

  it("provides clarification question", () => {
    const result = plan("hmm");
    expect(result.router_result.needs_clarification).toBe(true);
    expect(result.router_result.clarification_question).toBeTruthy();
  });
});

// ── Missing person ────────────────────────────────────────────────────────────

describe("planCarsonInstruction — missing person", () => {
  it("delegation to unknown person flags missing entity", () => {
    const result = plan("Ask Ahmad to clean the pool");
    const agent = result.agent_plans.find(p => p.agent_name === "delegationAgent")!;
    expect(agent).toBeDefined();
    const personMissing = agent.missing_entities.some(e => e.includes("Ahmad") || e.includes("person_not_found"));
    expect(personMissing).toBe(true);
  });

  it("is not safe to execute when person is unknown", () => {
    const result = plan("Ask Ahmad to clean the pool");
    const agent = result.agent_plans.find(p => p.agent_name === "delegationAgent")!;
    expect(agent.safe_to_execute).toBe(false);
    expect(result.safe_to_execute).toBe(false);
  });

  it("blockers mention the missing person entity", () => {
    const result = plan("Ask Ahmad to clean the pool");
    expect(result.blockers.length).toBeGreaterThan(0);
    expect(result.requires_human_approval).toBe(true);
  });
});

// ── Missing time ──────────────────────────────────────────────────────────────

describe("planCarsonInstruction — missing time", () => {
  it("reminder without time flags missing time_expression", () => {
    const result = plan("Remind me to call Grace");
    const agent = result.agent_plans.find(p => p.agent_name === "reminderAgent")!;
    expect(agent).toBeDefined();
    expect(agent.missing_entities).toContain("time_expression");
  });

  it("is not safe to execute without time", () => {
    const result = plan("Remind me to call Grace");
    const agent = result.agent_plans.find(p => p.agent_name === "reminderAgent")!;
    expect(agent.safe_to_execute).toBe(false);
    expect(result.safe_to_execute).toBe(false);
  });

  it("adds risk about missing time", () => {
    const result = plan("Remind me to call Grace");
    const agent = result.agent_plans.find(p => p.agent_name === "reminderAgent")!;
    expect(agent.risks.some(r => /time/i.test(r))).toBe(true);
  });

  it("still extracts reminder text even without time", () => {
    const result = plan("Remind me to call Grace");
    const agent = result.agent_plans.find(p => p.agent_name === "reminderAgent")!;
    const textEntity = agent.required_entities.find(e => e.name === "reminder_text");
    expect(textEntity?.found).toBe(true);
    expect(textEntity?.value).toMatch(/call grace/i);
  });
});

// ── Urgent delegation ─────────────────────────────────────────────────────────

describe("planCarsonInstruction — urgent delegation", () => {
  it("detects urgency and adds risk", () => {
    const result = plan("Ask Grace to come immediately, it's urgent");
    const agent = result.agent_plans.find(p => p.agent_name === "delegationAgent")!;
    expect(agent).toBeDefined();
    expect(agent.risks.some(r => /urgent/i.test(r))).toBe(true);
  });

  it("is still safe to execute when person is known", () => {
    const result = plan("Ask Grace to come immediately, it's urgent");
    const agent = result.agent_plans.find(p => p.agent_name === "delegationAgent")!;
    expect(agent.safe_to_execute).toBe(true);
  });

  it("urgency with 'asap' also flagged", () => {
    const agent = delegationAgent({
      transcript: "Tell Christopher to fix this ASAP",
      people: PEOPLE,
    });
    expect(agent.risks.some(r => /urgent/i.test(r))).toBe(true);
  });
});

// ── Individual agent unit tests ───────────────────────────────────────────────

describe("taskAgent", () => {
  it("always safe to execute", () => {
    const result = taskAgent({ transcript: "buy groceries" });
    expect(result.safe_to_execute).toBe(true);
    expect(result.missing_entities).toHaveLength(0);
  });
});

describe("delegationAgent", () => {
  it("get [name] to pattern", () => {
    const result = delegationAgent({
      transcript: "Get Ghulam to bring the cars",
      people: PEOPLE,
    });
    expect(result.safe_to_execute).toBe(true);
    const personEntity = result.required_entities.find(e => e.name === "person_name");
    expect(personEntity?.value).toMatch(/ghulam/i);
  });

  it("have [name] pattern", () => {
    const result = delegationAgent({
      transcript: "Have Christopher prepare dinner",
      people: PEOPLE,
    });
    expect(result.safe_to_execute).toBe(true);
    const personEntity = result.required_entities.find(e => e.name === "person_name");
    expect(personEntity?.value).toMatch(/christopher/i);
  });

  it("check-in 'ask [name] if' pattern", () => {
    const result = delegationAgent({
      transcript: "Ask Christopher if he confirmed the delivery",
      people: PEOPLE,
    });
    expect(result.safe_to_execute).toBe(true);
    expect(result.proposed_actions[0]!.type).toBe("send_delegation");
  });
});

describe("whatsappAgent", () => {
  it("Send [name] a message", () => {
    const result = whatsappAgent({
      transcript: "Send Grace a message saying the groceries are ready",
      people: PEOPLE,
    });
    expect(result.safe_to_execute).toBe(true);
    expect(result.proposed_actions[0]!.type).toBe("send_direct_whatsapp");
  });

  it("WhatsApp [name]", () => {
    const result = whatsappAgent({
      transcript: "WhatsApp Nasira now",
      people: PEOPLE,
    });
    const recipientEntity = result.required_entities.find(e => e.name === "recipient_name");
    expect(recipientEntity?.found).toBe(true);
  });

  it("no consent → risk added, not safe", () => {
    const noConsentPeople: CarsonPlanInput["people"] = [
      { name: "Grace", phone: "+971500000001", whatsapp_opted_in: false },
    ];
    const result = whatsappAgent({
      transcript: "Send Grace a message saying hello",
      people: noConsentPeople,
    });
    expect(result.safe_to_execute).toBe(false);
    expect(result.risks.some(r => /consent/i.test(r))).toBe(true);
  });

  it("unknown recipient → not safe", () => {
    const result = whatsappAgent({
      transcript: "Send Ahmad a message saying hi",
      people: PEOPLE,
    });
    expect(result.safe_to_execute).toBe(false);
    expect(result.missing_entities.some(e => /ahmad/i.test(e) || /not_found/i.test(e))).toBe(true);
  });
});

describe("reminderAgent", () => {
  it("'set a reminder to' pattern", () => {
    const result = reminderAgent({ transcript: "Set a reminder to check on Loulya at 6pm" });
    expect(result.safe_to_execute).toBe(true);
  });

  it("no time → missing time_expression", () => {
    const result = reminderAgent({ transcript: "Remind me to buy flowers" });
    expect(result.missing_entities).toContain("time_expression");
    expect(result.safe_to_execute).toBe(false);
  });
});

describe("calendarAgent", () => {
  it("create_event when 'schedule' keyword present", () => {
    const result = calendarAgent({ transcript: "Schedule a meeting on Monday at 10am" });
    expect(result.proposed_actions[0]!.type).toBe("create_event");
  });

  it("query_calendar for 'what do I have this week'", () => {
    const result = calendarAgent({ transcript: "What do I have this week?" });
    expect(result.proposed_actions[0]!.type).toBe("query_calendar");
    expect(result.proposed_actions[0]!.range).toBe("this_week");
  });
});

describe("memoryAgent", () => {
  it("'I prefer' pattern", () => {
    const result = memoryAgent({ transcript: "I prefer shorter daily briefs" });
    expect(result.safe_to_execute).toBe(true);
    expect(result.proposed_actions[0]!.category).toBe("preference");
  });

  it("no recognizable pattern → missing instruction_text", () => {
    const result = memoryAgent({ transcript: "something vague" });
    expect(result.missing_entities).toContain("instruction_text");
    expect(result.safe_to_execute).toBe(false);
  });
});

describe("generalAnswerAgent", () => {
  it("always produces answer_question action", () => {
    const result = generalAnswerAgent({ transcript: "Explain what Ra7etBal does" });
    expect(result.proposed_actions[0]!.type).toBe("answer_question");
    expect(result.safe_to_execute).toBe(true);
  });
});

// ── Output shape ──────────────────────────────────────────────────────────────

describe("planCarsonInstruction — output shape", () => {
  it("always returns all required top-level fields", () => {
    const result = plan("Ask Grace to prepare the guest room");
    expect(result).toHaveProperty("router_result");
    expect(result).toHaveProperty("agent_plans");
    expect(result).toHaveProperty("combined_summary");
    expect(result).toHaveProperty("blockers");
    expect(result).toHaveProperty("safe_to_execute");
    expect(result).toHaveProperty("requires_human_approval");
  });

  it("each agent plan has all required fields", () => {
    const result = plan("Ask Grace to prepare the guest room");
    for (const agent of result.agent_plans) {
      expect(agent).toHaveProperty("agent_name");
      expect(agent).toHaveProperty("intent");
      expect(agent).toHaveProperty("proposed_actions");
      expect(agent).toHaveProperty("required_entities");
      expect(agent).toHaveProperty("missing_entities");
      expect(agent).toHaveProperty("confidence");
      expect(agent).toHaveProperty("user_facing_summary");
      expect(agent).toHaveProperty("safe_to_execute");
      expect(agent).toHaveProperty("risks");
      expect(agent).toHaveProperty("errors");
    }
  });
});
