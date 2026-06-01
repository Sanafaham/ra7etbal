import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import AuthNotice from "../components/auth/AuthNotice";
import VoiceButton from "../components/home/VoiceButton";
import Spinner from "../components/Spinner";
import { useAuth } from "../hooks/useAuth";
import { buildDailyBrief } from "../lib/daily-brief";
import { useDraftStore } from "../stores/draft";
import { useExtractionStore } from "../stores/extraction";
import { usePeopleStore } from "../stores/people";
import { useTasksStore } from "../stores/tasks";

export default function Home() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const navigate = useNavigate();
  const textareaId = useId();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const { text, setText } = useDraftStore(
    useShallow((s) => ({ text: s.text, setText: s.setText })),
  );

  const { loadFor: loadPeople, items: people } = usePeopleStore(
    useShallow((s) => ({ loadFor: s.loadFor, items: s.items })),
  );

  const { tasks, loadTasks } = useTasksStore(
    useShallow((s) => ({ tasks: s.items, loadTasks: s.loadFor })),
  );

  const runExtraction = useExtractionStore((s) => s.run);

  const [now, setNow] = useState(() => new Date());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [textareaFocused, setTextareaFocused] = useState(false);
  const [viewportShrunk, setViewportShrunk] = useState(false);
  const submittingRef = useRef(false);

  useEffect(() => {
    if (!userId) return;
    void loadTasks(userId, { force: true });
  }, [userId, loadTasks]);

  useEffect(() => {
    const intervalId = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(intervalId);
  }, []);

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

  const today = useMemo(
    () =>
      new Intl.DateTimeFormat(undefined, {
        weekday: "long",
        month: "long",
        day: "numeric",
      }).format(now),
    [now],
  );

  const brief = useMemo(() => buildDailyBrief(tasks, now), [tasks, now]);
  const supportingLines = useMemo(() => {
    const lines = brief.summary.lines.filter(
      (line) => line !== brief.summary.headline && line !== "You're clear for tonight.",
    );
    return lines.length > 0 ? lines.slice(0, 3) : ["Nothing urgent is overdue."];
  }, [brief.summary.headline, brief.summary.lines]);

  const trimmed = text.trim();
  const canSubmit = !submitting && trimmed.length > 0 && !!userId;
  const keyboardOpen = textareaFocused || viewportShrunk;

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

  function focusCapture() {
    textareaRef.current?.focus();
    textareaRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  function viewBriefDetails() {
    navigate("/actions", { state: { initialFilter: "brief" } });
  }

  const clearMyHeadButton = (
    <button
      type="button"
      onClick={handleNext}
      onMouseDown={(e) => e.preventDefault()}
      onTouchStart={(e) => e.stopPropagation()}
      disabled={!canSubmit}
      aria-busy={submitting}
      className="inline-flex min-h-[50px] flex-1 items-center justify-center gap-2 rounded-full border border-charcoal/90 bg-charcoal px-5 py-3 text-[15px] font-semibold tracking-[0.02em] text-ivory shadow-[0_18px_42px_-18px_rgba(20,20,20,0.5),0_3px_10px_-5px_rgba(20,20,20,0.2)] transition hover:bg-espresso active:translate-y-[1px] disabled:cursor-not-allowed disabled:border-gold-soft/70 disabled:bg-gold-soft/55 disabled:text-text-soft disabled:shadow-none"
    >
      {submitting && <Spinner size={16} />}
      <span>{submitting ? "Organizing..." : "Clear My Head"}</span>
    </button>
  );

  return (
    <section
      className="mx-auto max-w-2xl"
      style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 36px)" }}
    >
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

      <section className="mt-7 rounded-[30px] border border-sage/25 bg-warm-white/92 px-6 py-7 text-center shadow-[0_34px_90px_-68px_rgba(20,20,20,0.52)] backdrop-blur-sm sm:mt-9 sm:px-9 sm:py-10">
        <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-text-muted">
          Right now
        </p>
        <h1
          className="mt-4 text-[38px] leading-[1.02] tracking-normal text-text sm:text-[54px]"
          style={{ fontFamily: "var(--font-display)" }}
        >
          {brief.summary.headline}
        </h1>
        <div className="mx-auto mt-5 max-w-md space-y-2 text-[15px] leading-relaxed text-text-soft sm:text-[16px]">
          {supportingLines.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>

        <div className="mt-7 flex flex-col gap-2.5 sm:flex-row sm:justify-center">
          <button
            type="button"
            onClick={focusCapture}
            className="inline-flex min-h-[50px] flex-1 items-center justify-center rounded-full border border-sage/35 bg-white/82 px-5 py-3 text-[15px] font-semibold text-text shadow-sm transition hover:bg-white sm:flex-none"
          >
            Ask Ra7etBal
          </button>
          {clearMyHeadButton}
        </div>

        <button
          type="button"
          onClick={viewBriefDetails}
          className="mt-4 text-[13px] font-semibold text-text-soft underline-offset-4 hover:text-text hover:underline"
        >
          View Details
        </button>
      </section>

      <section className="mt-5 rounded-[26px] border border-border/80 bg-card/82 p-4 shadow-[0_24px_70px_-60px_rgba(20,20,20,0.45)] backdrop-blur-sm sm:mt-7 sm:p-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <label
            htmlFor={textareaId}
            className="text-[11px] font-semibold uppercase tracking-[0.18em] text-stone"
          >
            Clear your head
          </label>
          <div className="[&_button]:rounded-full [&_button]:border-sage/30 [&_button]:bg-white [&_button]:px-2.5 [&_button]:py-1 [&_button]:text-xs [&_button]:font-medium [&_button]:text-text [&_button]:shadow-sm [&_svg]:h-[13px] [&_svg]:w-[13px]">
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
        </div>

        <textarea
          id={textareaId}
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => setTextareaFocused(true)}
          onBlur={() => setTextareaFocused(false)}
          placeholder="Say what you're carrying. Tasks, reminders, people to message, things to follow up on."
          autoComplete="off"
          spellCheck
          rows={4}
          disabled={submitting}
          style={{ fieldSizing: "content", fontFamily: "var(--font-sans)" }}
          className="block min-h-[104px] w-full resize-y rounded-2xl bg-transparent text-[16px] leading-relaxed text-text outline-none placeholder:text-muted focus:outline-none disabled:opacity-70"
        />

        <p className="mt-3 border-t border-border/70 pt-3 text-center text-[13px] italic leading-snug text-text-soft">
          Ra7etBal will organize it before anything is saved.
        </p>
      </section>

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

      {!keyboardOpen && (
        <p className="mt-4 text-center text-[11px] tracking-wide text-text-muted">
          Nothing is sent without review.
          {people.length === 0 && (
            <>
              {" "}
              ·{" "}
              <a href="/people" className="underline-offset-2 hover:underline">
                Add people
              </a>{" "}
              first if you want to delegate.
            </>
          )}
        </p>
      )}

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
            <span>{submitting ? "Organizing..." : "Clear My Head"}</span>
          </button>
        </div>
      )}
    </section>
  );
}
