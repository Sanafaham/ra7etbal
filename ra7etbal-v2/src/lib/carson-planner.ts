import type { Person } from "../types/person";
import {
  classifyCarsonInstruction,
  type CarsonDomain,
  type CarsonRoutingResult,
} from "./carson-router";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ProposedAction {
  type: string;
  [key: string]: unknown;
}

export interface RequiredEntity {
  name: string;
  value: string | null;
  found: boolean;
}

export interface AgentPlan {
  agent_name: string;
  intent: string;
  proposed_actions: ProposedAction[];
  required_entities: RequiredEntity[];
  missing_entities: string[];
  confidence: number;
  user_facing_summary: string;
  safe_to_execute: boolean;
  risks: string[];
  errors: string[];
}

export interface CarsonPlanInput {
  transcript: string;
  people?: Pick<Person, "name" | "phone" | "whatsapp_opted_in">[];
  userProfile?: { displayName?: string | null } | null;
  ra7etbalState?: string | null;
  calendarContext?: string | null;
  weatherContext?: string | null;
}

export interface CarsonPlanResult {
  router_result: CarsonRoutingResult;
  agent_plans: AgentPlan[];
  combined_summary: string;
  blockers: string[];
  safe_to_execute: boolean;
  requires_human_approval: boolean;
}

// ── Entity extraction utilities ───────────────────────────────────────────────

const TIME_PATTERNS: RegExp[] = [
  /\btomorrow\s*(?:morning|afternoon|evening|at\s+\d{1,2}(?::\d{2})?\s*[ap]m?)?\b/i,
  /\btonight\b/i,
  /\btoday\b/i,
  /\bnow\b/i,
  /\bthis\s+(?:morning|afternoon|evening|week|weekend|month)\b/i,
  /\bnext\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|month)\b/i,
  /\bat\s+\d{1,2}(?::\d{2})?\s*(?:[ap]m|o'?clock)?\b/i,
  /\bin\s+\d+\s+(?:minutes?|hours?|days?|weeks?)\b/i,
  /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
];

function extractTimeExpression(text: string): string | null {
  for (const p of TIME_PATTERNS) {
    const m = text.match(p);
    if (m) return m[0].trim();
  }
  return null;
}

function detectUrgency(text: string): boolean {
  return /\b(urgent|immediately|asap|right\s*now|right\s*away|emergency|critical|hurry)\b/i.test(
    text,
  );
}

interface PersonTaskExtract {
  personName: string | null;
  personFound: boolean;
  taskText: string | null;
}

function extractPersonAndTask(
  text: string,
  people: { name: string }[],
): PersonTaskExtract {
  const byName = (n: string) =>
    people.some((p) => p.name.toLowerCase() === n.toLowerCase());

  // ask/tell [name] to [task]
  const m1 = text.match(
    /\b(?:ask|tell)\s+([A-Za-z]+(?:\s+[A-Za-z]+)?)\s+to\s+(.+?)(?:\s+and\s+|,|$)/i,
  );
  if (m1) {
    const name = m1[1]!.trim();
    return { personName: name, personFound: byName(name), taskText: m1[2]!.trim() };
  }

  // have [name] [task]
  const m2 = text.match(/\bhave\s+([A-Za-z]+)\s+(.+?)(?:\s+and\s+|,|$)/i);
  if (m2) {
    const name = m2[1]!.trim();
    const task = m2[2]!.trim().replace(/^to\s+/i, "");
    return { personName: name, personFound: byName(name), taskText: task };
  }

  // get [name] to [task]
  const m3 = text.match(/\bget\s+([A-Za-z]+)\s+to\s+(.+?)(?:\s+and\s+|,|$)/i);
  if (m3) {
    const name = m3[1]!.trim();
    return { personName: name, personFound: byName(name), taskText: m3[2]!.trim() };
  }

  // ask/check with [name] if/whether [condition]
  const m4 = text.match(
    /\b(?:ask|check\s+with|follow\s+up\s+with)\s+([A-Za-z]+(?:\s+[A-Za-z]+)?)\s+(?:if|whether)\s+(.+?)(?:\s+and\s+|,|$)/i,
  );
  if (m4) {
    const name = m4[1]!.trim();
    return {
      personName: name,
      personFound: byName(name),
      taskText: `check if ${m4[2]!.trim()}`,
    };
  }

  return { personName: null, personFound: false, taskText: null };
}

