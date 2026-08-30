/**
 * _carson-tool-definitions.js
 *
 * C-03 Structural Response Ownership Project — Slice 2.
 *
 * Authoritative allowlist of the 23 client tools currently registered in
 * `clientTools` at src/components/home/ElevenLabsAgentWidget.tsx (read
 * exhaustively 2026-08-31). This module does NOT execute tools — execution
 * stays exactly where it is today (the client-side functions in that file).
 * This module only:
 *
 *   1. Declares the OpenAI/ElevenLabs function-calling schema for each tool,
 *      so the Custom LLM reasoning call can select among them.
 *   2. Classifies each tool's outcome determinism, so
 *      _carson-tool-execution-result.js knows when it may trust a
 *      success/failure signal versus when it must stay conservative.
 *
 * Only tools in CARSON_TOOL_ALLOWLIST may ever be exposed to or accepted
 * from the reasoning call — this is the fail-closed replacement for Stage
 * 2A's original "no tool surface" contract (see carson-protected-registry.json).
 */

// ── Deterministic-outcome classification ────────────────────────────────────
//
// A tool is DETERMINISTIC when its current implementation has a real,
// inspectable branch distinguishing success from failure before the string
// return (a thrown error, an `if (!data.ok)`/HTTP-status check, or a
// dedicated outcome ref such as lastDirectToolSuccessRef /
// noteSaveOutcomeRef). Verified per-tool against the actual source, not
// inferred from behavior.
//
// A tool is UNCERTAIN when today's implementation only guarantees "the
// promise did not throw" — per runDirectToolWithDiagnostic's own comment,
// "a string return ... only means the tool didn't throw, not that it
// genuinely succeeded." Until each such tool is individually reviewed and
// given a real internal success/failure signal, ToolExecutionResult must
// report `outcome: "uncertain"` for it — never inferred as success.

export const DETERMINISTIC_OUTCOME_TOOLS = new Set([
  "execute_instruction", // lastDirectToolSuccessRef + hosting exact-output signal
  "send_delegation", // lastDirectToolSuccessRef (OVERRIDABLE_TOOL_NAMES)
  "create_reminder", // lastDirectToolSuccessRef (OVERRIDABLE_TOOL_NAMES)
  "create_automation", // lastDirectToolSuccessRef (OVERRIDABLE_TOOL_NAMES)
  "save_note", // dedicated noteSaveOutcomeRef, turn-scoped
  "create_todo", // lastDirectToolSuccessRef (OVERRIDABLE_TOOL_NAMES)
  "complete_todo", // lastDirectToolSuccessRef (OVERRIDABLE_TOOL_NAMES)
  "control_task", // lastDirectToolSuccessRef (OVERRIDABLE_TOOL_NAMES)
  "create_calendar_event", // explicit `if (!data.ok)` branch, verified C-05 review
  "update_calendar_event", // explicit `if (!data.ok)` branch, verified C-05 review
  "delete_calendar_event", // explicit `if (!data.ok)` branch, verified C-05 review
  "save_instruction", // explicit try/catch with distinguishable success/failure text
]);

// Read-only query tools. Deterministic on the narrower axis of "did the read
// itself succeed" (their own fetch/response handling), not on a mutation
// outcome. PRESUMED deterministic by the same fetch/response.ok pattern used
// elsewhere in this file family — not individually re-read line-by-line in
// this pass. Flagged honestly: confirm each before relying on this in a
// production path.
export const PRESUMED_DETERMINISTIC_READ_TOOLS = new Set([
  "get_calendar_events",
  "search_calendar_history",
  "get_task_delivery_status",
  "get_operations_summary",
  "get_commitment_history",
  "get_person_history",
  "get_communication_history",
]);

// Verified 2026-08-31: current implementation returns a string on both
// genuine success and business-logic rejection with no distinguishable
// internal signal. Conservative per owner instruction.
export const UNCERTAIN_OUTCOME_TOOLS = new Set([
  "send_followup",
  "send_direct_whatsapp_message",
  "save_city",
  "act_on_note",
]);

// send_delegation is retained as LEGACY / COMPATIBILITY ONLY per C-02
// (RESOLVED / OWNER APPROVED). It remains on the allowlist because removing
// it is explicitly out of scope until later evidence proves no caller
// depends on it — but the reasoning system prompt must instruct the model to
// prefer execute_instruction, matching the existing C-02 product rule.
export const LEGACY_COMPATIBILITY_TOOLS = new Set(["send_delegation"]);

