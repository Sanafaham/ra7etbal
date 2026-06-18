/**
 * Person — a household helper or family member belonging to one Ra7etBal user.
 * Rows live in the Supabase `people` table; visibility is enforced by RLS.
 */

export type ReliabilityLevel = "very_high" | "high" | "medium" | "needs_support";
export type FollowUpLevel    = "none" | "light" | "regular" | "high";

export interface Person {
  id: string;
  user_id: string;
  name: string;
  role: string;
  phone: string | null;
  notes: string | null;
  created_at: string;

  // Household knowledge fields
  /** e.g. "Sana's brother", "Sana's daughter", "household staff" */
  relationship: string | null;
  /** True for family members who should never be treated as staff. */
  is_family: boolean;
  /** What this person is responsible for. */
  responsibilities: string | null;
  /** How reliably they execute without supervision. */
  reliability_level: ReliabilityLevel | null;
  /** How often Carson should prompt the owner to follow up. */
  follow_up_level: FollowUpLevel | null;
  /** Carson-facing delegation instructions for this person. */
  delegation_guidance: string | null;
  /** Task types or topics Carson must never assign to this person. */
  should_not_assign: string | null;
  /** Name of the person to escalate to if this person is unresponsive. */
  escalate_to: string | null;
  /** How they prefer to receive instructions (e.g. "short WhatsApp messages"). */
  communication_style: string | null;

  // WhatsApp consent
  /** True only when the person has explicitly consented to receive WhatsApp messages. */
  whatsapp_opted_in: boolean;
  /** ISO timestamp of when consent was recorded. */
  whatsapp_consent_at: string | null;
  /** How consent was collected: 'owner_confirmed' | 'self_registered' */
  whatsapp_consent_method: string | null;
}

/** Payload for create — the server fills id/user_id/created_at. */
export interface PersonDraft {
  name: string;
  role: string;
  phone: string | null;
  notes: string | null;
  relationship: string | null;
  is_family: boolean;
  responsibilities: string | null;
  reliability_level: ReliabilityLevel | null;
  follow_up_level: FollowUpLevel | null;
  delegation_guidance: string | null;
  should_not_assign: string | null;
  escalate_to: string | null;
  communication_style: string | null;
  whatsapp_opted_in: boolean;
  whatsapp_consent_at: string | null;
  whatsapp_consent_method: string | null;
}

/** Payload for update — only mutable fields. */
export type PersonPatch = Partial<PersonDraft>;

/** Household-level delegation rules (one per user). */
export interface HouseholdRules {
  id: string;
  user_id: string;
  rules: string;
  created_at: string;
  updated_at: string;
}
