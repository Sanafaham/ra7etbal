/**
 * /api/task-confirm — unified confirm-task handler
 *
 * Merges get-confirm-task.js (GET) and confirm-task.js (POST) to stay
 * within the Vercel Hobby 12-serverless-function limit.
 *
 * GET  /api/task-confirm?taskId=<id>
 *   Returns task data + signed image URLs + up to 5 signed upload URLs for
 *   proof photos (Proof Photo V2). Called by the public /confirm page (no
 *   auth session required).
 *
 * POST /api/task-confirm  { taskId, confirmedBy?, proofImagePaths?: string[] }
 *   Quality Intelligence V1 — when 1-5 proof photos are submitted for a
 *   delegated task, Carson reviews it (downloadImageAsBase64 +
 *   runQualityReview from _quality-review.js) before deciding what happens:
 *     - approved: falls through to the original behavior — mark done,
 *       insert a confirmation record, push the owner.
 *     - correction_required: task stays pending; a short WhatsApp message
 *       is sent to the assignee via the existing send-whatsapp-task route
 *       (sendMode: "direct_message", no new template).
 *     - uncertain: task stays pending; the owner gets pushed to review
 *       manually instead of a "confirmed" notification.
 *     - fraud_suspected: task stays pending; the photo itself looks like it
 *       isn't genuine proof (screenshot, reused reference image, etc). Carson
 *       asks the assignee for a new live proof unless repeated attempts mean
 *       owner input is genuinely required.
 *     - substitute_review (Phase 8.1): task stays pending, locked for owner
 *       review like uncertain; the assignee found a reasonable but different
 *       alternative to the exact requested item. No WhatsApp to the
 *       assignee and no correction-cycle increment here — the owner decides
 *       via Approve Alternative / Reject Alternative / Custom Instruction
 *       (PATCH handler below), not an automated retry loop.
 *
 * PATCH /api/task-confirm  { taskId, decision, instructionText?, reviewedAt? }
 *   Phase 8.1 owner decision endpoint for a substitute_review outcome.
 *   Authenticated (Authorization: Bearer <supabase access token>) — the
 *   resolved user id must match the task's owner. Kept in this file rather
 *   than a new api/*.js file to stay within the Vercel Hobby
 *   12-serverless-function limit (see the merge note above). Uses the
 *   claim/reserve/reserve_send_window/complete SECURITY DEFINER functions
 *   from supabase/migrations/20260710_quality_substitute_review.sql (plus
 *   20260712_approve_alternative_message_first.sql) for lease-fenced,
 *   idempotent, retry-safe decisions.
 *   All three decisions — Approve Alternative, Reject Alternative, Custom
 *   Instruction — send exactly one WhatsApp message to the assignee and only
 *   leave Needs You once Meta accepts it (2026-07-12: Approve Alternative
 *   previously completed the task with no message at all — an owner
 *   decision is not task completion; the task stays pending/open until the
 *   worker confirms it through the normal flow below).
 *   Photo delegations require proof before completion. Non-photo tasks, or a
 *   task with no assignee (assigned_to null), keep the original no-review
 *   completion behavior.
 */

import webpush from 'web-push';
import { downloadImageAsBase64, runQualityReview } from './_quality-review.js';
import { markWhatsappDeliveryAccepted, markWhatsappDeliveryFailed, getMetaFailure } from './_whatsapp-delivery.js';
import { sendMetaMessage, buildRoutineMessagePayload, buildOwnerDecisionTemplatePayload, normalizeTaskUuidForButton, markMessageAccepted, normalizeWhatsAppPhone } from './send-whatsapp-task.js';

// Quality Intelligence vision review can legitimately take longer than the
// default Vercel function window, especially with several proof photos.
export const config = { maxDuration: 60 };

// Proof Photo V2 — up to 5 proof photos per task. No schema change: proof
// photos are stored in the existing task_attachments table (the same table
// reference photos use), discriminated by the previously-unused file_name
// column set to 'proof' (reference-photo rows never set file_name).
const MAX_PROOF_PHOTOS = 5;
const MAX_AUTOMATED_CORRECTION_ATTEMPTS = 3;
const CANONICAL_APP_BASE_URL = 'https://www.ra7etbal.com';

function taskConfirmErrorMessageForStep(step) {
  if (step === 'load_review_images') {
    return 'The proof uploaded, but Ra7etBal could not read it for review. Please try again.';
  }
  if (step === 'quality_review') {
    return 'The proof uploaded, but Carson could not review it. Please try again.';
  }
  if (step === 'save_review' || step === 'save_approval') {
    return 'The proof uploaded, but Ra7etBal could not save the result. Please try again.';
  }
  return 'Could not confirm task. Please try again.';
}

function buildFreshWorkerConfirmationUrl(taskId) {
  return `${CANONICAL_APP_BASE_URL}/confirm?task=${encodeURIComponent(taskId)}`;
}

function logOwnerDecisionMetaPayloadAudit({ taskId, decision, payload }) {
  const components = Array.isArray(payload?.template?.components)
    ? payload.template.components
    : [];
  const bodyComponent = components.find((component) => component?.type === 'body') || null;
  const buttonComponent = components.find((component) => component?.type === 'button') || null;
  const bodyParameter = bodyComponent?.parameters?.[0] || null;
  const buttonParameter = buttonComponent?.parameters?.[0] || null;
  const buttonSuffix = buttonParameter?.text || '';
  const sanitizedPayload = {
    ...payload,
    to: '[redacted]',
    template: {
      ...(payload?.template || {}),
      components,
    },
  };

  console.log('[task-confirm] owner-decision Meta payload audit', JSON.stringify({
    payloadBuilder: 'buildOwnerDecisionTemplatePayload',
    usedRoutinePayloadBuilder: false,
    taskId,
    decision,
    templateName: payload?.template?.name || null,
    templateLanguage: payload?.template?.language?.code || null,
    bodyParameter: bodyParameter
      ? { type: bodyParameter.type || null, text: bodyParameter.text || '' }
      : null,
    buttonComponent: buttonComponent
      ? {
          type: buttonComponent.type || null,
          sub_type: buttonComponent.sub_type || null,
          index: buttonComponent.index || null,
          parameter: buttonParameter
            ? { type: buttonParameter.type || null, text: buttonParameter.text || '' }
            : null,
        }
      : null,
    computedFinalUrl: buttonSuffix
      ? buildFreshWorkerConfirmationUrl(buttonSuffix)
      : null,
    payload: sanitizedPayload,
  }));
}

function normalizeConfirmationTaskId(value) {
  let raw = Array.isArray(value) ? value[0] : value;
  if (raw == null) return '';
  let text = String(raw).trim();
  if (!text) return '';

  for (let i = 0; i < 3; i += 1) {
    try {
      const decoded = decodeURIComponent(text);
      if (decoded === text) break;
      text = decoded.trim();
    } catch {
      break;
    }
  }

  try {
    const url = new URL(text);
    const nestedTask = url.searchParams.get('task') || url.searchParams.get('task_id');
    if (nestedTask && nestedTask !== text) return normalizeConfirmationTaskId(nestedTask);
  } catch {
    // Not a full URL; fall through to query-string and UUID recovery.
  }

  const queryIndex = text.indexOf('?');
  if (queryIndex >= 0) {
    const params = new URLSearchParams(text.slice(queryIndex + 1));
    const nestedTask = params.get('task') || params.get('task_id');
    if (nestedTask && nestedTask !== text) return normalizeConfirmationTaskId(nestedTask);
  }

  const uuidMatch = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
  if (uuidMatch && /(?:https?:|\/confirm|\?|=|%)/i.test(text)) {
    return uuidMatch[0];
  }

  return text;
}

async function responseSnippet(response) {
  const text = await response.text().catch(() => '');
  return text.slice(0, 500);
}

export default async function handler(req, res) {
  if (req.method === 'GET') return handleGet(req, res);
  if (req.method === 'POST') return handlePost(req, res);
  if (req.method === 'PATCH') {
    // Phase D — a deepLinkToken body field identifies the owner-escalation
    // answer flow (staff_escalation_owner_decisions), never sent by the
    // Alternative Review UI. Everything else (taskId-based) keeps routing
    // to the existing, unchanged handleOwnerDecision.
    const body = req.body || {};
    if (typeof body.deepLinkToken === 'string' && body.deepLinkToken) {
      return handleEscalationAnswer(req, res);
    }
    return handleOwnerDecision(req, res);
  }
  return res.status(405).json({ error: 'Method not allowed' });
}

// ── GET: load task for the Confirm page ──────────────────────────────────────

