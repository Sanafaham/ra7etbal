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
import { getUpcomingReminderTasks } from "../lib/updates-reminders";
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
  const [keyboardInset, setKeyboardInset] = useState(0);
  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>([]);
  const submittingRef = useRef(false);

  // viewportShrunk is a visualViewport-derived heuristic and has been
  // observed to read true on iOS PWA even with the textarea never
  // focused (no real keyboard involved) — regression report 2026-07-10:
  // the sticky CTA appeared on Home with the keyboard closed. Gating it
  // behind "the textarea was focused recently" makes the sticky CTA
  // impossible to show without a real focus/blur event ever happening,
  // regardless of what causes viewportShrunk to misread — while still
  // keeping it visible through the brief focus→blur→keyboard-closing
  // transition (e.g. tapping the attach-photo button).
  const [recentlyFocused, setRecentlyFocused] = useState(false);
  const recentlyFocusedTimerRef = useRef<number | null>(null);

  function handleTextareaFocus() {
    if (recentlyFocusedTimerRef.current) window.clearTimeout(recentlyFocusedTimerRef.current);
    setTextareaFocused(true);
    setRecentlyFocused(true);
  }

  function handleTextareaBlur() {
    setTextareaFocused(false);
    if (recentlyFocusedTimerRef.current) window.clearTimeout(recentlyFocusedTimerRef.current);
    recentlyFocusedTimerRef.current = window.setTimeout(() => {
      setRecentlyFocused(false);
    }, 600);
  }

  useEffect(() => {
    return () => {
      if (recentlyFocusedTimerRef.current) window.clearTimeout(recentlyFocusedTimerRef.current);
    };
  }, []);

  // Photo attachment for Clear My Head — up to 5 photos. The first is described
  // before extraction so the AI sees image context; all are carried to the first
  // delegation item and uploaded as task_attachments on save.
  const MAX_PHOTOS = 5;
  const imageFileInputRef = useRef<HTMLInputElement>(null);
  const [draftImageFiles, setDraftImageFiles] = useState<File[]>([]);
  const [draftImagePreviewUrls, setDraftImagePreviewUrls] = useState<string[]>([]);

  useEffect(() => {
    if (draftImageFiles.length === 0) { setDraftImagePreviewUrls([]); return; }
    const urls = draftImageFiles.map((f) => URL.createObjectURL(f));
    setDraftImagePreviewUrls(urls);
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, [draftImageFiles]);

  function addDraftPhotos(files: File[]) {
    if (files.length === 0) return;
    setDraftImageFiles((prev) => {
      const remaining = Math.max(0, MAX_PHOTOS - prev.length);
      return remaining === 0 ? prev : [...prev, ...files.slice(0, remaining)];
    });
  }

  function removeDraftPhoto(index: number) {
    setDraftImageFiles((prev) => prev.filter((_, i) => i !== index));
  }

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

  // See computeKeyboardInset() below for why this tracks the visual
  // viewport directly instead of guessing a fixed keyboard height.
  useEffect(() => {
    if (typeof window === "undefined" || !window.visualViewport) return;
    const vv = window.visualViewport;
    function compute() {
      const inset = computeKeyboardInset(window.innerHeight, vv.height, vv.offsetTop);
      setViewportShrunk(inset > 120);
      setKeyboardInset(inset);
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
  const openCarson = useCarsonStore((s) => s.setOpen);

  // ── Stats grid — real counts, same sources as Updates ──────────────
  const upcomingReminders = useMemo(
    () => getUpcomingReminderTasks(tasks, brief.needsAttention, now),
    [tasks, brief.needsAttention, now],
  );
  const completedCount = useMemo(
    () => tasks.filter((t) => t.status === "done").length,
    [tasks],
  );

  const trimmed = text.trim();
  const canSubmit = !submitting && (trimmed.length > 0 || draftImageFiles.length > 0) && !!userId;
  const keyboardOpen = textareaFocused || (recentlyFocused && viewportShrunk);

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
        openCarson(true);
        return;
      }

      setRedirectMessage(null);
      await loadPeople(userId);
      const peopleNow = usePeopleStore.getState().items;

      const filesForExtraction = draftImageFiles;
      const imageForExtraction = filesForExtraction[0] ?? null;

      if (!trimmed && imageForExtraction) {
        // Image-only submission: extract directly from the first photo via vision API.
        await useExtractionStore.getState().runFromPhoto(
          imageForExtraction,
          peopleNow,
          displayName ?? undefined,
        );
      } else {
        // Text (+ optional image) submission: describe first image for context, then extract from text.
        let extractionText = trimmed;
        if (imageForExtraction) {
          const description = await describeImageForTextCarson(imageForExtraction).catch(() => null);
          extractionText = `${trimmed}\n\nAttached image:\n${
            description || "A photo is attached. Use it as reference for this item."
          }`;
        }
        await runExtraction(extractionText, peopleNow, displayName ?? undefined);
      }

      // Auto-attach all photos to the first item that can actually carry one,
      // so Review shows them pre-loaded and save uploads them without the
      // user having to re-attach. Only the task branch in save.ts persists
      // image_path ("message" writes to the messages table, which has no
      // image column, and "parked" items are skipped entirely) — so picking
      // a "message"/"parked" item here silently dropped the photo even
      // though Review showed it attached. Any other type (delegation,
      // action, reminder, followup, errand, decision) supports it.
      if (filesForExtraction.length > 0) {
        const extractedItems = useExtractionStore.getState().items;
        const firstImageCapableItem = extractedItems.find(
          (i) => i.type !== "message" && i.type !== "parked",
        );
        if (firstImageCapableItem) {
          useExtractionStore.getState().setImageFiles(firstImageCapableItem.id, filesForExtraction);
        }
      }

      setDraftImageFiles([]);
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
    <section
      data-testid="home-root"
      className="mx-auto max-w-2xl"
      style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 36px)" }}
    >
      {/* ── Briefing — no card, text on page ────────────────────────── */}
      <div data-testid="home-briefing" className="mt-0 px-2 text-center sm:mt-4">
        <p data-testid="home-greeting" className="text-[13px] font-normal tracking-[0.01em] text-text-soft">{greeting}</p>
        <h1
          data-testid="home-status-headline"
          className="mx-auto mt-1 max-w-xs text-[26px] leading-[1.1] tracking-[-0.015em] text-text sm:text-[32px]"
          style={{ fontFamily: "var(--font-display)" }}
        >
          {premiumStatus}
        </h1>
        <div className="mt-2.5 flex items-center justify-center gap-2">
          <span
            data-testid="home-status-indicator"
            aria-hidden
            className={
              "h-1.5 w-1.5 shrink-0 rounded-full " +
              (statusTone === "urgent"
                ? "bg-danger"
                : statusTone === "attention"
                  ? "bg-gold"
                  : "bg-sage")
            }
          />
          <p data-testid="home-brief-sentence" className="text-[13px] font-medium text-text-soft">{briefSentence}</p>
        </div>
      </div>

      {/* ── Stats grid — real counts, tap to jump to Updates ─────────── */}
      <div data-testid="home-stats-grid" className="mt-9 border-t border-border">
        <div className="grid grid-cols-2">
          <button
            type="button"
            onClick={() => navigate("/updates?tab=needs-you")}
            className="border-b border-r border-border py-[22px] pr-5 text-left"
          >
            <span className="mb-2.5 flex items-center gap-[7px]">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-gold" />
              <span className="text-[11.5px] font-bold uppercase tracking-[0.04em] text-text-soft">Needs You</span>
            </span>
            <span className="block text-[33px] font-semibold leading-none tracking-[-0.02em] text-ink">
              {brief.needsAttention.length}
            </span>
          </button>
          <button
            type="button"
            onClick={() => navigate("/updates?tab=waiting")}
            className="border-b border-border py-[22px] pl-5 text-left"
          >
            <span className="mb-2.5 flex items-center gap-[7px]">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-text-soft" />
              <span className="text-[11.5px] font-bold uppercase tracking-[0.04em] text-text-soft">Waiting</span>
            </span>
            <span className="block text-[33px] font-semibold leading-none tracking-[-0.02em] text-ink">
              {brief.waitingOnOthers.length}
            </span>
          </button>
          <button
            type="button"
            onClick={() => navigate("/updates?tab=needs-you")}
            className="border-r border-border py-[22px] pr-5 text-left"
          >
            <span className="mb-2.5 flex items-center gap-[7px]">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-text-soft" />
              <span className="text-[11.5px] font-bold uppercase tracking-[0.04em] text-text-soft">Upcoming</span>
            </span>
            <span className="block text-[33px] font-semibold leading-none tracking-[-0.02em] text-ink">
              {upcomingReminders.length}
            </span>
          </button>
          <button
            type="button"
            onClick={() => navigate("/updates?tab=history")}
            className="py-[22px] pl-5 text-left"
          >
            <span className="mb-2.5 flex items-center gap-[7px]">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-text-soft" />
              <span className="text-[11.5px] font-bold uppercase tracking-[0.04em] text-text-soft">Completed</span>
            </span>
            <span className="block text-[33px] font-semibold leading-none tracking-[-0.02em] text-ink">
              {completedCount}
            </span>
          </button>
        </div>
      </div>

      {/* ── Waiting preview — hidden entirely when nothing is waiting ── */}
      {brief.waitingOnOthers.length > 0 && (
        <div data-testid="home-waiting-preview" className="mt-7 border-t border-border pt-6">
          <p className="mb-3 text-[11px] font-bold uppercase tracking-[0.1em] text-text-soft">Waiting</p>
          <button type="button" onClick={() => navigate("/updates?tab=waiting")} className="w-full text-left">
            {brief.waitingOnOthers.slice(0, 2).map((t) => (
              <span key={t.id} className="flex items-baseline gap-2 py-1.5">
                <span aria-hidden className="h-[5px] w-[5px] shrink-0 rounded-full bg-text-soft" />
                <span className="text-[14.5px] font-medium leading-snug text-ink">{t.description}</span>
              </span>
            ))}
            {brief.waitingOnOthers.length > 2 && (
              <span className="block pl-[13px] pt-0.5 text-[13px] font-semibold text-text-soft">
                +{brief.waitingOnOthers.length - 2} more waiting
              </span>
            )}
          </button>
        </div>
      )}

      {/* ── Needs You — top item ─────────────────────────────────────── */}
      {brief.needsAttention.length > 0 && (
        <div data-testid="home-needs-you-preview" className="mt-6">
          <p className="mb-3 text-[11px] font-bold uppercase tracking-[0.1em] text-gold">Needs You</p>
          <button type="button" onClick={() => navigate("/updates?tab=needs-you")} className="w-full text-left">
            <span className="block text-[16.5px] font-bold leading-snug text-ink">
              {brief.needsAttention[0].description}
            </span>
          </button>
        </div>
      )}

      {/* ── Talk to Carson — visual hero ────────────────────────────── */}
      <section data-testid="home-talk-to-carson-section" className="mt-6 sm:mt-8">
        <button
          data-testid="home-talk-to-carson-button"
          type="button"
          onClick={() => openCarson(true)}
          className="group flex w-full flex-col items-center gap-0.5 rounded-[14px] border border-border bg-gold/[0.08] px-6 py-4 shadow-[0_1px_2px_rgba(31,31,31,0.05)] transition active:scale-[0.982]"
        >
          <span className="flex h-[56px] w-[56px] items-center justify-center rounded-full bg-gold/[0.12] ring-1 ring-gold/30 transition group-hover:bg-gold/[0.18] group-hover:ring-gold/55">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="text-gold">
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1="12" y1="19" x2="12" y2="23" />
              <line x1="8" y1="23" x2="16" y2="23" />
            </svg>
          </span>
          <div className="text-center">
            <p className="text-[20px] font-semibold tracking-[-0.02em] text-ink">Talk to Carson</p>
            <p className="text-[13px] text-text-soft">Ready when you are.</p>
          </div>
        </button>
      </section>

      {/* ── Clear My Head ─────────────────────────────────────────────── */}
      <section data-testid="home-clear-my-head-section" className="mt-6 rounded-[24px] border border-border bg-warm-white/60 px-4 py-4 shadow-[0_18px_50px_-32px_rgba(20,20,20,0.20)] backdrop-blur-sm sm:mt-8 sm:px-5 sm:py-5">
        <div className="mb-2.5 flex items-center justify-between gap-3">
          <label
            data-testid="home-clear-my-head-label"
            htmlFor={textareaId}
            className="text-[10px] font-semibold uppercase tracking-[0.16em] text-ink/75"
          >
            Clear My Head
          </label>
          <div data-testid="home-voice-button-slot" className="[&_button]:rounded-full [&_button]:border-border [&_button]:bg-warm-white [&_button]:px-3 [&_button]:py-1.5 [&_button]:text-[11px] [&_button]:font-medium [&_button]:text-text [&_button]:shadow-sm [&_svg]:h-[13px] [&_svg]:w-[13px]">
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
          data-testid="home-clear-my-head-textarea"
          id={textareaId}
          ref={textareaRef}
          value={text}
          onChange={(e) => { setText(e.target.value); setRedirectMessage(null); }}
          onFocus={handleTextareaFocus}
          onBlur={handleTextareaBlur}
          placeholder="Say what you're carrying. Tasks, reminders, people to message, things to follow up on."
          autoComplete="off"
          spellCheck
          rows={4}
          disabled={submitting}
          style={{ fieldSizing: "content", fontFamily: "var(--font-sans)" }}
          className="block min-h-[96px] w-full resize-y rounded-2xl bg-transparent text-[16px] leading-relaxed text-text outline-none placeholder:text-text-muted focus:outline-none disabled:opacity-70"
        />

        {/*
          * File input is always mounted outside any conditional block so iOS
          * Safari never invalidates the File object reference on re-render.
          */}
        <input
          data-testid="home-attach-input"
          ref={imageFileInputRef}
          type="file"
          accept="image/*"
          multiple
          onChange={(e) => {
            addDraftPhotos(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
          className="sr-only"
          aria-label="Attach photos to extraction"
        />

        {draftImagePreviewUrls.length > 0 && (
          <div data-testid="home-attach-preview" className="mt-3 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              {draftImagePreviewUrls.map((url, index) => (
                <div key={index} className="relative inline-block shrink-0">
                  <img
                    src={url}
                    alt={`Attached photo ${index + 1}`}
                    className="h-12 w-12 rounded-xl border border-border object-cover shadow-sm"
                  />
                  <button
                    data-testid="home-attach-preview-remove"
                    type="button"
                    onClick={() => removeDraftPhoto(index)}
                    disabled={submitting}
                    aria-label={`Remove attached photo ${index + 1}`}
                    className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-ink/70 text-white shadow transition hover:bg-ink disabled:opacity-50"
                  >
                    <svg width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                      <line x1="1" y1="1" x2="9" y2="9" /><line x1="9" y1="1" x2="1" y2="9" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
            <p className="text-[11px] leading-snug text-text-muted">
              {draftImageFiles.length} photo{draftImageFiles.length !== 1 ? "s" : ""} ready
              {draftImageFiles.length < MAX_PHOTOS ? " — tap the photo button to add more." : " — maximum reached."}
            </p>
          </div>
        )}

        <div className="mt-4 space-y-3 border-t border-border pt-4">
          <div className="flex items-center gap-2">
            <button
              data-testid="home-attach-button"
              type="button"
              onClick={() => imageFileInputRef.current?.click()}
              disabled={submitting || draftImageFiles.length >= MAX_PHOTOS}
              aria-label="Attach photos"
              title={draftImageFiles.length >= MAX_PHOTOS ? "Maximum 5 photos" : "Attach photos"}
              className={
                "flex h-10 w-10 shrink-0 items-center justify-center rounded-full border shadow-sm transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-45 " +
                (draftImageFiles.length > 0
                  ? "border-sage bg-sage/10 text-sage"
                  : "border-border bg-warm-white text-text-soft hover:border-sage hover:text-text")
              }
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <path d="M21 15l-5-5L5 21" />
              </svg>
            </button>
            {!keyboardOpen && (
              <button
                data-testid="home-submit-button"
                type="button"
                onClick={handleNext}
                onMouseDown={(e) => e.preventDefault()}
                onTouchStart={(e) => e.stopPropagation()}
                disabled={!canSubmit}
                aria-busy={submitting}
                className="inline-flex flex-1 min-h-[48px] items-center justify-center gap-2 rounded-full border border-charcoal/15 bg-charcoal px-4 text-sm font-semibold tracking-[-0.005em] text-ivory shadow-sm transition hover:bg-espresso disabled:cursor-not-allowed disabled:border-stone-300 disabled:bg-stone-100 disabled:text-stone-400 disabled:shadow-none"
              >
                {submitting && <Spinner size={14} />}
                <span>{submitting ? "Organizing..." : "Clear My Head"}</span>
              </button>
            )}
          </div>
        </div>

        {error && (
          <div data-testid="home-error-notice" className="mt-4">
            <AuthNotice kind="error">
              {error}{" "}
              <button
                data-testid="home-error-retry-button"
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
          <div data-testid="home-redirect-notice" className="mt-4 rounded-2xl border border-border bg-warm-white/70 px-4 py-3.5">
            <p className="text-[13px] leading-snug text-text-soft">{redirectMessage}</p>
            <p className="mt-1.5 text-[12px] text-text-muted">
              Tap <strong className="font-medium text-text">Carson</strong> in the bottom nav, or use the button above to speak with your Chief of Staff.
            </p>
            <button
              data-testid="home-redirect-dismiss-button"
              type="button"
              onClick={() => setRedirectMessage(null)}
              className="mt-3 w-full rounded-full bg-sage px-4 py-2 text-[13px] font-medium tracking-[-0.005em] text-white"
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
          data-testid="home-sticky-cta"
          className="fixed z-50"
          style={{
            bottom: `calc(env(safe-area-inset-bottom) + ${keyboardInset + 16}px)`,
            right: "24px",
          }}
        >
          <button
            data-testid="home-sticky-cta-button"
            type="button"
            onClick={handleNext}
            onMouseDown={(e) => e.preventDefault()}
            onTouchStart={(e) => e.stopPropagation()}
            disabled={!canSubmit}
            aria-busy={submitting}
            className="inline-flex items-center justify-center gap-2 rounded-full border border-charcoal/15 bg-charcoal px-5 py-3 text-[15px] font-medium tracking-[-0.005em] text-ivory shadow-[0_18px_45px_-22px_rgba(20,20,20,0.50)] transition hover:bg-espresso disabled:cursor-not-allowed disabled:border-charcoal/25 disabled:bg-ivory disabled:text-ink/60 disabled:shadow-none"
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

/**
 * Gap between the layout viewport (window.innerHeight) and the visible
 * visual viewport, including how far the visual viewport has panned down
 * (offsetTop) to keep a focused input in view. On iOS Safari this equals
 * the on-screen keyboard's real height — unlike a static guess, it adapts
 * to QuickType/emoji/third-party keyboards and to viewport panning, so a
 * `position: fixed` element can sit directly above the keyboard instead of
 * jumping around a fixed constant. Zero when no keyboard is showing.
 */
export function computeKeyboardInset(
  innerHeight: number,
  visualViewportHeight: number,
  visualViewportOffsetTop: number,
): number {
  return Math.max(0, innerHeight - visualViewportHeight - visualViewportOffsetTop);
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
