import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import AuthNotice from "../components/auth/AuthNotice";
import ElevenLabsAgentWidget from "../components/home/ElevenLabsAgentWidget";
import InboxReviewPanel from "../components/home/InboxReviewPanel";
import TextCarsonPanel from "../components/home/TextCarsonPanel";
import VoiceButton from "../components/home/VoiceButton";
import Spinner from "../components/Spinner";
import { useAuth } from "../hooks/useAuth";
import { buildDailyBrief } from "../lib/daily-brief";
import { buildMorningBriefSpoken } from "../lib/morning-brief";
import { formatReminderDue } from "../lib/reminder-time";
import { useDraftStore } from "../stores/draft";
import { useExtractionStore } from "../stores/extraction";
import { usePeopleStore } from "../stores/people";
import { useProfileStore } from "../stores/profile";
import type { Task } from "../types/task";
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

  const { people, loadPeople } = usePeopleStore(
    useShallow((s) => ({ people: s.items, loadPeople: s.loadFor })),
  );

  const { displayName, loadProfile } = useProfileStore(
    useShallow((s) => ({ displayName: s.displayName, loadProfile: s.loadFor })),
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
    if (!userId) return;
    void loadPeople(userId);
  }, [userId, loadPeople]);

  useEffect(() => {
    if (!userId) return;
    void loadProfile(userId);
  }, [userId, loadProfile]);

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
  const statusSummary = useMemo(
    () => buildStatusSummary(brief, now),
    [brief, now],
  );
  const elevenLabsBriefStateText = useMemo(
    () => buildElevenLabsBriefStateText(brief, { email: user?.email, people, tasks }),
    [brief, user?.email, people, tasks],
  );
  const spokenBrief = useMemo(
    () => buildMorningBriefSpoken(tasks, people, displayName, now),
    [tasks, people, displayName, now],
  );
  const supportingLines = statusSummary.lines;

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
      await runExtraction(trimmed, peopleNow, displayName ?? undefined);
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

  function viewBriefDetails() {
    navigate("/actions", { state: { initialFilter: "brief" } });
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

      {/* ── Carson (text + voice, same Carson) ────────────────────────── */}
      <section className="mt-3 rounded-[24px] border border-sage/25 bg-white/72 p-4 shadow-sm backdrop-blur-sm">
        <h2 className="mb-2 text-sm font-semibold text-text">Carson</h2>
        <div className="mb-3">
          <ElevenLabsAgentWidget
            briefStateText={elevenLabsBriefStateText}
            spokenBrief={spokenBrief}
            displayName={displayName}
            inline
            onBeforeCallStart={async () => {
              // Force a live Supabase fetch before Carson speaks so ALL
              // dynamic variables reflect the current task/message state.
              // Both ra7etbal_state and daily_brief are rebuilt from the
              // fresh store — never from the React render-time snapshot.
              if (userId) {
                await loadTasks(userId, { force: true });
              }
              const freshTasks = useTasksStore.getState().items;
              const freshNow = new Date();
              const freshBrief = buildDailyBrief(freshTasks, freshNow);
              return {
                briefStateText: buildElevenLabsBriefStateText(freshBrief, {
                  email: user?.email,
                  people,
                  tasks: freshTasks,
                }),
                spokenBrief: buildMorningBriefSpoken(
                  freshTasks,
                  people,
                  displayName,
                  freshNow,
                ),
              };
            }}
          />
        </div>
        <TextCarsonPanel
          context={{
            displayName,
            userEmail: user?.email ?? null,
            userId: userId,
            briefStateText: elevenLabsBriefStateText,
            dailyBrief: spokenBrief,
            people,
            tasks,
          }}
          hideHeading
          onPrefill={(prefillText) => {
            setText(prefillText);
            setTimeout(() => {
              textareaRef.current?.focus();
              textareaRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
            }, 50);
          }}
        />
      </section>

      {/* ── Inbox ─────────────────────────────────────────────────────── */}
      <InboxReviewPanel
        userId={userId}
        onPrefill={(prefillText) => {
          setText(prefillText);
          setTimeout(() => {
            textareaRef.current?.focus();
            textareaRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
          }, 50);
        }}
      />

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

        <div className="mt-3 space-y-2.5 border-t border-border/70 pt-3">
          <p className="text-[13px] italic leading-snug text-text-soft">
            Ra7etBal will organize it before anything is saved.
          </p>
          <button
            type="button"
            onClick={handleNext}
            onMouseDown={(e) => e.preventDefault()}
            onTouchStart={(e) => e.stopPropagation()}
            disabled={!canSubmit}
            aria-busy={submitting}
            className="inline-flex w-full min-h-[44px] items-center justify-center gap-2 rounded-full border border-charcoal/15 bg-charcoal px-4 text-sm font-semibold text-ivory shadow-sm transition hover:bg-espresso disabled:cursor-not-allowed disabled:bg-gold-soft/50 disabled:text-text-soft"
          >
            {submitting && <Spinner size={14} />}
            <span>{submitting ? "Organizing..." : "Clear My Head"}</span>
          </button>
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
    return { headline: "You're clear right now.", lines: [] };
  }

  let headline = "";
  const lines: string[] = [];

  if (urgent.length > 0) {
    headline =
      urgent.length === 1
        ? "You have 1 overdue reminder."
        : `You have ${urgent.length} overdue reminders.`;
  } else if (attention.length > 0) {
    headline =
      attention.length === 1
        ? "You have 1 item that needs attention."
        : `You have ${attention.length} items that need attention.`;
  } else {
    headline =
      waiting.length === 1
        ? "You have 1 item waiting on others."
        : `You have ${waiting.length} items waiting on others.`;
  }

  if (urgent.length > 0 && attention.length > 0) {
    lines.push(
      attention.length === 1
        ? "1 other item also needs your attention."
        : `${attention.length} other items also need your attention.`,
    );
  }
  if ((urgent.length > 0 || attention.length > 0) && waiting.length > 0) {
    lines.push(
      waiting.length === 1
        ? "1 item is waiting on others."
        : `${waiting.length} items are waiting on others.`,
    );
  }

  return { headline, lines };
}