async function handleGet(req, res) {
  const taskId = normalizeConfirmationTaskId(req.query?.taskId);

  if (!taskId) {
    return res.status(400).json({ error: 'Task ID is required' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({ error: 'Server configuration error' });
  }

  try {
    const response = await fetch(
      supabaseUrl + '/rest/v1/tasks?id=eq.' + encodeURIComponent(taskId) +
        '&select=id,user_id,description,assigned_to,status,confirmed_at,image_path,proof_image_path,attachment_count,quality_review_status,quality_review_note,worker_reply',
      {
        headers: {
          apikey: serviceKey,
          Authorization: 'Bearer ' + serviceKey,
          'Content-Type': 'application/json',
        },
      },
    );

    const data = await response.json();

    if (!response.ok || !data || data.length === 0) {
      return res.status(404).json({ error: 'This confirmation link is invalid or expired.' });
    }

    const task = data[0];
    const ownerPhone = await findOwnerPhone({ supabaseUrl, serviceKey, userId: task.user_id });

    let imageUrl = null;
    if (task.image_path) {
      imageUrl = await getSignedImageUrl({ supabaseUrl, serviceKey, imagePath: task.image_path });
    }

    // Load task_attachments for multi-photo reference tasks, sorted by
    // sort_order. file_name=is.null excludes proof-photo rows (below) — a
    // defensive filter, since reference rows never set file_name anyway.
    let attachmentUrls = [];
    if (task.attachment_count > 0) {
      const attachRes = await fetch(
        supabaseUrl + '/rest/v1/task_attachments?task_id=eq.' + encodeURIComponent(task.id) +
          '&file_name=is.null&order=sort_order.asc&select=storage_path',
        {
          headers: {
            apikey: serviceKey,
            Authorization: 'Bearer ' + serviceKey,
            'Content-Type': 'application/json',
          },
        },
      );
      if (attachRes.ok) {
        const attachRows = await attachRes.json().catch(() => []);
        attachmentUrls = await Promise.all(
          (Array.isArray(attachRows) ? attachRows : []).map((row) =>
            getSignedImageUrl({ supabaseUrl, serviceKey, imagePath: row.storage_path }),
          ),
        );
        attachmentUrls = attachmentUrls.filter(Boolean);
      }
    }

    // Load already-submitted proof photos (0-5), sorted by sort_order.
    let proofImageUrls = [];
    const proofAttachRes = await fetch(
      supabaseUrl + '/rest/v1/task_attachments?task_id=eq.' + encodeURIComponent(task.id) +
        '&file_name=eq.proof&order=sort_order.asc&select=storage_path',
      {
        headers: {
          apikey: serviceKey,
          Authorization: 'Bearer ' + serviceKey,
          'Content-Type': 'application/json',
        },
      },
    );
    if (proofAttachRes.ok) {
      const proofRows = await proofAttachRes.json().catch(() => []);
      proofImageUrls = await Promise.all(
        (Array.isArray(proofRows) ? proofRows : []).map((row) =>
          getSignedImageUrl({ supabaseUrl, serviceKey, imagePath: row.storage_path }),
        ),
      );
      proofImageUrls = proofImageUrls.filter(Boolean);
    }
    // Legacy single-column fallback — a task confirmed before Proof Photo V2
    // only ever wrote tasks.proof_image_path, with no task_attachments row.
    if (proofImageUrls.length === 0 && task.proof_image_path) {
      const legacyUrl = await getSignedImageUrl({ supabaseUrl, serviceKey, imagePath: task.proof_image_path });
      if (legacyUrl) proofImageUrls = [legacyUrl];
    }

    // Locked for owner review only when Carson genuinely needs owner input.
    // Operational rejection states (correction_required / fraud_suspected)
    // stay with Carson + assignee so a corrected proof can be uploaded.
    // substitute_review also locks: the owner, not the assignee, decides
    // next (Approve Alternative / Reject Alternative / Custom Instruction) —
    // this is not an automatic worker-retry loop.
    const approvedAlternativeConfirmationOnly =
      task.status !== 'done' && task.quality_review_status === 'approved';
    const isLockedForOwnerReview =
      task.quality_review_status === 'uncertain' || task.quality_review_status === 'substitute_review';

    // Fresh signed upload URLs for up to 5 proof-photo slots. Each slot's
    // signed URL is created with x-upsert so resubmitting to the same index
    // (e.g. after a Quality Intelligence rejection) overwrites cleanly
    // instead of failing with "Upload failed (400)".
    let proofUploadSlots = [];
    if (task.status !== 'done' && !isLockedForOwnerReview && !approvedAlternativeConfirmationOnly && task.user_id) {
      proofUploadSlots = await createSignedProofUploadUrls({
        supabaseUrl,
        serviceKey,
        userId: task.user_id,
        taskId: task.id,
        count: MAX_PROOF_PHOTOS,
      });
    }

    return res.status(200).json({
      id: task.id,
      description: task.description,
      assignedTo: task.assigned_to,
      status: task.status,
      confirmedAt: task.confirmed_at,
      ownerPhone,
      imageUrl,
      attachmentUrls,
      proofImageUrls,
      proofUploadSlots,
      proofRequired: Boolean(task.assigned_to && !approvedAlternativeConfirmationOnly && (task.image_path || Number(task.attachment_count || 0) > 0)),
      confirmationOnly: approvedAlternativeConfirmationOnly,
      // Source of truth for the confirm page's post-reload state — without
      // this, reopening the link after an uncertain outcome lost the "sent
      // to owner" locked view. Operational proof failures intentionally keep
      // upload slots open for Carson's correction loop.
      qualityReviewStatus: task.quality_review_status ?? null,
      qualityReviewNote: task.quality_review_note ?? null,
      workerReply: task.worker_reply ?? null,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}

// ── POST: confirm the task ────────────────────────────────────────────────────

async function handlePost(req, res) {
  const { taskId: rawTaskId, confirmedBy, proofImagePaths: rawProofImagePaths, workerReply: rawWorkerReply } = req.body;
  const taskId = normalizeConfirmationTaskId(rawTaskId);
  const proofImagePaths = (Array.isArray(rawProofImagePaths) ? rawProofImagePaths : [])
    .filter((p) => typeof p === 'string' && p.trim())
    .slice(0, MAX_PROOF_PHOTOS);
  // Optional worker note (e.g. "Could not find TEREA Silver, found Turquoise
  // instead"). Never required for a normal successful completion.
  const workerReply =
    typeof rawWorkerReply === 'string' && rawWorkerReply.trim()
      ? rawWorkerReply.trim().slice(0, 1000)
      : null;
  let step = 'init';

  if (!taskId) {
    return res.status(400).json({ error: 'Task ID is required' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const headers = {
    apikey: serviceKey,
    Authorization: 'Bearer ' + serviceKey,
    'Content-Type': 'application/json',
  };

  try {
    // 1. Fetch the task
    step = 'fetch_task';
    const fetchRes = await fetch(
      supabaseUrl + '/rest/v1/tasks' +
        '?id=eq.' + encodeURIComponent(taskId) +
        '&select=id,user_id,status,description,assigned_to,image_path,attachment_count,proof_image_path,quality_review_status,quality_review_note,quality_review_cycle_count',
      { headers },
    );

    const tasks = await fetchRes.json();

    if (!fetchRes.ok || !tasks || tasks.length === 0) {
      return res.status(404).json({ error: 'This confirmation link is invalid or expired.' });
    }

    const task = tasks[0];

    // Idempotent — already done
    if (task.status === 'done') {
      return res.status(200).json({ already_done: true, description: task.description });
    }

    const now = new Date().toISOString();

    // Quality Intelligence V1 — photo delegations must include proof so the
    // review cannot be bypassed by tapping Mark done without uploading.
    const approvedAlternativeConfirmationOnly = task.quality_review_status === 'approved';
    const proofRequired = Boolean(
      task.assigned_to &&
      !approvedAlternativeConfirmationOnly &&
      (task.image_path || Number(task.attachment_count || 0) > 0),
    );
    if (proofRequired && proofImagePaths.length === 0) {
      return res.status(400).json({
        error: 'Please attach a proof photo before marking this task done.',
      });
    }

    // Quality Intelligence V1 — only applies to delegated tasks with at
    // least one freshly submitted proof photo. No proof / no assignee →
    // unchanged.
    const needsReview = proofImagePaths.length > 0 && !!task.assigned_to;
    let review = null;

    if (needsReview) {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      const existingReviewStatus = normalizeQualityReviewStatus(task.quality_review_status);
      const duplicateOwnerReviewSubmission =
        isOwnerReviewLockedStatus(existingReviewStatus) &&
        task.proof_image_path &&
        task.proof_image_path === proofImagePaths[0];

      if (duplicateOwnerReviewSubmission) {
        return res.status(200).json({
          success: true,
          outcome: existingReviewStatus,
          description: task.description,
          duplicate: true,
        });
      }

      if (task.quality_review_status) {
        step = 'clear_previous_review';
        const clearRes = await clearPreviousQualityReviewForFreshProof({
          supabaseUrl,
          headers,
          taskId,
          proofImagePath: proofImagePaths[0] ?? null,
        });
        if (!clearRes.ok) {
          console.error('[task-confirm] clear_previous_review failed', {
            taskId,
            status: clearRes.status,
            body: await responseSnippet(clearRes),
          });
          return res.status(500).json({ error: 'Could not start a fresh review. Please try again.' });
        }
      }

      const activeCustomInstruction =
        task.proof_image_path && !task.quality_review_status
          ? await fetchLatestCompletedCustomInstruction({ supabaseUrl, serviceKey, taskId })
          : null;
      const reviewTaskDescription = activeCustomInstruction || task.description;
      const reviewDelegationMessage = activeCustomInstruction || null;

      step = 'load_review_images';
      // Same attachment_count > 0 gate the GET handler already uses (see
      // attachmentUrls above) — only the multi-reference-photo case needs
      // the extra task_attachments query; a single-reference task goes
      // straight to task.image_path with no additional round trip.
      const referenceImagePaths = activeCustomInstruction
        ? []
        : task.attachment_count > 0
          ? await loadReferenceImagePaths({ supabaseUrl, headers, taskId, fallbackImagePath: task.image_path })
          : (task.image_path ? [task.image_path] : []);
      const [delegationMessage, referenceImagesBase64, proofImagesBase64] = await Promise.all([
        reviewDelegationMessage
          ? Promise.resolve(reviewDelegationMessage)
          : fetchDelegationMessageContent({ supabaseUrl, serviceKey, taskId }),
        Promise.all(
          referenceImagePaths.map((imagePath) => downloadImageAsBase64({ supabaseUrl, serviceKey, imagePath })),
        ),
        Promise.all(
          proofImagePaths.map((imagePath) => downloadImageAsBase64({ supabaseUrl, serviceKey, imagePath })),
        ),
      ]);

      step = 'quality_review';
      review = await runQualityReview({
        apiKey,
        taskDescription: reviewTaskDescription,
        delegationMessage,
        referenceImagesBase64,
        proofImagesBase64,
        workerReply,
      });
    }

    if (review && review.status !== 'approved') {
      // CORRECTION_REQUIRED, UNCERTAIN, or FRAUD_SUSPECTED — task stays
      // open. Save the submitted photo and the review outcome; do not mark
      // done, do not insert a confirmation record.
      //
      // quality_review_cycle_count is incremented on every non-approved
      // outcome as a lifetime record of how many rounds this task needed.
      // It is never reset on approval. substitute_review is the one
      // exception: it is not a "wrong photo, try again" cycle — it hands a
      // single judgment call to the owner — so it must not consume the
      // automated correction-attempt budget. The budget is only spent later,
      // if the owner explicitly rejects the alternative (handled by
      // reserve_rejected_alternative in the decision endpoint).
      const isSubstituteReview = review.status === 'substitute_review';
      const cycleCount = isSubstituteReview
        ? (task.quality_review_cycle_count || 0)
        : (task.quality_review_cycle_count || 0) + 1;
      const isOperationalCorrection =
        review.status === 'correction_required' || review.status === 'fraud_suspected';
      const correctionLimitReached =
        isOperationalCorrection && cycleCount >= MAX_AUTOMATED_CORRECTION_ATTEMPTS;
      const savedReviewStatus = correctionLimitReached ? 'uncertain' : review.status;
      const savedReviewNote = correctionLimitReached
        ? `Multiple proof attempts still need owner review. Latest issue: ${review.note || 'The proof was not valid.'}`
        : review.note;

      step = 'save_review';
      const patchRes = await fetch(
        supabaseUrl + '/rest/v1/tasks?id=eq.' + encodeURIComponent(taskId) + '&status=eq.pending',
        {
          method: 'PATCH',
          headers: { ...headers, Prefer: 'return=representation' },
          body: JSON.stringify({
            // Primary/back-compat column — TaskCard, HistoryCard, and
            // ConfirmationNotices all read this single column for a thumbnail.
            proof_image_path: proofImagePaths[0] ?? null,
            quality_review_status: savedReviewStatus,
            quality_review_note: savedReviewNote,
            quality_reviewed_at: now,
            quality_review_cycle_count: cycleCount,
            worker_reply: workerReply,
          }),
        },
      );

      if (!patchRes.ok) {
        console.error('[task-confirm] save_review failed', {
          taskId,
          status: patchRes.status,
          body: await responseSnippet(patchRes),
          outcome: savedReviewStatus,
        });
        return res.status(500).json({ error: taskConfirmErrorMessageForStep(step) });
      }
      const savedReviewRows = await readSupabaseRows(patchRes);
      if (Array.isArray(savedReviewRows) && savedReviewRows.length === 0) {
        console.warn('[task-confirm] stale non-approved review ignored after task left pending state', {
          taskId,
          outcome: savedReviewStatus,
        });
        return res.status(200).json({
          success: true,
          already_done: true,
          outcome: 'approved',
          description: task.description,
          stale: true,
        });
      }

      // Persist the full submitted proof set (up to 5) for the confirmation
      // page to display and for the next review cycle to read back. Best-
      // effort: the review outcome above already saved successfully, so a
      // failure here only means extra proof photos beyond the primary one
      // won't show on reload — not a lost submission.
      await replaceProofAttachments({
        supabaseUrl,
        serviceKey,
        taskId,
        userId: task.user_id,
        proofImagePaths,
      }).catch((err) =>
        console.error('[task-confirm] replaceProofAttachments failed (non-fatal):', err?.message || err),
      );

      // Owner push only when manual owner review is required. Clear proof
      // failures stay in Carson's operational loop: the assignee receives a
      // correction request and the owner continues to see the task as Waiting.
      if (correctionLimitReached) {
        await sendOwnerPush({
          supabaseUrl,
          serviceKey,
          userId: task.user_id,
          description: task.description,
          assignedTo: task.assigned_to,
          variant: 'correction_limit',
        }).catch((err) =>
          console.error('[task-confirm] correction-limit owner push failed (non-fatal):', err?.message || err),
        );
      } else if (isOperationalCorrection) {
        await sendCorrectionRequest({
          req,
          supabaseUrl,
          serviceKey,
          userId: task.user_id,
          taskId,
          assignedTo: task.assigned_to,
          correctionNote: buildWorkerCorrectionNote(review),
        }).catch((err) =>
          console.error('[task-confirm] correction WhatsApp failed (non-fatal):', err?.message || err),
        );
      } else if (review.status === 'uncertain') {
        await sendOwnerPush({
          supabaseUrl,
          serviceKey,
          userId: task.user_id,
          description: task.description,
          assignedTo: task.assigned_to,
          variant: review.status,
        }).catch((err) =>
          console.error(`[task-confirm] ${review.status}-review owner push failed (non-fatal):`, err?.message || err),
        );
      } else if (isSubstituteReview) {
        // Narrow additive branch: hand a single judgment call to the owner.
        // No WhatsApp to the assignee — the owner decides via Approve
        // Alternative / Reject Alternative / Custom Instruction.
        await sendOwnerPush({
          supabaseUrl,
          serviceKey,
          userId: task.user_id,
          description: task.description,
          assignedTo: task.assigned_to,
          variant: 'substitute_review',
        }).catch((err) =>
          console.error('[task-confirm] substitute_review owner push failed (non-fatal):', err?.message || err),
        );
      }

      // S2: Register Indeterminate commitments with Open Loop Governance.
      // Schedules a +4h QStash follow-up so unresolved uncertain/fraud_suspected
      // tasks get an OLG escalation push if the owner hasn't acted.
      // COS Ch. 13.5 Amendment S2 — non-fatal.
      if (savedReviewStatus === 'uncertain' || savedReviewStatus === 'fraud_suspected') {
        await scheduleUncertainOLG({
          supabaseUrl,
          serviceKey,
          taskId,
          appBaseUrl: CANONICAL_APP_BASE_URL,
        }).catch((err) =>
          console.error('[task-confirm] scheduleUncertainOLG failed (non-fatal):', err?.message || err),
        );
      }

      return res.status(200).json({
        success: true,
        outcome: savedReviewStatus,
        description: task.description,
        // The QI note for correction_required is shown inline on the
        // confirmation page so the assignee knows exactly what to fix.
        correctionNote: isOperationalCorrection && !correctionLimitReached ? buildWorkerCorrectionNote(review) : null,
        correctionCycleCount: cycleCount,
      });
    }

    // 2. Mark task done — original behavior, now also recording an
    // APPROVED review outcome when one was run.
    step = 'save_approval';
    const updateRes = await fetch(
      supabaseUrl + '/rest/v1/tasks?id=eq.' + encodeURIComponent(taskId) + '&status=eq.pending',
      {
        method: 'PATCH',
        headers: { ...headers, Prefer: 'return=representation' },
        body: JSON.stringify({
          status: 'done',
          confirmed_at: now,
          needs_follow_up: false,
          updated_at: now,
          ...(proofImagePaths.length > 0 ? { proof_image_path: proofImagePaths[0] } : {}),
          ...(review
            ? { quality_review_status: 'approved', quality_review_note: review.note, quality_reviewed_at: now, worker_reply: workerReply }
            : {}),
        }),
      },
    );

    if (!updateRes.ok) {
      console.error('[task-confirm] save_approval failed', {
        taskId,
        status: updateRes.status,
        body: await responseSnippet(updateRes),
        outcome: review?.status ?? null,
      });
      return res.status(500).json({ error: taskConfirmErrorMessageForStep(step) });
    }
    const approvedRows = await readSupabaseRows(updateRes);
    if (Array.isArray(approvedRows) && approvedRows.length === 0) {
      console.warn('[task-confirm] duplicate approval ignored after task left pending state', { taskId });
      return res.status(200).json({
        success: true,
        already_done: true,
        outcome: 'approved',
        description: task.description,
        duplicate: true,
      });
    }

    if (proofImagePaths.length > 0) {
      await replaceProofAttachments({
        supabaseUrl,
        serviceKey,
        taskId,
        userId: task.user_id,
        proofImagePaths,
      }).catch((err) =>
        console.error('[task-confirm] replaceProofAttachments failed (non-fatal):', err?.message || err),
      );
    }

    // 3. Insert confirmation record (non-fatal)
    await fetch(supabaseUrl + '/rest/v1/confirmations', {
      method: 'POST',
      headers: { ...headers, Prefer: 'return=minimal' },
      body: JSON.stringify({
        task_id: taskId,
        confirmed_at: now,
        confirmed_by: confirmedBy || null,
        source: 'confirmation_link',
      }),
    }).catch(() => {});

    // 4. Push notification to owner (non-fatal)
    try {
      await sendOwnerPush({
        supabaseUrl,
        serviceKey,
        userId: task.user_id,
        description: task.description,
        assignedTo: task.assigned_to,
      });
    } catch (err) {
      console.error('[task-confirm] owner push failed (non-fatal):', err?.message || err);
    }

    return res.status(200).json({ success: true, outcome: 'approved', description: task.description });
  } catch (err) {
    console.error('[task-confirm] proof confirmation failed', {
      taskId,
      step,
      proofCount: proofImagePaths.length,
      message: err?.message || String(err),
      stack: err?.stack || null,
    });
    return res.status(500).json({ error: taskConfirmErrorMessageForStep(step) });
  }
}

// ── PATCH: Phase 8.1 owner decision (substitute_review) ──────────────────────

const VALID_SUBSTITUTE_DECISIONS = ['approved_alternative', 'rejected_alternative', 'custom_instruction'];

async function handleOwnerDecision(req, res) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !serviceKey || !anonKey) {
    return res.status(500).json({ error: 'Server configuration error.' });
  }

  const auth = await requireOwnerUser(req, { supabaseUrl, anonKey });
  if (auth.error) {
    return res.status(401).json({ error: auth.error });
  }
  const userId = auth.uid;

  const {
    taskId: rawTaskId,
    decision,
    instructionText: rawInstructionText,
    reviewedAt: rawReviewedAt,
  } = req.body || {};
  const taskId = normalizeConfirmationTaskId(rawTaskId);

  if (!taskId || !decision || !VALID_SUBSTITUTE_DECISIONS.includes(decision)) {
    return res.status(400).json({ error: 'taskId and a valid decision are required.' });
  }

  const instructionText =
    typeof rawInstructionText === 'string' && rawInstructionText.trim()
      ? rawInstructionText.trim().slice(0, 1000)
      : null;
  if (decision === 'custom_instruction' && !instructionText) {
    return res.status(400).json({ error: 'Custom instruction text is required.' });
  }
  const reviewedAt = typeof rawReviewedAt === 'string' && rawReviewedAt.trim() ? rawReviewedAt : null;

  const headers = {
    apikey: serviceKey,
    Authorization: 'Bearer ' + serviceKey,
    'Content-Type': 'application/json',
  };

  try {
    const taskRes = await fetch(
      supabaseUrl + '/rest/v1/tasks?id=eq.' + encodeURIComponent(taskId) +
        '&select=id,user_id,description,assigned_to,confirmation_url,quality_review_status,quality_review_note,quality_reviewed_at,worker_reply',
      { headers },
    );
    const taskRows = await taskRes.json().catch(() => []);
    if (!taskRes.ok || !Array.isArray(taskRows) || taskRows.length === 0) {
      return res.status(404).json({ error: 'Task not found.' });
    }
    const task = taskRows[0];
    if (task.user_id !== userId) {
      return res.status(403).json({ error: 'Not authorized for this task.' });
    }

    const claim = await callRpcSingle(supabaseUrl, serviceKey, 'claim_substitute_decision', {
      p_task_id: taskId,
      p_user_id: userId,
      p_decision: decision,
      p_reviewed_at: reviewedAt ?? task.quality_reviewed_at ?? null,
      p_qi_note: task.quality_review_note ?? null,
      p_worker_reply: task.worker_reply ?? null,
      p_requested_instruction: decision === 'custom_instruction' ? instructionText : null,
    });
    if (claim.error) return respondRpcError(res, claim.error);
    const decisionRow = claim.data;

    if (decisionRow.status === 'completed') {
      return res.status(200).json(buildCompletedResponse(decisionRow));
    }

    // Approve Alternative / Reject Alternative / Custom Instruction — every
    // owner decision needs exactly one WhatsApp send before the task can
    // leave Needs You. An owner decision is not task completion: the worker
    // must be told first, and the task stays open until the worker actually
    // confirms it through the normal flow.
    const assigneePerson = await findAssigneePerson({
      supabaseUrl, serviceKey, userId, assignedTo: task.assigned_to,
    });
    if (!assigneePerson?.phone) {
      return res.status(400).json({ error: 'No phone number on file for the assignee.' });
    }
    const recipientName = assigneePerson.name || task.assigned_to || 'there';

    const messageContent =
      decision === 'rejected_alternative'
        ? buildRejectionMessageText({ recipientName, taskDescription: task.description, substituteNote: task.quality_review_note })
        : decision === 'approved_alternative'
        ? buildApprovalMessageText({ recipientName, taskDescription: task.description })
        : instructionText;
    const workerConfirmationUrl = buildFreshWorkerConfirmationUrl(task.id || taskId);

    const reserveFn = decision === 'rejected_alternative' ? 'reserve_rejected_alternative' : 'reserve_custom_instruction';
    const reserve = await callRpcRows(supabaseUrl, serviceKey, reserveFn, {
      p_decision_id: decisionRow.id,
      p_lease_token: decisionRow.lease_token,
      p_user_id: userId,
      p_message_content: messageContent,
      p_confirmation_url: workerConfirmationUrl,
      p_recipient: assigneePerson.phone,
      p_recipient_name: recipientName,
    });
    if (reserve.error) return respondRpcError(res, reserve.error);
    const reserveResult = reserve.data[0];

    // Reject-only: the correction-attempt ceiling was hit — task already
    // fell back to uncertain atomically inside the reserve call, no send.
    if (decision === 'rejected_alternative' && reserveResult.outcome === 'fallback_to_uncertain') {
      await sendOwnerPush({
        supabaseUrl, serviceKey, userId: task.user_id, description: task.description,
        assignedTo: task.assigned_to, variant: 'correction_limit',
      }).catch((err) =>
        console.error('[task-confirm] substitute-review correction-limit owner push failed (non-fatal):', err?.message || err),
      );
      return res.status(200).json({ success: true, decision, outcome: 'fallback_to_uncertain' });
    }

    const { message_id: messageId, delivery_id: deliveryId } = reserveResult;

    // Skip the send entirely if a prior attempt under this same lease
    // already got an accepted delivery (retry resuming after the task
    // transition failed, not the send).
    const deliveryStatus = await fetchDeliveryStatus({ supabaseUrl, serviceKey, deliveryId });
    if (deliveryStatus !== 'accepted') {
      // Mandatory fenced checkpoint immediately before the irreversible Meta
      // call — a superseded lease is rejected here and never reaches Meta.
      const fence = await callRpcVoid(supabaseUrl, serviceKey, 'reserve_send_window', {
        p_decision_id: decisionRow.id, p_lease_token: decisionRow.lease_token, p_user_id: userId, p_delivery_id: deliveryId,
      });
      if (fence.error) return respondRpcError(res, fence.error);

      const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
      const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
      if (!accessToken || !phoneNumberId) {
        await markWhatsappDeliveryFailed({
          supabaseUrl, serviceKey, deliveryId, failureStage: 'configuration', reason: 'WhatsApp is not configured.',
        });
        return res.status(500).json({ error: 'WhatsApp is not configured.' });
      }

      const ownerDecisionTemplate = (process.env.WHATSAPP_OWNER_DECISION_TEMPLATE || '').trim();
      const ownerDecisionButtonTaskId = ownerDecisionTemplate
        ? normalizeTaskUuidForButton(task.id || taskId)
        : '';
      if (ownerDecisionTemplate && !ownerDecisionButtonTaskId) {
        await markWhatsappDeliveryFailed({
          supabaseUrl,
          serviceKey,
          deliveryId,
          failureStage: 'validation',
          reason: 'Owner decision Visit Task button requires a task UUID.',
          templateName: ownerDecisionTemplate,
        });
        return res.status(500).json({ error: 'Could not build a valid Visit Task link. Please try again.' });
      }
      const templateName = ownerDecisionTemplate
        ? ownerDecisionTemplate
        : (process.env.WHATSAPP_ROUTINE_MESSAGE_TEMPLATE || 'ra7etbal_routine_message').trim();
      const templateLanguage = (process.env.WHATSAPP_TEMPLATE_LANGUAGE || 'en_US').trim();
      const normalizedPhone = normalizeWhatsAppPhone(assigneePerson.phone);
      if (!normalizedPhone) {
        await markWhatsappDeliveryFailed({
          supabaseUrl, serviceKey, deliveryId, failureStage: 'validation', reason: 'Recipient phone number is missing or invalid.',
        });
        return res.status(400).json({ error: 'No valid phone number on file for the assignee.' });
      }
      const cleanMessageContent = String(messageContent).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
      const payload = ownerDecisionTemplate
        ? buildOwnerDecisionTemplatePayload({
            to: normalizedPhone,
            message: cleanMessageContent,
            templateName,
            templateLanguage,
            taskUuid: ownerDecisionButtonTaskId,
          })
        : buildRoutineMessagePayload({
            to: normalizedPhone,
            message: cleanMessageContent,
            templateName,
            templateLanguage,
          });

      if (ownerDecisionTemplate) {
        logOwnerDecisionMetaPayloadAudit({
          taskId: task.id || taskId,
          decision,
          payload,
        });
      }

      let sendResult;
      try {
        sendResult = await sendMetaMessage({
          url: `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`,
          accessToken,
          payload,
        });
      } catch (err) {
        await markWhatsappDeliveryFailed({
          supabaseUrl, serviceKey, deliveryId, failureStage: 'network',
          reason: err instanceof Error ? err.message : String(err), templateName,
        });
        return res.status(502).json({ error: 'Could not send WhatsApp message. Please retry.' });
      }

      if (!sendResult.ok) {
        const failure = getMetaFailure(sendResult);
        await markWhatsappDeliveryFailed({ supabaseUrl, serviceKey, deliveryId, failureStage: 'meta_api', ...failure, templateName });
        return res.status(502).json({ error: 'Could not send WhatsApp message. Please retry.' });
      }

      await markMessageAccepted({ supabaseUrl, serviceKey, messageRecordId: messageId, messageId: sendResult.messageId }).catch(() => {});
      await markWhatsappDeliveryAccepted({
        supabaseUrl, serviceKey, deliveryId, metaMessageId: sendResult.messageId, templateName,
        metadata: { send_mode: 'direct_message', decision },
      });
    }

    // Complete — validates lease + delivery ownership + accepted status once
    // more before applying the task transition. Idempotent on retry.
    const completeFn = decision === 'rejected_alternative' ? 'complete_rejected_alternative' : 'complete_custom_instruction';
    const complete = await callRpcVoid(supabaseUrl, serviceKey, completeFn, {
      p_decision_id: decisionRow.id, p_lease_token: decisionRow.lease_token, p_user_id: userId, p_delivery_id: deliveryId,
    });
    if (complete.error) return respondRpcError(res, complete.error);

    if (decision === 'approved_alternative') {
      const marker = await markApprovedAlternativeConfirmationOnly({
        supabaseUrl,
        serviceKey,
        taskId: task.id || taskId,
      });
      if (!marker.ok) {
        console.error('[task-confirm] approved alternative marker failed', {
          taskId: task.id || taskId,
          status: marker.status,
          body: marker.body,
        });
        return res.status(500).json({ error: 'The approval was sent, but the confirmation link could not be prepared. Please try again.' });
      }
    }

    return res.status(200).json({
      success: true,
      decision,
      outcome:
        decision === 'rejected_alternative'
          ? 'correction_required'
          : decision === 'approved_alternative'
          ? 'approved'
          : 'custom_instruction_sent',
    });
  } catch (err) {
    console.error('[task-confirm] owner decision failed', {
      taskId, decision, message: err?.message || String(err),
    });
    return res.status(500).json({ error: 'Could not process this decision. Please try again.' });
  }
}

// ── PATCH (deepLinkToken): Phase D — owner answers a staff escalation ───────

const ESCALATION_DECISIONS = ['approved', 'rejected', 'custom_instruction'];

/**
 * Approve/Reject build a generic, escalation-specific reply from data
 * already on the staff_messages row — never a fixed, scenario-specific
 * string. A fixed string (e.g. "Yes, buy the red wine vinegar instead.")
 * would be actively wrong for every escalation except the one it was
 * written for; this codebase already has exactly this problem solved
 * once, for a structurally identical owner-decision flow — see
 * buildApprovalMessageText/buildRejectionMessageText above, which
 * interpolate {recipientName, taskDescription} (real stored fields, never
 * invented) rather than hardcoding wording. This mirrors that pattern:
 * {staffName, inboundText} are both real, stored, already-verified fields
 * (staff_messages.staff_name/inbound_text), quoted verbatim — the exact
 * same "quote it back" technique the owner-decision page itself already
 * uses to show the request to the owner (OwnerEscalationDecision.tsx's
 * read-only card). Quoting the staff member's own words is not inventing
 * an owner response — it identifies *which* request this reply answers,
 * which matters because a staff member can have more than one pending
 * question open with Carson over time. No other field is used, and
 * nothing beyond "approved"/"not approved" + a quote of their own
 * question is asserted — the actual decision content for Approve/Reject
 * is exactly what the owner selected by tapping the button, nothing more.
 */
function buildEscalationApprovalReplyText(staffName, inboundText) {
  return `${staffName}, this was approved: "${inboundText}" — please go ahead.`;
}
function buildEscalationRejectionReplyText(staffName, inboundText) {
  return `${staffName}, this was not approved: "${inboundText}" — please hold off for now.`;
}

/**
 * Phase D — owner answers an open staff escalation
 * (staff_escalation_owner_decisions, reached via deep_link_token) and
 * Ra7etBal delivers that answer to the staff member who asked, exactly
 * once, as a plain-text WhatsApp message (never a template — the staff
 * member messaged first, so this send is inside Meta's customer-service
 * window, same as Carson's own auto-reply to staff in
 * api/whatsapp-webhook.js's handleInboundStaffMessage).
 *
 * Reuses the Phase A state machine and RPCs unchanged
 * (answer_escalation_owner_decision, claim/complete/fail_escalation_
 * answer_delivery — supabase/migrations/20260726_staff_escalation_owner_
 * decisions.sql, plus the Phase D delivery_transport_message_id widening
 * in 20260727_phase_d_escalation_answer_delivery_message_id.sql). No
 * parallel state machine, no new lease pattern.
 *
 * answer_escalation_owner_decision itself authorizes by token possession
 * only (it has no p_user_id parameter — see its own doc comment in the
 * migration) because the Phase C read-only page has no session to check
 * against. This PATCH route DOES have a real signed-in session, so it adds
 * its own explicit ownership check here, before any write: the escalation
 * row is looked up by token first, and a mismatched or nonexistent
 * user_id gets the exact same generic "invalid link" response — never a
 * different one that would disclose whether the token exists at all for
 * another household.
 */
async function handleEscalationAnswer(req, res) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !serviceKey || !anonKey) {
    return res.status(500).json({ error: 'Server configuration error.' });
  }

  const auth = await requireOwnerUser(req, { supabaseUrl, anonKey });
  if (auth.error) {
    return res.status(401).json({ error: auth.error });
  }
  const userId = auth.uid;

  const { deepLinkToken, decision, instructionText: rawInstructionText } = req.body || {};
  if (typeof deepLinkToken !== 'string' || !deepLinkToken) {
    return res.status(400).json({ error: 'deepLinkToken is required.' });
  }
  // decision/instructionText are only required (and only used) when this
  // request will actually record a new answer — i.e. the escalation is
  // still 'open' below. A retry on a 'failed' delivery reuses the answer
  // already stored and never needs a decision resubmitted.
  const instructionText =
    typeof rawInstructionText === 'string' && rawInstructionText.trim()
      ? rawInstructionText.trim().slice(0, 1000)
      : null;

  const headers = {
    apikey: serviceKey,
    Authorization: 'Bearer ' + serviceKey,
    'Content-Type': 'application/json',
  };
  const invalidLinkResponse = () =>
    res.status(404).json({ error: 'This link is invalid, expired, or not associated with your account.' });

  try {
    // 1. Look up by token, verify ownership — see the function doc comment
    // above for why this can't be left to the RPC alone.
    const lookupRes = await fetch(
      supabaseUrl + '/rest/v1/staff_escalation_owner_decisions?deep_link_token=eq.' +
        encodeURIComponent(deepLinkToken) +
        '&select=id,user_id,staff_message_id,status,owner_reply_text',
      { headers },
    );
    const lookupRows = await lookupRes.json().catch(() => []);
    if (!lookupRes.ok || !Array.isArray(lookupRows) || lookupRows.length === 0) {
      return invalidLinkResponse();
    }
    const existing = lookupRows[0];
    if (existing.user_id !== userId) {
      return invalidLinkResponse();
    }

    // 2. Fetch the linked staff_messages row once, up front — needed both
    // to build a safe, escalation-specific Approve/Reject reply text
    // below, and later to resolve the recipient/opt-in state. If this
    // can't be resolved, or lacks the one field an approval/rejection
    // reply structurally needs (inbound_text — NOT NULL at the schema
    // level, but re-checked here rather than assumed), stop entirely:
    // nothing is written, nothing is sent, no guess is substituted.
    const staffMsgRes = await fetch(
      supabaseUrl + '/rest/v1/staff_messages?id=eq.' + encodeURIComponent(existing.staff_message_id) +
        '&select=id,person_id,staff_name,staff_phone,inbound_text',
      { headers },
    );
    const staffMsgRows = await staffMsgRes.json().catch(() => []);
    const staffMessage = Array.isArray(staffMsgRows) ? staffMsgRows[0] : null;
    const staffContextText = typeof staffMessage?.inbound_text === 'string' ? staffMessage.inbound_text.trim() : '';
    if (!staffMessage || !staffContextText) {
      console.error('[task-confirm] escalation answer blocked — could not resolve safe reply context', {
        escalationId: existing.id, staffMessageId: existing.staff_message_id,
      });
      return res.status(500).json({ error: 'Could not determine the staff request. Please try again.' });
    }

    // 3-6. Save the answer (if needed), claim the delivery lease, resolve
    // the recipient, and send — the reusable Phase D core, shared with the
    // authoritative owner WhatsApp quoted-reply path
    // (api/_owner-whatsapp-routing.js).
    const result = await resolveAndDeliverEscalationAnswer({
      supabaseUrl, serviceKey, userId, deepLinkToken,
      escalation: existing, staffMessage, staffContextText, decision, instructionText,
      replyChannel: 'app',
    });
    if (result.kind === 'rpc_error') return respondRpcError(res, result.error);
    if (result.kind === 'validation_error') return res.status(400).json({ error: result.message });
    if (result.kind === 'config_error') return res.status(500).json({ error: result.message });
    if (result.kind === 'send_error') return res.status(502).json({ error: 'Could not send the message. Please retry.' });
    return res.status(200).json({
      success: true,
      status: result.status,
      ownerReplyText: result.ownerReplyText,
    });
  } catch (err) {
    console.error('[task-confirm] escalation answer failed', {
      deepLinkToken, decision, message: err?.message || String(err),
    });
    return res.status(500).json({ error: 'Could not process this decision. Please try again.' });
  }
}

async function failEscalationDeliveryLease(supabaseUrl, serviceKey, escalationId, userId, claimToken, reason) {
  try {
    await callRpcSingle(supabaseUrl, serviceKey, 'fail_escalation_answer_delivery', {
      p_id: escalationId, p_user_id: userId, p_claim_token: claimToken, p_error: reason,
    });
  } catch (err) {
    console.error('[task-confirm] fail_escalation_answer_delivery threw (non-fatal)', {
      escalationId, error: err?.message || String(err),
    });
  }
}

/**
 * The reusable Phase D core: save the owner's answer (idempotently, if the
 * escalation is still 'open'), claim the delivery lease, resolve the staff
 * recipient, and send the plain-text WhatsApp reply. Extracted from
 * handleEscalationAnswer's PATCH-route body so the exact same logic can be
 * reused by the authoritative owner WhatsApp quoted-reply path
 * (api/_owner-whatsapp-routing.js) without a second, independently
 * maintained Phase D implementation.
 *
 * Returns a plain result object instead of writing to an HTTP response —
 * callers translate `kind` into whatever response shape (HTTP JSON, plain
 * return value, etc.) fits their own context:
 *   { kind: 'validation_error', message }         — bad decision/instructionText (open-escalation path only)
 *   { kind: 'rpc_error', error }                  — answer/claim RPC failed; caller should use respondRpcError-equivalent handling
 *   { kind: 'config_error', message }              — WhatsApp not configured, or the stored reply text is empty
 *   { kind: 'send_error' }                         — Meta rejected the send or the network call failed
 *   { kind: 'success', status, ownerReplyText }    — status is one of
 *       'delivered' | 'in_progress' | 'saved_unreachable' | 'sent_unconfirmed'
 *
 * `escalation` must already be ownership-verified by the caller (token
 * lookup + user_id match, or an equivalent check) — this function does not
 * re-verify ownership. `staffMessage`/`staffContextText` must already be
 * resolved and non-blank (staffContextText is staffMessage.inbound_text,
 * trimmed) — this function does not re-fetch or re-validate them.
 */
export async function resolveAndDeliverEscalationAnswer({
  supabaseUrl, serviceKey, userId, deepLinkToken, escalation: existing, staffMessage, staffContextText,
  decision, instructionText, replyChannel = 'app',
}) {
  const headers = {
    apikey: serviceKey,
    Authorization: 'Bearer ' + serviceKey,
    'Content-Type': 'application/json',
  };

  // 3. Save the answer, exactly once. Only a genuinely open escalation
  // gets a new answer; anything else already has one stored, and the
  // caller's freshly submitted decision/text is deliberately ignored in
  // favor of what's already persisted — this is what makes a duplicate
  // submit, a second browser tab, or a resubmit-after-refresh all safe.
  let escalation = existing;
  if (existing.status === 'open') {
    if (!['app', 'whatsapp'].includes(replyChannel)) {
      return { kind: 'validation_error', message: 'A valid reply channel is required.' };
    }
    if (!ESCALATION_DECISIONS.includes(decision)) {
      return { kind: 'validation_error', message: 'A valid decision is required.' };
    }
    if (decision === 'custom_instruction' && !instructionText) {
      return { kind: 'validation_error', message: 'Custom instruction text is required.' };
    }
    const submittedReplyText =
      decision === 'rejected'
        ? buildEscalationRejectionReplyText(staffMessage.staff_name, staffContextText)
        : decision === 'approved'
        ? buildEscalationApprovalReplyText(staffMessage.staff_name, staffContextText)
        : instructionText;

    const answer = await callRpcSingle(supabaseUrl, serviceKey, 'answer_escalation_owner_decision', {
      p_deep_link_token: deepLinkToken,
      p_owner_reply_text: submittedReplyText,
      p_owner_reply_channel: replyChannel,
    });
    if (answer.error) return { kind: 'rpc_error', error: answer.error };
    escalation = answer.data;
  }

  if (escalation.status === 'delivered_to_staff') {
    return { kind: 'success', status: 'delivered', ownerReplyText: escalation.owner_reply_text };
  }

  // 4. Claim the delivery lease. Idempotent/atomic — see
  // claim_escalation_answer_delivery's own doc comment in the migration.
  const claim = await callRpcRows(supabaseUrl, serviceKey, 'claim_escalation_answer_delivery', {
    p_id: escalation.id,
    p_user_id: userId,
    p_lease_seconds: 120,
  });
  if (claim.error) return { kind: 'rpc_error', error: claim.error };
  const claimResult = claim.data[0];

  if (!claimResult.claimed) {
    // Either this escalation just won a race and is already fully
    // delivered, or a live lease is held elsewhere (this or a
    // concurrent request already sending) — report truthfully, never
    // guess, never send a second message.
    if (claimResult.delivery_status === 'delivered_to_staff') {
      return { kind: 'success', status: 'delivered', ownerReplyText: claimResult.reply_text };
    }
    return { kind: 'success', status: 'in_progress', ownerReplyText: claimResult.reply_text };
  }

  // 5. Resolve the staff recipient and current WhatsApp eligibility,
  // reusing the staffMessage row already fetched by the caller — no second
  // staff_messages lookup needed. Never trust staff_phone alone for
  // opt-in, though — re-check the live people row.
  let recipientPhone = staffMessage.staff_phone || null;
  let optedIn = false;
  if (staffMessage?.person_id) {
    const personRes = await fetch(
      supabaseUrl + '/rest/v1/people?id=eq.' + encodeURIComponent(staffMessage.person_id) +
        '&select=id,phone,whatsapp_opted_in',
      { headers },
    );
    const personRows = await personRes.json().catch(() => []);
    const person = Array.isArray(personRows) ? personRows[0] : null;
    if (person) {
      recipientPhone = person.phone || recipientPhone;
      optedIn = Boolean(person.whatsapp_opted_in);
    }
  }
  const normalizedPhone = recipientPhone ? normalizeWhatsAppPhone(recipientPhone) : null;

  if (!staffMessage || !normalizedPhone || !optedIn) {
    await failEscalationDeliveryLease(
      supabaseUrl, serviceKey, escalation.id, userId, claimResult.claim_token, 'staff_unreachable',
    );
    return { kind: 'success', status: 'saved_unreachable', ownerReplyText: claimResult.reply_text };
  }

  // 6. Send — preserve the owner's exact stored reply as the audit source,
  // while making only recipient-certain third-person references natural for
  // the staff member who is receiving the message directly.
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!accessToken || !phoneNumberId) {
    await failEscalationDeliveryLease(
      supabaseUrl, serviceKey, escalation.id, userId, claimResult.claim_token, 'whatsapp_not_configured',
    );
    return { kind: 'config_error', message: 'WhatsApp is not configured.' };
  }

  const messageText = normalizeOwnerReplyForRecipient(
    claimResult.reply_text,
    staffMessage.staff_name,
  );
  if (!messageText) {
    await failEscalationDeliveryLease(
      supabaseUrl, serviceKey, escalation.id, userId, claimResult.claim_token, 'empty_reply_text',
    );
    return { kind: 'config_error', message: 'Could not send an empty message. Please try again.' };
  }

  let sendResult;
  try {
    sendResult = await sendMetaMessage({
      url: `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`,
      accessToken,
      payload: {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: normalizedPhone,
        type: 'text',
        text: { body: messageText },
      },
    });
  } catch (err) {
    await failEscalationDeliveryLease(
      supabaseUrl, serviceKey, escalation.id, userId, claimResult.claim_token,
      err instanceof Error ? err.message : String(err),
    );
    return { kind: 'send_error' };
  }

  if (!sendResult.ok) {
    const failure = getMetaFailure(sendResult);
    await failEscalationDeliveryLease(
      supabaseUrl, serviceKey, escalation.id, userId, claimResult.claim_token, failure.reason,
    );
    return { kind: 'send_error' };
  }

  // 7. Complete — atomic, gated on the exact live claim token; a
  // superseded/stale token can never resolve this call.
  const complete = await callRpcSingle(supabaseUrl, serviceKey, 'complete_escalation_answer_delivery', {
    p_id: escalation.id,
    p_user_id: userId,
    p_claim_token: claimResult.claim_token,
    p_transport_message_id: sendResult.messageId,
  });
  if (complete.error) {
    // Meta already accepted the send — this is a bookkeeping failure
    // afterward, not a delivery failure. Truthful partial-success result:
    // the message really did go out, so this must never read as a plain
    // error implying nothing happened.
    console.error('[task-confirm] escalation delivery sent but completion bookkeeping failed', {
      escalationId: escalation.id, error: complete.error,
    });
    return {
      kind: 'success',
      status: 'sent_unconfirmed',
      ownerReplyText: claimResult.reply_text,
      transportMessageId: sendResult.messageId,
    };
  }

  return {
    kind: 'success',
    status: 'delivered',
    ownerReplyText: complete.data.owner_reply_text,
    transportMessageId: sendResult.messageId,
  };
}

export function normalizeOwnerReplyForRecipient(replyText, staffName) {
  const exact = String(replyText || '').replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
  if (!exact) return '';

  // Quoted wording may be legally or operationally significant. Transform
  // only unquoted spans and leave every quoted span byte-for-byte intact.
  const spans = exact.split(/((?:["“]).*?(?:["”]))/g);
  return spans.map((span, index) => {
    if (index % 2 === 1) return span;

    let text = span;
    const escapedName = String(staffName || '').trim()
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (escapedName) {
      text = text.replace(
        new RegExp(
          `\\b${escapedName}\\s+(can|cannot|can't|should|shouldn't|must|mustn't|may|will|won't|needs to|has to)\\b`,
          'gi',
        ),
        (_match, modal) => {
          const normalizedModal = /^needs to$/i.test(modal)
            ? 'need to'
            : /^has to$/i.test(modal)
              ? 'have to'
              : modal.toLowerCase();
          return `you ${normalizedModal}`;
        },
      );
    }

    // A mixed-pronoun or reported-speech sentence does not identify the
    // recipient safely enough for a rewrite.
    const hasHe = /\bhe\b/i.test(text);
    const hasShe = /\bshe\b/i.test(text);
    const hasReportedSpeech = /\b(?:said|says|told|asked|reported)\b/i.test(text);
    if ((hasHe && hasShe) || hasReportedSpeech) return text;

    text = text.replace(/\btell\s+(?:him|her)\s+to\s+/gi, '');
    text = text.replace(
      /\b(?:he|she)\s+(can|cannot|can't|should|shouldn't|must|mustn't|may|will|won't|needs to|has to)\b/gi,
      (_match, modal) => {
        const normalizedModal = /^needs to$/i.test(modal)
          ? 'need to'
          : /^has to$/i.test(modal)
            ? 'have to'
            : modal.toLowerCase();
        return `you ${normalizedModal}`;
      },
    );
    text = text.replace(/\b(Yes|No)\s+(?=you\b)/g, '$1, ');
    return text;
  }).join('');
}

async function markApprovedAlternativeConfirmationOnly({ supabaseUrl, serviceKey, taskId }) {
  const response = await fetch(
    `${supabaseUrl}/rest/v1/tasks?id=eq.${encodeURIComponent(taskId)}&status=eq.pending`,
    {
      method: 'PATCH',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        quality_review_status: 'approved',
        quality_review_note: 'Owner approved the alternative.',
        updated_at: new Date().toISOString(),
      }),
    },
  );
  return {
    ok: response.ok,
    status: response.status,
    body: response.ok ? '' : await response.text().catch(() => ''),
  };
}

/** Verifies the Bearer JWT, returns { uid } or { error }. Same auth/v1/user pattern as api/automations.js's requireUser(). */
async function requireOwnerUser(req, { supabaseUrl, anonKey }) {
  const authHeader = req.headers?.['authorization'] ?? req.headers?.['Authorization'] ?? '';
  if (!authHeader.startsWith('Bearer ')) {
    return { error: 'Unauthorized' };
  }
  const jwt = authHeader.slice(7);
  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${jwt}` },
  });
  if (!userRes.ok) return { error: 'Unauthorized' };
  const user = await userRes.json().catch(() => null);
  if (!user?.id) return { error: 'Unauthorized' };
  return { uid: user.id };
}

async function callRpcRaw(supabaseUrl, serviceKey, fnName, args) {
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/${fnName}`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    return { error: { status: response.status, message: body?.message || body?.error || 'rpc_failed', body } };
  }
  const text = await response.text();
  return { data: text ? JSON.parse(text) : null };
}

