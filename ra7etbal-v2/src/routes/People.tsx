import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import AuthNotice from "../components/auth/AuthNotice";
import PersonCard from "../components/people/PersonCard";
import PersonForm from "../components/people/PersonForm";
import Spinner from "../components/Spinner";
import Modal from "../components/ui/Modal";
import { useAuth } from "../hooks/useAuth";
import { usePeopleStore } from "../stores/people";
import { useHouseholdRulesStore } from "../stores/household-rules";
import type { Person, PersonDraft } from "../types/person";

export default function People() {
  const { user } = useAuth();
  const userId = user?.id ?? null;

  const { status, items, error, loadedForUserId, loadFor, add, update, remove } =
    usePeopleStore(
      useShallow((s) => ({
        status: s.status,
        items: s.items,
        error: s.error,
        loadedForUserId: s.loadedForUserId,
        loadFor: s.loadFor,
        add: s.add,
        update: s.update,
        remove: s.remove,
      })),
    );

  // ── Household Rules ──────────────────────────────────────────────────────
  const { rules: savedRules, status: rulesStatus, error: rulesError, load: loadRules, save: saveRules } =
    useHouseholdRulesStore(
      useShallow((s) => ({
        rules: s.rules,
        status: s.status,
        error: s.error,
        load: s.load,
        save: s.save,
      })),
    );
  const [rulesText, setRulesText]     = useState("");
  const [rulesSaving, setRulesSaving] = useState(false);
  const [rulesSaved,  setRulesSaved]  = useState(false);
  const rulesBusyRef = useRef(false);

  // Sync local text when store loads
  useEffect(() => {
    if (rulesStatus === "idle") void loadRules();
  }, [rulesStatus, loadRules]);
  useEffect(() => {
    if (rulesStatus === "ready") setRulesText(savedRules);
  }, [rulesStatus, savedRules]);

  async function handleSaveRules() {
    if (rulesBusyRef.current) return;
    rulesBusyRef.current = true;
    setRulesSaving(true);
    try {
      await saveRules(rulesText);
      setRulesSaved(true);
      setTimeout(() => setRulesSaved(false), 2500);
    } finally {
      rulesBusyRef.current = false;
      setRulesSaving(false);
    }
  }

  useEffect(() => {
    if (!userId) return;
    if (loadedForUserId !== userId) void loadFor(userId);
  }, [userId, loadedForUserId, loadFor]);

  const [editing, setEditing] = useState<Person | null>(null);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    if (!query.trim()) return items;
    const q = query.trim().toLowerCase();
    return items.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.role?.toLowerCase().includes(q) ||
        p.phone?.includes(q),
    );
  }, [items, query]);

  async function handleCreate(draft: PersonDraft) {
    await add(draft);
    setAdding(false);
  }

  async function handleUpdate(draft: PersonDraft) {
    if (!editing) return;
    await update(editing.id, draft);
    setEditing(null);
  }

  async function handleDelete() {
    if (!editing) return;
    await remove(editing.id);
    setEditing(null);
  }

  const initialLoading = status === "loading" && items.length === 0;

  return (
    <section className="space-y-4">
      {/* ── Header ── */}
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink">People</h1>
          <p className="text-sm text-ink/55">The people Carson works with.</p>
        </div>
        <button
          type="button"
          onClick={() => setAdding(true)}
          aria-label="Add person"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-sage px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:brightness-105 active:brightness-95"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
          Add
        </button>
      </header>

      {/* ── Error ── */}
      {error && status !== "loading" && (
        <AuthNotice kind="error">
          {error}{" "}
          {userId && (
            <button
              type="button"
              onClick={() => void loadFor(userId, { force: true })}
              className="ml-1 underline"
            >
              Try again
            </button>
          )}
        </AuthNotice>
      )}

      {/* ── Loading ── */}
      {initialLoading && (
        <div className="flex items-center justify-center py-12 text-ink/60">
          <Spinner size={20} label="Loading people" />
        </div>
      )}

      {/* ── Search (only when there are people) ── */}
      {!initialLoading && items.length > 0 && (
        <div className="relative">
          <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-ink/35">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.35-4.35" />
            </svg>
          </span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search people…"
            aria-label="Search people"
            className="w-full rounded-2xl border border-sage/20 bg-white/70 py-2 pl-9 pr-4 text-sm text-ink placeholder:text-ink/35 focus:border-sage/40 focus:outline-none focus:ring-2 focus:ring-sage/15"
          />
        </div>
      )}

      {/* ── Empty state ── */}
      {!initialLoading && status === "ready" && items.length === 0 && (
        <div className="rounded-2xl border border-dashed border-sage/30 bg-white/50 px-6 py-10 text-center">
          {/* Avatar cluster illustration */}
          <div className="mb-4 flex justify-center gap-2">
            {["A", "B", "C"].map((l) => (
              <span
                key={l}
                className="flex h-11 w-11 items-center justify-center rounded-full border-2 border-white bg-sage/10 text-sm font-semibold text-sage shadow-sm"
              >
                {l}
              </span>
            ))}
          </div>
          <p className="text-base font-semibold text-ink">No people added yet.</p>
          <p className="mt-1.5 text-sm leading-relaxed text-ink/55">
            Start by adding family members, staff, or anyone Carson may need to contact.
          </p>
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="mt-5 inline-flex items-center gap-2 rounded-full bg-sage px-5 py-2.5 text-sm font-medium text-white shadow-sm transition hover:brightness-105 active:brightness-95"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
            Add your first person
          </button>
        </div>
      )}

      {/* ── No search results ── */}
      {!initialLoading && items.length > 0 && filtered.length === 0 && (
        <div className="rounded-2xl border border-dashed border-sage/20 bg-white/40 px-4 py-6 text-center text-sm text-ink/45">
          No people match &ldquo;{query}&rdquo;
        </div>
      )}

      {/* ── People list ── */}
      {filtered.length > 0 && (
        <ul className="space-y-2.5">
          {filtered.map((p) => (
            <li key={p.id}>
              <PersonCard person={p} onEdit={setEditing} />
            </li>
          ))}
        </ul>
      )}

      {/* ── Carson context hint (when list is populated) ── */}
      {!initialLoading && items.length > 0 && (
        <p className="pt-1 text-center text-[11px] text-ink/30">
          Carson uses these people for delegation and reminders.
        </p>
      )}

      {/* ── Household Delegation Rules ───────────────────────────────────────── */}
      <div className="rounded-2xl border border-sage/15 bg-white/60 p-5">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-ink">Household Delegation Rules</h2>
            <p className="mt-0.5 text-[11px] leading-relaxed text-ink/45">
              Global rules Carson follows when helping you delegate. Applies to everyone.
            </p>
          </div>
          {rulesSaved && (
            <span className="shrink-0 rounded-full bg-sage/10 px-3 py-1 text-[11px] font-medium text-sage">
              Saved
            </span>
          )}
        </div>

        {rulesError && (
          <div className="mb-3">
            <AuthNotice kind="error">{rulesError}</AuthNotice>
          </div>
        )}

        <textarea
          value={rulesText}
          onChange={(e) => setRulesText(e.target.value)}
          placeholder={
            "e.g.\n• Grace manages all household staff — always loop her in.\n• Never assign financial tasks to staff without my approval.\n• Loulya's schedule always takes priority."
          }
          rows={5}
          disabled={rulesStatus === "loading" || rulesSaving}
          className="w-full resize-none rounded-xl border border-sage/20 bg-white px-4 py-3 text-sm text-ink placeholder:text-ink/30 outline-none focus:border-sage focus:ring-2 focus:ring-sage/20 disabled:opacity-50"
        />

        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={() => void handleSaveRules()}
            disabled={rulesStatus === "loading" || rulesSaving || rulesText === savedRules}
            className="inline-flex items-center gap-2 rounded-full bg-sage px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {rulesSaving && (
              <Spinner size={12} />
            )}
            {rulesSaving ? "Saving…" : "Save rules"}
          </button>
        </div>
      </div>

      {/* ── Modals ── */}
      <Modal open={adding} onClose={() => setAdding(false)} title="Add a person">
        <PersonForm onSubmit={handleCreate} onCancel={() => setAdding(false)} />
      </Modal>

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing ? `Edit ${editing.name}` : "Edit person"}
      >
        {editing && (
          <PersonForm
            initial={editing}
            onSubmit={handleUpdate}
            onCancel={() => setEditing(null)}
            onDelete={handleDelete}
          />
        )}
      </Modal>
    </section>
  );
}