interface WhatsAppExtract {
  recipientName: string | null;
  recipientFound: boolean;
  hasConsent: boolean;
  message: string | null;
}

function extractWhatsAppRecipientAndMessage(
  text: string,
  people: Pick<Person, "name" | "phone" | "whatsapp_opted_in">[],
): WhatsAppExtract {
  const findPerson = (name: string) =>
    people.find((p) => p.name.toLowerCase() === name.toLowerCase()) ?? null;

  // send [name] a message saying [message]
  const m1 = text.match(
    /\bsend\s+(\w+)\s+(?:a\s+)?message\s+(?:saying\s+|that\s+)?(.+?)(?:\.|,|$)/i,
  );
  if (m1) {
    const name = m1[1]!.trim();
    const person = findPerson(name);
    return {
      recipientName: name,
      recipientFound: !!person,
      hasConsent: person?.whatsapp_opted_in ?? false,
      message: m1[2]?.trim() ?? null,
    };
  }

  // WhatsApp [name] [message?]
  const m2 = text.match(/\bwhatsapp\s+(\w+)\s*(.*)?/i);
  if (m2) {
    const name = m2[1]!.trim();
    const person = findPerson(name);
    return {
      recipientName: name,
      recipientFound: !!person,
      hasConsent: person?.whatsapp_opted_in ?? false,
      message: m2[2]?.trim() || null,
    };
  }

  // text [name] saying [message]
  const m3 = text.match(/\btext\s+(\w+)\s+(?:saying|that)\s+(.+?)(?:\.|,|$)/i);
  if (m3) {
    const name = m3[1]!.trim();
    const person = findPerson(name);
    return {
      recipientName: name,
      recipientFound: !!person,
      hasConsent: person?.whatsapp_opted_in ?? false,
      message: m3[2]?.trim() ?? null,
    };
  }

  return { recipientName: null, recipientFound: false, hasConsent: false, message: null };
}

function extractReminderText(text: string): string | null {
  // "remind me to [task]" — stop before time words
  const m1 = text.match(
    /\bremind\s+me\s+to\s+(.+?)(?:\s+(?:at|on|tomorrow|today|tonight|this|next|in)\b|[,.]|$)/i,
  );
  if (m1) return m1[1]!.trim();

  // "remind me about [topic]"
  const m2 = text.match(
    /\bremind\s+me\s+about\s+(.+?)(?:\s+(?:at|on|tomorrow|today)\b|[,.]|$)/i,
  );
  if (m2) return m2[1]!.trim();

  // "set a reminder to/for [task]"
  const m3 = text.match(
    /\bset\s+a\s+reminder\s+(?:to\s+|for\s+)(.+?)(?:\s+(?:at|on|tomorrow|today)\b|[,.]|$)/i,
  );
  if (m3) return m3[1]!.trim();

  // "remember to [task]"
  const m4 = text.match(
    /\bremember\s+to\s+(.+?)(?:\s+(?:at|on|tomorrow|today|tonight|this|next|in)\b|[,.]|$)/i,
  );
  if (m4) return m4[1]!.trim();

  return null;
}

