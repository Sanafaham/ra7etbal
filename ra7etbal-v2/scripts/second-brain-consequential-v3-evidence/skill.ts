/**
 * EVIDENCE ONLY — Second Brain consequential skill, contract V3
 * (extraction-only). Frozen. Not wired into any Production path.
 *
 * The model only understands and extracts what Sana said. It never outputs a
 * route, a custody judgment, implicit Carson duties, a channel, or a final
 * recipient message. Ra7etBal's C-02 policy (policy.ts) decides custody from
 * the extracted facts; the deterministic boundary (plan.ts) builds the message.
 */
import type { Relationship } from "./anchors";

export const SKILL_VERSION = "second-brain-consequential-v3-extraction-frozen";
export const TOOL_NAME = "extract_owner_instruction";

export const NATURES = ["operational_outcome", "information", "personal_message", "presence_coordination"] as const;
export type Nature = (typeof NATURES)[number];

export const INSTRUCTION_TYPES = [
  "track",
  "follow_up",
  "make_sure",
  "confirm",
  "report_back",
  "remind_owner",
  "act_on_condition",
  "contact_other_person",
  "change_calendar",
  "other",
] as const;
export type InstructionType = (typeof INSTRUCTION_TYPES)[number];

export const CLARIFICATION_REASONS = ["recipient_unknown", "multiple_recipients", "responsibility_unclear"] as const;
export type ClarificationReason = (typeof CLARIFICATION_REASONS)[number];

export interface Responsibility {
  text: string;
  nature: Nature;
  source: string;
}
export interface CarsonInstruction {
  type: InstructionType;
  owner_words: string;
}
export interface V3Extraction {
  outcome: "act" | "clarify";
  recipient: string | null;
  responsibilities: Responsibility[];
  carson_instructions: CarsonInstruction[];
  clarification: { reason: ClarificationReason; question: string } | null;
}

/** The ONLY inputs the skill receives. There is deliberately no channel. */
export interface SkillInput {
  utterance: string;
  people: Array<{ name: string; relationship: Relationship }>;
}

export const TOOL_SCHEMA = {
  name: TOOL_NAME,
  description: "Record exactly what the owner said: who it is for, what that person is asked or told, and anything the owner explicitly told Carson to do.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["outcome", "recipient", "responsibilities", "carson_instructions", "clarification"],
    properties: {
      outcome: { type: "string", enum: ["act", "clarify"] },
      recipient: { type: ["string", "null"], description: "The one person the instruction is for, as the owner referred to them. null only when clarifying." },
      responsibilities: {
        type: "array",
        description: "Everything the recipient is asked to do or is told, in the owner's order.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["text", "nature", "source"],
          properties: {
            text: { type: "string", description: "Natural wording addressed to the recipient. Write the owner as {owner}." },
            nature: { type: "string", enum: [...NATURES] },
            source: { type: "string", description: "Which part of the owner's instruction this comes from (audit only)." },
          },
        },
      },
      carson_instructions: {
        type: "array",
        description: "ONLY what the owner explicitly told Carson itself to do. Empty when the owner gave Carson no such instruction.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["type", "owner_words"],
          properties: {
            type: { type: "string", enum: [...INSTRUCTION_TYPES] },
            owner_words: { type: "string", description: "What the owner said to Carson (audit only)." },
          },
        },
      },
      clarification: {
        type: ["object", "null"],
        additionalProperties: false,
        required: ["reason", "question"],
        properties: {
          reason: { type: "string", enum: [...CLARIFICATION_REASONS] },
          question: { type: "string" },
        },
      },
    },
  },
} as const;

/**
 * Frozen skill instructions. Language understanding only — no custody, no
 * routing. Examples deliberately avoid the evidence corpus sentences.
 */
export function buildSkillSystemPrompt(input: Pick<SkillInput, "people">): string {
  const people = input.people.map((p) => `${p.name} (${p.relationship})`).join(", ");
  return `You read one instruction from the owner and record exactly what she said by calling ${TOOL_NAME}. You do not decide what Carson will do with it, you do not send anything, and you do not judge whether anything needs following up. Ra7etBal decides all of that from what you record.

The owner's people (context to understand who is meant): ${people}.

RECIPIENT
Who the instruction is for, as the owner referred to them.

RESPONSIBILITIES
Everything the recipient is asked to do or is told, in the owner's order, one item each. Keep every material detail: other people involved, reporting to the owner, conditions, times, dates, quantities and places. Write each item naturally to the recipient and refer to the owner only as {owner}; never write or translate her name. Add nothing she did not say. Informal wording, filler and mixed Arabic and English are normal.

Describe the nature of each item — what the owner is doing with it — using one of:
- operational_outcome: the owner wants a result accomplished through this person, something done, fetched, prepared, fixed, arranged, checked, contacted or reported.
- information: the owner is letting the person know something.
- personal_message: the owner's own personal message, wish, invitation or personal request to the person.
- presence_coordination: the owner is coordinating where or when the person is, such as coming to her, waiting for her, meeting her, or waiting until a time.
Use the people list only to understand the request. A staff member asked to call or contact the owner is being given an operational outcome; a family member asked to call the owner is a personal request. Explicit tracking or follow-up words belong in carson_instructions, not in the nature.
Examples of meaning (not phrases to match): "Have Nasira bake bread" — operational_outcome. "Let Ghulam know the delivery came" — information. "Tell my sister I miss her" — personal_message. "Ask Ghulam to wait at the gate for me" — presence_coordination.

CARSON INSTRUCTIONS
Record only what the owner explicitly told Carson itself to do, such as track it, follow up, make sure, confirm, report back, remind her, act later if something happens, contact someone else, or change the calendar. Never record delivering the message, never record anything the owner did not say, and never add what you think Carson should do. If she gave Carson no instruction, leave this empty.

CLARIFICATION
Use outcome "clarify" only when you cannot tell who the one recipient is, the owner names more than one recipient, or what she is asking is genuinely unclear in a way that would matter. Ask one short question. Otherwise use "act".`;
}

export function buildSkillUserMessage(input: Pick<SkillInput, "utterance">): string {
  return `Owner instruction:\n${input.utterance}`;
}

/** Provider-neutral, channel-free request description for a future runner. */
export function buildSkillRequest(input: SkillInput) {
  return {
    system: buildSkillSystemPrompt(input),
    user: buildSkillUserMessage(input),
    tool: TOOL_SCHEMA,
  };
}
