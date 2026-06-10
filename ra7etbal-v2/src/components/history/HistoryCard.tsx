import { useEffect, useState } from "react";
import { getSignedImageUrl } from "../../lib/image-upload";
import type { Task, TaskType } from "../../types/task";

interface Props {
  task: Task;
  message?: { content: string } | null;
}

const TYPE_LABEL: Record<TaskType, string> = {
  action: "Action",
  reminder: "Reminder",
  delegation: "Delegation",
  decision: "Decision",
  followup: "Follow-up",
  errand: "Errand",
  parked: "Parked",
};

/**
 * Read-only history card. No actions. No status toggle. No delete.
 * Just the record of what was coordinated and when.
 */
export default function HistoryCard({ task, message }: Props) {
  const assignedLabel = task.assigned_to ?? "Me";
  const isDone = task.status === "done";
  const isArchivedOnly = !isDone && !!task.archived_at;
  const stamp = task.confirmed_at ?? task.archived_at ?? task.created_at;

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

  return (
    <article className="rounded-2xl border border-sage/20 bg-white/80 p-4 shadow-sm">
      <header className="flex items-center justify-between gap-2 text-xs text-ink/55">
        <span className="font-medium uppercase tracking-wide">
          {TYPE_LABEL[task.type] ?? task.type}
        </span>
        <span>{assignedLabel === "Me" ? "Me" : `→ ${assignedLabel}`}</span>
      </header>

      <p className="mt-2 text-base leading-snug text-ink/85">{task.description}</p>

      {signedImageUrl && (
        <div className="mt-2 space-y-1">
          <p className="text-[10px] font-medium uppercase tracking-wide text-ink/40">
            Reference image
          </p>
          <img
            src={signedImageUrl}
            alt="Reference image attached by owner"
            className="max-h-40 w-full rounded-xl border border-sage/20 object-cover shadow-sm"
          />
        </div>
      )}

      {signedProofImageUrl && (
        <ProofPhotoThumbnail url={signedProofImageUrl} />
      )}

      {message?.content && (
        <p className="mt-2 rounded-lg border border-sage/15 bg-cream/40 px-3 py-2 text-sm italic text-ink/70">
          “{message.content}”
        </p>
      )}

      <footer className="mt-2 flex items-center gap-2 text-[11px] text-ink/55">
        {isDone && (
          <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-800">
            Confirmed done
          </span>
        )}
        {isArchivedOnly && (
          <span className="rounded-full border border-sage/20 bg-cream/60 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink/55">
            Archived
          </span>
        )}
        <span>
          {new Date(stamp).toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })}
        </span>
      </footer>
    </article>
  );
}

function ProofPhotoThumbnail({ url }: { url: string }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <div className="mt-2 space-y-1">
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
            className="max-h-40 w-full object-cover"
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
