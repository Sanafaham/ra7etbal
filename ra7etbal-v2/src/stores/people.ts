import { create } from "zustand";
import {
  createPerson as apiCreate,
  deletePerson as apiDelete,
  listPeople as apiList,
  updatePerson as apiUpdate,
} from "../lib/people";
import type { Person, PersonDraft, PersonPatch } from "../types/person";

/**
 * People store
 *
 * Supabase is the only source of truth. The store caches the last fetched
 * list in memory keyed by the userId it was loaded for, so we re-fetch when
 * the signed-in user changes (or on first visit).
 *
 * No localStorage mirror — refreshing the page falls back to loadFor() which
 * re-fetches from Supabase. This is the architectural fix for the v1 bug
 * where a stale localStorage cache could overwrite a fresh empty Supabase
 * response and make people "disappear".
 *
 * CRUD actions update the cache optimistically and roll back on error so the
 * UI feels instant but never drifts from Supabase.
 */

export type PeopleStatus = "idle" | "loading" | "ready" | "error";

export interface PeopleState {
  status: PeopleStatus;
  items: Person[];
  error: string | null;
  /** The user.id this cache was loaded for. Re-fetch when it changes. */
  loadedForUserId: string | null;

  loadFor: (userId: string, opts?: { force?: boolean }) => Promise<void>;
  reset: () => void;

  add: (draft: PersonDraft) => Promise<Person>;
  update: (id: string, patch: PersonPatch) => Promise<Person>;
  remove: (id: string) => Promise<void>;
}

export const usePeopleStore = create<PeopleState>((set, get) => ({
  status: "idle",
  items: [],
  error: null,
  loadedForUserId: null,

  reset: () =>
    set({ status: "idle", items: [], error: null, loadedForUserId: null }),

  async loadFor(userId, opts) {
    const { status, loadedForUserId } = get();
    const sameUser = loadedForUserId === userId;
    const cached = sameUser && status === "ready";
    if (cached && !opts?.force) return;
    if (status === "loading" && sameUser && !opts?.force) return;

    set({ status: "loading", error: null });
    try {
      const items = await apiList();
      // Guard against an out-of-order response after the user changed.
      if (get().loadedForUserId && get().loadedForUserId !== userId) return;
      set({ status: "ready", items, loadedForUserId: userId, error: null });
    } catch (err) {
      set({
        status: "error",
        error: err instanceof Error ? err.message : "Could not load people.",
      });
    }
  },

  async add(draft) {
    // Optimistic: insert a temp row so the list updates instantly.
    const tempId = "tmp_" + Math.random().toString(36).slice(2);
    const optimistic: Person = {
      id: tempId,
      user_id: get().loadedForUserId ?? "",
      name: draft.name,
      role: draft.role,
      phone: draft.phone,
      notes: draft.notes,
      created_at: new Date().toISOString(),
      relationship: draft.relationship ?? null,
      is_family: draft.is_family ?? false,
      responsibilities: draft.responsibilities ?? null,
      reliability_level: draft.reliability_level ?? null,
      follow_up_level: draft.follow_up_level ?? null,
      delegation_guidance: draft.delegation_guidance ?? null,
      should_not_assign: draft.should_not_assign ?? null,
      escalate_to: draft.escalate_to ?? null,
      communication_style: draft.communication_style ?? null,
      whatsapp_opted_in: draft.whatsapp_opted_in ?? false,
      whatsapp_consent_at: draft.whatsapp_consent_at ?? null,
      whatsapp_consent_method: draft.whatsapp_consent_method ?? null,
    };
    set((s) => ({ items: [...s.items, optimistic] }));
    try {
      const created = await apiCreate(draft);
      set((s) => ({
        items: s.items.map((p) => (p.id === tempId ? created : p)),
      }));
      return created;
    } catch (err) {
      // Rollback the optimistic insert.
      set((s) => ({ items: s.items.filter((p) => p.id !== tempId) }));
      throw err;
    }
  },

  async update(id, patch) {
    const prev = get().items.find((p) => p.id === id);
    if (!prev) throw new Error("Person not found");
    const optimistic: Person = { ...prev, ...patch } as Person;
    set((s) => ({
      items: s.items.map((p) => (p.id === id ? optimistic : p)),
    }));
    try {
      const updated = await apiUpdate(id, patch);
      set((s) => ({
        items: s.items.map((p) => (p.id === id ? updated : p)),
      }));
      return updated;
    } catch (err) {
      set((s) => ({ items: s.items.map((p) => (p.id === id ? prev : p)) }));
      throw err;
    }
  },

  async remove(id) {
    const prev = get().items;
    set({ items: prev.filter((p) => p.id !== id) });
    try {
      await apiDelete(id);
    } catch (err) {
      // Restore on failure.
      set({ items: prev });
      throw err;
    }
  },
}));