function extractMemoryInstruction(
  text: string,
): { instruction: string | null; category: string } {
  const m1 = text.match(/\bremember\s+that\s+(.+)/i);
  if (m1) return { instruction: m1[1]!.trim(), category: "general" };

  const m2 = text.match(/\bfrom\s+now\s+on\s+(.+)/i);
  if (m2) {
    const rule = m2[1]!.trim();
    const cat = /\balways\b/i.test(rule)
      ? "always"
      : /\bnever\b/i.test(rule)
        ? "never"
        : "preference";
    return { instruction: rule, category: cat };
  }

  const m3 = text.match(/\balways\s+(tell|ask|send|use|call|write|message|give)\s+(.+)/i);
  if (m3) return { instruction: m3[0]!.trim(), category: "always" };

  const m4 = text.match(/\bnever\s+(tell|ask|send|use|call|write|message|give)\s+(.+)/i);
  if (m4) return { instruction: m4[0]!.trim(), category: "never" };

  const m5 = text.match(/\bI\s+prefer\s+(.+)/i);
  if (m5) return { instruction: m5[1]!.trim(), category: "preference" };

  return { instruction: null, category: "general" };
}

function detectCalendarOperation(text: string): "query" | "create" | "update" | "delete" {
  if (/\b(add|create|schedule|book|put|set\s+up)\b/i.test(text)) return "create";
  if (/\b(move|reschedule|change|update)\b/i.test(text)) return "update";
  if (/\b(cancel|delete|remove)\b/i.test(text)) return "delete";
  return "query";
}