/** For functions returning a single composite row (PostgREST returns a JSON object). */
export async function callRpcSingle(supabaseUrl, serviceKey, fnName, args) {
  const result = await callRpcRaw(supabaseUrl, serviceKey, fnName, args);
  if (result.error) return result;
  return { data: result.data };
}

/** For functions returning TABLE(...) (PostgREST returns a JSON array). */
export async function callRpcRows(supabaseUrl, serviceKey, fnName, args) {
  const result = await callRpcRaw(supabaseUrl, serviceKey, fnName, args);
  if (result.error) return result;
  return { data: Array.isArray(result.data) ? result.data : [result.data] };
}

/** For functions returning void. */
async function callRpcVoid(supabaseUrl, serviceKey, fnName, args) {
  const result = await callRpcRaw(supabaseUrl, serviceKey, fnName, args);
  if (result.error) return result;
  return { data: null };
}

function respondRpcError(res, error) {
  const message = error?.message || 'unknown_error';
  const statusMap = {
    not_authorized: 403,
    stale_review: 409,
    decision_conflict: 409,
    still_processing: 409,
    lease_lost: 409,
    delivery_superseded: 409,
    delivery_not_pending: 409,
    delivery_mismatch: 409,
    delivery_not_accepted: 409,
    invalid_decision: 400,
    wrong_outcome_path: 400,
    // Phase D — staff_escalation_owner_decisions RPCs
    empty_reply: 400,
    invalid_transition: 409,
    invalid_lease: 400,
    stale_delivery_claim: 409,
  };
  const friendlyMap = {
    not_authorized: 'Not authorized for this task.',
    stale_review: 'This review is no longer current — please reload and try again.',
    decision_conflict: 'A different decision already exists for this review.',
    still_processing: 'This decision is already being processed — please wait a moment and try again.',
    lease_lost: 'This action was superseded by another attempt — please reload and try again.',
    delivery_superseded: 'This send was superseded by another attempt — please reload and try again.',
    delivery_not_pending: 'This message has already been handled — please reload and try again.',
    delivery_mismatch: 'This message does not match the current decision — please reload and try again.',
    delivery_not_accepted: 'The message was not confirmed sent — please try again.',
    invalid_decision: 'This decision is not valid for this task.',
    wrong_outcome_path: 'This decision was already resolved differently — please reload.',
    // Phase D
    empty_reply: 'A decision is required.',
    invalid_transition: 'This request has already been answered — please reload to see the current status.',
    invalid_lease: 'Could not process this decision right now — please try again.',
    stale_delivery_claim: 'This send was superseded by another attempt — please reload and try again.',
  };
  return res
    .status(statusMap[message] || 500)
    .json({ error: friendlyMap[message] || 'Could not process this decision. Please try again.' });
}

