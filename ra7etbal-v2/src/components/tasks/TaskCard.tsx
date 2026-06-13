import { useEffect, useState } from "react";
import Spinner from "../Spinner";
import { getSignedImageUrl } from "../../lib/image-upload";
import {
  formatReminderDue,
  formatReminderDueTime,
  isReminderOverdue,
} from "../../lib/reminder-time";
import { openWhatsAppMessage, sendWhatsAppTask } from "../../lib/whatsapp";
import type { Task, TaskType } from "../../types/task";

interface Props {
  task: Task;
  /** Linked message for delegations, if present. */
  message?: { content: string } | null;
  recipientPhone?: string | null;
  now?: Date;
  onToggleDone: (task: Task) => Promise<unknown>;
  onDelete: (task: Task) => Promise<unknown>;
}

const TYPE_META: Record<TaskType, { label: string; cls: string }> = {
  action: { label: "Action", cls: "bg-sage/15 text-sage border-sage/30" },
  reminder: { label: "Reminder", cls: "bg-amber-100 text-amber-900 border-amber-300" },
  delegation: { label: "Delegation", cls: "bg-emerald-100 text-emerald-900 border-emerald-300" },
  decision: { label: "Decision", cls: "bg-violet-100 text-violet-900 border-violet-300" },
  followup: { label: "Follow-up", cls: "bg-rose-100 text-rose-900 border-rose-300" },
  errand: { label: "Errand", cls: "bg-teal-100 text-teal-900 border-teal-300" },
  parked: { label: "Parked", cls: "bg-stone-100 text-stone-700 border-stone-300" },
};