function outcomeClassOf(name) {
  if (DETERMINISTIC_OUTCOME_TOOLS.has(name)) return "deterministic";
  if (PRESUMED_DETERMINISTIC_READ_TOOLS.has(name)) return "presumed_deterministic_read";
  if (UNCERTAIN_OUTCOME_TOOLS.has(name)) return "uncertain";
  return "unclassified";
}

// ── OpenAI/ElevenLabs function-calling schema ───────────────────────────────
//
// Parameter shapes mirror the actual client tool signatures read from
// ElevenLabsAgentWidget.tsx. Some upstream types (e.g. ExecuteInstructionParams)
// are not fully expanded in this pass — where a field list could not be
// independently confirmed, the schema is intentionally permissive
// (additionalProperties: true) rather than inventing precise-looking but
// unverified field names. Tighten in a follow-up slice once each tool's
// exported param type is read in full.

const READ_ONLY_KEYWORD_SCHEMA = {
  type: "object",
  properties: { keyword: { type: "string" } },
  additionalProperties: false,
};

const READ_ONLY_PERSON_SCHEMA = {
  type: "object",
  properties: { person_name: { type: "string" } },
  additionalProperties: false,
};

export const CARSON_TOOL_ALLOWLIST = [
  {
    name: "execute_instruction",
    mutating: true,
    canBeExact: true, // Hosting's clarification/proposal/approval-question/execution-summary
    description:
      "Canonical tracked-work entry path (C-02). Routes the owner's raw instruction through the shared Carson pipeline: tracked delegation (simple, multi-person, recurring, photo-based) and Hosting. Prefer this over send_delegation.",
    parameters: {
      type: "object",
      properties: { instruction: { type: "string", description: "The owner's raw instruction, verbatim." } },
      required: ["instruction"],
      additionalProperties: true,
    },
  },
  {
    name: "send_delegation",
    mutating: true,
    canBeExact: false,
    legacy: true,
    description:
      "LEGACY / COMPATIBILITY ONLY (C-02, resolved). Do not select this for new tracked work — prefer execute_instruction. Retained only because removing it is not yet evidenced as safe.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        task: { type: "string" },
        message: { type: "string" },
        note: { type: "string" },
      },
      required: ["name", "task"],
      additionalProperties: false,
    },
  },
  {
    name: "send_followup",
    mutating: true,
    canBeExact: false,
    description: "Follows up on an existing tracked task. Distinct from creating new tracked work.",
    parameters: { type: "object", properties: {}, additionalProperties: true },
  },
  {
    name: "create_reminder",
    mutating: true,
    canBeExact: false,
    description: "Creates a one-time or recurring personal reminder, or an invisible-deadline reminder (C-06).",
    parameters: { type: "object", properties: {}, additionalProperties: true },
  },
  {
    name: "create_automation",
    mutating: true,
    canBeExact: false,
    description:
      "Scheduling/execution infrastructure for recurring tracked delegated work (C-06) — not a competing entry point to execute_instruction.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        instruction: { type: "string" },
        cadence_phrase: { type: "string", description: "Preserve the owner's exact cadence wording (C-06)." },
        first_run_text: { type: "string" },
        assignee_name: { type: "string" },
      },
      required: ["title", "instruction", "cadence_phrase"],
      additionalProperties: false,
    },
  },
  {
    name: "send_direct_whatsapp_message",
    mutating: true,
    canBeExact: false,
    description: "Delivery-only communication with no tracked outcome.",
    parameters: {
      type: "object",
      properties: { recipient_name: { type: "string" }, message: { type: "string" } },
      required: ["recipient_name", "message"],
      additionalProperties: false,
    },
  },
  {
    name: "save_city",
    mutating: true,
    canBeExact: false,
    description: "Stores a supplied city for weather context.",
    parameters: { type: "object", properties: {}, additionalProperties: true },
  },
  {
    name: "save_note",
    mutating: true,
    canBeExact: false,
    description: "Saves information/idea/reference the owner wants remembered (not a to-do).",
    parameters: { type: "object", properties: {}, additionalProperties: true },
  },
  {
    name: "act_on_note",
    mutating: true,
    canBeExact: false,
    description: "Acts on an existing note (e.g. put it on the calendar, ask someone about it).",
    parameters: { type: "object", properties: {}, additionalProperties: true },
  },
  {
    name: "create_todo",
    mutating: true,
    canBeExact: false,
    description: "Creates an owner to-do — something the owner needs to do.",
    parameters: { type: "object", properties: {}, additionalProperties: true },
  },
  {
    name: "complete_todo",
    mutating: true,
    canBeExact: false,
    description: "Marks an existing to-do complete.",
    parameters: { type: "object", properties: {}, additionalProperties: true },
  },
  {
    name: "control_task",
    mutating: true,
    canBeExact: false,
    description: "Controls an existing tracked task's state.",
    parameters: { type: "object", properties: {}, additionalProperties: true },
  },
  {
    name: "get_calendar_events",
    mutating: false,
    canBeExact: false,
    description: "Reads future calendar events for a named range (today/tomorrow/this_week/next_week/next_10_days/next_30_days).",
    parameters: { type: "object", properties: { range: { type: "string" } }, additionalProperties: false },
  },
  {
    name: "search_calendar_history",
    mutating: false,
    canBeExact: false,
    description: "Reads past calendar events. Never mutates state (C-05).",
    parameters: {
      type: "object",
      properties: { start_date: { type: "string" }, end_date: { type: "string" }, query: { type: "string" } },
      additionalProperties: false,
    },
  },
  { name: "get_task_delivery_status", mutating: false, canBeExact: false, description: "Reads delivery status for tracked tasks.", parameters: READ_ONLY_KEYWORD_SCHEMA },
  { name: "get_operations_summary", mutating: false, canBeExact: false, description: "Reads an operations health summary.", parameters: { type: "object", properties: {}, additionalProperties: true } },
  { name: "get_commitment_history", mutating: false, canBeExact: false, description: "Reads commitment history evidence.", parameters: READ_ONLY_KEYWORD_SCHEMA },
  { name: "get_person_history", mutating: false, canBeExact: false, description: "Reads a person's history.", parameters: READ_ONLY_PERSON_SCHEMA },
  { name: "get_communication_history", mutating: false, canBeExact: false, description: "Reads communication history with a person.", parameters: READ_ONLY_PERSON_SCHEMA },
  {
    name: "create_calendar_event",
    mutating: true,
    canBeExact: false,
    description:
      "Creates a calendar event. C-05 (resolved): act immediately once title, date, and time are known; 60-minute default duration when unsupplied; never invent an unsupported default (e.g. a vague daypart). On conflict with no prior override authorization, report and ask once before proceeding.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        date: { type: "string", description: "YYYY-MM-DD" },
        time: { type: "string", description: "HH:MM 24-hour" },
        duration_minutes: { type: "number" },
        description: { type: "string" },
        override_conflict: { type: "boolean" },
      },
      required: ["title", "date", "time"],
      additionalProperties: false,
    },
  },
  {
    name: "update_calendar_event",
    mutating: true,
    canBeExact: false,
    description: "Updates an existing calendar event's changed fields only (C-05). Requires event_id from get_calendar_events.",
    parameters: {
      type: "object",
      properties: {
        event_id: { type: "string" },
        title: { type: "string" },
        date: { type: "string" },
        time: { type: "string" },
        duration_minutes: { type: "number" },
      },
      required: ["event_id"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_calendar_event",
    mutating: true,
    canBeExact: false,
    description: "Deletes a calendar event. Only on explicit delete/cancel/remove language directed at a uniquely resolved event (C-05).",
    parameters: {
      type: "object",
      properties: { event_id: { type: "string" } },
      required: ["event_id"],
      additionalProperties: false,
    },
  },
  {
    name: "save_instruction",
    mutating: true,
    canBeExact: false,
    description: "Saves a durable behavioral instruction/rule for future turns.",
    parameters: {
      type: "object",
      properties: { instruction: { type: "string" }, category: { type: "string" } },
      required: ["instruction"],
      additionalProperties: false,
    },
  },
].map((tool) => ({ ...tool, outcomeClass: outcomeClassOf(tool.name) }));

const ALLOWLIST_NAMES = new Set(CARSON_TOOL_ALLOWLIST.map((tool) => tool.name));

export function isAllowlistedTool(name) {
  return typeof name === "string" && ALLOWLIST_NAMES.has(name);
}

export function getToolDefinition(name) {
  return CARSON_TOOL_ALLOWLIST.find((tool) => tool.name === name) ?? null;
}

/** OpenAI-format `tools` array to send to the reasoning provider. */
export function toOpenAiToolsPayload() {
  return CARSON_TOOL_ALLOWLIST.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}
