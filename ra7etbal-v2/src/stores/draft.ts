import { create } from "zustand";

/**
 * Draft store
 *
 * Holds the "Clear My Head" text the user is typing on Home before they send
 * it through AI extraction (Step 7). In-memory only — refresh clears it, like
 * any unsaved draft, and we clear it on sign-out via `stores/sync.ts`.
 *
 * No localStorage. The premise of this app is that you type a thought, the AI
 * turns it into tasks/messages, and then the tasks/messages are the durable
 * record in Supabase. Persisting raw drafts across devices would surface
 * private text in places the user doesn't expect.
 */
export interface DraftState {
  text: string;
  setText: (text: string) => void;
  clear: () => void;
}

export const useDraftStore = create<DraftState>((set) => ({
  text: "",
  setText: (text) => set({ text }),
  clear: () => set({ text: "" }),
}));