export default function TaskCard({
  task,
  message,
  recipientPhone,
  now,
  onToggleDone,
  onDelete,
}: Props) {
  const type = TYPE_META[task.type] ?? TYPE_META.action;
  const [busy, setBusy] = useState<"done" | "delete" | "send" | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [copied, setCopied] = useState(false);
  const [signedImageUrl, setSignedImageUrl] = useState<string | null>(null);
  const [signedProofImageUrl, setSignedProofImageUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!task.image_path) return;
    let cancelled = false;
    void getSignedImageUrl(task.image_path).then((url) => {
      if (!cancelled) setSignedImageUrl(url);
    });
    return () => { cancelled = true; };
  }, [task.image_path]);

  useEffect(() => {
    if (!task.proof_image_path) return;
    let cancelled = false;
    void getSignedImageUrl(task.proof_image_path).then((url) => {
      if (!cancelled) setSignedProofImageUrl(url);
    });
    return () => { cancelled = true; };
  }, [task.proof_image_path]);
  const isDone = task.status === "done";
  const isWaitingDelegation = task.type === "delegation" && !isDone;
  const hasConfirmLink = !!task.confirmation_url && isWaitingDelegation;
  const reminderDue = task.type === "reminder" ? getReminderDue(task.due_at, isDone, now) : null;

  async function toggle() {
    if (busy) return;
    setBusy("done");
    try {
      await onToggleDone(task);
    } finally {
      setBusy(null);
    }
  }

  function armDelete() {
    if (busy) return;
    if (confirmingDelete) {
      // Second tap — execute immediately.
      void executeDelete();
      return;
    }
    setConfirmingDelete(true);
    window.setTimeout(() => setConfirmingDelete(false), 3000);
  }

  async function executeDelete() {
    setConfirmingDelete(false);
    setBusy("delete");
    try {
      await onDelete(task);
    } finally {
      setBusy(null);
    }
  }

  async function send() {
    if (!message?.content) return;
    if (busy) return;
    setBusy("send");
    try {
      await sendWhatsAppTask({
        to: recipientPhone ?? null,
        messageText: message.content,
        confirmationLink: hasConfirmLink ? task.confirmation_url : null,
        taskId: task.id,
        recipientName: task.assigned_to,
        imagePath: task.image_path ?? null,
      });
      window.alert("Sent through Ra7etBal WhatsApp.");
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      const messageText =
        err instanceof Error ? err.message : "Could not send WhatsApp message.";
      window.alert(
        `WhatsApp send failed: ${messageText}. Opening manual fallback.`,
      );
      const opened = openWhatsAppMessage({
        content: message.content,
        confirmationUrl: hasConfirmLink ? task.confirmation_url : null,
        phone: recipientPhone,
      });
      if (opened) {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      }
    } finally {
      setBusy(null);
    }
  }

  const assignedLabel = task.assigned_to ?? "Me";

  return (
    <article
      className={
        "rounded-2xl border bg-white/85 p-4 shadow-sm transition " +
        (isDone ? "border-sage/15 opacity-70" : "border-sage/30")
      }
    >
      <header className="flex items-start justify-between gap-3">
        <span
          className={
            "rounded-full border px-2.5 py-0.5 text-xs font-medium uppercase tracking-wide " +
            type.cls
          }
        >
          {type.label}
        </span>
        <div className="flex items-center gap-2 text-xs text-ink/55">
          {isWaitingDelegation && task.confirmation_url && (
            <span className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-800">
              Waiting for confirmation
            </span>
          )}
          {isDone && task.type === "delegation" && (
            <span className="rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-800">
              Confirmed done
            </span>
          )}
          {reminderDue?.overdue && (
            <span className="rounded-full border border-rose-300 bg-rose-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-rose-800">
              Overdue
            </span>
          )}
         {(task.type === "followup" || task.type === "delegation") &&
  task.created_at && (
    <span className="text-[11px] text-ink/45">
      {formatFollowUpSentTime(task.created_at)}
    </span>
  )}
          <span>{assignedLabel === "Me" ? "Me" : `→ ${assignedLabel}`}</span>
        </div>
      </header>

      <p
        className={
          "mt-3 text-base leading-snug " +
          (isDone ? "text-ink/55 line-through" : "text-ink")
        }
      >
        {task.description}
      </p>

      {signedImageUrl && (
        <div className="mt-3 space-y-1">
          <p className="text-[10px] font-medium uppercase tracking-wide text-ink/40">
            Reference image
          </p>
          <img
            src={signedImageUrl}
            alt="Reference image attached by owner"
            className="max-h-48 w-full rounded-xl border border-sage/20 object-cover shadow-sm"
          />
        </div>
      )}

      {signedProofImageUrl && (
        <ProofPhotoThumbnail url={signedProofImageUrl} />
      )}

      {message?.content && (
        <p className="mt-2 whitespace-pre-wrap rounded-lg border border-sage/15 bg-cream/40 px-3 py-2 text-sm italic text-ink/75">
          "{message.content}"
        </p>
      )}

      {reminderDue && !isDone && (
        <div className="mt-2 space-y-0.5 text-xs font-medium">
          <p className={reminderDue.overdue ? "text-rose-800" : "text-amber-900"}>
            {reminderDue.dueTime}
          </p>
          {/* Only show label when it adds relative countdown/overdue info not
              already expressed by dueTime (e.g. "Due in 5 minutes", "Overdue by
              2 hours"). For absolute future times the label duplicates dueTime. */}
          {(reminderDue.label.startsWith("Due in") ||
            reminderDue.label.startsWith("Overdue")) && (
            <p className={reminderDue.overdue ? "text-rose-800" : "text-amber-900"}>
              {reminderDue.label}
            </p>
          )}
        </div>
      )}

      <footer className="mt-3 flex flex-wrap items-center gap-2">
        {message?.content && !isDone && (
          // Primary action for waiting delegations.
          <button
            type="button"
            onClick={() => void send()}
            disabled={!!busy}
            className="inline-flex items-center gap-2 rounded-full border border-sage/40 bg-sage px-3 py-1.5 text-xs font-medium text-white shadow-sm transition hover:brightness-105"
          >
            {busy === "send" ? "Sending…" : copied ? "Sent ✓" : "Send message"}
          </button>
        )}

        {/* Inline toggle only when this is NOT a waiting delegation.
            For waiting delegations the manual override is tucked into
            the Manual options disclosure below — it shouldn't compete
            with Send message as an equal action. */}
        {!isWaitingDelegation && (
          <button
            type="button"
            onClick={() => void toggle()}
            disabled={!!busy}
            className={
              "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium shadow-sm transition disabled:opacity-50 " +
              (isDone
                ? "border-sage/30 bg-white text-ink hover:bg-cream"
                : "border-sage/40 bg-sage text-white hover:brightness-105")
            }
          >
            {busy === "done" && <Spinner size={12} />}
            <span>{isDone ? "Reopen" : "Mark done"}</span>
          </button>
        )}

        <button
          type="button"
          onClick={armDelete}
          disabled={!!busy}
          className={
            "ml-auto inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition disabled:opacity-50 " +
            (confirmingDelete
              ? "border-rose-500 bg-rose-500 text-white"
              : "border-rose-200 bg-white text-rose-700 hover:bg-rose-50")
          }
        >
          {busy === "delete" && <Spinner size={12} />}
          <span>{confirmingDelete ? "Tap to confirm" : "Delete"}</span>
        </button>
      </footer>

      {/* Calm forward-looking helper under Send. */}
      {isWaitingDelegation && message?.content && (
        <p className="mt-2 text-[11px] leading-snug text-ink/55">
          Sent through Ra7etBal WhatsApp. The task stays open until they tap
          Done.
        </p>
      )}

      {/* Manual override hidden behind a small disclosure so it doesn't
          sit beside Send message as an equal action. */}
      {isWaitingDelegation && (
        <details className="mt-2 text-xs text-ink/55">
          <summary className="cursor-pointer select-none text-[11px] text-ink/55 transition hover:text-ink/80">
            Manual options
          </summary>
          <div className="mt-2 flex flex-col gap-1.5">
            <button
              type="button"
              onClick={() => void toggle()}
              disabled={!!busy}
              className="inline-flex w-fit items-center gap-2 rounded-full border border-sage/30 bg-white px-3 py-1.5 text-xs font-medium text-ink shadow-sm transition hover:bg-cream disabled:opacity-50"
            >
              {busy === "done" && <Spinner size={12} />}
              <span>Mark done manually</span>
            </button>
            <p className="text-[11px] italic text-ink/45">
              Use only if confirmed outside the app.
            </p>
          </div>
        </details>
      )}
    </article>
  );
}

