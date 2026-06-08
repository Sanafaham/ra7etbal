/**
 * carson-facts.ts
 *
 * Read-only retrieval for Carson's structured durable memory.
 *
 * Schema:
 *   carson_facts (category, key, value, archived_at)
 *   RLS: user sees only their own rows
 */

import { supabase } from "./supabase";

interface CarsonFactRow {
  category: string;
  key: string;
  value: string;
}

/**
 * Load canonical user facts as a compact block for Carson context.
 *
 * Returns an empty string when there are no active facts or when loading fails.
 */
export async function loadUserMemory(limit = 50): Promise<string> {
  const { data, error } = await supabase
    .from("carson_facts")
    .select("category, key, value")
    .is("archived_at", null)
    .order("category", { ascending: true })
    .order("key", { ascending: true })
    .limit(limit);

  if (error) {
    console.error("[carson-facts] loadUserMemory failed:", error.message);
    return "";
  }

  if (!data || data.length === 0) return "";

  const lines = (data as CarsonFactRow[])
    .map((fact) => formatFactLine(fact))
    .filter(Boolean);

  return lines.length > 0 ? `User memory:\n${lines.join("\n")}` : "";
}

function formatFactLine({ category, key, value }: CarsonFactRow): string {
  const cleanedCategory = cleanLabel(category);
  const cleanedKey = cleanLabel(key);
  const cleanedValue = value.trim().replace(/\s+/g, " ");

  if (!cleanedValue) return "";
  if (cleanedCategory && cleanedKey) {
    return `- ${cleanedCategory} / ${cleanedKey}: ${cleanedValue}`;
  }
  if (cleanedCategory) return `- ${cleanedCategory}: ${cleanedValue}`;
  if (cleanedKey) return `- ${cleanedKey}: ${cleanedValue}`;
  return `- ${cleanedValue}`;
}

function cleanLabel(value: string): string {
  return value.trim().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}
