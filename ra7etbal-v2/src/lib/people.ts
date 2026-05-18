import { supabase } from "./supabase";
import type { Person, PersonDraft, PersonPatch } from "../types/person";

/**
 * Thin Supabase wrappers for the `people` table. The store calls these.
 * Components never reach into Supabase directly.
 *
 * All queries rely on RLS to scope rows to the current user — we do NOT
 * pass `user_id` filters from the client. Insert relies on a default
 * (`user_id default auth.uid()`) configured on the column.
 */

const COLUMNS = "id, user_id, name, role, phone, created_at";

export async function listPeople(): Promise<Person[]> {
  const { data, error } = await supabase
    .from("people")
    .select(COLUMNS)
    .order("created_at", { ascending: true });
  if (error) throw friendly(error);
  return (data ?? []) as Person[];
}

export async function createPerson(draft: PersonDraft): Promise<Person> {
  const { data, error } = await supabase
    .from("people")
    .insert(draft)
    .select(COLUMNS)
    .single();
  if (error) throw friendly(error);
  return data as Person;
}

export async function updatePerson(id: string, patch: PersonPatch): Promise<Person> {
  const { data, error } = await supabase
    .from("people")
    .update(patch)
    .eq("id", id)
    .select(COLUMNS)
    .single();
  if (error) throw friendly(error);
  return data as Person;
}

export async function deletePerson(id: string): Promise<void> {
  const { error } = await supabase.from("people").delete().eq("id", id);
  if (error) throw friendly(error);
}

// ---------------------------------------------------------------------------

function friendly(err: { message?: string }): Error {
  const msg = (err.message ?? "").toLowerCase();
  if (msg.includes("row-level security") || msg.includes("permission denied")) {
    return new Error("You don't have permission to do that.");
  }
  if (msg.includes("network") || msg.includes("failed to fetch")) {
    return new Error("Network issue. Please check your connection.");
  }
  return new Error(err.message || "Something went wrong. Please try again.");
}
