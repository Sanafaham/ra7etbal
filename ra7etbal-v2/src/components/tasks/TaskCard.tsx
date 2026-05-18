import { useState } from "react";
import Spinner from "../Spinner";
import type { Task, TaskType } from "../../types/task";

interface Props {
  task: Task;
  /** Linked message for delegations, if present. */
  message?: { content: string } | null;
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

export default function TaskCard({ task, message, onToggleDone, onDelete }: Props) {
  const type = TYPE_META[task.type] ?? TYPE_META.action;
  const [busy, setBusy] = useState<"done" | "delete" | null>(null);
  const [copied, setCopied] = useState(false);
  const isDone = task.status === "done";

  async function toggle() {
    if (busy) return;
    setBusy("done");
    try {
      await onToggleDone(task);
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (busy) return;
    setBusy("delete");
    try {
      await onDelete(task);
    } finally {
      setBusy(null);
    }
  }

  async function copyShareable() {
    const lines: string[] = [];
    if (message?.content) lines.push(message.content);
    if (task.confirmation_url) lines.push(task.confirmation_url);
    const payload = lines.join("\n\n");
    if (!payload) return;
    try {
      await navigator.clipboard.writeText(payload);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore — older browsers without clipboard API. */
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
        <span className="text-xs text-ink/55">
          {assignedLabel === "Me" ? "Me" : `→ ${assignedLabel}`}
        </span>
      </header>

      <p
        className={
          "mt-3 text-base leading-snug " +
          (isDone ? "text-ink/55 line-through" : "text-ink")
        }
      >
        {task.description}
      </p>

      {message?.content && (
        <p className="mt-2 rounded-lg border border-sage/15 bg-cream/40 px-3 py-2 text-sm italic text-ink/75">
          “{message.content}”
        </p>
      )}

      <footer className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={toggle}
          disabled={!!busy}
          className={
            "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium shadow-sm transition disabled:opacity-50 " +
            (isDone
              ? "border-sage/30 bg-white text-ink hover:bg-cream"
              : "border-sage/40 bg-sage text-white hover:brightness-105")
          }
        >
          {busy === "done" && <Spinner size={12} />}
          <span>{isDone ? "Mark pending" : "Mark done"}</span>
        </button>

        {task.confirmation_url && (
          <button
            type="button"
            onClick={copyShareable}
            className="rounded-full border border-sage/30 bg-white px-3 py-1.5 text-xs font-medium text-ink shadow-sm transition hover:bg-cream"
          >
            {copied ? "Copied ✓" : "Copy message + link"}
          </button>
        )}

        <button
          type="button"
          onClick={remove}
          disabled={!!busy}
          className="ml-auto inline-flex items-center gap-2 rounded-full border border-rose-200 bg-white px-3 py-1.5 text-xs font-medium text-rose-700 transition hover:bg-rose-50 disabled:opacity-50"
        >
          {busy === "delete" && <Spinner size={12} />}
          <span>Delete</span>
        </button>
      </footer>
    </article>
  );
}
