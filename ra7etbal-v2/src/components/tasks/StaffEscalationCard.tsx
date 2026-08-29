import { formatDate, formatTime, isSameLocalDay, isYesterday } from "../../lib/reminder-time";
import type { OpenStaffEscalation } from "../../types/staff-message";

/**
 * Phase C — a staff escalation card inside the existing Needs You list.
 * Visual language deliberately matches TaskCard.tsx / the earlier
 * StaffMessageCard (Owner Visibility V1) rather than inventing a new
 * pattern. Read-only except for the one "Review decision" action, which
 * navigates to the secure owner-decision page via deep_link_token — it
 * never answers or resolves the escalation itself.
 */
export function formatEscalationReceivedAt(iso: string, now: Date): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  if (isSameLocalDay(date, now)) return `Received today at ${formatTime(date)}`;
  if (isYesterday(date, now)) return `Received yesterday at ${formatTime(date)}`;
  return `Received ${formatDate(date)} at ${formatTime(date)}`;
}

export interface StaffEscalationCardProps {
  escalation: OpenStaffEscalation;
  now: Date;
}

export default function StaffEscalationCard({ escalation, now }: StaffEscalationCardProps) {
  return (
    <article className="rounded-2xl border border-danger/40 bg-surface p-4 shadow-sm">
      <header className="flex items-start justify-between gap-3">
        <span className="text-sm font-medium text-ink">{escalation.staffName}</span>
        <span className="rounded-full border border-rose-300 bg-rose-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-rose-800">
          Needs You
        </span>
      </header>

      <p className="mt-1 text-[11px] text-ink/40">{formatEscalationReceivedAt(escalation.receivedAt, now)}</p>

      {escalation.escalationReason && (
        <div className="mt-2 rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-900">
          <p className="font-medium">Decision needed</p>
          <p className="mt-0.5">{escalation.escalationReason}</p>
        </div>
      )}

      <p className="mt-2 whitespace-pre-wrap rounded-lg border border-border bg-surface-subtle px-3 py-2 text-sm italic text-text-soft">
        "{escalation.inboundText}"
      </p>

      <a
        href={`/confirm?task=${encodeURIComponent(escalation.deepLinkToken)}`}
        className="mt-3 block w-full rounded-full border border-sage bg-sage px-4 py-2 text-center text-[13px] font-semibold text-white transition active:scale-[0.982]"
      >
        Review decision
      </a>
    </article>
  );
}