function extractCalendarRange(text: string): string {
  if (/\btoday\b/i.test(text)) return "today";
  if (/\btomorrow\b/i.test(text)) return "tomorrow";
  if (/\bthis\s+week\b/i.test(text)) return "this_week";
  if (/\bnext\s+week\b/i.test(text)) return "next_week";
  if (/\bthis\s+month\b/i.test(text)) return "this_month";
  return "today";
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ── Specialist agent planners ─────────────────────────────────────────────────

export function taskAgent(input: CarsonPlanInput): AgentPlan {
  const { transcript } = input;
  return {
    agent_name: "taskAgent",
    intent: `Capture task: ${transcript.slice(0, 80)}`,
    proposed_actions: [{ type: "create_task", description: transcript }],
    required_entities: [{ name: "task_description", value: transcript, found: true }],
    missing_entities: [],
    confidence: 0.70,
    user_facing_summary: "I'll capture this as a task.",
    safe_to_execute: true,
    risks: [],
    errors: [],
  };
}

export function delegationAgent(input: CarsonPlanInput): AgentPlan {
  const { transcript, people = [] } = input;
  const { personName, personFound, taskText } = extractPersonAndTask(transcript, people);
  const isUrgent = detectUrgency(transcript);

  const missing: string[] = [];
  const risks: string[] = [];

  if (!personName) {
    missing.push("person_name");
  } else if (!personFound) {
    missing.push(`person_not_found: ${personName}`);
  }
  if (!taskText) missing.push("task_description");
  if (isUrgent) risks.push("urgent: verify person availability before delegating");

  const safeToExecute = personFound && !!taskText && missing.length === 0;

  return {
    agent_name: "delegationAgent",
    intent:
      personName && taskText
        ? `Delegate to ${personName}: ${taskText.slice(0, 60)}`
        : "Delegate task (person or task unclear)",
    proposed_actions:
      personName && taskText
        ? [{ type: "send_delegation", person_name: personName, task_text: taskText, via: "whatsapp" }]
        : [],
    required_entities: [
      { name: "person_name", value: personName, found: personFound && !!personName },
      { name: "task_description", value: taskText, found: !!taskText },
    ],
    missing_entities: missing,
    confidence: safeToExecute ? 0.92 : 0.55,
    user_facing_summary: safeToExecute
      ? `I'll ask ${personName} to ${taskText}.`
      : `Delegation unclear — ${missing.join(", ")}.`,
    safe_to_execute: safeToExecute,
    risks,
    errors: [],
  };
}

export function whatsappAgent(input: CarsonPlanInput): AgentPlan {
  const { transcript, people = [] } = input;
  const { recipientName, recipientFound, hasConsent, message } =
    extractWhatsAppRecipientAndMessage(transcript, people);

  const missing: string[] = [];
  const risks: string[] = [];

  if (!recipientName) {
    missing.push("recipient_name");
  } else if (!recipientFound) {
    missing.push(`recipient_not_found: ${recipientName}`);
  }
  if (!message) missing.push("message_content");
  if (recipientFound && !hasConsent) {
    risks.push("WhatsApp consent not confirmed for this recipient");
  }

  const safeToExecute =
    recipientFound && !!message && hasConsent && missing.length === 0;

  return {
    agent_name: "whatsappAgent",
    intent:
      recipientName && message
        ? `Send WhatsApp to ${recipientName}: "${message.slice(0, 60)}"`
        : "Send WhatsApp (recipient or message unclear)",
    proposed_actions:
      recipientName && message
        ? [{ type: "send_direct_whatsapp", recipient_name: recipientName, message }]
        : [],
    required_entities: [
      { name: "recipient_name", value: recipientName, found: recipientFound && !!recipientName },
      { name: "message_content", value: message, found: !!message },
    ],
    missing_entities: missing,
    confidence: safeToExecute ? 0.90 : 0.60,
    user_facing_summary: safeToExecute
      ? `I'll send a WhatsApp to ${recipientName}.`
      : `WhatsApp blocked — ${[...missing, ...risks].join("; ")}.`,
    safe_to_execute: safeToExecute,
    risks,
    errors: [],
  };
}

export function reminderAgent(input: CarsonPlanInput): AgentPlan {
  const { transcript } = input;
  const reminderText = extractReminderText(transcript);
  const timeExpression = extractTimeExpression(transcript);

  const missing: string[] = [];
  if (!reminderText) missing.push("reminder_text");
  if (!timeExpression) missing.push("time_expression");

  const safeToExecute = !!reminderText && !!timeExpression;

  return {
    agent_name: "reminderAgent",
    intent: reminderText
      ? `Set reminder: ${reminderText.slice(0, 60)}`
      : "Set reminder (text unclear)",
    proposed_actions: reminderText
      ? [{ type: "create_reminder", text: reminderText, time_expression: timeExpression }]
      : [],
    required_entities: [
      { name: "reminder_text", value: reminderText, found: !!reminderText },
      { name: "time_expression", value: timeExpression, found: !!timeExpression },
    ],
    missing_entities: missing,
    confidence: safeToExecute ? 0.90 : 0.60,
    user_facing_summary: safeToExecute
      ? `I'll set a reminder to ${reminderText} — ${timeExpression}.`
      : `I'll set a reminder${reminderText ? ` to ${reminderText}` : ""} — no time specified.`,
    safe_to_execute: safeToExecute,
    risks: timeExpression ? [] : ["No time specified — will need to ask user"],
    errors: [],
  };
}

export function calendarAgent(input: CarsonPlanInput): AgentPlan {
  const { transcript } = input;
  const operation = detectCalendarOperation(transcript);
  const range = extractCalendarRange(transcript);
  const timeExpr = extractTimeExpression(transcript);

  const missing: string[] = [];
  let proposed: ProposedAction[];

  if (operation === "query") {
    proposed = [{ type: "query_calendar", range }];
  } else if (operation === "create") {
    proposed = [{ type: "create_event", title: transcript.slice(0, 60), time_expression: timeExpr }];
    if (!timeExpr) missing.push("event_time");
  } else {
    proposed = [{ type: `${operation}_event`, time_expression: timeExpr }];
  }

  const requiredEntities: RequiredEntity[] =
    operation === "query"
      ? [{ name: "time_range", value: range, found: true }]
      : [
          { name: "event_title", value: transcript.slice(0, 60), found: true },
          { name: "event_time", value: timeExpr, found: !!timeExpr },
        ];

  return {
    agent_name: "calendarAgent",
    intent:
      operation === "query"
        ? `Query calendar for ${range}`
        : `${cap(operation)} calendar event`,
    proposed_actions: proposed,
    required_entities: requiredEntities,
    missing_entities: missing,
    confidence: 0.85,
    user_facing_summary:
      operation === "query"
        ? `I'll check your calendar for ${range}.`
        : `I'll ${operation} the calendar event.`,
    safe_to_execute: missing.length === 0,
    risks: [],
    errors: [],
  };
}

export function memoryAgent(input: CarsonPlanInput): AgentPlan {
  const { transcript } = input;
  const { instruction, category } = extractMemoryInstruction(transcript);

  const missing: string[] = [];
  if (!instruction) missing.push("instruction_text");

  return {
    agent_name: "memoryAgent",
    intent: instruction
      ? `Save ${category} instruction: ${instruction.slice(0, 60)}`
      : "Save persistent instruction (text unclear)",
    proposed_actions: instruction
      ? [{ type: "save_instruction", instruction, category }]
      : [],
    required_entities: [
      { name: "instruction_text", value: instruction, found: !!instruction },
    ],
    missing_entities: missing,
    confidence: instruction ? 0.88 : 0.50,
    user_facing_summary: instruction
      ? `I'll remember: ${instruction.slice(0, 80)}.`
      : "I'll save that as a persistent instruction.",
    safe_to_execute: !!instruction,
    risks: [],
    errors: [],
  };
}

export function generalAnswerAgent(input: CarsonPlanInput): AgentPlan {
  const { transcript } = input;

  const topicMatch =
    transcript.match(/\bwhat\s+(?:is|are|does|do|did)\s+(.+?)(?:\?|$)/i) ??
    transcript.match(/\bhow\s+(?:do|can|does|is)\s+(.+?)(?:\?|$)/i) ??
    transcript.match(/\bexplain\s+(.+?)(?:\?|$)/i);
  const topic = topicMatch?.[1]?.trim() ?? transcript;

  return {
    agent_name: "generalAnswerAgent",
    intent: `Answer question: ${topic.slice(0, 60)}`,
    proposed_actions: [{ type: "answer_question", topic }],
    required_entities: [{ name: "question", value: transcript, found: true }],
    missing_entities: [],
    confidence: 0.75,
    user_facing_summary: `I'll answer your question about ${topic.slice(0, 60)}.`,
    safe_to_execute: true,
    risks: [],
    errors: [],
  };
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

const AGENT_MAP: Partial<Record<CarsonDomain, (input: CarsonPlanInput) => AgentPlan>> = {
  task: taskAgent,
  delegation: delegationAgent,
  whatsapp: whatsappAgent,
  reminder: reminderAgent,
  calendar: calendarAgent,
  memory: memoryAgent,
  general_answer: generalAnswerAgent,
};

/**
 * Plans a Carson instruction by:
 * 1. Running the domain router (logs [carson_router])
 * 2. Calling the relevant specialist planner for each matched domain
 * 3. Merging outputs into a structured plan
 *
 * This is read-only. It does not execute any actions.
 * Log [carson_plan] from the call site to inspect results.
 */
export function planCarsonInstruction(input: CarsonPlanInput): CarsonPlanResult {
  const routerResult = classifyCarsonInstruction({
    transcript: input.transcript,
    people: input.people,
  });

  const agentPlans: AgentPlan[] = [];
  for (const domain of routerResult.domains) {
    const agent = AGENT_MAP[domain];
    if (agent) agentPlans.push(agent(input));
  }

  const blockers = agentPlans.flatMap((p) =>
    p.missing_entities.map((e) => `${p.agent_name}: ${e}`),
  );

  const safeToExecute =
    agentPlans.length > 0 && agentPlans.every((p) => p.safe_to_execute);

  const requiresHumanApproval =
    !safeToExecute ||
    blockers.length > 0 ||
    routerResult.primary_domain === "unknown";

  const combinedSummary =
    agentPlans
      .map((p) => p.user_facing_summary)
      .filter(Boolean)
      .join(" ") ||
    routerResult.clarification_question ||
    "Unable to plan this instruction.";

  return {
    router_result: routerResult,
    agent_plans: agentPlans,
    combined_summary: combinedSummary,
    blockers,
    safe_to_execute: safeToExecute,
    requires_human_approval: requiresHumanApproval,
  };
}
