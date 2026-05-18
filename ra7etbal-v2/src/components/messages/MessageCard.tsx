import { useState } from "react";
import Spinner from "../Spinner";
import type { Message } from "../../types/message";

interface Props {
  message: Message;
  onDelete: (message: Message) => Promise<unknown>;
}

export default function MessageCard({ message, onDelete }: Props) {
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function copyShareable() {
    const lines = [message.content];
    if (message.confirmation_url) lines.push(message.confirmation_url);
    const payload = lines.join("\n\n");
    try {
      await navigator.clipboard.writeText(payload);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
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

  return (
    <article className="rounded-2xl border border-sage/30 bg-white/85 p-4 shadow-sm">
      <header className="flex items-center justify-between text-xs text-ink/55">
        <span className="font-medium text-ink/80">→ {message.recipient}</span>
        <time>{new Date(message.created_at).toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })}</time>
      </header>

      <p className="mt-3 text-base italic leading-snug text-ink/85">“{message.content}”</p>

      <footer className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={copyShareable}
          className="rounded-full border border-sage/40 bg-sage px-3 py-1.5 text-xs font-medium text-white shadow-sm transition hover:brightness-105"
        >
          {copied ? "Copied ✓" : message.confirmation_url ? "Copy message + link" : "Copy message"}
        </button>
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
