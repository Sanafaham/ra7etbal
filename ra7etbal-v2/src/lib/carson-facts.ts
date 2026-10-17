/**
 * carson-facts.ts
 *
 * Retrieval and correction-aware writes for Carson's structured durable
 * memory.
 *
 * Schema:
 *   carson_facts (category, key, value, archived_at, ...)
 *   RLS: user sees / inserts / updates only their own rows
 *
 * Selection and correction rules live in shared/carson-memory-selection.js
 * so Talk, Type and WhatsApp Carson make the same decision.
 */

import { extractDurableFacts, type ExtractedCarsonFact } from "./carson-fact-extract";
import type { TranscriptMessage } from "./carson-summarize";
import { supabase } from "./supabase";
import {
  buildCarsonMemoryContext,
  buildPeopleIndex,
  findFactsSupersededBy,
  formatUserMemoryBlock,
  selectRelevantFacts,
  type FactRow,
  type MemoryPersonRow,
} from "../../shared/carson-memory-selection.js";

interface CarsonFactRow {
  category: string;
  key: string;
  value: string;
}

/** Columns every fact reader needs for relevance and correction decisions. */
export const FACT_COLUMNS =
  "id, category, key, value, confidence, source, created_at, updated_at, last_seen_at";

/** Upper bound on active facts read per owner (PostgREST page). */
const MAX_ACTIVE_FACTS = 1000;

/**
 * All active (non-archived) facts for the signed-in user. Throws on a
 * database error so callers can tell "none" from "could not load".
 */
export async function loadActiveFactRows(): Promise<FactRow[]> {
  const { data, error } = await supabase
    .from("carson_facts")
    .select(FACT_COLUMNS)
    .is("archived_at", null)
    .order("updated_at", { ascending: false })
    .limit(MAX_ACTIVE_FACTS);
  if (error) throw error;
  return (data ?? []) as FactRow[];
}

/**
 * Load the facts most relevant to the current context as a compact block for
 * Carson. Replaces the old "first 50 rows alphabetically by category", which
 * hid most relationship, preference and correction facts.
 *
 * Returns an empty string when there are no active facts or when loading fails.
 */
export async function loadUserMemory(
  limit = 60,
  context: { contextText?: string; people?: MemoryPersonRow[] } = {},
): Promise<string> {
  let rows: FactRow[];
  try {
    rows = await loadActiveFactRows();
  } catch (error) {
    console.error("[carson-facts] loadUserMemory failed:", (error as { message?: string })?.message ?? error);
    return "";
  }
  if (rows.length === 0) return "";
  return buildCarsonMemoryContext({
    facts: rows,
    people: context.people,
    contextText: context.contextText,
    factLimit: limit,
  }).userMemory;
}

/**
 * Existing facts relevant to a transcript, for the fact extractor to reuse
 * exact (category, key) pairs when the owner updates or corrects them.
 */
export function selectFactsForExtraction(
  rows: FactRow[],
  transcriptText: string,
  people?: MemoryPersonRow[],
  limit = 40,
): FactRow[] {
  return selectRelevantFacts(rows, {
    contextText: transcriptText,
    peopleIndex: buildPeopleIndex(people),
    limit,
    charBudget: 4000,
  });
}

/**
 * The one post-conversation fact-learning path (Talk to Carson and Text
 * Carson both call it): show the extractor the owner's related existing
 * facts so a correction keeps its key, then save and archive what it
 * corrects. Never throws; learning is best-effort and must not block Carson.
 */
export async function learnFactsFromTranscript(
  userId: string,
  transcript: TranscriptMessage[],
  people?: MemoryPersonRow[],
): Promise<{ saved: boolean; archivedIds: string[]; extracted: number }> {
  let existing: FactRow[] | undefined;
  try {
    existing = await loadActiveFactRows();
  } catch (err) {
    // Extraction still runs without context; the read-time resolver keeps
    // corrections safe even if a duplicate key is created.
    console.error("[carson-facts] existing facts unavailable for extraction:", (err as { message?: string })?.message ?? err);
  }
  const userText = transcript.filter((m) => m.role === "user").map((m) => m.message).join("\n");
  const related = existing ? selectFactsForExtraction(existing, userText, people) : [];
  let facts: ExtractedCarsonFact[] = [];
  try {
    facts = await extractDurableFacts(transcript, related);
  } catch (err) {
    console.error("[carson-facts] fact extraction failed:", (err as { message?: string })?.message ?? err);
    return { saved: false, archivedIds: [], extracted: 0 };
  }
  if (facts.length === 0) return { saved: false, archivedIds: [], extracted: 0 };
  const result = await upsertUserFacts(userId, facts, { people, existingFacts: existing });
  return { ...result, extracted: facts.length };
}

export function formatUserMemoryForCarson(facts: CarsonFactRow[]): string {
  return formatUserMemoryBlock(facts);
}

/**
 * Upsert validated durable facts for the signed-in user, then archive the
 * older facts they correct.
 *
 * Uses (user_id, category, key) as the conflict target so repeated facts update
 * their canonical row and refresh last_seen_at instead of creating duplicates.
 * Re-stating a fact un-archives it.
 *
 * Correction safety: archiving runs only AFTER the new facts are saved, and
 * archiving is a reversible flag (archived_at), never a delete. If the
 * upsert fails nothing is archived; if archiving fails the newer fact still
 * wins at read time (shared resolution), so Carson never uses the old value.
 */
export async function upsertUserFacts(
  userId: string,
  facts: ExtractedCarsonFact[],
  options: { people?: MemoryPersonRow[]; existingFacts?: FactRow[] } = {},
): Promise<{ saved: boolean; archivedIds: string[] }> {
  const trimmedUserId = userId.trim();
  if (!trimmedUserId || facts.length === 0) return { saved: false, archivedIds: [] };

  const now = new Date().toISOString();
  const rows = facts.map((fact) => ({
    user_id: trimmedUserId,
    category: fact.category,
    key: fact.key,
    value: fact.value,
    confidence: fact.confidence,
    source: "voice_session",
    last_seen_at: now,
    archived_at: null,
  }));

  const { error } = await supabase
    .from("carson_facts")
    .upsert(rows, { onConflict: "user_id,category,key" });

  if (error) {
    console.error("[carson-facts] upsertUserFacts failed:", error.message);
    return { saved: false, archivedIds: [] };
  }

  let existing = options.existingFacts;
  if (!existing) {
    try {
      existing = await loadActiveFactRows();
    } catch (err) {
      console.error("[carson-facts] correction lookup failed:", (err as { message?: string })?.message ?? err);
      return { saved: true, archivedIds: [] };
    }
  }

  const ids = findFactsSupersededBy(existing, facts, options.people);
  if (ids.length === 0) return { saved: true, archivedIds: [] };

  const { error: archiveError } = await supabase
    .from("carson_facts")
    .update({ archived_at: now })
    .eq("user_id", trimmedUserId)
    .in("id", ids)
    .is("archived_at", null);

  if (archiveError) {
    console.error("[carson-facts] archiving corrected facts failed:", archiveError.message);
    return { saved: true, archivedIds: [] };
  }
  return { saved: true, archivedIds: ids };
}
