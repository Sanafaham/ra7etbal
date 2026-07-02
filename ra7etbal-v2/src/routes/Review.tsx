import { useRef } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import ItemCard from "../components/review/ItemCard";
import Spinner from "../components/Spinner";
import AuthNotice from "../components/auth/AuthNotice";
import { pickReviewEmptyStateMessage } from "../lib/review-selection";
import { useDraftStore } from "../stores/draft";
import { useExtractionStore } from "../stores/extraction";

/**
 * Review — Clear My Head's temporary thought-dump review space. Shows
 * AI-extracted items, editable only as plain text, but never persists them.
 * Items are either kept here (in-memory, for further review) or discarded.
 * Carson is the only path that converts a thought into a saved
 * Note/To-do/Reminder/Delegation/Message — this screen shows no Carson
 * operational fields (assignment, message, due date, photo) so it never
 * looks like that conversion has already happened.
 */
export default function Review() {
  const navigate = useNavigate();

  const { status, items, sourceText, setDescription, removeItem } = useExtractionStore(
    useShallow((s) => ({
      status: s.status,
      items: s.items,
      sourceText: s.sourceText,
      setDescription: s.setDescription,
      removeItem: s.removeItem,
    })),
  );

  // Tracks whether this review ever had items, so the empty state can tell
  // "you cleared everything" apart from "nothing was found".
  const everHadItemsRef = useRef(false);
  if (items.length > 0) everHadItemsRef.current = true;

  // No extraction has run — user landed on /review directly. Send them home.
  if (status === "idle") {
    return <Navigate to="/" replace />;
  }

  if (status === "running") {
    return (
      <div className="flex items-center justify-center py-12 text-text-soft">
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
          className="rounded-full border border-border/85 bg-warm-white px-4 py-2 text-sm font-medium text-text shadow-sm transition hover:bg-card"
        >
          ← Back to Home
        </button>
      </section>
    );
  }

  return (
    <section className="space-y-5">
      <header className="space-y-1">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-gold">
          Clear My Head
        </p>
        <h1 className="text-4xl font-semibold leading-tight text-text" style={{ fontFamily: "var(--font-display)" }}>Here's what's on your mind.</h1>
        {items.length > 0 && (
          <p className="text-sm text-text-soft">
            {items.length === 1
              ? "I found 1 thing. Edit it, remove it, or keep it here — ask Carson to turn it into a note, to-do, reminder, or delegation."
              : `I found ${items.length} things. Edit, remove, or keep them here — ask Carson to turn any of them into a note, to-do, reminder, or delegation.`}
          </p>
        )}
      </header>

      {sourceText && (
        <details className="rounded-[24px] border border-border/80 bg-card/70 p-3 text-sm text-text-soft">
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-[0.18em] text-text-soft">
            What you wrote
          </summary>
          <p className="mt-2 whitespace-pre-wrap leading-relaxed">{sourceText}</p>
        </details>
      )}

      {items.length === 0 ? (
        <div className="rounded-[28px] border border-dashed border-gold/30 bg-card/70 p-6 text-sm text-text-soft">
          {pickReviewEmptyStateMessage(everHadItemsRef.current)}
        </div>
      ) : (
        <ul className="space-y-3">
          {items.map((it) => (
            <li key={it.id}>
              <ItemCard
                item={it}
                onDescriptionChange={setDescription}
                onRemove={removeItem}
              />
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-col-reverse items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Link
          to="/"
          className="rounded-full border border-border/85 bg-warm-white px-4 py-2 text-center text-sm font-medium text-text shadow-sm transition hover:bg-card"
        >
          ← Back to Home
        </Link>
        {items.length > 0 && (
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <button
              type="button"
              onClick={handleDiscardAll}
              className="rounded-full border border-rose-200 bg-rose-50/80 px-4 py-2 text-sm font-medium text-rose-700 shadow-sm transition hover:bg-rose-100"
            >
              Discard all
            </button>
            <button
              type="button"
              onClick={handleKeep}
              className="inline-flex items-center justify-center gap-2 rounded-full bg-charcoal px-5 py-3 text-base font-medium text-ivory shadow-sm transition hover:bg-espresso"
            >
              Leave here for now
            </button>
          </div>
        )}
      </div>
    </section>
  );

  // Leaves the extraction store untouched so items remain available next
  // time the user opens Clear My Head this session — only the raw draft
  // textarea (already superseded by these organized items) is cleared.
  function handleKeep() {
    useDraftStore.getState().clear();
    navigate("/", { replace: true });
  }

  function handleDiscardAll() {
    useDraftStore.getState().clear();
    useExtractionStore.getState().clear();
    navigate("/", { replace: true });
  }
}
