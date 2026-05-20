import { useState } from "react";
import Spinner from "../Spinner";
import { copyDelegationMessage } from "../../lib/copy-message";
import type { Message } from "../../types/message";

interface LinkedTaskInfo {
  status: string;
  confirmed_at: string | null;
}

interface Props {
  message: Message;
  /** When the message was sent alongside a delegation task, pass the
   * task's current status so the card can render Waiting vs Confirmed. */
  linkedTask?: LinkedTaskInfo | null;
  onDelete: (message: Message) => Promise<unknown>;
}

export default function MessageCard({ message, linkedTask, onDelete }: Props) {
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const isConfirmed = linkedTask?.status === "done";
  const isWaiting = !!linkedTask && !isConfirmed;
  const hasConfirmLink = !!message.confirmation_url && isWaiting;

  async function copy() {
    try {
      await copyDelegationMessage({
        content: message.content,
        confirmationUrl: hasConfirmLink ? message.confirmation_url : null,
      });
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore — clipboard unsupported */
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
        "rounded-2xl border bg-white/85 p-4 shadow-sm transition " +
        (isConfirmed ? "border-emerald-200" : "border-sage/30")
      }
    >
      <header className="flex items-center justify-between gap-2 text-xs text-ink/55">
        <span className="font-medium text-ink/80">→ {message.recipient}</span>
        <div className="flex items-center gap-2">
          {isConfirmed && (
            <span className="rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-800">
              Confirmed done
            </span>
          )}
          {isWaiting && (
            <span className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-800">
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

      <p className="mt-3 whitespace-pre-wrap text-base italic leading-snug text-ink/85">
        “{message.content}”
      </p>

      {isConfirmed && linkedTask?.confirmed_at && (
        <p className="mt-2 text-xs text-emerald-800">
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
            onClick={() => void copy()}
            className="rounded-full border border-sage/40 bg-sage px-3 py-1.5 text-xs font-medium text-white shadow-sm transition hover:brightness-105"
          >
            {copied ? "Sent ✓" : "Send message"}
          </button>
        )}
        <button
          type="button"
          onClick={() => void remove()}
          disabled={busy}
          className="ml-auto inline-flex items-center gap-2 rounded-full border border-rose-200 bg-white px-3 py-1.5 text-xs font-medium text-rose-700 transition hover:bg-rose-50 disabled:opacity-50"
        >
          {busy && <Spinner size={12} />}
          <span>Delete</span>
        </button>
      </footer>

      {hasConfirmLink && (
        <p className="mt-2 text-[11px] text-ink/55">
          For now, this prepares the message with a Done link. WhatsApp
          auto-send is coming next.
        </p>
      )}
    </article>
  );
}