function buildCompletedResponse(decisionRow) {
  return {
    success: true,
    decision: decisionRow.decision,
    outcome: decisionRow.outcome || 'approved',
    already_completed: true,
  };
}

function buildRejectionMessageText({ recipientName, taskDescription, substituteNote }) {
  const note = String(substituteNote || '').trim();
  const suffix = note ? ` ${note}` : '';
  return `${recipientName}, the exact item is needed for "${taskDescription}" instead of the alternative.${suffix} Please try again.`;
}

function buildApprovalMessageText({ recipientName, taskDescription }) {
  return `${recipientName}, the alternative for "${taskDescription}" was approved — please go ahead.`;
}

async function fetchDeliveryStatus({ supabaseUrl, serviceKey, deliveryId }) {
  if (!deliveryId) return null;
  const response = await fetch(
    `${supabaseUrl}/rest/v1/whatsapp_deliveries?id=eq.${encodeURIComponent(deliveryId)}&select=delivery_status`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
  );
  if (!response.ok) return null;
  const rows = await response.json().catch(() => []);
  return Array.isArray(rows) && rows[0] ? rows[0].delivery_status : null;
}

// ── Push helper ───────────────────────────────────────────────────────────────

async function clearPreviousQualityReviewForFreshProof({ supabaseUrl, headers, taskId, proofImagePath }) {
  return fetch(
    supabaseUrl + '/rest/v1/tasks?id=eq.' + encodeURIComponent(taskId),
    {
      method: 'PATCH',
      headers: { ...headers, Prefer: 'return=minimal' },
      body: JSON.stringify({
        proof_image_path: proofImagePath,
        quality_review_status: null,
        quality_review_note: null,
        quality_reviewed_at: null,
        worker_reply: null,
      }),
    },
  );
}

