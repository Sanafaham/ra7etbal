import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import AuthNotice from "../components/auth/AuthNotice";
import Spinner from "../components/Spinner";
import { resizeImage } from "../lib/image-upload";

/**
 * Recipient-facing confirmation page.
 *
 * Reached via the link the host shares (`/confirm?task=<id>`). The recipient
 * does NOT sign in — `/api/get-confirm-task` and `/api/confirm-task` use the
 * Supabase service role on the server to read/write a single task by id, so
 * no public RLS policy on the tasks table is required.
 *
 * Visual Verification V2:
 * - Owner's Reference image is shown if attached (image_path).
 * - Recipient can attach a Proof photo before marking done.
 * - Proof photo is uploaded via a server-issued signed upload URL.
 * - proof_image_path is saved atomically with the confirmation PATCH.
 */

interface TaskInfo {
  id: string;
  description: string;
  assignedTo: string | null;
  status: "pending" | "done" | "cancelled" | string;
  confirmedAt: string | null;
  ownerPhone: string | null;
  /** Signed URL for the owner's reference image (single-photo tasks). Null when none. */
  imageUrl: string | null;
  /** Signed URLs for all attached photos (multi-photo tasks). Empty for single/no photo tasks. */
  attachmentUrls: string[];
  /** Signed URL for an already-uploaded proof photo. Null until recipient uploads. */
  proofImageUrl: string | null;
  /** Signed upload URL for the recipient to PUT a proof photo. Null when already done. */
  proofUploadUrl: string | null;
  /** Storage path to save as proof_image_path after successful upload. */
  proofUploadPath: string | null;
}

