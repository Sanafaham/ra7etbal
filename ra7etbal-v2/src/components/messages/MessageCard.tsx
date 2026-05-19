import { useState } from "react";
import Spinner from "../Spinner";
import type { Message } from "../../types/message";

interface Props {
  message: Message;
  onDelete: (message: Message) => Promise<unknown>;
}

export default function MessageCard({ message, onDelete }: Props) {
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<null | "all" | "link" | "msg">(null);

  async function copy(text: string, which: "all" | "link" | "msg") {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      window.setTimeout(() => setCopied(null), 1500);
    } catch {
      /* ignore */
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

  const shareablePayload = [message.content, message.confirmation_url]
    .filter((v): v is string => Boolean(v))
    .join("\n\n");

  return (
    <article className="rounded-2xl border border-sage/30 bg-white/85 p-4 shadow-sm">
      <header className="flex items-center justify-between text-xs text-ink/55">
        <span className="font-medium text-ink/80">→ {message.recipient}</span>
        <time>
          {new Date(message.created_at).toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })}
        </time>
      </header>

      <p className="mt-3 text-base italic leading-snug text-ink/85">“{message.content}”</p>

      {message.confirmation_url && (
        <div className="mt-3 space-y-1.5">
          <p className="text-[10px] font-medium uppercase tracking-wide text-ink/50">
            Confirmation link
          </p>
          <div className="flex items-center gap-2 rounded-lg border border-sage/20 bg-cream/40 px-3 py-2">
            <a
              href={message.confirmation_url}
              target="_blank"
              rel="noreferrer"
              className="block flex-1 truncate font-mono text-xs text-ink/80 underline-offset-2 hover:underline"
            >
              {message.confirmation_url}
            </a>
            <button
              type="button"
              onClick={() => void copy(message.confirmation_url!, "link")}
              className="shrink-0 rounded-full border border-sage/30 bg-white px-2.5 py-1 text-[10px] font-medium uppercase tracking-wide text-ink shadow-sm transition hover:bg-cream"
            >
              {copied === "link" ? "Copied ✓" : "Copy"}
            </button>
          </div>
        </div>
      )}

      <footer className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void copy(message.content, "msg")}
          className="rounded-full border border-sage/40 bg-sage px-3 py-1.5 text-xs font-medium text-white shadow-sm transition hover:brightness-105"
        >
          {copied === "msg" ? "Copied ✓" : "Copy message"}
        </button>
        {message.confirmation_url && (
          <button
            type="button"
            onClick={() => void copy(shareablePayload, "all")}
            className="rounded-full border border-sage/30 bg-white px-3 py-1.5 text-xs font-medium text-ink shadow-sm transition hover:bg-cream"
          >
            {copied === "all" ? "Copied ✓" : "Copy message + link"}
          </button>
        )}
        <button
          type="button"
          onClick={remove}
          disabled={busy}
          className="ml-auto inline-flex items-center gap-2 rounded-full border border-rose-200 bg-white px-3 py-1.5 text-xs font-medium text-rose-700 transition hover:bg-rose-50 disabled:opacity-50"
        >
          {busy && <Spinner size={12} />}
          <span>Delete</span>
        </button>
      </footer>
    </article>
  );
}
