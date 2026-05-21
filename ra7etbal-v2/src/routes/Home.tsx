import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import AuthNotice from "../components/auth/AuthNotice";
import VoiceButton from "../components/home/VoiceButton";
import Spinner from "../components/Spinner";
import { useAuth } from "../hooks/useAuth";
import { dailyInspiration } from "../lib/daily-inspiration";
import { useDraftStore } from "../stores/draft";
import { useExtractionStore } from "../stores/extraction";
import { usePeopleStore } from "../stores/people";

/**
 * Home — premium calm redesign.
 *
 * Visual goals:
 *   - Aman/Apple-calm. Ivory + sand + muted gold. Espresso text.
 *   - Editorial: serif display, body sans, handwritten italic for the
 *     daily inspiration note.
 *   - Large breathing space. The input area is the emotional center.
 *
 * Functional invariants (do NOT change — backend, extraction, navigation,
 * stores, iOS keyboard handling are identical to before):
 *   - useDraftStore for `text`/`setText`
 *   - usePeopleStore for loadFor
 *   - useExtractionStore for run
 *   - navigate("/review") after successful extraction
 *   - VoiceButton appends transcript to draft, errors flow to inline notice
 *   - iOS keyboard detection lifts the primary CTA to a floating position
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

  const inspiration = useMemo(() => dailyInspiration(), []);

  const charCount = text.length;
  const wordCount = useMemo(() => {
    const trimmed = text.trim();
    return trimmed ? trimmed.split(/\s+/).length : 0;
  }, [text]);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submittingRef = useRef(false);

  // --- iOS keyboard detection (preserved verbatim from the prior Home). ---
  const [textareaFocused, setTextareaFocused] = useState(false);
  const [viewportShrunk, setViewportShrunk] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.visualViewport) return;
    const vv = window.visualViewport;
    function compute() {
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

  const keyboardOpen = textareaFocused || viewportShrunk;

  const trimmed = text.trim();
  const canSubmit = !submitting && trimmed.length > 0 && !!userId;

  // --- handler — unchanged behavior; only the button label changes. ---
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

  const clearMyHeadButton = (
    <button
      type="button"
      onClick={handleNext}
      // Keep the textarea focused when tapping the floating button on iOS.
      onMouseDown={(e) => e.preventDefault()}
      onTouchStart={(e) => e.stopPropagation()}
      disabled={!canSubmit}
      aria-busy={submitting}
      className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-espresso px-7 py-3.5 text-base font-medium tracking-wide text-cream shadow-[0_10px_30px_-12px_rgba(58,46,31,0.45)] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto"
    >
      {submitting && <Spinner size={16} />}
      <span>{submitting ? "Organizing…" : "Clear My Head"}</span>
    </button>
  );

  return (
    <section
      className="mx-auto max-w-2xl"
      // Reserve bottom space for the floating CTA when iOS keyboard is open.
      style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 96px)" }}
    >
      {/* 1. Minimal brand area — quiet, centered. */}
      <header className="flex flex-col items-center gap-1 pt-2 text-center">
        <div className="flex items-center gap-2 text-ink/70">
          <span aria-hidden className="text-base text-gold">✦</span>
          <span
            className="text-[11px] font-medium uppercase tracking-[0.28em] text-ink/55"
            style={{ fontFamily: "var(--font-sans)" }}
          >
            Ra7etBal
          </span>
          <span aria-hidden className="text-base text-gold">✦</span>
        </div>
        <p className="mt-1 text-[10px] uppercase tracking-[0.22em] text-ink/40">
          {today}
        </p>
      </header>

      {/* 2. Daily inspiration — handwritten italic, calm and quiet. */}
      <p
        className="mt-7 text-center text-[22px] leading-snug text-ink/75 sm:text-2xl"
        style={{
          fontFamily: "var(--font-script)",
          fontStyle: "italic",
        }}
      >
        “{inspiration}”
      </p>

      {/* 3. Large calm prompt — serif display. */}
      <h1
        className="mt-10 text-center text-[34px] leading-[1.15] tracking-tight text-espresso sm:text-[40px]"
        style={{ fontFamily: "var(--font-display)" }}
      >
        {greetingName ? (
          <>
            <span className="block text-ink/55 text-[18px] tracking-wide sm:text-[20px]" style={{ fontFamily: "var(--font-display)", fontStyle: "italic" }}>
              {`Hello, ${greetingName}.`}
            </span>
            <span className="mt-2 block">What's on your mind?</span>
          </>
        ) : (
          "What's on your mind?"
        )}
      </h1>

      {/* 4. Premium input area — ivory card, soft inner light, integrated mic. */}
      <div className="relative mt-10">
        {/* Soft halo behind the card */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -m-2 rounded-[28px] bg-sand/40 blur-2xl"
        />
        <div className="relative rounded-[26px] border border-stone/60 bg-cream/85 p-5 shadow-[0_30px_80px_-50px_rgba(58,46,31,0.45)] backdrop-blur-sm sm:p-7">
          {/* Mic — top-right of the card */}
          <div className="absolute right-4 top-4 z-10 sm:right-5 sm:top-5">
            <VoiceButton
              disabled={submitting}
              onTranscript={(transcript) => {
                const current = useDraftStore.getState().text;
                const trimmedNow = current.trimEnd();
                const sep = trimmedNow.length === 0 ? "" : " ";
                useDraftStore.getState().setText(trimmedNow + sep + transcript);
              }}
              onError={(message) => setError(message)}
            />
          </div>

          <label htmlFor={textareaId} className="sr-only">
            Clear my head
          </label>
          <textarea
            id={textareaId}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onFocus={() => setTextareaFocused(true)}
            onBlur={() => setTextareaFocused(false)}
            placeholder="Say what you're carrying. Tasks, reminders, people to message, things to follow up on."
            autoComplete="off"
            spellCheck
            rows={7}
            disabled={submitting}
            style={
              {
                fieldSizing: "content",
                fontFamily: "var(--font-sans)",
              } as React.CSSProperties
            }
            className="block min-h-[180px] w-full resize-y rounded-2xl bg-transparent pr-24 text-[16px] leading-relaxed text-ink/90 outline-none placeholder:text-ink/35 focus:outline-none disabled:opacity-60 sm:pr-28"
          />

          <div className="mt-4 flex items-center justify-between border-t border-stone/50 pt-3 text-[11px] uppercase tracking-[0.18em] text-ink/40">
            <span>
              {wordCount} {wordCount === 1 ? "word" : "words"}
            </span>
            <span aria-live="polite">{charCount} characters</span>
          </div>
        </div>
      </div>

      {error && (
        <div className="mt-5">
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
        </div>
      )}

      {/* 6. Primary CTA — Clear My Head — in flow when keyboard closed. */}
      {!keyboardOpen && (
        <div className="mt-7 flex flex-col items-center gap-3">
          {clearMyHeadButton}

          {/* 7. Small reassurance line. */}
          <p
            className="max-w-md text-center text-[13px] italic leading-snug text-ink/55"
            style={{ fontFamily: "var(--font-display)" }}
          >
            Ra7etBal will organize it before anything is saved.
          </p>
        </div>
      )}

      {/* Bottom whisper — replaces the old draft-privacy line, kept calm. */}
      {!keyboardOpen && (
        <p className="mt-10 text-center text-[11px] tracking-wide text-ink/35">
          Nothing is sent without review.
          {people.length === 0 && (
            <>
              {" "}
              · <a href="/people" className="underline-offset-2 hover:underline">Add people</a> first if you want to delegate.
            </>
          )}
        </p>
      )}

      {/* Floating CTA while iOS keyboard is open — same surgical fix as before. */}
      {keyboardOpen && (
        <div
          className="fixed z-50"
          style={{
            bottom: "calc(env(safe-area-inset-bottom) + 132px)",
            right: "24px",
          }}
        >
          <button
            type="button"
            onClick={handleNext}
            onMouseDown={(e) => e.preventDefault()}
            onTouchStart={(e) => e.stopPropagation()}
            disabled={!canSubmit}
            aria-busy={submitting}
            className="inline-flex items-center justify-center gap-2 rounded-full bg-espresso px-5 py-3 text-base font-medium tracking-wide text-cream shadow-[0_18px_40px_-14px_rgba(58,46,31,0.5)] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting && <Spinner size={16} />}
            <span>{submitting ? "Organizing…" : "Clear My Head"}</span>
          </button>
        </div>
      )}
    </section>
  );
}
