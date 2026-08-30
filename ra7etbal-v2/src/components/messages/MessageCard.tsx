import { useState } from "react";
import Spinner from "../Spinner";
import { openWhatsAppMessage, sendWhatsAppTask } from "../../lib/whatsapp";
import type { Message } from "../../types/message";

interface LinkedTaskInfo {
  status: string;
  confirmed_at: string | null;
  confirmation_url?: string | null;
}

interface Props {
  message: Message;
  /** When the message was sent alongside a delegation task, pass the
   * task's current status so the card can render Waiting vs Confirmed. */
  linkedTask?: LinkedTaskInfo | null;
  recipientPhone?: string | null;
  onDelete: (message: Message) => Promise<unknown>;
}

export default function MessageCard({
  message,
  linkedTask,
  recipientPhone,
  onDelete,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const isConfirmed = linkedTask?.status === "done";
  const isWaiting = !!linkedTask && !isConfirmed;
  const confirmationUrl =
    message.confirmation_url ?? linkedTask?.confirmation_url ?? null;
  const hasConfirmLink = !!confirmationUrl && !isConfirmed;

  async function send() {
    if (busy) return;
    setBusy(true);
    try {
      await sendWhatsAppTask({
        to: recipientPhone ?? null,
        messageText: message.content,
        confirmationLink: hasConfirmLink ? confirmationUrl : null,
        messageRecordId: message.id,
        taskId: message.task_id,
        recipientName: message.recipient,
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
        confirmationUrl: hasConfirmLink ? confirmationUrl : null,
        phone: recipientPhone,
      });
      if (opened) {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      }
    } finally {
      setBusy(false);
    }
  }

  function openManualFallback() {
    const opened = openWhatsAppMessage({
      content: message.content,
      confirmationUrl: hasConfirmLink ? confirmationUrl : null,
      phone: recipientPhone,
    });
    if (opened) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
  }

  async function remove() {
    if (busy) return;
    setBusy(true);
    try {
      await onDelete(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <article
      className={
        "rounded-2xl border bg-surface/90 p-4 shadow-sm transition " +
        (isConfirmed ? "border-gold" : "border-border")
      }
    >
      <header className="flex items-center justify-between gap-2 text-xs text-text-soft">
        <span className="font-medium text-ink">→ {message.recipient}</span>
        <div className="flex items-center gap-2">
          {isConfirmed && (
            <span className="rounded-full border border-gold bg-gold px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-cream">
              Confirmed done
            </span>
          )}
          {isWaiting && (
            <span className="rounded-full border border-gold bg-gold px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-cream">
              Waiting for confirmation
            </span>
          )}
          <time>
            {new Date(message.created_at).toLocaleString(undefined, {
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })}
          </time>
        </div>
      </header>

      <p className="mt-3 whitespace-pre-wrap text-base italic leading-snug text-ink">
        “{message.content}”
      </p>

      {isConfirmed && linkedTask?.confirmed_at && (
        <p className="mt-2 text-xs text-gold">
          Confirmed on{" "}
          {new Date(linkedTask.confirmed_at).toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })}
          .
        </p>
      )}

      <footer className="mt-3 flex flex-wrap items-center gap-2">
        {!isConfirmed && (
          <button
            type="button"
            onClick={() => void send()}
            disabled={busy}
            className="rounded-full border border-sage/40 bg-sage px-3 py-1.5 text-xs font-medium text-white shadow-sm transition hover:brightness-105"
          >
            {busy ? "Sending…" : copied ? "Sent ✓" : "Send message"}
          </button>
        )}
        <button
          type="button"
          onClick={() => void remove()}
          disabled={busy}
          className="ml-auto inline-flex items-center gap-2 rounded-full border border-danger/35 bg-surface-subtle px-3 py-1.5 text-xs font-medium text-danger transition hover:bg-danger/10 disabled:opacity-50"
        >
          {busy && <Spinner size={12} />}
          <span>Delete</span>
        </button>
      </footer>

      {hasConfirmLink && (
        <p className="mt-2 text-[11px] text-ink">
          Sent through Ra7etBal WhatsApp. The task stays open until they tap
          Done.
          <button
            type="button"
            onClick={openManualFallback}
            className="ml-1 underline underline-offset-2"
          >
            Manual fallback
          </button>
        </p>
      )}
    </article>
  );
}
