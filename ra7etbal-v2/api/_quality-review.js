/**
 * Quality Intelligence V1 — pure review logic, shared by api/task-confirm.js.
 *
 * Underscore-prefixed: Vercel does not deploy this as a Function (same
 * convention as _whatsapp-delivery.js), so it does not count against the
 * Hobby 12-function cap.
 */

const BUCKET = 'task-images';
const QUALITY_MODEL = 'claude-sonnet-4-6';

export const QUALITY_RESULTS = ['approved', 'correction_required', 'uncertain', 'fraud_suspected'];

/**
 * Downloads a Supabase Storage object directly (service role bypasses RLS)
 * and returns it as a base64 string. Returns null on any failure — callers
 * must treat a missing image as "not available", never as an error.
 */
export async function downloadImageAsBase64({ supabaseUrl, serviceKey, imagePath }) {
  if (!imagePath || !supabaseUrl || !serviceKey) return null;

  const objectPath = imagePath.startsWith(`${BUCKET}/`)
    ? imagePath.slice(`${BUCKET}/`.length)
    : imagePath;

  try {
    const response = await fetch(`${supabaseUrl}/storage/v1/object/${BUCKET}/${objectPath}`, {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
      },
    });
    if (!response.ok) return null;
    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength === 0) return null;
    return Buffer.from(arrayBuffer).toString('base64');
  } catch {
    return null;
  }
}

function buildReviewPrompt({ taskDescription, delegationMessage, hasReferenceImage, proofImageCount }) {
  const proofLabel = proofImageCount === 1 ? 'a proof photo' : `${proofImageCount} proof photos`;
  return `You are Carson, a meticulous quality reviewer for household/work task proof photos.

Task: "${taskDescription}"
Delegation message sent to the assignee: "${delegationMessage || 'none'}"
${
  hasReferenceImage
    ? `A reference image showing what the result should look like is attached first, followed by ${proofLabel} submitted by the assignee.`
    : `No reference image was provided for this task. Only ${proofLabel} submitted by the assignee ${proofImageCount === 1 ? 'is' : 'are'} attached. Judge them against the task description and delegation message alone.`
}
${proofImageCount > 1 ? 'Treat all attached proof photos together as one submission — approve only if they collectively satisfy the task.' : ''}

Decide exactly one outcome:
- APPROVED: the proof photo clearly satisfies the task as described.
- CORRECTION_REQUIRED: you can clearly see what's wrong and describe it specifically — wrong placement, missing item, visibly incomplete, or an entirely different/mismatched item than what was asked for (e.g. the wrong product, wrong color, wrong object altogether). A photo showing the WRONG item is still a clear, describable, fixable problem — it is CORRECTION_REQUIRED, not UNCERTAIN, as long as you can say what's wrong and what should be sent instead. Only flag a problem you can actually see in the photo — never invent or guess at issues that aren't visible.
- UNCERTAIN: reserve this only for genuine ambiguity where you cannot tell what's in the photo or whether it matches — for example the photo itself is blurry, too dark, or cropped so the relevant item isn't visible, the angle makes it impossible to judge, or there's no reference image and the task description is too vague to judge against. If you can clearly see the item and can clearly see that it does not match, that is CORRECTION_REQUIRED, never UNCERTAIN.
- FRAUD_SUSPECTED: the proof photo itself is not a genuine, live photo of the completed task — it's not just wrong or unclear, it's not real proof at all. Use this when the photo is a screenshot (product listing, marketplace page, menu, app UI, etc.), is the exact same image as the reference image reused as if it were new proof, is a stock/web image rather than a photo taken of a real physical item, or otherwise shows clear signs of not being a live photo of the actual completed task. This is about the photo's authenticity as proof, not about whether the item looks right — a real photo of the wrong item is CORRECTION_REQUIRED; a screenshot, a reused reference image, or any non-live image presented as proof is FRAUD_SUSPECTED.

If CORRECTION_REQUIRED, write a short, specific message addressed directly to the assignee by name, describing only the visible difference and what to do about it. One or two sentences, friendly but direct. Do not invent issues that are not visible in the photo.

If FRAUD_SUSPECTED, write one short sentence in "reasoning" explaining specifically why the photo does not look like genuine proof (e.g. "this looks like a screenshot of a product listing, not a photo of the item" or "this is the same image as the reference photo, not a new photo of the completed task").

Respond with ONLY this JSON and nothing else — no markdown fences, no commentary:
{"result":"APPROVED"|"CORRECTION_REQUIRED"|"UNCERTAIN"|"FRAUD_SUSPECTED","correction_message":"string or null","reasoning":"one short sentence"}`;
}

function parseReviewResponse(text) {
  if (!text) return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  const result = String(parsed.result || '').toLowerCase();
  if (!QUALITY_RESULTS.includes(result)) return null;
  return {
    status: result,
    note:
      result === 'correction_required'
        ? typeof parsed.correction_message === 'string' && parsed.correction_message.trim()
          ? parsed.correction_message.trim()
          : null
        : typeof parsed.reasoning === 'string' && parsed.reasoning.trim()
          ? parsed.reasoning.trim()
          : null,
  };
}

/**
 * Runs the Carson quality review. Never throws — any failure (missing API
 * key, network error, malformed model output, missing correction text for a
 * CORRECTION_REQUIRED result) falls safe to `uncertain` so the task is never
 * silently auto-approved or auto-rejected.
 */
export async function runQualityReview({
  apiKey,
  taskDescription,
  delegationMessage,
  referenceImageBase64,
  proofImagesBase64,
}) {
  const fallback = { status: 'uncertain', note: 'Could not complete an automated review — please check manually.' };

  const proofImages = (Array.isArray(proofImagesBase64) ? proofImagesBase64 : []).filter(Boolean);
  if (!apiKey || proofImages.length === 0) return fallback;

  const content = [
    {
      type: 'text',
      text: buildReviewPrompt({
        taskDescription,
        delegationMessage,
        hasReferenceImage: !!referenceImageBase64,
        proofImageCount: proofImages.length,
      }),
    },
  ];
  if (referenceImageBase64) {
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: referenceImageBase64 } });
  }
  for (const proofImageBase64 of proofImages) {
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: proofImageBase64 } });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: QUALITY_MODEL,
        max_tokens: 300,
        messages: [{ role: 'user', content }],
      }),
    });

    if (!response.ok) return fallback;

    const data = await response.json();
    const text = data?.content?.[0]?.text ?? null;
    const parsed = parseReviewResponse(text);
    if (!parsed) return fallback;

    // A CORRECTION_REQUIRED result with no usable message is not actionable
    // — fall back to uncertain rather than sending an empty WhatsApp message.
    if (parsed.status === 'correction_required' && !parsed.note) return fallback;

    return parsed;
  } catch {
    return fallback;
  } finally {
    clearTimeout(timeout);
  }
}
