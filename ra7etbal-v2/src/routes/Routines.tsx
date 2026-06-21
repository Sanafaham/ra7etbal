import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import Spinner from "../components/Spinner";
import { useAuth } from "../hooks/useAuth";
import {
  createRoutine,
  deleteRoutine,
  listRoutines,
  toggleRoutine,
} from "../lib/routines";
import type { CreateRoutineInput, Routine, RoutineSchedule, RoutineType } from "../lib/routines";
import { supabase } from "../lib/supabase";
import { usePeopleStore } from "../stores/people";

// ── Automation types ───────────────────────────────────────────────────────────

interface AutomationRow {
  id: string;
  title: string;
  instruction: string;
  assignee_id: string | null;
  automation_type: "delegation" | "message";
  cadence_type: "daily" | "weekly" | "every_n_days" | "monthly" | "once";
  cadence_value: { n?: number } | null;
  next_run_at: string | null;
  timezone: string | null;
  status: "active" | "paused" | "stopped" | "archived";
  created_at: string;
  people?: { name: string } | null;
}

interface AutomationRunRow {
  automation_id: string;
  current_state: string;
}

function automationCadenceLabel(row: AutomationRow): string {
  switch (row.cadence_type) {
    case "daily": return "Daily";
    case "weekly": return "Weekly";
    case "monthly": return "Monthly";
    case "once": return "Once";
    case "every_n_days": {
      const n = row.cadence_value?.n ?? "?";
      return `Every ${n} days`;
    }
    default: return row.cadence_type;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function scheduleLabel(routine: Routine): string {
  if (routine.schedule === "daily") {
    return `Daily at ${formatTime(routine.schedule_time)}`;
  }
  if (routine.schedule === "every_n_days") {
    const n = routine.interval_days ?? "?";
    const nextRun = routine.next_run_at ? new Date(routine.next_run_at) : null;
    const nextLabel = nextRun
      ? `next ${nextRun.toLocaleDateString([], { month: "short", day: "numeric" })}`
      : "";
    return `Every ${n} days${nextLabel ? ` · ${nextLabel}` : ""}`;
  }
  const day = routine.schedule_day != null ? WEEKDAYS[routine.schedule_day] : "?";
  return `Every ${day} at ${formatTime(routine.schedule_time)}`;
}

/** Convert "HH:MM" 24-hour to "H:MM AM/PM". */
function formatTime(hhmm: string): string {
  const [hStr, mStr] = hhmm.split(":");
  const h = parseInt(hStr, 10);
  const m = mStr ?? "00";
  const ampm = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m} ${ampm}`;
}

function lastRunLabel(lastRunAt: string | null): string {
  if (!lastRunAt) return "Not run yet";
  const d = new Date(lastRunAt);
  return `Last ran ${d.toLocaleDateString([], { month: "short", day: "numeric" })} at ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

function autoName(
  type: RoutineType,
  schedule: RoutineSchedule,
  scheduleDay: number,
  _scheduleTime: string,
  reminderTitle: string,
  personName: string,
  intervalDays: number,
): string {
  const schedulePrefix =
    schedule === "daily"
      ? "Daily"
      : schedule === "every_n_days"
        ? `Every ${intervalDays}d`
        : WEEKDAYS[scheduleDay] ?? "Weekly";

  if (type === "reminder") {
    const title = reminderTitle.trim() || "Reminder";
    return `${schedulePrefix}: ${title}`;
  }
  const name = personName.trim() || "someone";
  if (type === "message") {
    return `${schedulePrefix} message → ${name}`;
  }
  return `${schedulePrefix} delegation → ${name}`;
}

// ── Blank form state ───────────────────────────────────────────────────────────

interface FormState {
  type: RoutineType;
  schedule: RoutineSchedule;
  scheduleDay: number;        // 0–6
  scheduleTime: string;       // "HH:MM"
  intervalDays: number;       // used when schedule = "every_n_days"
  reminderTitle: string;
  delegatePersonId: string;
  delegateMessage: string;
  messagePersonId: string;
  messageBody: string;
  name: string;
  nameEdited: boolean;        // true once user manually edits name
}

function blankForm(): FormState {
  return {
    type: "reminder",
    schedule: "daily",
    scheduleDay: 1,            // Monday
    scheduleTime: "08:00",
    intervalDays: 2,
    reminderTitle: "",
    delegatePersonId: "",
    delegateMessage: "",
    messagePersonId: "",
    messageBody: "",
    name: "",
    nameEdited: false,
  };
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function Routines({ headerless = false }: { headerless?: boolean } = {}) {
  const { user } = useAuth();
  const userId = user?.id ?? null;

  // ── Routines list state ────────────────────────────────────────────────────
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [listStatus, setListStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [listError, setListError] = useState<string | null>(null);

  // ── Automations list state ─────────────────────────────────────────────────
  const [automations, setAutomations] = useState<AutomationRow[]>([]);
  const [automationRuns, setAutomationRuns] = useState<Record<string, string>>({});

  // ── Automation action state ────────────────────────────────────────────────
  const [automationActioningId, setAutomationActioningId] = useState<string | null>(null);
  const [automationConfirmStopId, setAutomationConfirmStopId] = useState<string | null>(null);

  // ── Create form state ──────────────────────────────────────────────────────
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FormState>(blankForm);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // ── Delete confirmation state ──────────────────────────────────────────────
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // ── Toggle state ───────────────────────────────────────────────────────────
  const [togglingId, setTogglingId] = useState<string | null>(null);

  // ── People store ───────────────────────────────────────────────────────────
  const { peopleItems, peopleStatus, loadPeople, peopleLoadedFor } = usePeopleStore(
    useShallow((s) => ({
      peopleItems: s.items,
      peopleStatus: s.status,
      loadPeople: s.loadFor,
      peopleLoadedFor: s.loadedForUserId,
    })),
  );

  // All people — phone is required for delivery, not for routine creation.
  // The runner handles missing phones at send time.
  const delegatablePeople = peopleItems;

  // ── Effects ────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!userId) {
      setRoutines([]);
      setAutomations([]);
      setListStatus("idle");
      return;
    }
    void loadRoutines();
    void loadAutomations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  // Refresh lists when Voice Carson creates a routine or automation mid-session.
  useEffect(() => {
    function handleVoiceRoutineCreated() {
      console.log("[routine:ROUTINES_REFRESH] received ra7etbal:routine-created — reloading");
      void loadRoutines();
    }
    function handleAutomationCreated() {
      void loadAutomations();
    }
    window.addEventListener("ra7etbal:routine-created", handleVoiceRoutineCreated);
    window.addEventListener("ra7etbal:automation-created", handleAutomationCreated);
    return () => {
      window.removeEventListener("ra7etbal:routine-created", handleVoiceRoutineCreated);
      window.removeEventListener("ra7etbal:automation-created", handleAutomationCreated);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load people when the create form is opened (needed for delegation picker)
  useEffect(() => {
    if (showForm && userId && peopleLoadedFor !== userId) {
      void loadPeople(userId);
    }
  }, [showForm, userId, peopleLoadedFor, loadPeople]);

  // ── Data loaders ───────────────────────────────────────────────────────────

  async function loadRoutines() {
    setListStatus("loading");
    setListError(null);
    try {
      const data = await listRoutines();
      setRoutines(data);
      setListStatus("ready");
    } catch (err) {
      setListError(err instanceof Error ? err.message : "Could not load routines.");
      setListStatus("error");
    }
  }

  async function loadAutomations() {
    if (!userId) return;
    const { data: rows } = await supabase
      .from("automations")
      .select("*, people(name)")
      .eq("user_id", userId)
      .in("status", ["active", "paused"])
      .order("created_at", { ascending: false });

    if (!rows) return;
    setAutomations(rows as AutomationRow[]);

    // Fetch latest run state per automation
    const ids = rows.map((r: AutomationRow) => r.id);
    if (ids.length === 0) return;
    const { data: runs } = await supabase
      .from("automation_runs")
      .select("automation_id, current_state")
      .in("automation_id", ids)
      .order("created_at", { ascending: false });

    if (!runs) return;
    const stateMap: Record<string, string> = {};
    for (const run of runs as AutomationRunRow[]) {
      if (!stateMap[run.automation_id]) {
        stateMap[run.automation_id] = run.current_state;
      }
    }
    setAutomationRuns(stateMap);
  }

  // ── Automation action handler ──────────────────────────────────────────────

  async function handleAutomationAction(id: string, action: "pause" | "resume" | "stop") {
    if (automationActioningId) return;

    if (action === "stop") {
      if (automationConfirmStopId !== id) {
        setAutomationConfirmStopId(id);
        window.setTimeout(() => {
          setAutomationConfirmStopId((cur) => (cur === id ? null : cur));
        }, 3000);
        return;
      }
      setAutomationConfirmStopId(null);
    }

    setAutomationActioningId(id);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const jwt = sessionData?.session?.access_token;
      if (!jwt) return;

      const res = await fetch("/api/automations", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify({ id, action }),
      });

      if (!res.ok) return;

      // Optimistic update: reflect new status immediately, then reload
      const nextStatus = action === "pause" ? "paused" : action === "resume" ? "active" : "stopped";
      setAutomations((prev) =>
        action === "stop"
          ? prev.filter((a) => a.id !== id)
          : prev.map((a) => (a.id === id ? { ...a, status: nextStatus as AutomationRow["status"] } : a)),
      );
    } catch {
      // Silently fail — list reload on next visit will correct state
    } finally {
      setAutomationActioningId(null);
    }
  }

  // ── Form helpers ───────────────────────────────────────────────────────────

  function setField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => {
      const next = { ...prev, [key]: value };

      // Auto-update name unless user has manually edited it
      if (!prev.nameEdited) {
        // Resolve the relevant person ID for the active type
        const delegateId = key === "delegatePersonId" ? (value as string) : prev.delegatePersonId;
        const messageId  = key === "messagePersonId"  ? (value as string) : prev.messagePersonId;
        const activePersonId = next.type === "message" ? messageId : delegateId;
        const personName = delegatablePeople.find((p) => p.id === activePersonId)?.name ?? "";
        next.name = autoName(
          next.type,
          next.schedule,
          next.scheduleDay,
          next.scheduleTime,
          next.reminderTitle,
          personName,
          next.intervalDays,
        );
      }

      return next;
    });
  }

  function handleOpenForm() {
    setForm(blankForm());
    setFormError(null);
    setShowForm(true);
  }

  function handleCancelForm() {
    setShowForm(false);
    setForm(blankForm());
    setFormError(null);
  }

  async function handleSave() {
    if (saving) return;
    setFormError(null);

    // Validation
    if (!form.name.trim()) {
      setFormError("Please enter a name for this routine.");
      return;
    }
    if (form.type === "reminder" && !form.reminderTitle.trim()) {
      setFormError("Please enter a reminder title.");
      return;
    }
    if (form.type === "delegation") {
      if (!form.delegatePersonId) {
        setFormError("Please select a person to delegate to.");
        return;
      }
      if (!form.delegateMessage.trim()) {
        setFormError("Please enter a delegation message.");
        return;
      }
    }
    if (form.type === "message") {
      if (!form.messagePersonId) {
        setFormError("Please select a recipient.");
        return;
      }
      if (!form.messageBody.trim()) {
        setFormError("Please enter the message to send.");
        return;
      }
    }
    if (!form.scheduleTime) {
      setFormError("Please set a time for this routine.");
      return;
    }
    if (form.schedule === "every_n_days") {
      if (!form.intervalDays || form.intervalDays < 1) {
        setFormError("Please enter a valid interval (1 day or more).");
        return;
      }
    }

    const payload: Record<string, unknown> =
      form.type === "reminder"
        ? { title: form.reminderTitle.trim() }
        : form.type === "message"
          ? { person_id: form.messagePersonId, message: form.messageBody.trim() }
          : { person_id: form.delegatePersonId, message: form.delegateMessage.trim() };

    // For every_n_days routines, seed next_run_at = now + interval_days.
    let nextRunAt: string | undefined;
    if (form.schedule === "every_n_days") {
      const ms = form.intervalDays * 24 * 60 * 60 * 1000;
      nextRunAt = new Date(Date.now() + ms).toISOString();
    }

    const input: CreateRoutineInput = {
      name: form.name.trim(),
      type: form.type,
      schedule: form.schedule,
      schedule_day: form.schedule === "weekly" ? form.scheduleDay : undefined,
      schedule_time: form.scheduleTime,
      payload,
      interval_days: form.schedule === "every_n_days" ? form.intervalDays : undefined,
      next_run_at: nextRunAt,
    };

    setSaving(true);
    try {
      const created = await createRoutine(input);
      setRoutines((prev) => [created, ...prev]);
      setShowForm(false);
      setForm(blankForm());
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Could not save routine.");
    } finally {
      setSaving(false);
    }
  }

  // ── Toggle handler ─────────────────────────────────────────────────────────

  async function handleToggle(routine: Routine) {
    if (togglingId) return;
    setTogglingId(routine.id);
    try {
      await toggleRoutine(routine.id, !routine.enabled);
      setRoutines((prev) =>
        prev.map((r) => (r.id === routine.id ? { ...r, enabled: !routine.enabled } : r)),
      );
    } catch {
      // Silently revert — nothing else to do without a toast system
    } finally {
      setTogglingId(null);
    }
  }

  // ── Delete handlers ────────────────────────────────────────────────────────

  async function handleDelete(routine: Routine) {
    if (deletingId) return;

    if (confirmingDeleteId !== routine.id) {
      setConfirmingDeleteId(routine.id);
      window.setTimeout(() => {
        setConfirmingDeleteId((cur) => (cur === routine.id ? null : cur));
      }, 3000);
      return;
    }

    setConfirmingDeleteId(null);
    setDeletingId(routine.id);
    try {
      await deleteRoutine(routine.id);
      setRoutines((prev) => prev.filter((r) => r.id !== routine.id));
    } catch {
      // Silently fail for V1
    } finally {
      setDeletingId(null);
    }
  }

  // ── Derived ────────────────────────────────────────────────────────────────

  const activeRoutines = routines.filter((r) => r.enabled);
  const pausedRoutines = routines.filter((r) => !r.enabled);
  const activeAutomations = automations.filter((a) => a.status === "active");
  const pausedAutomations = automations.filter((a) => a.status === "paused");
  const showInitialLoading = listStatus === "loading" && routines.length === 0;
  const showEmpty = listStatus === "ready" && routines.length === 0 && automations.length === 0 && !showForm;

  // ── Render ─────────────────────────────────────────────────────────────────

  if (!userId) return null;

  return (
    <section className="space-y-5">
      {/* ── Header (hidden when embedded in Updates) ── */}
      <header className="flex items-center justify-between gap-3">
        {!headerless && (
          <div>
            <h1 className="text-2xl font-semibold text-ink">Routines</h1>
            <p className="text-sm text-ink/60">
              Recurring reminders and delegations that run automatically.
            </p>
          </div>
        )}
        {!showForm && (
          <button
            type="button"
            onClick={handleOpenForm}
            className="inline-flex shrink-0 items-center gap-2 rounded-full bg-sage px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:brightness-105"
          >
            <span aria-hidden className="text-lg leading-none">＋</span>
            <span>New routine</span>
          </button>
        )}
      </header>

      {/* ── List error ── */}
      {listError && listStatus !== "loading" && (
        <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {listError}
        </p>
      )}

      {/* ── Loading ── */}
      {showInitialLoading && (
        <div className="flex items-center justify-center py-10 text-ink/40">
          <Spinner size={20} label="Loading routines" />
        </div>
      )}

      {/* ── Create form ── */}
      {showForm && (
        <div className="rounded-2xl border border-sand bg-white/80 p-5 shadow-sm space-y-4">
          <h2 className="text-base font-semibold text-ink">New Routine</h2>

          {/* Type picker */}
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-ink/60 uppercase tracking-wide">Type</p>
            <div className="flex flex-wrap gap-2">
              {(["reminder", "delegation", "message"] as RoutineType[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setField("type", t)}
                  className={`rounded-full px-4 py-1.5 text-sm font-medium transition ${
                    form.type === t
                      ? "bg-sage text-white"
                      : "bg-sand/60 text-ink/70 hover:bg-sand"
                  }`}
                >
                  {t === "reminder" ? "Remind me" : t === "delegation" ? "Delegate" : "Send message"}
                </button>
              ))}
            </div>
          </div>

          {/* Reminder fields */}
          {form.type === "reminder" && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-ink/60 uppercase tracking-wide">
                Reminder title
              </label>
              <input
                type="text"
                value={form.reminderTitle}
                onChange={(e) => setField("reminderTitle", e.target.value)}
                placeholder="e.g. Review your priorities"
                className="w-full rounded-xl border border-sand bg-white px-3.5 py-2.5 text-sm text-ink placeholder:text-ink/30 focus:border-sage/60 focus:outline-none"
              />
            </div>
          )}

          {/* Delegation fields */}
          {form.type === "delegation" && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-ink/60 uppercase tracking-wide">
                  Person
                </label>
                {peopleStatus === "loading" && delegatablePeople.length === 0 ? (
                  <p className="text-sm text-ink/40">Loading people…</p>
                ) : delegatablePeople.length === 0 ? (
                  <p className="text-sm text-ink/50">
                    No people added yet.{" "}
                    <a href="/people" className="text-sage underline underline-offset-2">
                      Add someone in People.
                    </a>
                  </p>
                ) : (
                  <select
                    value={form.delegatePersonId}
                    onChange={(e) => setField("delegatePersonId", e.target.value)}
                    className="w-full rounded-xl border border-sand bg-white px-3.5 py-2.5 text-sm text-ink focus:border-sage/60 focus:outline-none"
                  >
                    <option value="">Select a person…</option>
                    {delegatablePeople.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-ink/60 uppercase tracking-wide">
                  Message
                </label>
                <textarea
                  value={form.delegateMessage}
                  onChange={(e) => setField("delegateMessage", e.target.value)}
                  placeholder="e.g. Please send the weekly status update to the team."
                  rows={3}
                  className="w-full resize-none rounded-xl border border-sand bg-white px-3.5 py-2.5 text-sm text-ink placeholder:text-ink/30 focus:border-sage/60 focus:outline-none"
                />
              </div>
            </div>
          )}

          {/* Message fields */}
          {form.type === "message" && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-ink/60 uppercase tracking-wide">
                  Recipient
                </label>
                {peopleStatus === "loading" && delegatablePeople.length === 0 ? (
                  <p className="text-sm text-ink/40">Loading people…</p>
                ) : delegatablePeople.length === 0 ? (
                  <p className="text-sm text-ink/50">
                    No people added yet.{" "}
                    <a href="/people" className="text-sage underline underline-offset-2">
                      Add someone in People.
                    </a>
                  </p>
                ) : (
                  <select
                    value={form.messagePersonId}
                    onChange={(e) => setField("messagePersonId", e.target.value)}
                    className="w-full rounded-xl border border-sand bg-white px-3.5 py-2.5 text-sm text-ink focus:border-sage/60 focus:outline-none"
                  >
                    <option value="">Select a recipient…</option>
                    {delegatablePeople.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-ink/60 uppercase tracking-wide">
                  Message
                </label>
                <textarea
                  value={form.messageBody}
                  onChange={(e) => setField("messageBody", e.target.value)}
                  placeholder={`e.g. Good morning Loulya, I love you. Please keep me posted on your day.`}
                  rows={4}
                  className="w-full resize-none rounded-xl border border-sand bg-white px-3.5 py-2.5 text-sm text-ink placeholder:text-ink/30 focus:border-sage/60 focus:outline-none"
                />
                <p className="text-[11px] text-ink/40">
                  Sent verbatim — not rewritten or modified.
                </p>
              </div>
            </div>
          )}

          {/* Schedule */}
          <div className="space-y-3">
            <p className="text-xs font-medium text-ink/60 uppercase tracking-wide">Schedule</p>
            {/* Daily / Weekly / Every N days chips */}
            <div className="flex flex-wrap gap-2">
              {([["daily", "Daily"], ["weekly", "Weekly"], ["every_n_days", "Every N days"]] as [RoutineSchedule, string][]).map(([s, label]) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setField("schedule", s)}
                  className={`rounded-full px-4 py-1.5 text-sm font-medium transition ${
                    form.schedule === s
                      ? "bg-sage text-white"
                      : "bg-sand/60 text-ink/70 hover:bg-sand"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            {/* Every N days — interval input */}
            {form.schedule === "every_n_days" && (
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-ink/60 uppercase tracking-wide">
                  Every how many days?
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    max={365}
                    value={form.intervalDays}
                    onChange={(e) => setField("intervalDays", Math.max(1, parseInt(e.target.value, 10) || 1))}
                    className="w-24 rounded-xl border border-sand bg-white px-3.5 py-2.5 text-sm text-ink focus:border-sage/60 focus:outline-none"
                  />
                  <span className="text-sm text-ink/50">days</span>
                </div>
                <p className="text-[11px] text-ink/40">
                  First run in {form.intervalDays} {form.intervalDays === 1 ? "day" : "days"}.
                </p>
              </div>
            )}
            {/* Weekday picker — only when weekly */}
            {form.schedule === "weekly" && (
              <select
                value={form.scheduleDay}
                onChange={(e) => setField("scheduleDay", parseInt(e.target.value, 10))}
                className="w-full rounded-xl border border-sand bg-white px-3.5 py-2.5 text-sm text-ink focus:border-sage/60 focus:outline-none"
              >
                {WEEKDAYS.map((day, i) => (
                  <option key={day} value={i}>
                    {day}
                  </option>
                ))}
              </select>
            )}
            {/* Time */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-ink/60 uppercase tracking-wide">
                Time
              </label>
              <input
                type="time"
                value={form.scheduleTime}
                onChange={(e) => setField("scheduleTime", e.target.value)}
                className="rounded-xl border border-sand bg-white px-3.5 py-2.5 text-sm text-ink focus:border-sage/60 focus:outline-none"
              />
            </div>
          </div>

          {/* Routine name */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-ink/60 uppercase tracking-wide">
              Routine name
            </label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value, nameEdited: true }))}
              placeholder="Auto-filled — edit if you want"
              className="w-full rounded-xl border border-sand bg-white px-3.5 py-2.5 text-sm text-ink placeholder:text-ink/30 focus:border-sage/60 focus:outline-none"
            />
          </div>

          {/* Form error */}
          {formError && (
            <p className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
              {formError}
            </p>
          )}

          {/* Actions */}
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="inline-flex items-center gap-2 rounded-full bg-sage px-5 py-2 text-sm font-medium text-white shadow-sm transition hover:brightness-105 disabled:opacity-50"
            >
              {saving ? (
                <>
                  <Spinner size={14} label="Saving" />
                  Saving…
                </>
              ) : (
                "Save routine"
              )}
            </button>
            <button
              type="button"
              onClick={handleCancelForm}
              disabled={saving}
              className="rounded-full px-5 py-2 text-sm font-medium text-ink/60 transition hover:text-ink/80 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ── Empty state ── */}
      {showEmpty && (
        <div className="rounded-2xl border border-sand bg-white/60 px-5 py-10 text-center">
          <p className="text-sm text-ink/50">
            No routines yet. Add one to automate recurring reminders and delegations.
          </p>
        </div>
      )}

      {/* ── Active (automations first, then legacy routines) ── */}
      {(activeAutomations.length > 0 || activeRoutines.length > 0) && (
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-ink/55">Active</p>
          {activeAutomations.map((a) => (
            <AutomationCard
              key={a.id}
              automation={a}
              latestState={automationRuns[a.id] ?? null}
              actioning={automationActioningId === a.id}
              confirmingStop={automationConfirmStopId === a.id}
              onPause={() => handleAutomationAction(a.id, "pause")}
              onResume={() => handleAutomationAction(a.id, "resume")}
              onStop={() => handleAutomationAction(a.id, "stop")}
            />
          ))}
          {activeRoutines.map((r) => (
            <RoutineCard
              key={r.id}
              routine={r}
              confirmingDelete={confirmingDeleteId === r.id}
              deleting={deletingId === r.id}
              toggling={togglingId === r.id}
              onToggle={() => handleToggle(r)}
              onDelete={() => handleDelete(r)}
            />
          ))}
        </div>
      )}

      {/* ── Paused ── */}
      {(pausedAutomations.length > 0 || pausedRoutines.length > 0) && (
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-ink/55">Paused</p>
          {pausedAutomations.map((a) => (
            <AutomationCard
              key={a.id}
              automation={a}
              latestState={automationRuns[a.id] ?? null}
              actioning={automationActioningId === a.id}
              confirmingStop={automationConfirmStopId === a.id}
              onPause={() => handleAutomationAction(a.id, "pause")}
              onResume={() => handleAutomationAction(a.id, "resume")}
              onStop={() => handleAutomationAction(a.id, "stop")}
            />
          ))}
          {pausedRoutines.map((r) => (
            <RoutineCard
              key={r.id}
              routine={r}
              confirmingDelete={confirmingDeleteId === r.id}
              deleting={deletingId === r.id}
              toggling={togglingId === r.id}
              onToggle={() => handleToggle(r)}
              onDelete={() => handleDelete(r)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

// ── AutomationCard ────────────────────────────────────────────────────────────

interface AutomationCardProps {
  automation: AutomationRow;
  latestState: string | null;
  actioning: boolean;
  confirmingStop: boolean;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
}

type StateConfig = {
  label: string;
  dot: string;        // dot color class
  text: string;       // label text color class
  border: string;     // card left-border accent class
};

function resolveStateConfig(state: string | null): StateConfig {
  switch (state) {
    case "sent":
    case "task_created":
      return {
        label: "Waiting for confirmation",
        dot:   "bg-amber-400",
        text:  "text-amber-600",
        border: "border-l-amber-300",
      };
    case "followup_sent":
      return {
        label: "Follow-up sent",
        dot:   "bg-amber-500",
        text:  "text-amber-700",
        border: "border-l-amber-400",
      };
    case "confirmed":
    case "completed":
      return {
        label: "Confirmed",
        dot:   "bg-sage",
        text:  "text-sage",
        border: "border-l-sage/40",
      };
    case "escalated":
      return {
        label: "Escalated — needs attention",
        dot:   "bg-red-400",
        text:  "text-red-600",
        border: "border-l-red-300",
      };
    case "failed":
    case "skipped":
      return {
        label: state === "failed" ? "Failed" : "Skipped",
        dot:   "bg-red-400",
        text:  "text-red-600",
        border: "border-l-red-300",
      };
    default:
      return {
        label: "Not run yet",
        dot:   "bg-ink/20",
        text:  "text-ink/40",
        border: "border-l-sand",
      };
  }
}

function AutomationCard({
  automation,
  latestState,
  actioning,
  confirmingStop,
  onPause,
  onResume,
  onStop,
}: AutomationCardProps) {
  const assigneeName =
    automation.people?.name ??
    (automation.assignee_id ? "Unknown" : null);

  const nextRun = automation.next_run_at
    ? new Date(automation.next_run_at).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : null;

  const state = resolveStateConfig(latestState);
  const isActive = automation.status === "active";
  const isPaused = automation.status === "paused";

  return (
    <div className={`rounded-2xl border border-sand border-l-4 ${state.border} bg-white/80 px-4 py-3.5 shadow-sm transition`}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 space-y-1">

          {/* Title + type badge + paused badge */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-ink leading-snug">{automation.title}</span>
            {automation.automation_type === "message" ? (
              <span className="rounded-full bg-blush/20 px-2 py-0.5 text-[11px] font-medium text-blush">
                Message
              </span>
            ) : (
              <span className="rounded-full bg-sage/15 px-2 py-0.5 text-[11px] font-medium text-sage">
                Automation
              </span>
            )}
            {isPaused && (
              <span className="rounded-full bg-stone/40 px-2 py-0.5 text-[11px] font-medium text-ink/50">
                Paused
              </span>
            )}
          </div>

          {/* Cadence + assignee */}
          <p className="text-xs text-ink/50">
            {automationCadenceLabel(automation)}
            {assigneeName ? ` · ${assigneeName}` : ""}
          </p>

          {/* Run state */}
          <div className="flex items-center gap-1.5 pt-0.5">
            <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${state.dot}`} />
            <span className={`text-[11px] font-medium ${state.text}`}>{state.label}</span>
          </div>

          {/* Next run */}
          {nextRun && isActive && (
            <p className="text-[11px] text-ink/35">Next run {nextRun}</p>
          )}

        </div>

        {/* Controls */}
        <div className="flex shrink-0 items-center gap-1.5 pt-0.5">
          {/* Pause / Resume toggle */}
          {isActive && (
            <button
              type="button"
              onClick={onPause}
              disabled={actioning}
              aria-label="Pause automation"
              className="rounded-full px-2.5 py-1 text-xs font-medium text-ink/40 transition hover:bg-sand hover:text-ink/70 disabled:opacity-40"
            >
              {actioning ? "…" : "Pause"}
            </button>
          )}
          {isPaused && (
            <button
              type="button"
              onClick={onResume}
              disabled={actioning}
              aria-label="Resume automation"
              className="rounded-full px-2.5 py-1 text-xs font-medium text-sage transition hover:bg-sage/10 disabled:opacity-40"
            >
              {actioning ? "…" : "Resume"}
            </button>
          )}

          {/* Stop — requires confirm tap */}
          <button
            type="button"
            onClick={onStop}
            disabled={actioning}
            aria-label={confirmingStop ? "Confirm stop" : "Stop automation"}
            className={`rounded-full px-2.5 py-1 text-xs font-medium transition disabled:opacity-40 ${
              confirmingStop
                ? "bg-red-100 text-red-600 hover:bg-red-200"
                : "text-ink/30 hover:text-red-500"
            }`}
          >
            {actioning ? "…" : confirmingStop ? "Confirm?" : "Stop"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── RoutineCard ───────────────────────────────────────────────────────────────

interface RoutineCardProps {
  routine: Routine;
  confirmingDelete: boolean;
  deleting: boolean;
  toggling: boolean;
  onToggle: () => void;
  onDelete: () => void;
}

function RoutineCard({
  routine,
  confirmingDelete,
  deleting,
  toggling,
  onToggle,
  onDelete,
}: RoutineCardProps) {
  const typeLabel =
    routine.type === "reminder" ? "Reminder" :
    routine.type === "message"  ? "Message"  : "Delegation";
  const typeBadgeClass =
    routine.type === "reminder" ? "bg-stone/40 text-espresso/70" :
    routine.type === "message"  ? "bg-blue-50 text-blue-600"     :
    "bg-sage/15 text-sage";

  return (
    <div
      className={`rounded-2xl border bg-white/80 px-4 py-3.5 shadow-sm transition ${
        routine.enabled ? "border-sand" : "border-sand/50 opacity-60"
      }`}
    >
      <div className="flex items-start gap-3">
        {/* Main info */}
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-ink leading-snug">{routine.name}</span>
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${typeBadgeClass}`}>
              {typeLabel}
            </span>
            <span className="rounded-full bg-stone/30 px-2 py-0.5 text-[11px] font-medium text-ink/40">
              Legacy
            </span>
          </div>
          <p className="text-xs text-ink/50">{scheduleLabel(routine)}</p>
          <p className="text-[11px] text-ink/35">{lastRunLabel(routine.last_run_at)}</p>
        </div>

        {/* Controls */}
        <div className="flex shrink-0 items-center gap-2 pt-0.5">
          {/* Toggle */}
          <button
            type="button"
            onClick={onToggle}
            disabled={toggling}
            aria-label={routine.enabled ? "Pause routine" : "Activate routine"}
            className={`relative h-6 w-10 rounded-full transition-colors focus:outline-none disabled:opacity-50 ${
              routine.enabled ? "bg-sage" : "bg-stone/50"
            }`}
          >
            <span
              className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
                routine.enabled ? "translate-x-4" : "translate-x-0.5"
              }`}
            />
          </button>

          {/* Delete */}
          <button
            type="button"
            onClick={onDelete}
            disabled={deleting}
            aria-label={confirmingDelete ? "Confirm delete" : "Delete routine"}
            className={`rounded-full px-2.5 py-1 text-xs font-medium transition disabled:opacity-40 ${
              confirmingDelete
                ? "bg-red-100 text-red-600 hover:bg-red-200"
                : "text-ink/30 hover:text-red-500"
            }`}
          >
            {deleting ? "…" : confirmingDelete ? "Confirm?" : "Delete"}
          </button>
        </div>
      </div>
    </div>
  );
}
