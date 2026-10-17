/**
 * EVIDENCE ONLY — Second Brain consequential skill, contract V2 (frozen).
 * Not wired into any Production path.
 *
 * One model call proposes responsibilities. The model never outputs a
 * tracked/direct route, a channel, or the final recipient message: Ra7etBal
 * derives the route and composes the message deterministically (plan.ts).
 *
 * The skill input has NO channel field. Voice and typed input are the same
 * owner instruction reaching the same contract (C-01).
 */

export const SKILL_VERSION = "second-brain-consequential-v2-frozen";
export const TOOL_NAME = "propose_responsibilities";

export const CARSON_DUTY_TYPES = [
  "track_until_confirmed",
  "report_outcome_to_owner",
  "remind_owner",
  "act_on_condition",
  "contact_other_person",
  "change_calendar",
  "other",
] as const;
export type CarsonDutyType = (typeof CARSON_DUTY_TYPES)[number];

export const CLARIFICATION_REASONS = ["recipient_unknown", "multiple_recipients", "material_meaning_unclear"] as const;
export type ClarificationReason = (typeof CLARIFICATION_REASONS)[number];

export interface RecipientItem {
  text: string;
  carson_follows_through: boolean;
  basis: string;
}
export interface CarsonDuty {
  type: CarsonDutyType;
  detail: string;
}
export interface V2Proposal {
  outcome: "act" | "clarify";
  recipient: string | null;
  recipient_items: RecipientItem[];
  carson_duties: CarsonDuty[];
  clarification: { reason: ClarificationReason; question: string } | null;
}

/** The ONLY inputs the skill receives. There is deliberately no channel. */
export interface SkillInput {
  utterance: string;
  ownerName: string;
  people: Array<{ name: string; relationship: "staff" | "family" }>;
}

export const TOOL_SCHEMA = {
  name: TOOL_NAME,
  description:
    "Describe the responsibilities in the owner's instruction. Ra7etBal decides the route and writes the recipient's message from your items.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["outcome", "recipient", "recipient_items", "carson_duties", "clarification"],
    properties: {
      outcome: { type: "string", enum: ["act", "clarify"] },
      recipient: { type: ["string", "null"], description: "The one recipient, as the owner named them. null only when clarifying." },
      recipient_items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["text", "carson_follows_through", "basis"],
          properties: {
            text: { type: "string", description: "One responsibility or piece of content for the recipient, written naturally to them. Write the owner as {owner}." },
            carson_follows_through: {
              type: "boolean",
              description: "After truthful delivery, does Carson still own follow-through on this outcome?",
            },
            basis: { type: "string", description: "A few words explaining the answer (audit only)." },
          },
        },
      },
      carson_duties: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["type", "detail"],
          properties: {
            type: { type: "string", enum: [...CARSON_DUTY_TYPES] },
            detail: { type: "string" },
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
 * Frozen skill instructions. Examples deliberately avoid the exact evidence
 * corpus sentences (anti-leakage); the C-02 ruling is stated as principle.
 */
export function buildSkillSystemPrompt(input: Pick<SkillInput, "ownerName" | "people">): string {
  const people = input.people.map((p) => `${p.name} (${p.relationship})`).join(", ");
  return `You are Carson, Chief of Staff for {owner}. Ra7etBal will fill in {owner}'s real name.

The owner's people: ${people}.

Your job for this instruction is to describe its responsibilities by calling ${TOOL_NAME}. You never send anything and never decide the delivery route. Ra7etBal does that from what you describe. Ordinary clear instructions are carried out without asking the owner to confirm.

RECIPIENT
Name the one person who will receive this. If you cannot tell who it is, or the owner wants it sent to more than one person, set outcome to "clarify".

RECIPIENT ITEMS
List what the recipient must do or know, one item per responsibility or piece of content. Keep every material thing the owner asked of the recipient, including telling or contacting other people, reporting to {owner}, and every condition, time, date, quantity and place. Write each item naturally to the recipient. Refer to the owner only as {owner}; never write or translate the owner's name. Add nothing the owner did not ask for. Informal wording, filler and mixed Arabic and English are normal; keep the meaning, not the exact words.

For each item answer one question: after this is truthfully delivered, does Carson still own follow-through on this outcome?
- Yes when the recipient is being assigned an action or outcome that Carson should see through until it is done. A request for a staff member to call, contact, message or otherwise personally respond to {owner} is such an assignment.
- No when the item is information, or a personal or family message, wish, invitation or preference where Carson's job genuinely ends once it is delivered, or when the recipient is asked to come to, wait for or meet {owner}, who will see that happen herself.
Relationship is context, not the answer: decide by the question above. Sentence wording such as "ask" or "tell" does not decide it.
Examples of the meaning (not phrases to match): "Have Nasira bake bread" — yes. "Let Ghulam know the delivery came" — no. "Tell Nasira to wait for me at the door" — no. "Get Ghulam to ring me" (staff) — yes.

CARSON DUTIES
Anything the owner asks Carson itself to do goes here, never in recipient items: tracking it, keeping an eye on it, making sure it happens, chasing, following up, reporting back to {owner}, reminding {owner}, acting later when something happens, contacting another person, or changing the calendar. Use the closest type.

CLARIFICATION
Use outcome "clarify" only when the recipient is unknown, there is more than one recipient, or the meaning is so unclear that acting could do the wrong thing and that would matter. Ask one short question. Otherwise act.`;
}

export function buildSkillUserMessage(input: Pick<SkillInput, "utterance">): string {
  return `Owner instruction:\n${input.utterance}`;
}

/** The complete, channel-free model request body (used by the future runner and by parity tests). */
export function buildSkillRequest(input: SkillInput, model: string, maxTokens = 800) {
  return {
    model,
    max_tokens: maxTokens,
    system: buildSkillSystemPrompt(input),
    tools: [TOOL_SCHEMA],
    tool_choice: { type: "tool", name: TOOL_NAME },
    messages: [{ role: "user", content: buildSkillUserMessage(input) }],
  };
}
