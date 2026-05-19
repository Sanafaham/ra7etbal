import { useEffect, useRef, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import ItemCard from "../components/review/ItemCard";
import Spinner from "../components/Spinner";
import AuthNotice from "../components/auth/AuthNotice";
import { useAuth } from "../hooks/useAuth";
import { savePending } from "../lib/save";
import { useDraftStore } from "../stores/draft";
import { useExtractionStore } from "../stores/extraction";
import { useMessagesStore } from "../stores/messages";
import { usePeopleStore } from "../stores/people";
import { useTasksStore } from "../stores/tasks";

/**
 * Review — shows AI-extracted items with editable assignments, descriptions,
 * and messages, then saves them to Supabase as tasks + messages on Save.
 */
export default function Review() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const userId = user?.id ?? null;

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const savingRef = useRef(false);

  const {
    status,
    items,
    sourceText,
    setAssignment,
    setDescription,
    setSuggestedMessage,
  } = useExtractionStore(
    useShallow((s) => ({
      status: s.status,
      items: s.items,
      sourceText: s.sourceText,
      setAssignment: s.setAssignment,
      setDescription: s.setDescription,
      setSuggestedMessage: s.setSuggestedMessage,
    })),
  );

  const { items: people, loadFor: loadPeople, loadedForUserId } = usePeopleStore(
    useShallow((s) => ({
      items: s.items,
      loadFor: s.loadFor,
      loadedForUserId: s.loadedForUserId,
    })),
  );

  // Ensure People are loaded so the Assign dropdown is populated.
  useEffect(() => {
    if (!userId) return;
    if (loadedForUserId !== userId) void loadPeople(userId);
  }, [userId, loadedForUserId, loadPeople]);

  // No extraction has run — user landed on /review directly. Send them home.
  if (status === "idle") {
    return <Navigate to="/" replace />;
  }

  if (status === "running") {
    return (
      <div className="flex items-center justify-center py-12 text-ink/60">
        <Spinner size={20} label="Organizing" />
      </div>
    );
  }

  if (status === "error") {
    return (
      <section className="space-y-4">
        <AuthNotice kind="error">
          We couldn't organize what you wrote. Head back to Home and try again.
        </AuthNotice>
        <button
          type="button"
          onClick={() => navigate("/")}
          className="rounded-full border border-sage/40 bg-white px-4 py-2 text-sm font-medium text-ink shadow-sm transition hover:bg-cream"
        >
          ← Back to Home
        </button>
      </section>
    );
  }

  return (
    <section className="space-y-5">
      <header className="space-y-1">
        <p className="text-xs font-medium uppercase tracking-wide text-ink/50">
          Review
        </p>
        <h1 className="text-2xl font-semibold text-ink">Here's what I picked up.</h1>
        {items.length > 0 && (
          <p className="text-sm text-ink/70">
            {items.length === 1
              ? "I found 1 item for you to review."
              : `I found ${items.length} items for you to review.`}
          </p>
        )}
      </header>

      {sourceText && (
        <details className="rounded-2xl border border-sage/20 bg-cream/60 p-3 text-sm text-ink/70">
          <summary className="cursor-pointer text-xs font-medium uppercase tracking-wide text-ink/55">
            What you wrote
          </summary>
          <p className="mt-2 whitespace-pre-wrap leading-relaxed">{sourceText}</p>
        </details>
      )}

      {items.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-sage/40 bg-white/60 p-6 text-sm text-ink/70">
          Ra7etBal didn't find anything actionable in that. Head back and try
          rephrasing.
        </div>
      ) : (
        <ul className="space-y-3">
          {items.map((it) => (
            <li key={it.id}>
              <ItemCard
                item={it}
                people={people}
                onAssign={setAssignment}
                onDescriptionChange={setDescription}
                onMessageChange={setSuggestedMessage}
              />
            </li>
          ))}
        </ul>
      )}

      {saveError && <AuthNotice kind="error">{saveError}</AuthNotice>}

      <div className="flex flex-col-reverse items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Link
          to="/"
          className="rounded-full border border-sage/30 bg-white px-4 py-2 text-center text-sm font-medium text-ink shadow-sm transition hover:bg-cream"
        >
          ← Back to Home
        </Link>
        {items.length > 0 && (
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving}
            aria-busy={saving}
            className="inline-flex items-center justify-center gap-2 rounded-full bg-sage px-5 py-3 text-base font-medium text-white shadow-sm transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving && <Spinner size={16} />}
            <span>{saving ? "Saving…" : "Save"}</span>
          </button>
        )}
      </div>
    </section>
  );

  async function handleSave() {
    if (savingRef.current) return;
    if (!items.length) return;
    if (!userId) {
      setSaveError("Not signed in.");
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      await savePending(items, userId);
      // Force-reload from Supabase so Actions/Messages/Follow-ups reflect the
      // canonical server state, not an optimistic local push. This is the
      // safety net against any row that didn't actually persist (RLS, missing
      // default, etc) — if the rows aren't visible on read, the user sees the
      // empty state immediately rather than a phantom optimistic card.
      await Promise.all([
        useTasksStore.getState().loadFor(userId, { force: true }),
        useMessagesStore.getState().loadFor(userId, { force: true }),
      ]);
      // Clear the draft and the extraction — the flow is done.
      useDraftStore.getState().clear();
      useExtractionStore.getState().clear();
      navigate("/actions", { replace: true });
    } catch (err) {
      // Surface the original message — Supabase errors are now propagated
      // (e.g. "null value in column ... violates not-null constraint").
      console.error("savePending failed:", err);
      setSaveError(
        err instanceof Error ? err.message : "Could not save. Please try again.",
      );
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }
}