/**
 * Confirmed production bug: a task with 2 owner-attached reference photos
 * had only the first (tasks.image_path) sent into Quality Intelligence — the
 * second reference photo (task_attachments, file_name IS NULL, sort_order 1)
 * was never loaded, so the model judged all submitted proof photos against
 * one incomplete reference and produced a false CORRECTION_REQUIRED.
 *
 * Returns every reference-photo storage path for the task, ordered by
 * sort_order — the same file_name=is.null query the GET handler already uses
 * to build attachmentUrls for display. Falls back to [fallbackImagePath]
 * only when no task_attachments reference rows exist (single-photo tasks,
 * and tasks created before Multi-Attachment Task V1).
 */
async function loadReferenceImagePaths({ supabaseUrl, headers, taskId, fallbackImagePath }) {
  try {
    const response = await fetch(
      supabaseUrl + '/rest/v1/task_attachments?task_id=eq.' + encodeURIComponent(taskId) +
        '&file_name=is.null&order=sort_order.asc&select=storage_path',
      { headers },
    );
    if (response.ok) {
      const rows = await response.json().catch(() => []);
      const paths = (Array.isArray(rows) ? rows : [])
        .map((row) => row.storage_path)
        .filter(Boolean);
      if (paths.length > 0) return paths;
    }
  } catch {
    // Falls through to the single-image fallback below.
  }
  return fallbackImagePath ? [fallbackImagePath] : [];
}

