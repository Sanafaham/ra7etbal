import type { Person } from "../types/person";
import { classifyCarsonInstruction, type CarsonDomain } from "./carson-router";
import {
  CARSON_REPEAT_PROMPT,
  evaluateCarsonTranscriptCapture,
  normalizeTranscript,
} from "./carson-transcript-guard";
import { isSocialAcknowledgement } from "./carson-social";
import { isCommunicationStyleTaskText } from "./communication-vs-delegation";

export type CarsonChannel = "voice" | "text";
export type CarsonToolRisk = "read" | "reversible_mutation" | "external_side_effect";

export interface CarsonToolPolicyDefinition {
  intent: string;
  precedence: number;
  allowedChannels: readonly CarsonChannel[];
  positiveTriggers: readonly string[];
  notFor: readonly string[];
  requiredEntities: readonly string[];
  risk: CarsonToolRisk;
  eligibleTools: readonly string[];
  clarification: string;
}

export interface CarsonToolPolicyInput {
  utterance: string | null | undefined;
  channel: CarsonChannel;
  selectedTool: string;
  toolArguments?: unknown;
  people?: Pick<Person, "name">[];
  hasActiveHostingClarification?: boolean;
}

export interface CarsonToolPolicyDecision {
  allowed: boolean;
  intent: string;
  precedence: number;
  selectedTool: string;
  eligibleTools: readonly string[];
  risk: CarsonToolRisk;
  reason: string;
  outcome: string;
  routingDomain: CarsonDomain | "invalid";
  missingEntities: string[];
}

const NO_ACTION_TOOLS: readonly string[] = [];
const REMINDER_TOOLS = ["create_reminder", "create_automation"] as const;
const DIRECT_MESSAGE_TOOLS = ["send_direct_whatsapp_message"] as const;
const DELEGATION_TOOLS = ["execute_instruction", "send_delegation", "send_followup"] as const;
const MEMORY_TOOLS = ["save_instruction"] as const;
const NOTE_TOOLS = ["save_note"] as const;
const CALENDAR_READ_TOOLS = ["get_calendar_events"] as const;
const KNOWN_SAFE_READ_TOOLS = new Set<string>(CALENDAR_READ_TOOLS);
const CALENDAR_MUTATION_TOOLS = [
  "create_calendar_event",
  "update_calendar_event",
  "delete_calendar_event",
] as const;
const TODO_TOOLS = ["create_todo", "complete_todo"] as const;

