/**
 * Quality Intelligence V1 — pure review logic, shared by api/task-confirm.js.
 *
 * Underscore-prefixed: Vercel does not deploy this as a Function (same
 * convention as _whatsapp-delivery.js), so it does not count against the
 * Hobby 12-function cap.
 */

const BUCKET = 'task-images';
const QUALITY_MODEL = 'claude-sonnet-4-6';

export const QUALITY_RESULTS = ['approved', 'correction_required', 'uncertain'];

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

function buildReviewPrompt({ taskDescription, delegationMessage, hasReferenceImage }) {
  return `You are Carson, a meticulous quality reviewer for household/work task proof photos.

Task: "${taskDescription}"
Delegation message sent to the assignee: "${delegationMessage || 'none'}"
${
  hasReferenceImage
    ? 'A reference image showing what the result should look like is attached first, followed by the proof photo submitted by the assignee.'
    : 'No reference image was provided for this task. Only the proof photo submitted by the assignee is attached. Judge it against the task description and delegation message alone.'
}

Decide exactly one outcome:
- APPROVED: the proof photo clearly satisfies the task as described.
- CORRECTION_REQUIRED: the proof photo shows a clear, visible problem worth fixing (wrong placement, missing item, visibly incomplete, etc). Only flag a problem you can actually see in the photo — never invent or guess at issues that aren't visible.
- UNCERTAIN: you cannot tell confidently either way — for example the photo is unclear, the angle is ambiguous, or there's no reference image and the task description is too vague to judge against.

If CORRECTION_REQUIRED, write a short, specific message addressed directly to the assignee by name, describing only the visible difference and what to do about it. One or two sentences, friendly but direct. Do not invent issues that are not visible in the photo.

Respond with ONLY this JSON and nothing else — no markdown fences, no commentary:
{"result":"APPROVED"|"CORRECTION_REQUIRED"|"UNCERTAIN","correction_message":"string or null","reasoning":"one short sentence"}`;
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
  proofImageBase64,
}) {
  const fallback = { status: 'uncertain', note: 'Could not complete an automated review — please check manually.' };

  if (!apiKey || !proofImageBase64) return fallback;

  const content = [
    { type: 'text', text: buildReviewPrompt({ taskDescription, delegationMessage, hasReferenceImage: !!referenceImageBase64 }) },
  ];
  if (referenceImageBase64) {
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: referenceImageBase64 } });
  }
  content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: proofImageBase64 } });

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
