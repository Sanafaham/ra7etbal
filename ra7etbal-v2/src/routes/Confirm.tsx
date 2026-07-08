import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import AuthNotice from "../components/auth/AuthNotice";
import Spinner from "../components/Spinner";
import { resizeImage } from "../lib/image-upload";

/**
 * Recipient-facing confirmation page.
 *
 * Reached via the link the host shares (`/confirm?task=<id>`). The recipient
 * does NOT sign in — `/api/task-confirm` uses the Supabase service role on
 * the server to read/write a single task by id, so no public RLS policy on
 * the tasks table is required.
 *
 * Visual Verification V2 / Proof Photo V2:
 * - Owner's Reference photo(s) are shown if attached (image_path or
 *   task_attachments).
 * - Recipient can attach up to 5 Proof photos before marking done.
 * - Each proof photo is uploaded via its own server-issued signed upload URL.
 * - proofImagePaths is saved atomically with the confirmation PATCH.
 * - If Quality Intelligence rejects the submission, the recipient can attach
 *   corrected photos and resubmit — this re-runs the review.
 */

const MAX_PROOF_PHOTOS = 5;
const PROOF_LIMIT_MESSAGE = "You can attach up to 5 photos.";

interface ProofUploadSlot {
  index: number;
  uploadUrl: string;
  storagePath: string;
}

interface ProofPhoto {
  id: string;
  file: File;
  previewUrl: string;
}

interface TaskInfo {
  id: string;
  description: string;
  assignedTo: string | null;
  status: "pending" | "done" | "cancelled" | string;
  confirmedAt: string | null;
  ownerPhone: string | null;
  /** Signed URL for the owner's reference image (single-photo tasks). Null when none. */
  imageUrl: string | null;
  /** Signed URLs for all attached reference photos (multi-photo tasks). Empty for single/no photo tasks. */
  attachmentUrls: string[];
  /** Signed URLs for already-submitted proof photos (0-5). */
  proofImageUrls: string[];
  /** Fresh signed upload slots for the next submission. Empty when already done. */
  proofUploadSlots: ProofUploadSlot[];
  /** True when a delegated task has reference photo(s) and needs proof before completion. */
  proofRequired: boolean;
  /**
   * Persisted outcome of Carson's automated proof review (server source of
   * truth). Rehydrated into `outcome` state on every load so reopening the
   * confirmation link after an uncertain review shows the locked "sent to
   * owner" state instead of the upload form again. Operational rejection
   * states still show the upload form so Carson can collect a corrected proof.
   */
  qualityReviewStatus: "approved" | "correction_required" | "uncertain" | "fraud_suspected" | null;
  qualityReviewNote: string | null;
}