export default function Confirm() {
  const [params] = useSearchParams();
  const taskId = params.get("task");

  const [info, setInfo] = useState<TaskInfo | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);

  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const confirmedRef = useRef(false);
  const [outcome, setOutcome] = useState<"approved" | "correction_required" | "uncertain" | null>(null);
  const [correctionDelivered, setCorrectionDelivered] = useState<boolean | null>(null);

  // Proof photo state
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [proofFile, setProofFile] = useState<File | null>(null);
  const [proofPreviewUrl, setProofPreviewUrl] = useState<string | null>(null);
  const [proofUploading, setProofUploading] = useState(false);
  const [proofError, setProofError] = useState<string | null>(null);

  // Revoke object URL on cleanup / file change
  useEffect(() => {
    if (!proofFile) return;
    const url = URL.createObjectURL(proofFile);
    setProofPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [proofFile]);

  useEffect(() => {
    if (!taskId) {
      setLoadState("error");
      setLoadError("Missing task id in the link.");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/task-confirm?taskId=${encodeURIComponent(taskId)}`);
        const data = (await res.json()) as Partial<TaskInfo> & { error?: string };
        if (cancelled) return;
        if (!res.ok || !data.id) {
          setLoadState("error");
          setLoadError(data.error || "Could not find that task.");
          return;
        }
        setInfo({
          id: data.id,
          description: data.description ?? "",
          assignedTo: data.assignedTo ?? null,
          status: data.status ?? "pending",
          confirmedAt: data.confirmedAt ?? null,
          ownerPhone: data.ownerPhone ?? null,
          imageUrl: data.imageUrl ?? null,
          attachmentUrls: Array.isArray(data.attachmentUrls) ? data.attachmentUrls : [],
          proofImageUrl: data.proofImageUrl ?? null,
          proofUploadUrl: data.proofUploadUrl ?? null,
          proofUploadPath: data.proofUploadPath ?? null,
        });
        setLoadState("ready");
      } catch (err) {
        if (cancelled) return;
        setLoadState("error");
        setLoadError(
          err instanceof TypeError
            ? "Network issue. Please check your connection."
            : "Could not load that task.",
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    setProofFile(file);
    setProofError(null);
    // Reset input value so the same file can be reselected after removal
    e.target.value = "";
  }

  function removeProofPhoto() {
    setProofFile(null);
    setProofError(null);
  }

  async function handleConfirm() {
    if (!taskId || confirmedRef.current || confirming || !info) return;
    confirmedRef.current = true;
    setConfirming(true);
    setConfirmError(null);

    let savedProofPath: string | null = null;

    // Upload proof photo first if one was selected
    if (proofFile && info.proofUploadUrl && info.proofUploadPath) {
      try {
        setProofUploading(true);
        const blob = await resizeImage(proofFile);
        const uploadRes = await fetch(info.proofUploadUrl, {
          method: "PUT",
          headers: { "Content-Type": "image/jpeg" },
          body: blob,
        });
        if (!uploadRes.ok) {
          throw new Error(`Upload failed (${uploadRes.status})`);
        }
        savedProofPath = info.proofUploadPath;
      } catch (err) {
        setProofUploading(false);
        setProofError(
          err instanceof Error
            ? err.message
            : "Could not upload proof photo. You can still mark done without it.",
        );
        confirmedRef.current = false;
        setConfirming(false);
        return;
      } finally {
        setProofUploading(false);
      }
    }

    try {
      const res = await fetch("/api/task-confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskId,
          ...(savedProofPath ? { proofImagePath: savedProofPath } : {}),
        }),
      });
      const data = (await res.json()) as {
        success?: boolean;
        already_done?: boolean;
        error?: string;
        outcome?: "approved" | "correction_required" | "uncertain";
        correctionDelivered?: boolean | null;
      };
      if (!res.ok || data.error) {
        setConfirmError(data.error || "Could not confirm. Please try again.");
        confirmedRef.current = false;
        return;
      }

      // already_done always means approved in a prior submission.
      const resolvedOutcome = data.already_done ? "approved" : data.outcome ?? "approved";
      setOutcome(resolvedOutcome);
      setCorrectionDelivered(data.correctionDelivered ?? null);

      // Quality Intelligence V1 — only an "approved" outcome marks the task
      // done. correction_required / uncertain leave it pending so the
      // recipient can submit a new proof photo next time they open this link.
      setInfo((prev) =>
        prev
          ? {
              ...prev,
              status: resolvedOutcome === "approved" ? "done" : prev.status,
              confirmedAt: resolvedOutcome === "approved" ? new Date().toISOString() : prev.confirmedAt,
              // Show local proof preview as the submitted proof url
              proofImageUrl: proofPreviewUrl ?? prev.proofImageUrl,
            }
          : prev,
      );
      if (resolvedOutcome !== "approved") {
        // Allow another submission attempt on this same visit.
        confirmedRef.current = false;
        setProofFile(null);
      }
    } catch (err) {
      confirmedRef.current = false;
      setConfirmError(
        err instanceof TypeError
          ? "Network issue. Please check your connection."
          : "Could not confirm. Please try again.",
      );
    } finally {
      setConfirming(false);
    }
  }

  const isBusy = confirming || proofUploading;

  return (
    <section className="mx-auto max-w-md space-y-5 rounded-2xl border border-sage/30 bg-white/85 p-6 shadow-sm">
      <header className="space-y-1">
        <p className="text-xs font-medium uppercase tracking-wide text-ink/50">
          Ra7etBal · راحة بال
        </p>
        <h1 className="text-2xl font-semibold text-ink">Task confirmation</h1>
      </header>

      {loadState === "loading" && (
        <div className="flex items-center justify-center py-6 text-ink/60">
          <Spinner size={20} label="Loading task" />
        </div>
      )}

      {loadState === "error" && (
        <AuthNotice kind="error">{loadError ?? "Could not load that task."}</AuthNotice>
      )}

      {loadState === "ready" && info && (
        <>
          <div className="space-y-3">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-ink/50">Task</p>
              <p className="mt-1 text-base leading-snug text-ink">{info.description}</p>
              {info.assignedTo && (
                <p className="mt-0.5 text-sm text-ink/55">For: {info.assignedTo}</p>
              )}
            </div>

            {/* Reference photos — multi-photo grid or single image */}
            {info.attachmentUrls.length > 0 ? (
              <div className="space-y-1">
                <p className="text-xs font-medium uppercase tracking-wide text-ink/45">
                  Reference photos ({info.attachmentUrls.length})
                </p>
                <div className={info.attachmentUrls.length === 1 ? "" : "grid grid-cols-2 gap-2"}>
                  {info.attachmentUrls.map((url, i) => (
                    <img
                      key={i}
                      src={url}
                      alt={`Reference photo ${i + 1}`}
                      className="w-full rounded-xl border border-sage/20 object-cover shadow-sm aspect-square"
                    />
                  ))}
                </div>
              </div>
            ) : info.imageUrl ? (
              <div className="space-y-1">
                <p className="text-xs font-medium uppercase tracking-wide text-ink/45">
                  Reference image
                </p>
                <img
                  src={info.imageUrl}
                  alt="Reference image attached by owner"
                  className="max-h-56 w-full rounded-xl border border-sage/20 object-cover shadow-sm"
                />
              </div>
            ) : null}

            {/* Proof photo — uploaded by recipient, shown after confirmation */}
            {info.status === "done" && info.proofImageUrl && (
              <div className="space-y-1">
                <p className="text-xs font-medium uppercase tracking-wide text-ink/45">
                  Proof photo
                </p>
                <img
                  src={info.proofImageUrl}
                  alt="Proof photo from recipient"
                  className="max-h-56 w-full rounded-xl border border-emerald-200 object-cover shadow-sm"
                />
              </div>
            )}
          </div>

          {info.status === "done" ? (
            <div className="space-y-3">
              <AuthNotice kind="success">Marked as done.</AuthNotice>
            </div>
          ) : outcome === "uncertain" ? (
            <div className="space-y-3">
              <AuthNotice kind="success">
                Thanks — this has been sent to the owner for a quick review.
              </AuthNotice>
            </div>
          ) : (
            <>
              {/* Quality Intelligence V1 — task stayed open; a new proof photo is needed */}
              {outcome === "correction_required" && (
                <AuthNotice kind="error">
                  {correctionDelivered === false
                    ? "The correction message was not delivered. I can try again — attach a new photo below to retry."
                    : "A quick correction is needed — check WhatsApp for details, then attach a new photo below."}
                </AuthNotice>
              )}

              {/* Proof photo section — shown before Mark done */}
              <div className="space-y-2">
                <p className="text-xs font-medium uppercase tracking-wide text-ink/50">
                  Proof photo
                  <span className="ml-1 normal-case text-ink/35">(optional)</span>
                </p>

                {proofFile && proofPreviewUrl ? (
                  <div className="space-y-2">
                    <div className="relative">
                      <img
                        src={proofPreviewUrl}
                        alt="Proof photo preview"
                        className="max-h-48 w-full rounded-xl border border-sage/25 object-cover shadow-sm"
                      />
                      <button
                        type="button"
                        onClick={removeProofPhoto}
                        disabled={isBusy}
                        aria-label="Remove proof photo"
                        className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full bg-ink/60 text-white shadow transition hover:bg-ink/80 disabled:opacity-50"
                      >
                        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                          <line x1="1" y1="1" x2="11" y2="11" />
                          <line x1="11" y1="1" x2="1" y2="11" />
                        </svg>
                      </button>
                    </div>
                    <p className="text-xs text-ink/50">
                      Photo ready. Tap Mark done to send.
                    </p>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isBusy}
                    className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-sage/40 bg-cream/40 px-4 py-3 text-sm text-ink/60 transition hover:border-sage/60 hover:bg-cream/60 disabled:opacity-50"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="3" width="18" height="18" rx="2" />
                      <circle cx="8.5" cy="8.5" r="1.5" />
                      <path d="M21 15l-5-5L5 21" />
                    </svg>
                    Attach proof photo
                  </button>
                )}

                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleFileChange}
                  className="sr-only"
                  aria-label="Attach proof photo"
                />

                {proofError && (
                  <p className="text-xs text-rose-700">{proofError}</p>
                )}
              </div>

              {confirmError && <AuthNotice kind="error">{confirmError}</AuthNotice>}

              <button
                type="button"
                onClick={() => void handleConfirm()}
                disabled={isBusy}
                aria-busy={isBusy}
                className="flex w-full items-center justify-center gap-2 rounded-full bg-sage px-5 py-3 text-base font-medium text-white shadow-sm transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isBusy && <Spinner size={16} />}
                <span>
                  {proofUploading
                    ? "Uploading photo…"
                    : confirming
                      ? "Confirming…"
                      : proofFile
                        ? "Mark done with proof"
                        : "Mark done"}
                </span>
              </button>
            </>
          )}
        </>
      )}
    </section>
  );
}