export async function sendOwnerPush({ supabaseUrl, serviceKey, userId, description, assignedTo, variant }) {
  if (!userId) return;

  const vapidPublicKey = process.env.VAPID_PUBLIC_KEY || process.env.VITE_VAPID_PUBLIC_KEY;
  const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;
  const vapidSubject = process.env.VAPID_SUBJECT;

  if (!vapidPublicKey || !vapidPrivateKey || !vapidSubject) {
    console.warn('[task-confirm] VAPID keys not configured — owner push skipped');
    return;
  }

  const headers = {
    apikey: serviceKey,
    Authorization: 'Bearer ' + serviceKey,
    'Content-Type': 'application/json',
  };

  const subsRes = await fetch(
    supabaseUrl + '/rest/v1/push_subscriptions' +
      '?user_id=eq.' + encodeURIComponent(userId) +
      '&enabled=eq.true' +
      '&select=id,endpoint,p256dh,auth',
    { headers },
  );
  const subscriptions = await subsRes.json().catch(() => []);

  if (!Array.isArray(subscriptions) || subscriptions.length === 0) {
    console.log('[task-confirm] no enabled push subscriptions for owner — skipping');
    return;
  }

  webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);

  const notificationBody = buildOwnerPushBody({ description, assignedTo, variant });

  const payload = JSON.stringify({ title: 'Ra7etBal', body: notificationBody });

  for (const sub of subscriptions) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
        { urgency: 'high', TTL: 300 },
      );
      console.log(`[task-confirm] owner push sent to sub=${sub.id}`);
    } catch (err) {
      const statusCode = err?.statusCode ?? null;
      console.error(`[task-confirm] owner push failed sub=${sub.id} status=${statusCode}:`, err?.message);
      if (statusCode === 410 || statusCode === 404) {
        await fetch(
          supabaseUrl + '/rest/v1/push_subscriptions?id=eq.' + encodeURIComponent(sub.id),
          { method: 'DELETE', headers },
        ).catch(() => {});
      }
    }
  }
}