export default function Confirm() {
  const [params] = useSearchParams();
  // `task` is canonical; `task_id` keeps legacy routine/automation links working.
  const taskId = params.get("task") ?? params.get("task_id");

  const [info, setInfo] = useState<TaskInfo | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);

  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const confirmedRef = useRef(false);
  const [outcome, setOutcome] = useState<"approved" | "correction_required" | "uncertain" | "fraud_suspected" | null>(null);
  const [correctionNote, setCorrectionNote] = useState<string | null>(null);

  // Proof photo state — mirrors the reference-photo PendingPhoto[] pattern
  // (ElevenLabsAgentWidget.tsx): accumulate up to MAX_PROOF_PHOTOS, remove
  // any, block overflow with a clear message.
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [proofPhotos, setProofPhotos] = useState<ProofPhoto[]>([]);
  const [proofLimitWarning, setProofLimitWarning] = useState<string | null>(null);
  const [proofUploading, setProofUploading] = useState(false);
  const [proofError, setProofError] = useState<string | null>(null);

  // Revoke preview object URLs on unmount.
  useEffect(() => {
    return () => {
      for (const photo of proofPhotos) URL.revokeObjectURL(photo.previewUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
          proofImageUrls: Array.isArray(data.proofImageUrls) ? data.proofImageUrls : [],
          proofUploadSlots: Array.isArray(data.proofUploadSlots) ? data.proofUploadSlots : [],
          proofRequired: data.proofRequired === true,
          qualityReviewStatus: data.qualityReviewStatus ?? null,
          qualityReviewNote: data.qualityReviewNote ?? null,
        });
        // Rehydrate the review outcome from the server so a fresh page
        // load/reopen reflects the persisted state — see qualityReviewStatus
        // above. Without this, `outcome` only ever came from a submission
        // made during the same page visit, so reopening the link after an
        // uncertain result lost the locked view and showed
        // the upload form again (the original bug).
        if (data.qualityReviewStatus) {
          setOutcome(data.qualityReviewStatus);
          setCorrectionNote(data.qualityReviewNote ?? null);
        }
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
    const incoming = Array.from(e.target.files ?? []);
    e.target.value = ""; // allow reselecting same files
    if (incoming.length === 0) return;

    setProofPhotos((prev) => {
      const availableSlots = Math.max(0, MAX_PROOF_PHOTOS - prev.length);
      const accepted = incoming.slice(0, availableSlots);
      setProofLimitWarning(incoming.length > accepted.length ? PROOF_LIMIT_MESSAGE : null);
      if (accepted.length === 0) return prev;
      const added: ProofPhoto[] = accepted.map((file) => ({
        id: crypto.randomUUID(),
        file,
        previewUrl: URL.createObjectURL(file),
      }));
      return [...prev, ...added];
    });
    setProofError(null);
  }

  function removeProofPhoto(id: string) {
    setProofPhotos((prev) => {
      const removed = prev.find((p) => p.id === id);
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      return prev.filter((p) => p.id !== id);
    });
    setProofLimitWarning(null);
    setProofError(null);
  }

  async function refreshProofUploadSlotsForRetry(): Promise<ProofUploadSlot[] | null> {
    if (!taskId) return null;

    try {
      const res = await fetch(`/api/task-confirm?taskId=${encodeURIComponent(taskId)}`);
      const data = (await res.json()) as Partial<TaskInfo> & { error?: string };
      if (!res.ok || !Array.isArray(data.proofUploadSlots)) {
        setProofError(data.error || "Could not prepare fresh upload slots. Please try again.");
        return null;
      }

      setInfo((prev) =>
        prev
          ? {
              ...prev,
              status: data.status ?? prev.status,
              confirmedAt: data.confirmedAt ?? prev.confirmedAt,
              proofImageUrls: Array.isArray(data.proofImageUrls) ? data.proofImageUrls : prev.proofImageUrls,
              proofUploadSlots: data.proofUploadSlots ?? prev.proofUploadSlots,
              qualityReviewStatus: data.qualityReviewStatus ?? prev.qualityReviewStatus,
              qualityReviewNote: data.qualityReviewNote ?? prev.qualityReviewNote,
            }
          : prev,
      );

      if (data.qualityReviewStatus === "uncertain") {
        setOutcome(data.qualityReviewStatus);
        setCorrectionNote(data.qualityReviewNote ?? null);
        return null;
      }

      if (data.status === "done" || data.qualityReviewStatus === "approved") {
        setOutcome("approved");
        setCorrectionNote(null);
        return null;
      }

      return data.proofUploadSlots;
    } catch {
      setProofError("Network issue while preparing the upload. Please check your connection and try again.");
      return null;
    }
  }

  async function handleConfirm() {
    if (!taskId || confirmedRef.current || confirming || !info) return;
    confirmedRef.current = true;
    setConfirming(true);
    setConfirmError(null);

    const savedProofPaths: string[] = [];

    // Upload every selected proof photo first, each to its own signed slot.
    // Abort the whole submission on the first failure — reporting honestly
    // which photo failed rather than silently proceeding with a partial set.
    if (proofPhotos.length > 0) {
      // After a QI rejection, signed upload URLs from the previous attempt are
      // single-use and may already be exhausted. Refresh them synchronously so
      // a corrected proof never depends on the non-blocking background refresh.
      const activeProofUploadSlots =
        outcome === "correction_required" || outcome === "fraud_suspected"
          ? await refreshProofUploadSlotsForRetry()
          : info.proofUploadSlots;

      if (!activeProofUploadSlots) {
        confirmedRef.current = false;
        setConfirming(false);
        return;
      }

      if (proofPhotos.length > activeProofUploadSlots.length) {
        setProofError("Could not prepare upload slots for all photos. Please reload the page and try again.");
        confirmedRef.current = false;
        setConfirming(false);
        return;
      }
      setProofUploading(true);
      for (let i = 0; i < proofPhotos.length; i++) {
        const slot = activeProofUploadSlots[i];
        try {
          const blob = await resizeImage(proofPhotos[i].file);
          const uploadRes = await fetch(slot.uploadUrl, {
            method: "PUT",
            headers: { "Content-Type": "image/jpeg" },
            body: blob,
          });
          if (!uploadRes.ok) {
            throw new Error(`Upload failed (${uploadRes.status})`);
          }
          savedProofPaths.push(slot.storagePath);
        } catch (err) {
          setProofUploading(false);
          setProofError(
            err instanceof Error
              ? `Photo ${i + 1} of ${proofPhotos.length}: ${err.message}`
              : `Could not upload photo ${i + 1} of ${proofPhotos.length}. You can still mark done without proof, or try again.`,
          );
          confirmedRef.current = false;
          setConfirming(false);
          return;
        }
      }
      setProofUploading(false);
    }

    try {
      const res = await fetch("/api/task-confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskId,
          ...(savedProofPaths.length > 0 ? { proofImagePaths: savedProofPaths } : {}),
        }),
      });
      const rawBody = await res.text();
      let data: {
        success?: boolean;
        already_done?: boolean;
        error?: string;
        outcome?: "approved" | "correction_required" | "uncertain" | "fraud_suspected";
        correctionNote?: string | null;
      } = {};
      try {
        data = rawBody ? JSON.parse(rawBody) : {};
      } catch {
        console.error("[confirm] /api/task-confirm returned non-JSON", {
          status: res.status,
          body: rawBody.slice(0, 200),
        });
      }
      if (!res.ok || data.error) {
        setConfirmError(data.error || `Could not confirm (HTTP ${res.status}). Please try again.`);
        confirmedRef.current = false;
        return;
      }

      // already_done always means approved in a prior submission.
      const resolvedOutcome = data.already_done ? "approved" : data.outcome ?? "approved";
      setOutcome(resolvedOutcome);
      setCorrectionNote(data.correctionNote ?? null);

      // Quality Intelligence V1 — only an "approved" outcome marks the task
      // done. correction_required / fraud_suspected leave it pending for
      // Carson's correction loop; uncertain locks because owner input is
      // genuinely required.
      const submittedPreviewUrls = proofPhotos.map((p) => p.previewUrl);
      setInfo((prev) =>
        prev
          ? {
              ...prev,
              status: resolvedOutcome === "approved" ? "done" : prev.status,
              confirmedAt: resolvedOutcome === "approved" ? new Date().toISOString() : prev.confirmedAt,
              // Show local proof previews as the submitted proof set.
              proofImageUrls: submittedPreviewUrls.length > 0 ? submittedPreviewUrls : prev.proofImageUrls,
            }
          : prev,
      );
      if (resolvedOutcome !== "approved") {
        // Allow another submission attempt on this same visit — clear the
        // rejected set so the recipient must attach corrected photos.
        confirmedRef.current = false;
        setProofPhotos([]);
        setProofLimitWarning(null);
        // Refresh signed upload slots — Supabase pre-signed upload URLs are
        // single-use, so the ones from the initial GET are exhausted after
        // the first upload attempt. Fetching fresh ones non-fatally; if this
        // fails the user will see an upload error on their next attempt and
        // can reload.
        if (taskId) {
          fetch(`/api/task-confirm?taskId=${encodeURIComponent(taskId)}`)
            .then((r) => r.json() as Promise<Partial<TaskInfo>>)
            .then((d) => {
              if (Array.isArray(d.proofUploadSlots)) {
                setInfo((prev) => (prev ? { ...prev, proofUploadSlots: d.proofUploadSlots! } : prev));
              }
            })
            .catch(() => {});
        }
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
  // After an operational rejection, the assignee must attach new proof photos
  // before resubmitting. This prevents bypassing QI by clicking "Mark done"
  // without a photo (which would skip the review entirely since needsReview =
  // proofImagePaths.length > 0 on the server).
  const needsNewProof =
    ((info?.proofRequired === true && outcome !== "uncertain") ||
      outcome === "correction_required" ||
      outcome === "fraud_suspected") &&
    proofPhotos.length === 0;

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

            {/* Proof photo(s) — uploaded by recipient, shown after confirmation */}
            {info.status === "done" && info.proofImageUrls.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-medium uppercase tracking-wide text-ink/45">
                  Proof photo{info.proofImageUrls.length === 1 ? "" : "s"} ({info.proofImageUrls.length})
                </p>
                <div className={info.proofImageUrls.length === 1 ? "" : "grid grid-cols-2 gap-2"}>
                  {info.proofImageUrls.map((url, i) => (
                    <img
                      key={i}
                      src={url}
                      alt={`Proof photo ${i + 1} from recipient`}
                      className="w-full rounded-xl border border-emerald-200 object-cover shadow-sm aspect-square"
                    />
                  ))}
                </div>
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
              {/* Quality Intelligence — task stayed open; new proof photos are needed */}
              {(outcome === "correction_required" || outcome === "fraud_suspected") && (
                <AuthNotice kind="error">
                  {correctionNote
                    ? correctionNote
                    : "This photo does not match the requested item."}{" "}
                  Please review the reference image above and upload new photo(s) below.
                </AuthNotice>
              )}

              {/* Proof photo section — shown before Mark done */}
              <div className="space-y-2">
                <p className="text-xs font-medium uppercase tracking-wide text-ink/50">
                  Proof photo
                  <span className="ml-1 normal-case text-ink/35">
                    ({info.proofRequired ? "required" : "optional"}, up to 5)
                  </span>
                </p>

                {proofPhotos.length > 0 && (
                  <div className="grid grid-cols-2 gap-2">
                    {proofPhotos.map((photo, i) => (
                      <div key={photo.id} className="relative">
                        <img
                          src={photo.previewUrl}
                          alt={`Proof photo preview ${i + 1}`}
                          className="aspect-square w-full rounded-xl border border-sage/25 object-cover shadow-sm"
                        />
                        <button
                          type="button"
                          onClick={() => removeProofPhoto(photo.id)}
                          disabled={isBusy}
                          aria-label={`Remove proof photo ${i + 1}`}
                          className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full bg-ink/60 text-white shadow transition hover:bg-ink/80 disabled:opacity-50"
                        >
                          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                            <line x1="1" y1="1" x2="11" y2="11" />
                            <line x1="11" y1="1" x2="1" y2="11" />
                          </svg>
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isBusy || proofPhotos.length >= MAX_PROOF_PHOTOS}
                  className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-sage/40 bg-cream/40 px-4 py-3 text-sm text-ink/60 transition hover:border-sage/60 hover:bg-cream/60 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <circle cx="8.5" cy="8.5" r="1.5" />
                    <path d="M21 15l-5-5L5 21" />
                  </svg>
                  {proofPhotos.length > 0 ? "Add another photo" : "Attach proof photo"}
                </button>

                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={handleFileChange}
                  className="sr-only"
                  aria-label="Attach proof photos"
                />

                {proofLimitWarning && (
                  <p className="text-xs text-ink/50">{proofLimitWarning}</p>
                )}

                {proofPhotos.length > 0 && !proofError && (
                  <p className="text-xs text-ink/50">
                    {proofPhotos.length} photo{proofPhotos.length === 1 ? "" : "s"} ready. Tap Mark done to send.
                  </p>
                )}

                {proofError && (
                  <p className="text-xs text-rose-700">{proofError}</p>
                )}
              </div>

              {confirmError && <AuthNotice kind="error">{confirmError}</AuthNotice>}

              <button
                type="button"
                onClick={() => void handleConfirm()}
                disabled={isBusy || needsNewProof}
                aria-busy={isBusy}
                className="flex w-full items-center justify-center gap-2 rounded-full bg-sage px-5 py-3 text-base font-medium text-white shadow-sm transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isBusy && <Spinner size={16} />}
                <span>
                  {proofUploading
                    ? "Uploading photo(s)…"
                    : confirming
                      ? "Confirming…"
                      : needsNewProof
                        ? "Attach a new photo to continue"
                        : proofPhotos.length > 0
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
