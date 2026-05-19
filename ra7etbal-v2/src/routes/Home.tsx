import { useEffect, useId, useMemo, useRef, useState } from "react";
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
 * iOS keyboard handling
 *   The textarea is the only input on Home. When focused on iPhone Safari,
 *   the keyboard opens AND Safari's floating URL bar overlays the bottom of
 *   the page — both together can hide the Next button.
 *
 *   We listen to window.visualViewport (the visible-region API) to detect
 *   when the visual viewport has shrunk meaningfully relative to the layout
 *   viewport. When it has, we lift the Next button into a position: fixed
 *   container pinned just above Safari's URL bar via env(safe-area-inset-
 *   bottom) + a buffer. When the keyboard closes, the button returns to
 *   its in-flow location.
 *
 *   We also keep textarea focus as a secondary signal — on devices where
 *   visualViewport isn't reliable, focus alone flips the button.
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

  // --- iOS keyboard detection ---
  const [textareaFocused, setTextareaFocused] = useState(false);
  const [viewportShrunk, setViewportShrunk] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.visualViewport) return;
    const vv = window.visualViewport;
    function compute() {
      // If the visible area is more than ~120px shorter than the layout
      // viewport, the on-screen keyboard is up.
      setViewportShrunk(window.innerHeight - vv.height > 120);
    }
    compute();
    vv.addEventListener("resize", compute);
    vv.addEventListener("scroll", compute);
    return () => {
      vv.removeEventListener("resize", compute);
      vv.removeEventListener("scroll", compute);
    };
  }, []);

  // Either signal (focused textarea OR shrunken viewport) means the on-screen
  // keyboard is effectively up. Using both makes us resilient on older
  // browsers without visualViewport.
  const keyboardOpen = textareaFocused || viewportShrunk;

  const trimmed = text.trim();
  const canSubmit = !submitting && trimmed.length > 0 && !!userId;

  async function handleNext() {
    if (submittingRef.current) return;
    if (!canSubmit || !userId) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);

    try {
      await loadPeople(userId);
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

  const tipText =
    people.length === 0
      ? "Tip: add people first so delegations can be assigned."
      : "Tap Next to let Ra7etBal organize what you wrote.";

  const nextButton = (
    <button
      type="button"
      onClick={handleNext}
      // Avoid blurring the textarea when the user taps the floating button —
      // otherwise iOS closes the keyboard, the button un-floats mid-tap, and
      // the click can land on the wrong element.
      onMouseDown={(e) => e.preventDefault()}
      onTouchStart={(e) => e.stopPropagation()}
      disabled={!canSubmit}
      aria-busy={submitting}
      className="inline-flex items-center justify-center gap-2 rounded-full bg-sage px-5 py-3 text-base font-medium text-white shadow-lg transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {submitting && <Spinner size={16} />}
      <span>{submitting ? "Organizing…" : "Next →"}</span>
    </button>
  );

  return (
    <section
      className="space-y-6"
      // Reserve room at the bottom of the page flow for the floating Next
      // button when the keyboard is open, so the scrollable content can fully
      // scroll without being permanently obscured.
      style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 96px)" }}
    >
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
          onFocus={() => setTextareaFocused(true)}
          onBlur={() => setTextareaFocused(false)}
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

      {/* In-flow Tip + button when keyboard is CLOSED. */}
      {!keyboardOpen && (
        <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-ink/45">{tipText}</p>
          {nextButton}
        </div>
      )}

      <p className="text-xs text-ink/45">
        Your draft stays on this device only and is cleared when you sign out.
      </p>

      {/*
        Floating Next button while the iOS keyboard is open. position: fixed
        elements follow the visual viewport on modern iOS Safari, so anchoring
        to `bottom: env(safe-area-inset-bottom) + 88px` puts the button above
        the floating URL bar and the keyboard accessory toolbar.
        The .always-on-top z-index sits above Safari's chrome.
      */}
      {keyboardOpen && (
        <div
          className="fixed inset-x-0 z-40 flex justify-end px-5"
          style={{ bottom: "calc(env(safe-area-inset-bottom) + 88px)" }}
        >
          {nextButton}
        </div>
      )}
    </section>
  );
}
