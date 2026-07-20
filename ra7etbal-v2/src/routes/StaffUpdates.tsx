/**
 * Staff Updates — read-only owner visibility into staff communications
 * processed by the staff communication engine (api/_staff-comms-engine.js,
 * processStaffMessage()). No transport (WhatsApp/ElevenLabs) is wired to
 * that engine yet, so this list may be empty in production — see
 * RA7ETBAL_STATE.md. That is never surfaced in the UI; the empty state
 * simply says nothing needs attention.
 *
 * Read-only: no reply, approve/reject, or outbound-messaging actions here.
 *
 * Split into a stateful wrapper (data fetching, below) and a pure,
 * hook-free `StaffUpdatesView` so the rendering logic itself — empty
 * state, badges, escalation box, internal-field exclusion, error
 * containment — can be tested directly via `renderToStaticMarkup`
 * without any DOM/testing-library dependency, matching this repo's
 * existing pure-function test convention.
 */
import { useEffect, useRef, useState } from "react";
import AuthNotice from "../components/auth/AuthNotice";
import Spinner from "../components/Spinner";
import { useAuth } from "../hooks/useAuth";
import { getStaffMessageDisplayState, listStaffMessages } from "../lib/staff-messages";
import { formatDate, formatTime, isSameLocalDay, isYesterday } from "../lib/reminder-time";
import type { StaffMessage, StaffMessageState, StaffMessageNextActionOwner } from "../types/staff-message";

export type StaffUpdatesStatus = "idle" | "loading" | "ready" | "error";

const STATE_BADGE_CLASS: Record<StaffMessageState, string> = {
  "Needs You": "border-rose-300 bg-rose-50 text-rose-800",
  Waiting: "border-amber-300 bg-amber-50 text-amber-800",
  "In Progress": "border-sky-300 bg-sky-50 text-sky-800",
  Completed: "border-emerald-300 bg-emerald-50 text-emerald-800",
};

const NEXT_ACTION_LABEL: Record<StaffMessageNextActionOwner, string> = {
  carson: "Carson",
  staff: "Staff",
  owner: "You",
  nobody: "Nobody",
};

export function formatReceivedAt(iso: string, now: Date): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  if (isSameLocalDay(date, now)) return `Received today at ${formatTime(date)}`;
  if (isYesterday(date, now)) return `Received yesterday at ${formatTime(date)}`;
  return `Received ${formatDate(date)} at ${formatTime(date)}`;
}

export interface StaffUpdatesViewProps {
  headerless: boolean;
  status: StaffUpdatesStatus;
  error: string | null;
  messages: StaffMessage[];
  now: Date;
  onRetry: () => void;
}

/** Pure presentational component — no hooks, no data fetching. */
export function StaffUpdatesView({ headerless, status, error, messages, now, onRetry }: StaffUpdatesViewProps) {
  // "idle" is the pre-fetch window while auth is still resolving (the
  // stateful wrapper's reload() early-returns until userId is known) — it
  // must render as loading, not as a premature "nothing needs attention"
  // empty state, or the owner would briefly see a false-truthful message
  // before Carson has actually checked.
  const initialLoading = (status === "loading" || status === "idle") && messages.length === 0;

  return (
    <section className="space-y-3">
      {!headerless && (
        <header>
          <h2 className="text-xs font-medium uppercase tracking-wide text-ink/60">Staff</h2>
        </header>
      )}

      {error && (
        <AuthNotice kind="error">
          {error}{" "}
          <button type="button" onClick={onRetry} className="ml-1 underline">
            Try again
          </button>
        </AuthNotice>
      )}

      {initialLoading && (
        <div className="flex items-center justify-center py-12 text-ink/60">
          <Spinner size={20} label="Loading" />
        </div>
      )}

      {!initialLoading && status !== "error" && messages.length === 0 && (
        <div className="rounded-2xl border border-dashed border-border bg-white/40 px-4 py-6 text-sm text-ink/45">
          No staff messages need your attention.
        </div>
      )}

      {!initialLoading && messages.length > 0 && (
        <ul className="space-y-3">
          {messages.map((message) => (
            <li key={message.id}>
              <StaffMessageCard message={message} now={now} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function StaffMessageCard({ message, now }: { message: StaffMessage; now: Date }) {
  const displayState = getStaffMessageDisplayState(message);

  return (
    <article className="rounded-2xl border border-sage/30 bg-white/85 p-4 shadow-sm">
      <header className="flex items-start justify-between gap-3">
        <span className="text-sm font-medium text-ink">{message.staff_name}</span>
        <span
          className={
            "rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide " +
            STATE_BADGE_CLASS[displayState]
          }
        >
          {displayState}
        </span>
      </header>

      <p className="mt-1 text-[11px] text-ink/40">{formatReceivedAt(message.received_at, now)}</p>

      <p className="mt-2 whitespace-pre-wrap rounded-lg border border-border bg-cream/40 px-3 py-2 text-sm italic text-ink/75">
        "{message.inbound_text}"
      </p>

      {message.carson_response && (
        <p className="mt-2 whitespace-pre-wrap text-sm text-ink/80">
          <span className="font-medium text-ink">Carson replied: </span>
          {message.carson_response}
        </p>
      )}

      {message.owner_attention_required && message.escalation_reason && (
        <div className="mt-2 rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-900">
          <p className="font-medium">Decision needed</p>
          <p className="mt-0.5">{message.escalation_reason}</p>
        </div>
      )}

      {message.task && (
        <p className="mt-2 text-[11px] text-ink/40">Related to: {message.task.description}</p>
      )}

      <p className="mt-2 text-[11px] text-ink/40">Next: {NEXT_ACTION_LABEL[message.next_action_owner]}</p>
    </article>
  );
}

export default function StaffUpdates({ headerless = false }: { headerless?: boolean } = {}) {
  const { user } = useAuth();
  const userId = user?.id ?? null;

  const [messages, setMessages] = useState<StaffMessage[]>([]);
  const [status, setStatus] = useState<StaffUpdatesStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const reloadGenerationRef = useRef(0);

  async function reload() {
    if (!userId) return;
    const generation = ++reloadGenerationRef.current;
    setStatus((s) => (s === "ready" ? "ready" : "loading"));
    setError(null);
    try {
      const loaded = await listStaffMessages();
      if (reloadGenerationRef.current !== generation) return;
      setMessages(loaded);
      setStatus("ready");
    } catch (e) {
      if (reloadGenerationRef.current !== generation) return;
      // A failed fetch here must never break the rest of the attention
      // screen — this component owns and contains its own error state.
      setError(e instanceof Error ? e.message : "Could not load staff messages. Please try again.");
      setStatus("error");
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  return (
    <StaffUpdatesView
      headerless={headerless}
      status={status}
      error={error}
      messages={messages}
      now={new Date()}
      onRetry={() => void reload()}
    />
  );
}