function formatFollowUpSentTime(createdAt: string): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return "";
  return (
    "Sent " +
    new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(date)
  );
}

/**
 * Proof photo thumbnail with tap-to-fullscreen lightbox.
 * Renders a green-labelled thumbnail; tapping opens a full-screen overlay
 * with the image and a close button. Closes on overlay click or × button.
 */
function ProofPhotoThumbnail({ url }: { url: string }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <div className="mt-3 space-y-1">
        <p className="text-[10px] font-medium uppercase tracking-wide text-emerald-700/70">
          Proof photo
        </p>
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="View proof photo full screen"
          className="block w-full overflow-hidden rounded-xl border border-emerald-200 shadow-sm transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
        >
          <img
            src={url}
            alt="Proof photo from recipient"
            className="max-h-48 w-full object-cover"
          />
        </button>
      </div>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Proof photo"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setOpen(false)}
        >
          {/* Close button */}
          <button
            type="button"
            aria-label="Close proof photo"
            onClick={(e) => { e.stopPropagation(); setOpen(false); }}
            className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full bg-white/15 text-white transition hover:bg-white/25"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>

          {/* Image — stopPropagation so clicking the image itself doesn't close */}
          <img
            src={url}
            alt="Proof photo full size"
            className="max-h-[90dvh] max-w-full rounded-xl object-contain shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  );
}

function getReminderDue(
  value: string | null,
  isDone: boolean,
  now = new Date(),
): { dueTime: string; label: string; overdue: boolean } | null {
  const dueTime = formatReminderDueTime(value, now);
  const label = formatReminderDue(value, now);
  if (!dueTime || !label) return null;
  return {
    dueTime,
    label,
    overdue: !isDone && isReminderOverdue(value, now),
  };
}