export function buildOwnerPushBody({ description, assignedTo, variant }) {
  const assignee = (assignedTo || '').trim();
  const proofOwner = assignee ? `${assignee}'s` : 'the';

  if (variant === 'uncertain') {
    return `${assignee || 'Someone'} submitted proof for review: ${description}`;
  }
  if (variant === 'correction_limit') {
    return `${proofOwner.charAt(0).toUpperCase()}${proofOwner.slice(1)} proof for "${description}" still needs correction after multiple attempts. Carson stopped messaging — please review.`;
  }
  if (variant === 'substitute_review') {
    return `${assignee || 'Someone'} sent an alternative for review: ${description}`;
  }
  if (variant === 'substitute_delivery_failed') {
    return `${assignee ? `${assignee}'s` : 'The'} message about "${description}" could not be delivered — please review again.`;
  }
  return assignee
    ? `${assignee} confirmed: ${description}`
    : `Task confirmed: ${description}`;
}

function normalizeQualityReviewStatus(status) {
  return typeof status === 'string' ? status.trim().toLowerCase() : '';
}

async function readSupabaseRows(response) {
  const text = await response.text().catch(() => '');
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isOwnerReviewLockedStatus(status) {
  // Phase 8.1: substitute_review locks the same way uncertain does — the
  // owner, not the assignee, decides next. Without this, a replayed/duplicate
  // POST while a decision is pending would clear the task's review state out
  // from under an in-flight Approve/Reject/Custom Instruction action.
  return status === 'uncertain' || status === 'substitute_review';
}

function buildWorkerCorrectionNote(review) {
  const note = String(review?.note || '').trim();
  if (review?.status === 'fraud_suspected') {
    return note
      ? `${note} Please upload a new live proof photo.`
      : 'This proof does not look like a live completion photo. Please upload a new live proof photo.';
  }
  return note || 'This proof does not match the requested task. Please upload a new proof photo.';
}

// ── Quality Intelligence V1 helpers ───────────────────────────────────────────

/** Best-effort lookup of the companion delegation message for a task. */
async function fetchDelegationMessageContent({ supabaseUrl, serviceKey, taskId }) {
  try {
    const response = await fetch(
      supabaseUrl + '/rest/v1/messages?task_id=eq.' + encodeURIComponent(taskId) +
        '&select=content&limit=1',
      {
        headers: {
          apikey: serviceKey,
          Authorization: 'Bearer ' + serviceKey,
          'Content-Type': 'application/json',
        },
      },
    );
    if (!response.ok) return null;
    const rows = await response.json();
    return Array.isArray(rows) && rows[0]?.content ? rows[0].content : null;
  } catch {
    return null;
  }
}

async function fetchLatestCompletedCustomInstruction({ supabaseUrl, serviceKey, taskId }) {
  try {
    const response = await fetch(
      supabaseUrl + '/rest/v1/quality_substitute_decisions?task_id=eq.' + encodeURIComponent(taskId) +
        '&decision=eq.custom_instruction&status=eq.completed&outcome=eq.custom_instruction_sent' +
        '&select=requested_instruction&order=completed_at.desc&limit=1',
      {
        headers: {
          apikey: serviceKey,
          Authorization: 'Bearer ' + serviceKey,
          'Content-Type': 'application/json',
        },
      },
    );
    if (!response.ok) return null;
    const rows = await response.json();
    const instruction = Array.isArray(rows) ? rows[0]?.requested_instruction : null;
    return typeof instruction === 'string' && instruction.trim() ? instruction.trim() : null;
  } catch {
    return null;
  }
}

async function sendCorrectionRequest({ req, supabaseUrl, serviceKey, userId, taskId, assignedTo, correctionNote }) {
  const messageText = String(correctionNote || '').trim();
  if (!messageText || !userId || !assignedTo) return;

  const person = await findAssigneePerson({ supabaseUrl, serviceKey, userId, assignedTo });
  if (!person?.phone) {
    console.warn('[task-confirm] correction WhatsApp skipped — no assignee phone', { taskId, assignedTo });
    return;
  }

  const messageRecord = await createCorrectionMessageRecord({
    supabaseUrl,
    serviceKey,
    userId,
    recipient: person.name || assignedTo,
    messageText,
  });
  if (!messageRecord?.id) {
    console.warn('[task-confirm] correction WhatsApp skipped — message row not created', { taskId, assignedTo });
    return;
  }

  const appBaseUrl =
    (process.env.APP_BASE_URL || '').trim() ||
    `${req.headers?.['x-forwarded-proto'] || 'https'}://${req.headers?.host || 'ra7etbal.com'}`;

  const response = await fetch(`${appBaseUrl}/api/send-whatsapp-task`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to: person.phone,
      messageText,
      confirmationLink: null,
      messageRecordId: messageRecord.id,
      taskId: null,
      sendMode: 'direct_message',
      sourceType: 'quality_correction',
      recipientName: person.name || assignedTo,
      ownerName: null,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Correction WhatsApp send failed (${response.status}): ${text.slice(0, 200)}`);
  }
}

async function createCorrectionMessageRecord({ supabaseUrl, serviceKey, userId, recipient, messageText }) {
  const response = await fetch(`${supabaseUrl}/rest/v1/messages`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({
      user_id: userId,
      task_id: null,
      recipient,
      content: messageText,
      confirmation_url: null,
    }),
  });
  if (!response.ok) return null;
  const rows = await response.json().catch(() => []);
  return Array.isArray(rows) ? rows[0] : null;
}

async function findAssigneePerson({ supabaseUrl, serviceKey, userId, assignedTo }) {
  if (!userId || !assignedTo) return null;
  const response = await fetch(
    supabaseUrl + '/rest/v1/people?user_id=eq.' +
      encodeURIComponent(userId) + '&select=name,phone',
    {
      headers: {
        apikey: serviceKey,
        Authorization: 'Bearer ' + serviceKey,
        'Content-Type': 'application/json',
      },
    },
  );
  if (!response.ok) return null;
  const people = await response.json().catch(() => []);
  if (!Array.isArray(people)) return null;
  const target = String(assignedTo).trim().toLowerCase();
  return people.find((person) => String(person.name || '').trim().toLowerCase() === target) ?? null;
}

// ── Storage helpers (from get-confirm-task.js) ────────────────────────────────

export async function findOwnerPhone({ supabaseUrl, serviceKey, userId }) {
  if (!userId) return null;

  const response = await fetch(
    supabaseUrl + '/rest/v1/people?user_id=eq.' +
      encodeURIComponent(userId) + '&select=name,role,phone',
    {
      headers: {
        apikey: serviceKey,
        Authorization: 'Bearer ' + serviceKey,
        'Content-Type': 'application/json',
      },
    },
  );

  if (!response.ok) return null;
  const people = await response.json();
  if (!Array.isArray(people)) return null;

  const owner = people.find((person) => {
    const name = String(person.name || '').trim().toLowerCase();
    const role = String(person.role || '').trim().toLowerCase();
    return (name === 'boss' || role === 'boss') && person.phone;
  });

  return owner ? owner.phone : null;
}

async function getSignedImageUrl({ supabaseUrl, serviceKey, imagePath }) {
  if (!imagePath) return null;

  const BUCKET = 'task-images';
  const objectPath = imagePath.startsWith(`${BUCKET}/`)
    ? imagePath.slice(`${BUCKET}/`.length)
    : imagePath;

  try {
    const response = await fetch(
      `${supabaseUrl}/storage/v1/object/sign/${BUCKET}/${objectPath}`,
      {
        method: 'POST',
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ expiresIn: 3600 }),
      },
    );
    if (!response.ok) return null;
    const data = await response.json();
    if (!data?.signedURL) return null;
    return `${supabaseUrl}/storage/v1${data.signedURL}`;
  } catch {
    return null;
  }
}

/**
 * Signs one proof-photo upload slot at a fixed, index-scoped path
 * (`{userId}/{taskId}/proof/{index}.jpg`). Root cause of the historical
 * "Upload failed (400)" bug on re-upload after a Quality Intelligence
 * rejection: this signing call never set the upsert header, so a second
 * upload to the same (deterministic) path was rejected by Supabase Storage
 * as a conflict. `x-upsert: true` here is the fix — the same signed-URL
 * mechanics remain single-use per token, so the caller still needs a fresh
 * signed URL per attempt (unchanged), but the underlying object write itself
 * now succeeds on repeat submissions to the same slot.
 */
async function createSignedProofUploadUrl({ supabaseUrl, serviceKey, userId, taskId, index }) {
  if (!userId || !taskId) return null;

  const BUCKET = 'task-images';
  const objectPath = `${userId}/${taskId}/proof/${index}.jpg`;
  const storagePath = `${BUCKET}/${objectPath}`;

  try {
    const response = await fetch(
      `${supabaseUrl}/storage/v1/object/upload/sign/${BUCKET}/${objectPath}`,
      {
        method: 'POST',
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
          'x-upsert': 'true',
        },
        body: JSON.stringify({ expiresIn: 3600 }),
      },
    );
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      console.warn('[task-confirm] createSignedProofUploadUrl: Supabase returned non-ok', {
        index,
        status: response.status,
        body: errText.slice(0, 200),
      });
      return null;
    }
    const data = await response.json();
    if (!data?.url) {
      console.warn('[task-confirm] createSignedProofUploadUrl: no url in response', {
        index,
        keys: data ? Object.keys(data) : null,
        data: JSON.stringify(data).slice(0, 300),
      });
      return null;
    }
    const uploadUrl = `${supabaseUrl}/storage/v1${data.url}`;
    return { index, uploadUrl, storagePath };
  } catch {
    return null;
  }
}

/** Signs up to `count` proof-photo upload slots in parallel, dropping any that failed to sign. */
async function createSignedProofUploadUrls({ supabaseUrl, serviceKey, userId, taskId, count }) {
  const slots = await Promise.all(
    Array.from({ length: count }, (_, index) =>
      createSignedProofUploadUrl({ supabaseUrl, serviceKey, userId, taskId, index }),
    ),
  );
  return slots.filter(Boolean);
}

/**
 * Replaces the full set of proof-photo rows for a task with the paths just
 * submitted. Proof rows are discriminated from reference-photo rows in the
 * same task_attachments table by file_name = 'proof' (reference rows never
 * set file_name) — no schema change needed. Delete-then-insert rather than
 * upsert-by-path, since a resubmission may have fewer photos than before
 * (a removed slot must not linger as a stale row).
 */
async function replaceProofAttachments({ supabaseUrl, serviceKey, taskId, userId, proofImagePaths }) {
  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
  };

  const deleteRes = await fetch(
    `${supabaseUrl}/rest/v1/task_attachments?task_id=eq.${encodeURIComponent(taskId)}&file_name=eq.proof`,
    { method: 'DELETE', headers: { ...headers, Prefer: 'return=minimal' } },
  );
  if (!deleteRes.ok) {
    throw new Error(`Could not clear previous proof photos (status ${deleteRes.status})`);
  }

  if (proofImagePaths.length === 0) return;

  const rows = proofImagePaths.map((storagePath, index) => ({
    task_id: taskId,
    user_id: userId,
    storage_path: storagePath,
    file_name: 'proof',
    content_type: 'image/jpeg',
    sort_order: index,
  }));

  const insertRes = await fetch(`${supabaseUrl}/rest/v1/task_attachments`, {
    method: 'POST',
    headers: { ...headers, Prefer: 'return=minimal' },
    body: JSON.stringify(rows),
  });
  if (!insertRes.ok) {
    throw new Error(`Could not save proof photos (status ${insertRes.status})`);
  }
}

// ─── S2: Indeterminate OLG registration ─────────────────────────────────────

const QSTASH_BASE_URL = 'https://qstash.upstash.io/v2';
const UNCERTAIN_OLG_FOLLOW_UP_SECONDS = 4 * 60 * 60; // 4 hours

/**
 * Stamps uncertain_olg_registered_at on the task and schedules a QStash
 * follow-up at +4h to process-delegation-escalations with
 * { taskId, trigger: 'uncertain_olg' }.
 *
 * Non-fatal: a failure here does not block the task-confirm response. The
 * cron-based escalation path remains active as a fallback.
 *
 * COS Ch. 13.5 Amendment S2.
 */
export async function scheduleUncertainOLG({ supabaseUrl, serviceKey, taskId, appBaseUrl }) {
  const qstashToken = process.env.QSTASH_TOKEN;
  const cronSecret = process.env.CRON_SECRET;

  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
  };

  // Stamp the OLG registration timestamp on the task (best-effort).
  const patchRes = await fetch(
    `${supabaseUrl}/rest/v1/tasks?id=eq.${encodeURIComponent(taskId)}&status=eq.pending`,
    {
      method: 'PATCH',
      headers: { ...headers, Prefer: 'return=minimal' },
      body: JSON.stringify({ uncertain_olg_registered_at: new Date().toISOString() }),
    },
  );
  if (!patchRes.ok) {
    console.warn('[task-confirm] uncertain_olg_registered_at stamp failed (non-fatal):', {
      taskId,
      status: patchRes.status,
    });
  }

  if (!qstashToken) {
    console.warn('[task-confirm] QSTASH_TOKEN not set — uncertain OLG follow-up not scheduled (non-fatal)');
    return;
  }

  const resolvedBaseUrl = appBaseUrl || CANONICAL_APP_BASE_URL;
  const targetUrl = `${resolvedBaseUrl}/api/process-delegation-escalations`;
  const notBefore = Math.ceil(Date.now() / 1000) + UNCERTAIN_OLG_FOLLOW_UP_SECONDS;
  const dedupId = `uncertain-olg-${taskId}`;

  const qstashRes = await fetch(`${QSTASH_BASE_URL}/publish/${targetUrl}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${qstashToken}`,
      'Content-Type': 'application/json',
      'Upstash-Not-Before': String(notBefore),
      'Upstash-Deduplication-Id': dedupId,
      'Upstash-Retries': '3',
      ...(cronSecret ? { 'Upstash-Forward-Authorization': `Bearer ${cronSecret}` } : {}),
    },
    body: JSON.stringify({ taskId, trigger: 'uncertain_olg' }),
  });

  if (!qstashRes.ok) {
    const data = await qstashRes.json().catch(() => null);
    console.warn('[task-confirm] uncertain OLG QStash publish failed (non-fatal):', {
      taskId,
      status: qstashRes.status,
      error: data?.error,
    });
    return;
  }

  console.log('[task-confirm] uncertain OLG registered', { taskId, dedupId, notBefore });
}
