/**
 * Person — a household helper (Driver, Nanny, Cook, etc.) belonging to one
 * Ra7etBal user. Rows live in the Supabase `people` table; visibility is
 * enforced by Row Level Security (`user_id = auth.uid()`), not by the
 * client.
 */
export interface Person {
  id: string;
  user_id: string;
  name: string;
  role: string;
  phone: string | null;
  notes: string | null;
  created_at: string;
}

/** Payload for create — the server fills id/user_id/created_at. */
export interface PersonDraft {
  name: string;
  role: string;
  phone: string | null;
  notes: string | null;
}

/** Payload for update — only mutable fields. */
export type PersonPatch = Partial<PersonDraft>;
