import { useEffect } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import ItemCard from "../components/review/ItemCard";
import Spinner from "../components/Spinner";
import AuthNotice from "../components/auth/AuthNotice";
import { useAuth } from "../hooks/useAuth";
import { useExtractionStore } from "../stores/extraction";
import { usePeopleStore } from "../stores/people";

/**
 * Review — shows AI-extracted items with editable assignments.
 *
 * Saving to Supabase is intentionally not wired here (next step). The user
 * can change assignments locally; navigating away keeps those edits in the
 * store. Sign-out clears the extraction via stores/sync.ts.
 */
export default function Review() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const userId = user?.id ?? null;

  const { status, items, summary, sourceText, setAssignment } = useExtractionStore(
    useShallow((s) => ({
      status: s.status,
      items: s.items,
      summary: s.summary,
      sourceText: s.sourceText,
      setAssignment: s.setAssignment,
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

  // Empty extraction means user landed on /review without running extraction
  // first. Send them back to Home.
  if (status === "idle" || (status === "ready" && items.length === 0 && !summary)) {
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
        {summary && <p className="text-sm text-ink/70">{summary}</p>}
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
              <ItemCard item={it} people={people} onAssign={setAssignment} />
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-col-reverse items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Link
          to="/"
          className="rounded-full border border-sage/30 bg-white px-4 py-2 text-center text-sm font-medium text-ink shadow-sm transition hover:bg-cream"
        >
          ← Back to Home
        </Link>
        <p className="text-xs text-ink/50">
          Saving these to Actions / Messages / Follow-ups arrives in the next
          step.
        </p>
      </div>
    </section>
  );
}
