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
      className="inline-flex min-h-[52px] w-full items-center justify-center gap-2 rounded-full border border-charcoal/90 bg-charcoal px-8 py-3.5 text-[15px] font-semibold tracking-[0.02em] text-ivory shadow-[0_18px_42px_-18px_rgba(20,20,20,0.55),0_3px_10px_-5px_rgba(20,20,20,0.2)] transition hover:bg-espresso active:translate-y-[1px] disabled:cursor-not-allowed disabled:border-gold-soft/70 disabled:bg-gold-soft/55 disabled:text-text-soft disabled:shadow-none sm:w-auto sm:min-w-[220px]"
    >
      {submitting && <Spinner size={16} />}
      <span>{submitting ? "Organizing…" : "Clear My Head"}</span>
    </button>
  );

  return (
    <section
      className="mx-auto max-w-2xl"
      // Reserve enough bottom room for iOS Safari without creating a long
      // empty tail after the CTA.
      style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 36px)" }}
    >
      {/* 1. Minimal brand area — quiet, centered. */}
      <header className="flex flex-col items-center gap-1 pt-2 text-center sm:pt-1">
        <div className="flex items-center gap-2 text-text-soft">
          <span aria-hidden className="text-base text-gold">✦</span>
          <span
            className="text-[11px] font-semibold uppercase tracking-[0.3em] text-text-soft"
            style={{ fontFamily: "var(--font-sans)" }}
          >
            Ra7etBal
          </span>
          <span aria-hidden className="text-base text-gold">✦</span>
        </div>
        <p className="mt-1 text-[10px] uppercase tracking-[0.22em] text-text-muted">
          {today}
        </p>
      </header>

      {/* 2. Daily inspiration — handwritten italic, calm and quiet.
            Slightly smaller on mobile so it doesn't dominate the fold. */}
      <p
        className="mt-6 text-center text-[22px] leading-[1.2] text-text-soft sm:mt-8 sm:text-[28px]"
        style={{
          fontFamily: "var(--font-script)",
          fontStyle: "italic",
        }}
      >
        “{inspiration}”
      </p>

      {/* 3. Large calm prompt — serif display. Mobile size trimmed so the
            voice button stays visible above the fold on small iPhones. */}
      <h1
        className="mt-6 text-center text-[34px] leading-[1.05] tracking-normal text-text sm:mt-9 sm:text-[48px]"
        style={{ fontFamily: "var(--font-display)" }}
      >
        {greetingName ? (
          <>
            <span className="block text-[18px] tracking-wide text-text-soft sm:text-[21px]" style={{ fontFamily: "var(--font-display)", fontStyle: "italic" }}>
              {`Hello, ${greetingName}.`}
            </span>
            <span className="mt-1 block sm:mt-2">What's on your mind?</span>
          </>
        ) : (
          "What's on your mind?"
        )}
      </h1>

      <div className="mt-7 flex flex-col items-center gap-3.5 sm:mt-8">
        <div className="w-full max-w-[320px] [&_button]:min-h-[68px] [&_button]:w-full [&_button]:justify-center [&_button]:gap-3 [&_button]:rounded-full [&_button]:border-border/90 [&_button]:bg-warm-white/92 [&_button]:px-7 [&_button]:py-4 [&_button]:text-[16px] [&_button]:font-semibold [&_button]:text-text [&_button]:shadow-[0_18px_46px_-30px_rgba(20,20,20,0.48),0_2px_10px_-6px_rgba(20,20,20,0.18)] [&_button]:backdrop-blur-sm [&_svg]:h-[20px] [&_svg]:w-[20px] sm:w-auto sm:max-w-none sm:[&_button]:min-h-0 sm:[&_button]:w-auto sm:[&_button]:gap-1.5 sm:[&_button]:border-sage/30 sm:[&_button]:bg-white sm:[&_button]:px-2.5 sm:[&_button]:py-1 sm:[&_button]:text-xs sm:[&_button]:font-medium sm:[&_button]:shadow-sm sm:[&_svg]:h-[13px] sm:[&_svg]:w-[13px]">
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
        <p className="text-center text-[13px] leading-snug text-text-soft sm:text-[12px] sm:text-stone">
          Speak once. Ra7etBal will turn it into a plan.
        </p>
      </div>

      {/* 4. Premium input area — typing stays available, but quieter.
            Tighter padding and a shorter min-height on mobile so the card
            doesn't crowd the CTA below it. */}
      <div className="relative mt-5 sm:mt-7">
        {/* Soft halo behind the card */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -m-3 rounded-[32px] bg-gold-soft/22 blur-2xl"
        />
        <div className="relative rounded-[26px] border border-border/90 bg-card/90 p-4 shadow-[0_30px_80px_-64px_rgba(20,20,20,0.42)] backdrop-blur-sm sm:rounded-[28px] sm:p-6">
          <p className="mb-3 text-[11px] font-medium uppercase tracking-[0.18em] text-stone">
            Prefer typing?
          </p>
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
            rows={5}
            disabled={submitting}
            style={
              {
                fieldSizing: "content",
                fontFamily: "var(--font-sans)",
              } as React.CSSProperties
            }
            className="block min-h-[108px] w-full resize-y rounded-2xl bg-transparent text-[16px] leading-relaxed text-text outline-none placeholder:text-muted focus:outline-none disabled:opacity-70 sm:min-h-[132px]"
          />

          <div className="mt-3 flex items-center justify-between border-t border-border/70 pt-3 text-[11px] uppercase tracking-[0.18em] text-muted sm:mt-4">
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
        <div
          className="sticky bottom-0 z-20 -mx-4 mt-5 flex flex-col items-center gap-2 bg-gradient-to-t from-ivory via-ivory/95 to-ivory/78 px-4 pt-3 shadow-[0_-24px_54px_-44px_rgba(20,20,20,0.5)] backdrop-blur-md sm:static sm:mx-0 sm:mt-8 sm:bg-transparent sm:px-0 sm:pt-0 sm:shadow-none sm:backdrop-blur-0"
          style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 12px)" }}
        >
          {clearMyHeadButton}

          {/* 7. Small reassurance line. */}
          <p
            className="max-w-md text-center text-[13px] italic leading-snug text-text-soft sm:text-[14px]"
            style={{ fontFamily: "var(--font-display)" }}
          >
            Ra7etBal will organize it before anything is saved.
          </p>
        </div>
      )}

      {/* Bottom whisper — replaces the old draft-privacy line, kept calm. */}
      {!keyboardOpen && (
        <p className="mt-3 text-center text-[11px] tracking-wide text-text-muted sm:mt-9">
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
            className="inline-flex items-center justify-center gap-2 rounded-full bg-charcoal px-5 py-3 text-[15px] font-medium tracking-[0.02em] text-ivory shadow-[0_22px_55px_-28px_rgba(20,20,20,0.62),0_3px_8px_-4px_rgba(20,20,20,0.16)] transition hover:bg-espresso disabled:cursor-not-allowed disabled:bg-gold-soft/50 disabled:text-text-soft disabled:shadow-none"
          >
            {submitting && <Spinner size={16} />}
            <span>{submitting ? "Organizing…" : "Clear My Head"}</span>
          </button>
        </div>
      )}
    </section>
  );
}
