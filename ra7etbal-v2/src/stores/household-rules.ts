import { create } from "zustand";
import { getHouseholdRules, upsertHouseholdRules } from "../lib/household-rules";
import type { HouseholdRules } from "../types/person";

interface HouseholdRulesState {
  rules: string;
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  load: () => Promise<void>;
  save: (rules: string) => Promise<void>;
}

export const useHouseholdRulesStore = create<HouseholdRulesState>((set) => ({
  rules: "",
  status: "idle",
  error: null,

  async load() {
    set({ status: "loading", error: null });
    try {
      const row: HouseholdRules | null = await getHouseholdRules();
      set({ rules: row?.rules ?? "", status: "ready" });
    } catch (err) {
      set({
        status: "error",
        error: err instanceof Error ? err.message : "Could not load household rules.",
      });
    }
  },

  async save(rules) {
    set({ error: null });
    try {
      await upsertHouseholdRules(rules);
      set({ rules, status: "ready" });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "Could not save." });
      throw err;
    }
  },
}));