export const CARSON_TOOL_POLICY_REGISTRY: readonly CarsonToolPolicyDefinition[] = [
  {
    intent: "hosting",
    precedence: 5,
    allowedChannels: ["voice"],
    positiveTriggers: ["host/guests/dinner preparation request"],
    notFor: ["simple reminder, note, or direct message"],
    requiredEntities: ["instruction"],
    risk: "external_side_effect",
    eligibleTools: ["execute_instruction"],
    clarification: "What outcome should I arrange for the guests?",
  },
  {
    intent: "no_action",
    precedence: 1,
    allowedChannels: ["voice", "text"],
    positiveTriggers: ["invalid capture", "social acknowledgement"],
    notFor: ["actionable owner instruction"],
    requiredEntities: [],
    risk: "read",
    eligibleTools: NO_ACTION_TOOLS,
    clarification: CARSON_REPEAT_PROMPT,
  },
  {
    intent: "reminder",
    precedence: 3,
    allowedChannels: ["voice"],
    positiveTriggers: ["remind me", "set a reminder", "don't let me forget", "alert me"],
    notFor: ["direct message", "delegation", "note", "generic task"],
    requiredEntities: ["reminder_text", "time"],
    risk: "reversible_mutation",
    eligibleTools: REMINDER_TOOLS,
    clarification: "When should I remind you?",
  },
  {
    intent: "direct_communication",
    precedence: 4,
    allowedChannels: ["voice"],
    positiveTriggers: ["tell/message/text/WhatsApp a person with message content"],
    notFor: ["tracked operational work", "reminder"],
    requiredEntities: ["person", "message"],
    risk: "external_side_effect",
    eligibleTools: DIRECT_MESSAGE_TOOLS,
    clarification: "Who should I send the message to, and what should it say?",
  },
  {
    intent: "delegation",
    precedence: 5,
    allowedChannels: ["voice"],
    positiveTriggers: ["ask/tell/have/get a person to perform operational work"],
    notFor: ["communication directed back to the owner", "reminder", "note"],
    requiredEntities: ["person", "task"],
    risk: "external_side_effect",
    eligibleTools: DELEGATION_TOOLS,
    clarification: "Who should handle it, and what should they do?",
  },
  {
    intent: "memory",
    precedence: 6,
    allowedChannels: ["voice"],
    positiveTriggers: ["remember that", "from now on", "save instruction/rule"],
    notFor: ["reminder", "note", "task"],
    requiredEntities: ["instruction"],
    risk: "reversible_mutation",
    eligibleTools: MEMORY_TOOLS,
    clarification: "What should I remember?",
  },
  {
    intent: "note",
    precedence: 6,
    allowedChannels: ["voice"],
    positiveTriggers: ["save/write/note this information"],
    notFor: ["reminder", "task", "delegation"],
    requiredEntities: ["note"],
    risk: "reversible_mutation",
    eligibleTools: NOTE_TOOLS,
    clarification: "What should I save in the note?",
  },
  {
    intent: "calendar_read",
    precedence: 7,
    allowedChannels: ["voice", "text"],
    positiveTriggers: ["what is on my calendar", "what do I have"],
    notFor: ["create, update, or delete calendar event"],
    requiredEntities: [],
    risk: "read",
    eligibleTools: CALENDAR_READ_TOOLS,
    clarification: "Which calendar period should I check?",
  },
  {
    intent: "calendar_mutation",
    precedence: 7,
    allowedChannels: ["voice"],
    positiveTriggers: ["add/create/update/move/delete calendar event"],
    notFor: ["calendar read"],
    requiredEntities: ["calendar_action"],
    risk: "reversible_mutation",
    eligibleTools: CALENDAR_MUTATION_TOOLS,
    clarification: "What calendar change should I make?",
  },
  {
    intent: "todo",
    precedence: 8,
    allowedChannels: ["voice"],
    positiveTriggers: ["create or complete an explicit to-do"],
    notFor: ["reminder", "note", "delegation"],
    requiredEntities: ["todo"],
    risk: "reversible_mutation",
    eligibleTools: TODO_TOOLS,
    clarification: "What should I add or update?",
  },
  {
    intent: "note_action",
    precedence: 8,
    allowedChannels: ["voice"],
    positiveTriggers: ["explicit action on an existing note"],
    notFor: ["saving a new note"],
    requiredEntities: ["note_reference", "action"],
    risk: "reversible_mutation",
    eligibleTools: ["act_on_note"],
    clarification: "Which note should I act on, and what should I do with it?",
  },
  {
    intent: "profile_setting",
    precedence: 8,
    allowedChannels: ["voice"],
    positiveTriggers: ["explicit request to save the owner's city"],
    notFor: ["weather query"],
    requiredEntities: ["city"],
    risk: "reversible_mutation",
    eligibleTools: ["save_city"],
    clarification: "Which city should I save?",
  },
  {
    intent: "task_control",
    precedence: 8,
    allowedChannels: ["voice"],
    positiveTriggers: ["explicit request to complete, reopen, archive, or restore a task"],
    notFor: ["new reminder, note, or delegation"],
    requiredEntities: ["task_reference", "action"],
    risk: "reversible_mutation",
    eligibleTools: ["control_task"],
    clarification: "Which task should I update, and how?",
  },
] as const;

const MUTATING_TOOLS = new Set<string>([
  ...REMINDER_TOOLS,
  ...DIRECT_MESSAGE_TOOLS,
  ...DELEGATION_TOOLS,
  ...MEMORY_TOOLS,
  ...NOTE_TOOLS,
  ...CALENDAR_MUTATION_TOOLS,
  ...TODO_TOOLS,
  "act_on_note",
  "control_task",
  "save_city",
]);

function argsRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function firstString(args: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function hasTimeEvidence(text: string, args: Record<string, unknown>): boolean {
  if (firstString(args, ["time_text", "time", "due_at", "first_run_text", "schedule"])) return true;
  return /\b(today|tomorrow|tonight|morning|afternoon|evening|noon|midnight|next\s+\w+|in\s+\d+\s+(minutes?|hours?|days?)|at\s+\d{1,2}(?::\d{2})?\s*(am|pm)?)\b/i.test(text);
}

function namedPerson(
  text: string,
  args: Record<string, unknown>,
  people: Pick<Person, "name">[],
): { name: string; known: boolean } {
  const fromArgs = firstString(args, ["recipient_name", "person_name", "assignee_name", "name"]);
  const fromRoster = people.find((person) =>
    new RegExp(`\\b${person.name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text)
  )?.name ?? "";
  const fromText = text.match(/\b(?:tell|ask|message|text|whatsapp|send|have|get)\s+([A-Za-z]+)/i)?.[1] ?? "";
  const name = (fromArgs || fromRoster || fromText).trim();
  return {
    name,
    known: Boolean(name) && people.some((person) => person.name.trim().toLowerCase() === name.toLowerCase()),
  };
}

function directCommunicationIntent(text: string): boolean {
  if (/\b(?:whatsapp|message|text|dm)\s+[A-Za-z]+(?:\s+[A-Za-z]+)?\b/i.test(text)) return true;
  if (/\bsend\s+[A-Za-z]+(?:\s+[A-Za-z]+)?\s+(?:a\s+)?message\b/i.test(text)) return true;
  if (/\btell\s+[A-Za-z]+\s+(?!to\b).+/i.test(text)) return true;
  // Confirmed production incident (2026-07-29, ~21:57 Turkey time): a garbled
  // voice transcript of "Ask Christopher to reply yes if he can come tomorrow
  // night." was heard as an "Ask [Name] if he can ... to [verb]" shape — the
  // check-in-delegation construction the router explicitly recognizes
  // elsewhere ("'Ask Christopher if/whether' is a check-in delegation").
  // This extraction regex previously allowed at most one word between the
  // name and "to", so it never even attempted isCommunicationStyleTaskText
  // for that shape — evaluateCarsonToolPolicy rejected send_direct_whatsapp_message
  // with "Required entities are missing: task." before the handler ever ran,
  // confirmed via carson_tool_diagnostics (policy_rejected, 0ms after invoked,
  // no handler_started). Non-greedy `.*?` before "to" allows any number of
  // intervening words (an "if/whether he/she can" check-in clause, a middle
  // name, etc.) without changing behavior for the already-working "Ask [Name]
  // to [task]" shape (0 intervening words matches identically). This still
  // only reclassifies as communication when the text captured after "to"
  // itself reads as communication-style (isCommunicationStyleTaskText) — a
  // genuine check-in delegation with no reply/respond clause is unaffected.
  const delegatedTask = text.match(/\b(?:ask|tell|have|get)\s+[A-Za-z]+\b.*?\bto\s+(.+)/i)?.[1];
  return delegatedTask ? isCommunicationStyleTaskText(delegatedTask) : false;
}

function calendarMutationToolForText(text: string): string | null {
  if (/\b(delete|remove|cancel)\b/i.test(text)) return "delete_calendar_event";
  if (/\b(update|change|move|reschedule|rename)\b/i.test(text)) return "update_calendar_event";
  if (/\b(add|create|schedule|book|put)\b/i.test(text)) return "create_calendar_event";
  return null;
}

function policyForIntent(intent: string): CarsonToolPolicyDefinition {
  return CARSON_TOOL_POLICY_REGISTRY.find((policy) => policy.intent === intent)
    ?? CARSON_TOOL_POLICY_REGISTRY[0]!;
}

function reject(
  policy: CarsonToolPolicyDefinition,
  input: CarsonToolPolicyInput,
  routingDomain: CarsonDomain | "invalid",
  reason: string,
  outcome = policy.clarification,
  missingEntities: string[] = [],
): CarsonToolPolicyDecision {
  return {
    allowed: false,
    intent: policy.intent,
    precedence: policy.precedence,
    selectedTool: input.selectedTool,
    eligibleTools: policy.eligibleTools,
    risk: MUTATING_TOOLS.has(input.selectedTool) ? "external_side_effect" : policy.risk,
    reason,
    outcome,
    routingDomain,
    missingEntities,
  };
}

export function evaluateCarsonToolPolicy(input: CarsonToolPolicyInput): CarsonToolPolicyDecision {
  const text = normalizeTranscript(input.utterance ?? "");
  const args = argsRecord(input.toolArguments);
  const people = input.people ?? [];
  const capture = evaluateCarsonTranscriptCapture(text);

  if (!capture.valid) {
    return reject(policyForIntent("no_action"), input, "invalid", `No tool is eligible for ${capture.reason}.`);
  }
  if (isSocialAcknowledgement(text)) {
    return reject(
      policyForIntent("no_action"),
      input,
      "social_ack",
      "A social acknowledgement does not authorize a tool call.",
      "No action was requested.",
    );
  }

  if (input.channel === "text" && MUTATING_TOOLS.has(input.selectedTool)) {
    const policy = policyForIntent("no_action");
    return reject(
      { ...policy, precedence: 2, risk: "external_side_effect" },
      input,
      "unknown",
      "Type to Carson is advisory-only; state-changing tools are not authorized.",
      "I can help you prepare that, but I can't complete it from typed chat. Use Talk to Carson to do it.",
    );
  }

  const routing = classifyCarsonInstruction({ transcript: text, people });
  let intent = routing.primary_domain as string;
  let eligibleTools: readonly string[] = [];
  let required: string[] = [];
  let expectedCalendarTool: string | null = null;

  // Explicit precedence is intentional: do not infer it from router confidence.
  const hostingIntent = Boolean(input.hasActiveHostingClarification) || (
    /\b(host|hosting|guests?|dinner|lunch|breakfast|party|gathering)\b/i.test(text)
    && /\b(arrange|handle|prepare|plan|organize|host|set up|take care)\b/i.test(text)
  );
  const recurringReminderIntent = /\b(every|daily|weekly|monthly|each\s+(day|week|month)|weekdays?|weekends?)\b/i.test(text);
  const noteActionIntent = /\b(note|that note|this note)\b/i.test(text)
    && /\b(turn|convert|make|delegate|remind|act|archive|delete)\b/i.test(text);
  const profileCityIntent = /\b(save|remember|set|change|update)\b.*\b(city|location)\b/i.test(text);
  const taskControlIntent = /\b(complete|reopen|archive|restore|mark)\b.*\b(task|item)\b/i.test(text);

  if ((routing.domains.includes("reminder") || recurringReminderIntent) && !noteActionIntent) {
    intent = "reminder";
    eligibleTools = REMINDER_TOOLS;
    if (!hasTimeEvidence(text, args)) required.push("time");
    if (!firstString(args, ["reminder_text", "text", "task", "description", "instruction"])) required.push("reminder_text");
  } else if (directCommunicationIntent(text)) {
    intent = "direct_communication";
    eligibleTools = DIRECT_MESSAGE_TOOLS;
    const person = namedPerson(text, args, people);
    if (!person.name || !person.known) required.push("known_person");
    if (!firstString(args, ["message", "message_text", "text", "instruction"])) required.push("message");
  } else if (routing.domains.includes("delegation")) {
    intent = "delegation";
    eligibleTools = DELEGATION_TOOLS;
    const person = namedPerson(text, args, people);
    if (!person.name || !person.known) required.push("known_person");
    if (!firstString(args, ["instruction", "task", "task_text", "description"])) required.push("task");
  } else if (hostingIntent) {
    intent = "hosting";
    eligibleTools = ["execute_instruction"];
    if (!firstString(args, ["instruction", "text", "description"])) required.push("instruction");
  } else if (routing.domains.includes("note")) {
    intent = "note";
    eligibleTools = NOTE_TOOLS;
    if (!firstString(args, ["note", "content", "text", "title", "description"])) required.push("note");
  } else if (routing.domains.includes("memory")) {
    intent = "memory";
    eligibleTools = MEMORY_TOOLS;
    if (!firstString(args, ["instruction", "text", "content"])) required.push("instruction");
  } else if (routing.domains.includes("calendar")) {
    expectedCalendarTool = calendarMutationToolForText(text);
    intent = expectedCalendarTool ? "calendar_mutation" : "calendar_read";
    eligibleTools = expectedCalendarTool ? [expectedCalendarTool] : CALENDAR_READ_TOOLS;
    if (expectedCalendarTool === "create_calendar_event") {
      const hasTitle = Boolean(firstString(args, ["title", "text", "description"]));
      const hasDate = Boolean(firstString(args, ["date"])) || hasTimeEvidence(text, args);
      const hasTime = Boolean(firstString(args, ["time"])) || hasTimeEvidence(text, args);
      if (!hasTitle || !hasDate || !hasTime) required.push("calendar_action");
    } else if (expectedCalendarTool) {
      if (!firstString(args, ["event_id"])) required.push("calendar_action");
    }
  } else if (routing.domains.includes("todo")) {
    intent = "todo";
    eligibleTools = TODO_TOOLS;
  } else if (noteActionIntent) {
    intent = "note_action";
    eligibleTools = ["act_on_note"];
  } else if (profileCityIntent) {
    intent = "profile_setting";
    eligibleTools = ["save_city"];
    if (!firstString(args, ["city", "name", "location"])) required.push("city");
  } else if (taskControlIntent) {
    intent = "task_control";
    eligibleTools = ["control_task"];
  } else {
    const fallbackPolicy = policyForIntent("no_action");
    if (KNOWN_SAFE_READ_TOOLS.has(input.selectedTool)) {
      return {
        allowed: true,
        intent: "read",
        precedence: 8,
        selectedTool: input.selectedTool,
        eligibleTools: [input.selectedTool],
        risk: "read",
        reason: "The selected tool is explicitly classified as read-only.",
        outcome: "",
        routingDomain: routing.primary_domain,
        missingEntities: [],
      };
    }
    return reject(
      { ...fallbackPolicy, precedence: 8, risk: "external_side_effect" },
      input,
      routing.primary_domain,
      MUTATING_TOOLS.has(input.selectedTool)
        ? "The current owner utterance does not provide enough deterministic evidence for this side effect."
        : "The selected tool is not classified by the deterministic policy and is denied by default.",
      routing.clarification_question ?? "What would you like me to do?",
    );
  }

  const policy = policyForIntent(intent);
  if (required.length > 0) {
    return reject(
      policy,
      input,
      routing.primary_domain,
      `Required entities are missing: ${required.join(", ")}.`,
      policy.clarification,
      required,
    );
  }
  if (!eligibleTools.includes(input.selectedTool)) {
    return reject(
      policy,
      input,
      routing.primary_domain,
      `The selected tool '${input.selectedTool}' conflicts with '${intent}' intent.`,
      `I didn't do that because this request belongs to ${intent.replaceAll("_", " ")}. ${policy.clarification}`,
    );
  }
  if (input.channel === "text" && !policy.allowedChannels.includes("text")) {
    return reject(
      policy,
      input,
      routing.primary_domain,
      "This tool is not authorized in Type to Carson.",
      "Use Talk to Carson to complete that action.",
    );
  }

  return {
    allowed: true,
    intent,
    precedence: policy.precedence,
    selectedTool: input.selectedTool,
    eligibleTools,
    risk: policy.risk,
    reason: `The selected tool is eligible for explicit ${intent.replaceAll("_", " ")} intent.`,
    outcome: "",
    routingDomain: routing.primary_domain,
    missingEntities: [],
  };
}
