import { useId, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import AuthNotice from "../components/auth/AuthNotice";
import Spinner from "../components/Spinner";
import { useAuth } from "../hooks/useAuth";
import { useDraftStore } from "../stores/draft";
import { useExtractionStore } from "../stores/extraction";
import { usePeopleStore } from "../stores/people";

/**
 * Home / Clear My Head — entry surface for offloading thoughts.
 *
 * Step 6 added the textarea + counts. Step 7 adds the "Organize" action:
 * loads the People roster (so the AI prompt has the right names/roles),
 * runs AI extraction, then navigates to /review. No save yet — that's a
 * later step.
 */
export default function Home() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const navigate = useNavigate();
  const textareaId = useId();

  const { text, setText } = useDraftStore(
    useShallow((s) => ({ text: s.text, setText: s.setText })),
  );

  const { loadFor: loadPeople, items: people } = usePeopleStore(
    useShallow((s) => ({ loadFor: s.loadFor, items: s.items })),
  );

  const runExtraction = useExtractionStore((s) => s.run);

  const today = useMemo(
    () =>
      new Intl.DateTimeFormat(undefined, {
        weekday: "long",
        month: "long",
        day: "numeric",
      }).format(new Date()),
    [],
  );

  const greetingName = useMemo(() => {
    if (!user?.email) return null;
    const local = user.email.split("@")[0] ?? "";
    if (!local) return null;
    return local.charAt(0).toUpperCase() + local.slice(1);
  }, [user?.email]);

  const charCount = text.length;
  const wordCount = useMemo(() => {
    const trimmed = text.trim();
    return trimmed ? trimmed.split(/\s+/).length : 0;
  }, [text]);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submittingRef = useRef(false);

  const trimmed = text.trim();
  const canSubmit = !submitting && trimmed.length > 0 && !!userId;

  async function handleNext() {
    if (submittingRef.current) return;
    if (!canSubmit || !userId) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);

    try {
      // Ensure People are loaded so the prompt's role-mapping has the right
      // roster. loadFor() is a no-op when the cache is already valid for this
      // user.
      await loadPeople(userId);
      // Read the latest people from the store after the await — `people` from
      // the render closure may be stale on first visit.
      const peopleNow = usePeopleStore.getState().items;
      await runExtraction(trimmed, peopleNow);
      navigate("/review");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Couldn't process that. Please try again.",
      );
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  return (
    <section className="space-y-6">
      <header className="space-y-1">
        <p className="text-xs font-medium uppercase tracking-wide text-ink/50">
          {today}
        </p>
        <h1 className="text-2xl font-semibold text-ink">
          {greetingName ? `Hi ${greetingName}.` : "Welcome."}
        </h1>
        <p className="text-sm text-ink/60">
          What's on your mind? Type it the way you'd say it — Ra7etBal will sort
          it out next.
        </p>
      </header>

      <div className="rounded-2xl border border-sage/30 bg-white/80 p-4 shadow-sm sm:p-5">
        <label htmlFor={textareaId} className="sr-only">
          Clear my head
        </label>
        <textarea
          id={textareaId}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="e.g. Tell Christopher dinner is at 9. Ask Ghulam to drop Loulya at school. Order more rice."
          autoComplete="off"
          spellCheck
          rows={8}
          disabled={submitting}
          style={{ fieldSizing: "content" } as React.CSSProperties}
          className="block min-h-[180px] w-full resize-y rounded-xl bg-transparent text-base leading-relaxed text-ink outline-none placeholder:text-ink/35 focus:outline-none disabled:opacity-60"
        />

        <div className="mt-3 flex items-center justify-between border-t border-sage/15 pt-3 text-xs text-ink/55">
          <span>
            {wordCount} {wordCount === 1 ? "word" : "words"}
          </span>
          <span aria-live="polite">{charCount} characters</span>
        </div>
      </div>

      {error && (
        <AuthNotice kind="error">
          {error}{" "}
          <button
            type="button"
            onClick={handleNext}
            className="ml-1 underline"
            disabled={submitting}
          >
            Try again
          </button>
        </AuthNotice>
      )}

      <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-ink/45">
          {people.length === 0
            ? "Tip: add people first so delegations can be assigned."
            : "Tap Next to let Ra7etBal organize what you wrote."}
        </p>
        <button
          type="button"
          onClick={handleNext}
          disabled={!canSubmit}
          aria-busy={submitting}
          className="inline-flex items-center justify-center gap-2 rounded-full bg-sage px-5 py-3 text-base font-medium text-white shadow-sm transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting && <Spinner size={16} />}
          <span>{submitting ? "Organizing…" : "Next →"}</span>
        </button>
      </div>

      <p className="text-xs text-ink/45">
        Your draft stays on this device only and is cleared when you sign out.
      </p>
    </section>
  );
}
