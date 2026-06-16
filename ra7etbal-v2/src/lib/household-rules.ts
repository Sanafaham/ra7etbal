import { supabase } from "./supabase";
import type { HouseholdRules } from "../types/person";

const COLUMNS = "id, user_id, rules, created_at, updated_at";

export async function getHouseholdRules(): Promise<HouseholdRules | null> {
  const { data, error } = await supabase
    .from("household_rules")
    .select(COLUMNS)
    .maybeSingle();
  if (error) throw friendly(error);
  return (data as HouseholdRules | null) ?? null;
}

export async function upsertHouseholdRules(rules: string): Promise<HouseholdRules> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in.");

  const { data, error } = await supabase
    .from("household_rules")
    .upsert({ user_id: user.id, rules, updated_at: new Date().toISOString() }, { onConflict: "user_id" })
    .select(COLUMNS)
    .single();
  if (error) throw friendly(error);
  return data as HouseholdRules;
}

function friendly(err: { message?: string }): Error {
  const msg = (err.message ?? "").toLowerCase();
  if (msg.includes("row-level security") || msg.includes("permission denied")) {
    return new Error("You don't have permission to do that.");
  }
  return new Error(err.message || "Something went wrong. Please try again.");
}
