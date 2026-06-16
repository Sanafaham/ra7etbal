import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { describeImageForTextCarson } from "../lib/text-carson";
import { useNavigate } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import { useCarsonStore } from "../stores/carson";
import AuthNotice from "../components/auth/AuthNotice";
import VoiceButton from "../components/home/VoiceButton";
import Spinner from "../components/Spinner";
import { useAuth } from "../hooks/useAuth";
import { fetchCalendarEvents, type CalendarEvent } from "../lib/calendar";
import { buildDailyBrief } from "../lib/daily-brief";
import { buildNightSweep } from "../lib/night-sweep";
import { useDraftStore } from "../stores/draft";
import { useExtractionStore } from "../stores/extraction";
import { usePeopleStore } from "../stores/people";
import { useProfileStore } from "../stores/profile";
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

  const { loadPeople } = usePeopleStore(
    useShallow((s) => ({ loadPeople: s.loadFor })),
  );

  const { displayName, loadProfile } = useProfileStore(
    useShallow((s) => ({ displayName: s.displayName, loadProfile: s.loadFor })),
  );

  const { tasks, loadTasks, markDone, archiveDone } = useTasksStore(
    useShallow((s) => ({
      tasks: s.items,
      loadTasks: s.loadFor,
      markDone: s.markDone,
      archiveDone: s.archiveDone,
    })),
  );

  const runExtraction = useExtractionStore((s) => s.run);

  const [now, setNow] = useState(() => new Date());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [redirectMessage, setRedirectMessage] = useState<string | null>(null);
  const [textareaFocused, setTextareaFocused] = useState(false);
  const [viewportShrunk, setViewportShrunk] = useState(false);
  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>([]);
  const [completingNightSweepItemId, setCompletingNightSweepItemId] = useState<string | null>(null);
  const [clearingHandled, setClearingHandled] = useState(false);
  const submittingRef = useRef(false);

  // Photo attachment for Clear My Head — described before extraction so the
  // AI sees the image context when generating tasks.
  const imageFileInputRef = useRef<HTMLInputElement>(null);
  const [draftImageFile, setDraftImageFile] = useState<File | null>(null);
  const [draftImagePreviewUrl, setDraftImagePreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!draftImageFile) { setDraftImagePreviewUrl(null); return; }
    const url = URL.createObjectURL(draftImageFile);
    setDraftImagePreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [draftImageFile]);

  useEffect(() => {
    if (!userId) return;
    void loadTasks(userId, { force: true });
  }, [userId, loadTasks]);

  useEffect(() => {
    if (!userId) return;
    void loadPeople(userId);
  }, [userId, loadPeople]);

  useEffect(() => {
    if (!userId) return;
    void loadProfile(userId);
  }, [userId, loadProfile]);

  useEffect(() => {
    if (!userId) {
      setCalendarEvents([]);
      return;
    }
    fetchCalendarEvents("next_7_days")
      .then((result) => setCalendarEvents(result.connected ? result.events : []))
      .catch(() => setCalendarEvents([]));
  }, [userId]);

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

  const brief = useMemo(() => buildDailyBrief(tasks, now), [tasks, now]);
  const nightSweep = useMemo(
    () => buildNightSweep(tasks, now, calendarEvents),
    [tasks, now, calendarEvents],
  );
  const urgentCount = useMemo(
    () =>
      brief.needsAttention.filter(
        (task) =>
          task.type === "reminder" &&
          task.due_at &&
          new Date(task.due_at) <= now,
      ).length,
    [brief.needsAttention, now],
  );
  const statusTone = useMemo(() => {
    if (urgentCount > 0) return "urgent";
    if (brief.needsAttention.length > 0) return "attention";
    return "clear";
  }, [brief.needsAttention.length, urgentCount]);
  const statusSummary = useMemo(
    () => buildStatusSummary(brief, now),
    [brief, now],
  );
  const supportingLines = statusSummary.lines;

  const isEvening = now.getHours() >= 20;
  const nightSweepLines = useMemo(
    () => (isEvening ? buildNightSweepLines(tasks, now) : []),
    [tasks, now, isEvening],
  );

  const trimmed = text.trim();
  const canSubmit = !submitting && (trimmed.length > 0 || !!draftImageFile) && !!userId;
  const keyboardOpen = textareaFocused || viewportShrunk;

  async function handleNext() {
    if (submittingRef.current) return;
    if (!canSubmit || !userId) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);

    try {
      // Intercept question-style inputs before running extraction.
      // These belong to Carson, not to the capture/organize pipeline.
      if (looksLikeQuestion(trimmed)) {
        setRedirectMessage(
          "Carson can answer questions about your notes, memory, priorities, and open items. Clear My Head is for capturing tasks, reminders, notes, and messages.",
        );
        return;
      }

      setRedirectMessage(null);
      await loadPeople(userId);
      const peopleNow = usePeopleStore.getState().items;

      const imageForExtraction = draftImageFile;

      if (!trimmed && imageForExtraction) {
        // Image-only submission: extract directly from the photo via vision API.
        await useExtractionStore.getState().runFromPhoto(
          imageForExtraction,
          peopleNow,
          displayName ?? undefined,
        );
      } else {
        // Text (+ optional image) submission: describe image for context, then extract from text.
        let extractionText = trimmed;
        if (imageForExtraction) {
          const description = await describeImageForTextCarson(imageForExtraction).catch(() => null);
          if (description) {
            extractionText = `${trimmed}\n\nAttached image:\n${description}`;
          }
        }
        await runExtraction(extractionText, peopleNow, displayName ?? undefined);
      }

      // Auto-attach the image to the first delegation item so Review shows it
      // pre-loaded and savePending uploads it without the user having to re-attach.
      if (imageForExtraction) {
        const extractedItems = useExtractionStore.getState().items;
        const firstDelegation = extractedItems.find(
          (i) => i.type === "delegation" || i.type === "message",
        );
        if (firstDelegation) {
          useExtractionStore.getState().setImageFile(firstDelegation.id, imageForExtraction);
        }
      }

      setDraftImageFile(null);
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

  const openCarson = useCarsonStore((s) => s.setOpen);

  function viewBriefDetails() {
    navigate("/active");
  }

  async function handleNightSweepMarkDone(id: string) {
    if (!userId || completingNightSweepItemId) return;
    setCompletingNightSweepItemId(id);
    try {
      await markDone(id);
      await loadTasks(userId, { force: true });
    } catch (err) {
      console.error(err);
      setError("Couldn't mark that done. Please try again.");
    } finally {
      setCompletingNightSweepItemId(null);
    }
  }

  async function handleClearHandled() {
    if (!userId || clearingHandled || nightSweep.handledToday.length === 0) return;
    setClearingHandled(true);
    try {
      await archiveDone(nightSweep.handledToday.map((item) => item.id));
      await loadTasks(userId, { force: true });
    } catch (err) {
      console.error(err);
      setError("Couldn't clear handled items. Please try again.");
    } finally {
      setClearingHandled(false);
    }
  }


  return (
    <section
      className="mx-auto max-w-2xl"
      style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 36px)" }}
    >
      <section className="mt-3 rounded-[30px] border border-sage/25 bg-warm-white/95 px-5 py-4 text-center shadow-[0_34px_90px_-70px_rgba(20,20,20,0.55)] backdrop-blur-sm sm:mt-5 sm:px-9 sm:py-5">
        <div className="inline-flex items-center justify-center gap-2 rounded-full border border-white/80 bg-white/65 px-3 py-1.5 shadow-[0_10px_28px_-22px_rgba(20,20,20,0.45)]">
          <span
            aria-hidden
            className={
              "relative h-3.5 w-3.5 rounded-full shadow-[inset_0_0_0_1px_rgba(255,255,255,0.55),0_0_0_4px_rgba(255,255,255,0.75)] " +
              (statusTone === "urgent"
                ? "bg-danger"
                : statusTone === "attention"
                  ? "bg-gold"
                  : "bg-sage")
            }
          />
          <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-text-muted">
            Right now
          </p>
        </div>
        <h1
          className="mx-auto mt-2 max-w-xl text-[44px] leading-[0.95] tracking-normal text-text sm:text-[64px]"
          style={{ fontFamily: "var(--font-display)" }}
        >
          {statusSummary.headline}
        </h1>
        <div className="mx-auto mt-2 max-w-md space-y-1 text-[14px] leading-snug text-text-soft sm:text-[15px]">
          {supportingLines.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>

        <button
          type="button"
          onClick={viewBriefDetails}
          className="mt-2.5 text-[11px] font-medium text-text-muted underline-offset-4 hover:text-text-soft hover:underline"
        >
          View Details
        </button>
      </section>

      <section className="mt-3 rounded-[24px] border border-sage/20 bg-white/72 px-4 py-3.5 shadow-[0_18px_55px_-46px_rgba(20,20,20,0.38)] backdrop-blur-sm">
        <div className="mb-2 flex items-center justify-between gap-3">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-stone">
            Night Sweep
          </h2>
          <span className="rounded-full bg-sage/10 px-2.5 py-1 text-[11px] font-medium text-sage">
            {nightSweep.badgeLabel}
          </span>
        </div>

        <div className="space-y-2.5">
          <NightSweepSection
            title="Handled today"
            items={nightSweep.handledToday}
            completingItemId={completingNightSweepItemId}
            onMarkDone={handleNightSweepMarkDone}
            action={
              <button
                type="button"
                onClick={handleClearHandled}
                disabled={clearingHandled}
                className="rounded-full border border-sage/20 bg-white/70 px-2.5 py-1 text-[11px] font-medium normal-case tracking-normal text-sage transition hover:border-sage/35 hover:bg-sage/5 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {clearingHandled ? "Clearing..." : "Clear handled"}
              </button>
            }
          />
          <NightSweepSection
            title="Still waiting"
            items={nightSweep.stillWaiting}
            completingItemId={completingNightSweepItemId}
            onMarkDone={handleNightSweepMarkDone}
          />
          <NightSweepSection
            title="Requires you"
            items={nightSweep.requiresYou}
            completingItemId={completingNightSweepItemId}
            onMarkDone={handleNightSweepMarkDone}
          />
          <NightSweepSection
            title="Upcoming"
            items={nightSweep.upcomingDeadline}
            completingItemId={completingNightSweepItemId}
            onMarkDone={handleNightSweepMarkDone}
          />
        </div>

        <p className="mt-3 border-t border-sage/15 pt-2.5 text-[13px] font-medium leading-snug text-ink">
          {nightSweep.reassurance}
        </p>
      </section>

      {/* ── Carson row ─────────────────────────────────────────────── */}
      <section className="mt-3">
        <button
          type="button"
          onClick={() => openCarson(true)}
          className="flex w-full items-center gap-3 rounded-[26px] border border-sage/25 bg-warm-white/95 px-4 py-3.5 shadow-[0_10px_30px_-20px_rgba(20,20,20,0.18)] backdrop-blur-sm transition hover:border-sage/40 hover:bg-warm-white active:scale-[0.99]"
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-sage/10">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="text-sage">
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1="12" y1="19" x2="12" y2="23" />
              <line x1="8" y1="23" x2="16" y2="23" />
            </svg>
          </span>
          <div className="flex flex-col items-start">
            <span className="text-sm font-semibold text-ink">Talk to Carson</span>
            <span className="text-[11px] text-ink/45">Your Chief of Staff · tap to start</span>
          </div>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="ml-auto text-ink/30">
            <path d="M9 18l6-6-6-6" />
          </svg>
        </button>
      </section>

      {/* ── Clear My Head ─────────────────────────────────────────────── */}
      <section className="mt-3 rounded-[26px] border border-border/80 bg-card/82 p-4 shadow-[0_24px_70px_-60px_rgba(20,20,20,0.45)] backdrop-blur-sm sm:mt-4 sm:p-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <label
            htmlFor={textareaId}
            className="text-[11px] font-semibold uppercase tracking-[0.18em] text-stone"
          >
            Clear My Head
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
          onChange={(e) => { setText(e.target.value); setRedirectMessage(null); }}
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

        {/*
          * File input is always mounted outside any conditional block so iOS
          * Safari never invalidates the File object reference on re-render.
          */}
        <input
          ref={imageFileInputRef}
          type="file"
          accept="image/*"
          onChange={(e) => {
            const file = e.target.files?.[0] ?? null;
            setDraftImageFile(file);
            e.target.value = "";
          }}
          className="sr-only"
          aria-label="Attach photo to extraction"
        />

        {draftImagePreviewUrl && (
          <div className="mt-2.5 flex items-center gap-2.5">
            <div className="relative inline-block shrink-0">
              <img
                src={draftImagePreviewUrl}
                alt="Attached photo"
                className="h-12 w-12 rounded-xl border border-sage/25 object-cover shadow-sm"
              />
              <button
                type="button"
                onClick={() => setDraftImageFile(null)}
                disabled={submitting}
                aria-label="Remove attached photo"
                className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-ink/70 text-white shadow transition hover:bg-ink disabled:opacity-50"
              >
                <svg width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <line x1="1" y1="1" x2="9" y2="9" /><line x1="9" y1="1" x2="1" y2="9" />
                </svg>
              </button>
            </div>
            <p className="text-[11px] leading-snug text-ink/50">
              Photo ready — Carson will describe it before organizing.
            </p>
          </div>
        )}

        <div className="mt-3 space-y-2.5 border-t border-border/70 pt-3">
          <p className="text-[13px] italic leading-snug text-text-soft">
            Ra7etBal will organize it before anything is saved.
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => imageFileInputRef.current?.click()}
              disabled={submitting}
              aria-label="Attach photo"
              title="Attach photo"
              className={
                "flex h-10 w-10 shrink-0 items-center justify-center rounded-full border shadow-sm transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-45 " +
                (draftImageFile
                  ? "border-sage/40 bg-sage/10 text-sage"
                  : "border-sage/25 bg-white text-ink/40 hover:border-sage/40 hover:text-ink/60")
              }
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <path d="M21 15l-5-5L5 21" />
              </svg>
            </button>
            <button
              type="button"
              onClick={handleNext}
              onMouseDown={(e) => e.preventDefault()}
              onTouchStart={(e) => e.stopPropagation()}
              disabled={!canSubmit}
              aria-busy={submitting}
              className="inline-flex flex-1 min-h-[44px] items-center justify-center gap-2 rounded-full border border-charcoal/15 bg-charcoal px-4 text-sm font-semibold text-ivory shadow-sm transition hover:bg-espresso disabled:cursor-not-allowed disabled:bg-gold-soft/50 disabled:text-text-soft"
            >
              {submitting && <Spinner size={14} />}
              <span>{submitting ? "Organizing..." : "Clear My Head"}</span>
            </button>
          </div>
        </div>

        {error && (
          <div className="mt-3">
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

        {redirectMessage && (
          <div className="mt-3 rounded-2xl border border-sage/25 bg-sage/5 px-3.5 py-3">
            <p className="text-[13px] leading-snug text-text-soft">{redirectMessage}</p>
            <p className="mt-1.5 text-[12px] text-text-muted">
              Tap <strong className="font-medium text-text">Carson</strong> in the bottom nav, or use the button above to speak with your Chief of Staff.
            </p>
            <button
              type="button"
              onClick={() => setRedirectMessage(null)}
              className="mt-3 w-full rounded-xl bg-sage px-4 py-2 text-[13px] font-medium text-white"
            >
              Got it
            </button>
          </div>
        )}
      </section>

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

function NightSweepSection({
  title,
  items,
  completingItemId,
  onMarkDone,
  action,
}: {
  title: string;
  items: { id: string; text: string; canMarkDone?: boolean }[];
  completingItemId: string | null;
  onMarkDone: (id: string) => void;
  action?: ReactNode;
}) {
  if (items.length === 0) return null;

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-text-muted">
          {title}
        </p>
        {action}
      </div>
      <ul className="mt-1 space-y-1">
        {items.map((item) => (
          <li key={item.id} className="flex items-start justify-between gap-3 text-[13px] leading-snug text-text-soft">
            <span>{item.text}</span>
            {item.canMarkDone && (
              <button
                type="button"
                onClick={() => onMarkDone(item.id)}
                disabled={completingItemId !== null}
                className="shrink-0 rounded-full border border-sage/20 bg-white/70 px-2.5 py-1 text-[11px] font-medium text-sage transition hover:border-sage/35 hover:bg-sage/5 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {completingItemId === item.id ? "Saving..." : "Mark done"}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Returns true when the input is requesting information from Carson rather
 * than asking Ra7etBal to capture, organize, or act on something.
 *
 * Conservative: false negatives (letting a borderline question through to
 * extraction) are fine — the extractor will park it and no harm is done.
 * False positives (blocking a real task input) are the problem to avoid.
 *
 * Exclusions:
 *   - "Ask [person] if/whether..." — delegation, caught by extraction
 *   - "Remind me to..." — reminder, caught by extraction
 *   - "Tell [person] to..." — delegation
 */
function looksLikeQuestion(input: string): boolean {
  const lower = input.trim().toLowerCase();

  // Starts with an interrogative word
  if (/^(?:what|who|when|where|which|why|how)\b/.test(lower)) return true;

  // "Tell me about/what/how..." — but NOT "Tell Grace/Ghulam to..."
  // The "tell me" check is safe because delegations start "tell [name]" not "tell me"
  if (/^tell me\b/.test(lower)) return true;

  // "Show me..."
  if (/^show me\b/.test(lower)) return true;

  // "Can you / do you / could you / would you..."
  if (/^(?:can you|do you|could you|would you)\b/.test(lower)) return true;

  return false;
}

function buildStatusSummary(
  brief: ReturnType<typeof buildDailyBrief>,
  now: Date,
): { headline: string; lines: string[] } {
  const urgent = brief.needsAttention.filter(
    (t) => t.type === "reminder" && t.due_at && new Date(t.due_at) <= now,
  );
  const attention = brief.needsAttention.filter(
    (t) => !(t.type === "reminder" && t.due_at && new Date(t.due_at) <= now),
  );
  const waiting = brief.waitingOnOthers;

  if (urgent.length === 0 && attention.length === 0 && waiting.length === 0) {
    return { headline: "You're in good shape.", lines: ["Nothing needs your attention right now."] };
  }

  let headline = "";
  const lines: string[] = [];

  if (urgent.length > 0) {
    headline = urgent.length === 1 ? "Something needs you now." : `${urgent.length} things need you now.`;
  } else if (attention.length > 0) {
    headline = attention.length === 1 ? "One thing needs your attention." : `${attention.length} things need your attention.`;
  } else {
    headline = waiting.length === 1 ? "One item is waiting on someone." : `${waiting.length} things are waiting on others.`;
  }

  if (urgent.length > 0 && attention.length > 0) {
    lines.push(attention.length === 1 ? "Plus one more open item." : `Plus ${attention.length} open items.`);
  }
  if ((urgent.length > 0 || attention.length > 0) && waiting.length > 0) {
    lines.push(waiting.length === 1 ? "One item waiting on others." : `${waiting.length} waiting on others.`);
  }

  return { headline, lines };
}
