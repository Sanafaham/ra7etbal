import { create } from "zustand";
import { extractItems } from "../lib/ai/extract";
import type { Assignment, ExtractedItem } from "../types/extraction";
import type { Person } from "../types/person";

/**
 * Extraction store — holds the latest AI extraction so the Review screen can
 * render it. The user can edit assignments locally; saving to Supabase is a
 * later step.
 *
 * In-memory only (no localStorage). Cleared on sign-out via stores/sync.ts.
 */

export type ExtractionStatus = "idle" | "running" | "ready" | "error";

export interface ExtractionState {
  status: ExtractionStatus;
  items: ExtractedItem[];
  summary: string;
  /** Original input text that produced this extraction. */
  sourceText: string;
  error: string | null;

  run: (text: string, people: Person[]) => Promise<void>;
  setAssignment: (itemId: string, assignedTo: Assignment) => void;
  setDescription: (itemId: string, description: string) => void;
  setSuggestedMessage: (itemId: string, suggestedMessage: string | null) => void;
  clear: () => void;
}

export const useExtractionStore = create<ExtractionState>((set, get) => ({
  status: "idle",
  items: [],
  summary: "",
  sourceText: "",
  error: null,

  async run(text, people) {
    set({ status: "running", error: null });
    try {
      const result = await extractItems(text, people);
      set({
        status: "ready",
        items: result.extracted,
        summary: result.summary,
        sourceText: text,
        error: null,
      });
    } catch (err) {
      set({
        status: "error",
        error:
          err instanceof Error
            ? err.message
            : "Couldn't process that. Please try again.",
      });
      throw err;
    }
  },

  setAssignment(itemId, assignedTo) {
    set({
      items: get().items.map((it) =>
        it.id === itemId
          ? { ...it, assignedTo, needsPerson: assignedTo == null }
          : it,
      ),
    });
  },

  setDescription(itemId, description) {
    set({
      items: get().items.map((it) =>
        it.id === itemId ? { ...it, description } : it,
      ),
    });
  },

  setSuggestedMessage(itemId, suggestedMessage) {
    const next = suggestedMessage && suggestedMessage.trim() ? suggestedMessage : null;
    set({
      items: get().items.map((it) =>
        it.id === itemId ? { ...it, suggestedMessage: next } : it,
      ),
    });
  },

  clear: () =>
    set({
      status: "idle",
      items: [],
      summary: "",
      sourceText: "",
      error: null,
    }),
}));