function buildElevenLabsBriefStateText(
  brief: ReturnType<typeof buildDailyBrief>,
  extras: {
    email?: string | null;
    people?: Array<{ name: string; role: string; notes?: string | null }>;
    /** Raw unarchived tasks — used to build a date-independent recent-completions
     *  list that matches what Text Carson sees via formatTasks(). Without this,
     *  Voice Carson misses confirmations from prior days. */
    tasks?: Task[];
  } = {},
): string {
  const now = new Date();
  const lines: string[] = [];

  // ── User identity ─────────────────────────────────────────────────────
  if (extras.email) {
    lines.push(`User email: ${extras.email}`);
  }

  // ── People (household contacts) ───────────────────────────────────────
  // Lets Carson match "message the driver" or "follow up with Grace" to
  // real names and roles without asking who they are.
  if (extras.people && extras.people.length > 0) {
    const items = extras.people
      .map((p) => (p.role ? `${p.name} (${p.role})` : p.name))
      .join(", ");
    lines.push(`People: ${items}.`);

    const peopleMemory = extras.people
      .map((p) => {
        const note = formatPersonMemoryForCarson(p.notes);
        return note ? `${p.name}: ${note}` : null;
      })
      .filter(Boolean);
    if (peopleMemory.length > 0) {
      lines.push(`People context: ${peopleMemory.join("; ")}.`);
    }
  } else {
    lines.push("People: none saved.");
  }

  lines.push(`Summary: ${brief.summary.paragraph}`);

  // ── Reminders (all buckets, with due times) ────────────────────────────
  // Collect every pending reminder the user has, regardless of which brief
  // bucket it landed in. Include the humanized due time so the agent can
  // answer "what time is my reminder to X?" accurately.
  const allTasks = [
    ...brief.needsAttention,
    ...brief.later,
    // waitingOnOthers are delegations/follow-ups — no reminders there
  ];
  const reminders = allTasks.filter(
    (t) => t.type === "reminder" && t.status === "pending",
  );
  if (reminders.length > 0) {
    const items = reminders.map((t) => {
      const due = t.due_at ? formatReminderDue(t.due_at, now) : null;
      return due
        ? `"${t.description.trim()}" (${due})`
        : `"${t.description.trim()}"`;
    });
    lines.push(`Reminders (${reminders.length}): ${items.join("; ")}.`);
  } else {
    lines.push("Reminders: none.");
  }

  // ── Non-reminder needs-attention items ────────────────────────────────
  const nonReminderAttention = brief.needsAttention.filter(
    (t) => t.type !== "reminder",
  );
  if (nonReminderAttention.length > 0) {
    const items = nonReminderAttention
      .slice(0, 5)
      .map((t) => t.description.trim())
      .join("; ");
    lines.push(`Needs attention: ${items}.`);
  }

  // ── Waiting on others ─────────────────────────────────────────────────
  if (brief.waitingOnOthers.length > 0) {
    const items = brief.waitingOnOthers
      .slice(0, 5)
      .map((t) => {
        const name = t.assigned_to?.trim();
        return name
          ? `"${t.description.trim()}" (waiting on ${name})`
          : `"${t.description.trim()}"`;
      })
      .join("; ");
    lines.push(`Waiting on others: ${items}.`);
  }

  // ── Later (non-reminder) ──────────────────────────────────────────────
  const nonReminderLater = brief.later.filter((t) => t.type !== "reminder");
  if (nonReminderLater.length > 0) {
    const items = nonReminderLater
      .slice(0, 5)
      .map((t) => t.description.trim())
      .join("; ");
    lines.push(`Later: ${items}.`);
  }

  // ── Recent completions ────────────────────────────────────────────────
  // Use raw tasks (same logic as Text Carson's formatTasks) so Carson sees
  // confirmations from prior days, not just today.
  // Falls back to brief.done if tasks were not passed.
  const recentDone = extras.tasks
    ? extras.tasks
        .filter((t) => t.archived_at == null && t.status === "done")
        .sort(
          (a, b) =>
            new Date(b.confirmed_at ?? b.created_at).getTime() -
            new Date(a.confirmed_at ?? a.created_at).getTime(),
        )
        .slice(0, 5)
    : brief.done.slice(0, 5);

  if (recentDone.length > 0) {
    const items = recentDone.map((t) => {
      const by = t.assigned_to?.trim() ? `, confirmed by ${t.assigned_to.trim()}` : "";
      const when = t.confirmed_at
        ? `, at ${new Date(t.confirmed_at).toLocaleString()}`
        : "";
      return `"${t.description.trim()}"${by}${when}`;
    });
    lines.push(`Recent completions: ${items.join("; ")}.`);
  }

  return lines.join("\n");
}

function formatPersonMemoryForCarson(value?: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  return trimmed
    .replace(/\s+/g, " ")
    .replace(/\bbossy\b/gi, "may over-control")
    .replace(/\bcontrolling\b/gi, "may over-control")
    .replace(/\blazy\b/gi, "may need firmer follow-up")
    .slice(0, 180);
}
