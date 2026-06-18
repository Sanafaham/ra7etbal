import { useEffect, useId, useMemo, useRef, useState } from "react";
import { describeImageForTextCarson } from "../lib/text-carson";
import { useNavigate } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import { useCarsonStore } from "../stores/carson";
import AuthNotice from "../components/auth/AuthNotice";
import AwarenessCard from "../components/home/AwarenessCard";
import VoiceButton from "../components/home/VoiceButton";
import Spinner from "../components/Spinner";
import { useAuth } from "../hooks/useAuth";
import { fetchCalendarEvents, type CalendarEvent } from "../lib/calendar";
import { buildDailyBrief } from "../lib/daily-brief";
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

  const { tasks, loadTasks } = useTasksStore(
    useShallow((s) => ({
      tasks: s.items,
      loadTasks: s.loadFor,
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

  const greeting = useMemo(() => buildGreeting(now, displayName), [now, displayName]);
  const premiumStatus = buildPremiumStatus(statusTone);
  const briefSentence = useMemo(() => buildBriefSentence(brief, now), [brief, now]);

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


  return (
    <section
      className="mx-auto max-w-2xl"
      style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 36px)" }}
    >
      {/* ── Briefing — no card, text on page ────────────────────────── */}
      <div className="mt-5 px-2 text-center sm:mt-7">
        <p className="text-[13px] font-medium text-stone">{greeting}</p>
        <h1
          className="mx-auto mt-1.5 max-w-xs text-[22px] leading-[1.1] tracking-[-0.01em] text-text sm:text-[26px]"
          style={{ fontFamily: "var(--font-display)" }}
        >
          {premiumStatus}
        </h1>
        <div className="mt-2 flex items-center justify-center gap-2">
          <span
            aria-hidden
            className={
              "h-2 w-2 shrink-0 rounded-full " +
              (statusTone === "urgent"
                ? "bg-danger"
                : statusTone === "attention"
                  ? "bg-gold"
                  : "bg-sage")
            }
          />
          <p className="text-[13px] text-stone">{briefSentence}</p>
        </div>
      </div>

      {/* ── Talk to Carson — visual hero ────────────────────────────── */}
      <section className="mt-4 sm:mt-5">
        <button
          type="button"
          onClick={() => openCarson(true)}
          className="group flex w-full flex-col items-center gap-3 rounded-[28px] bg-warm-white px-6 py-7 shadow-[0_40px_90px_-40px_rgba(20,20,20,0.45)] backdrop-blur-sm transition active:scale-[0.982]"
        >
          <span className="flex h-[64px] w-[64px] items-center justify-center rounded-full bg-sage/[0.12] ring-[1.5px] ring-sage/35 transition group-hover:bg-sage/[0.18] group-hover:ring-sage/55">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="text-sage">
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1="12" y1="19" x2="12" y2="23" />
              <line x1="8" y1="23" x2="16" y2="23" />
            </svg>
          </span>
          <div className="text-center">
            <p className="text-[20px] font-semibold tracking-[-0.025em] text-ink">Talk to Carson</p>
            <p className="mt-1 text-[13px] text-ink/50">Ready when you are.</p>
          </div>
        </button>
      </section>

      {/* ── Clear My Head ─────────────────────────────────────────────── */}
      <section className="mt-2.5 rounded-[20px] border border-border/20 bg-transparent px-3.5 pb-3.5 pt-3 sm:mt-3">
        <div className="mb-1.5 flex items-center justify-between gap-3">
          <label
            htmlFor={textareaId}
            className="text-[10px] font-semibold uppercase tracking-[0.2em] text-text-muted"
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
          className="block min-h-[84px] w-full resize-y rounded-2xl bg-transparent text-[16px] leading-relaxed text-text outline-none placeholder:text-muted focus:outline-none disabled:opacity-70"
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

      {/* ── Next Up — lightweight context ───────────────────────────── */}
      <AwarenessCard events={calendarEvents} now={now} />

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

function buildGreeting(now: Date, displayName: string | null): string {
  const hour = now.getHours();
  const name = displayName ? `, ${displayName}` : "";
  if (hour < 12) return `Good morning${name}`;
  if (hour < 18) return `Good afternoon${name}`;
  return `Good evening${name}`;
}

function buildPremiumStatus(tone: "urgent" | "attention" | "clear"): string {
  if (tone === "urgent") return "Immediate attention required.";
  if (tone === "attention") return "A few things need attention.";
  return "Everything is under control.";
}

function buildBriefSentence(
  brief: ReturnType<typeof buildDailyBrief>,
  now: Date,
): string {
  const urgent = brief.needsAttention.filter(
    (t) => t.type === "reminder" && t.due_at && new Date(t.due_at) <= now,
  );
  const attention = brief.needsAttention.filter(
    (t) => !(t.type === "reminder" && t.due_at && new Date(t.due_at) <= now),
  );
  const waiting = brief.waitingOnOthers;

  if (urgent.length > 0) {
    return urgent.length === 1
      ? "One reminder is overdue."
      : `${urgent.length} reminders are overdue.`;
  }
  if (attention.length > 0) {
    if (waiting.length > 0) {
      return `${attention.length} item${attention.length > 1 ? "s" : ""} to review, ${waiting.length} waiting on others.`;
    }
    return attention.length === 1
      ? "One item ready for your review."
      : `${attention.length} items ready for your review.`;
  }
  if (waiting.length > 0) {
    return waiting.length === 1
      ? "One item is waiting on someone."
      : `${waiting.length} items are waiting on others.`;
  }
  if (brief.done.length > 0) {
    return brief.done.length === 1
      ? "One thing wrapped up today."
      : `${brief.done.length} things wrapped up today.`;
  }
  return "Your day is clear.";
}

