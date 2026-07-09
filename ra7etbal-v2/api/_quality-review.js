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
  const cacheBuster = `qi=${Date.now()}-${Math.random().toString(36).slice(2)}`;

  try {
    const response = await fetch(
      `${supabaseUrl}/storage/v1/object/${BUCKET}/${objectPath}?${cacheBuster}`,
      {
        cache: 'no-store',
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          'Cache-Control': 'no-cache, no-store, max-age=0',
          Pragma: 'no-cache',
        },
      },
    );
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

Important duplicate-image boundary:
- The system already performs an exact byte-for-byte duplicate check before you see the images.
- If a proof photo is the exact same uploaded file as the reference image, the system will classify it before calling you.
- Do NOT claim "pixel-for-pixel identical", "same image as the reference", or "reused reference image" based only on visual similarity.
- A correct proof photo may look very similar to the reference because the assignee completed the task correctly — that is expected and is a GOOD sign, not suspicious. Judge whether the proof satisfies the requested outcome, never how much it resembles the reference or how polished it looks.

Reference and proof photo style — read carefully, this is a common source of wrongly rejecting a correct proof:
- The reference image can be any kind of image the user chose to show what they want: a real photo, a screenshot, a studio product photo, an AI-generated image, a stock/web image, or a photo found online. That the reference looks staged, AI-generated, or stock-like says nothing about the proof.
- The submitted proof does NOT have to look "live," casual, or amateur to be valid. Clean lighting, a white/neutral background, professional composition, high image quality, or a proof that closely resembles the reference in style are all normal and are NEVER by themselves a reason to reject.
- NEVER choose CORRECTION_REQUIRED or FRAUD_SUSPECTED only because the proof looks polished, studio-like, stock-like, AI-generated, too clean, or too similar in composition/style to the reference. Judge only whether the item/outcome shown is what the task actually asked for.

Item-vs-location judgment:
- For "find this item and send a photo" tasks, approve when the correct item is clearly visible and matches the requested/reference item, even if the item is photographed on a neutral surface, fabric, couch, table, floor, or a different background than the reference photo.
- Treat location/background/context as helpful evidence, not a hard requirement, unless the task or delegation message explicitly asks for location proof.
- Examples that do NOT require location proof: "Find the perfume and send a photo", "Take a photo of the Cheirosa 68 mist", "Find this in the closet and send a photo." For these, approve a live photo of the correct item on a couch/table/fabric.
- Examples that DO require location proof: "Show me the perfume inside the cabinet", "Verify it is in the cabinet", "Send proof that it is on the shelf." For these, reject if the correct item is visible but the required location is not shown.

Decide exactly one outcome:
- APPROVED: the requested item/outcome is clearly correct, materially matches the task, and is a reasonable fulfillment of the request. This applies regardless of the proof photo's style, polish, or resemblance to the reference.
- CORRECTION_REQUIRED: you can clearly see what's wrong and describe it specifically — wrong required placement/location, missing item, visibly incomplete, or an entirely different/mismatched item than what was asked for (e.g. the wrong product, wrong color/variant when the exact variant matters, wrong object altogether). A photo showing the WRONG item is still a clear, describable, fixable problem — it is CORRECTION_REQUIRED, not UNCERTAIN, as long as you can say what's wrong and what should be sent instead. Only flag a problem you can actually see in the photo — never invent or guess at issues that aren't visible, and never treat polish, studio quality, or resemblance to the reference as a problem. Do not reject the correct item merely because it is on a different neutral surface/background unless location proof was explicitly requested.
- UNCERTAIN: reserve this only for genuine ambiguity where you cannot tell what's in the photo or whether it matches — for example the photo itself is blurry, too dark, or cropped so the relevant item isn't visible, the angle makes it impossible to judge, or there's no reference image and the task description is too vague to judge against. If you can clearly see the item and can clearly see that it does not match, that is CORRECTION_REQUIRED, never UNCERTAIN.
- FRAUD_SUSPECTED: the proof photo itself is not genuine proof of the completed task — not just wrong or unclear, but not real evidence of the task at all. Use this ONLY when there is strong, concrete evidence, such as the photo being a screenshot (product listing, marketplace page, menu, app UI, etc.), or the proof being the exact same reference image re-uploaded when the task clearly requires the assignee to do actual work (find, make, buy, or complete something) rather than just forward the reference back. This is about strong evidence the image isn't genuine proof, NOT about how polished, professional, stock-like, or AI-generated it looks — those are never sufficient evidence on their own. A real photo of the wrong item is CORRECTION_REQUIRED; a correct, well-composed, professional-looking photo of the right item is APPROVED.

If CORRECTION_REQUIRED, write a short, specific message addressed directly to the assignee by name, describing only the visible difference and what to do about it. One or two sentences, friendly but direct. Do not invent issues that are not visible in the photo.

If FRAUD_SUSPECTED, write one short sentence in "reasoning" explaining specifically why the photo does not look like genuine proof (e.g. "this looks like a screenshot of a product listing, not a photo of the item"). Do not describe the proof as pixel-for-pixel identical to the reference; exact duplicate detection is handled deterministically before model review.

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

function normalizeBase64(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, '') : '';
}

function hasExactReferenceDuplicate({ referenceImageBase64, proofImages }) {
  const reference = normalizeBase64(referenceImageBase64);
  if (!reference) return false;
  return proofImages.some((proofImage) => normalizeBase64(proofImage) === reference);
}

function isUnsupportedReferenceReuseClaim(note) {
  const text = String(note || '').toLowerCase();
  if (!text) return false;
  const claimsExactIdentity =
    /pixel[-\s]?for[-\s]?pixel/.test(text) ||
    /\bidentical\b/.test(text) ||
    /\bsame image\b/.test(text) ||
    /\bsame photo\b/.test(text) ||
    /\breused\b/.test(text) ||
    /\bre-use(?:d)?\b/.test(text);
  const tiesClaimToReference = /\breference\b/.test(text);
  // "stock"/"web image"/style-based wording is deliberately excluded here —
  // per product rule, looking stock-like or polished is never on its own
  // concrete evidence of fraud, so it must not block this safety net either.
  const independentlyNonLive =
    /\bscreenshot\b/.test(text) ||
    /\bscreen shot\b/.test(text) ||
    /\bproduct listing\b/.test(text) ||
    /\bmenu\b/.test(text) ||
    /\bapp ui\b/.test(text);
  return claimsExactIdentity && tiesClaimToReference && !independentlyNonLive;
}

function isConcreteNonLiveProofReason(note) {
  const text = String(note || '').toLowerCase();
  return (
    /\bscreenshot\b/.test(text) ||
    /\bscreen shot\b/.test(text) ||
    /\bproduct listing\b/.test(text) ||
    /\bmenu\b/.test(text) ||
    /\bapp ui\b/.test(text) ||
    /\bnot a new photo\b/.test(text) ||
    /\bexactly the same uploaded image\b/.test(text)
  );
}

/**
 * True when a rejection's stated reason is purely about visual style —
 * polished, studio-like, stock-like, AI-generated, too clean/professional,
 * or similar in composition to the reference — with no concrete mismatch
 * (isVisibleMismatchReason) or concrete non-live evidence
 * (isConcreteNonLiveProofReason) also present. Product rule: style alone is
 * never a valid reason to reject a proof.
 */
function isStyleOnlyRejectionReason(note) {
  const text = String(note || '').toLowerCase();
  if (!text) return false;

  const stylistic =
    /\bpolished\b/.test(text) ||
    /\bstudio\b/.test(text) ||
    /\bstock\b/.test(text) ||
    /\bai[-\s]?generated\b/.test(text) ||
    /\btoo (?:clean|perfect|professional|good)\b/.test(text) ||
    /\bprofessional(?:ly)?[-\s]?(?:lit|lighting|composition|photo|looking)\b/.test(text) ||
    /\bwhite background\b/.test(text) ||
    /\bclean background\b/.test(text) ||
    /\bsimilar(?:ity)? (?:to|in) (?:the )?(?:composition|reference|style)\b/.test(text) ||
    /\bresembles? the reference\b/.test(text) ||
    /\blooks like (?:a )?(?:stock|studio|product) (?:photo|image)\b/.test(text);

  if (!stylistic) return false;

  return !(isVisibleMismatchReason(text) || isConcreteNonLiveProofReason(text));
}

function isVisibleMismatchReason(note) {
  const text = String(note || '').toLowerCase();
  return (
    /\bwrong\b/.test(text) ||
    /\bdifferent\b/.test(text) ||
    /\bmismatch/.test(text) ||
    /\bdoes not match\b/.test(text) ||
    /\bdoesn't match\b/.test(text) ||
    /\bnot match\b/.test(text) ||
    /\bnot the requested\b/.test(text) ||
    /\bnot the correct\b/.test(text) ||
    /\binstead of\b/.test(text) ||
    /\bmissing\b/.test(text) ||
    /\bincomplete\b/.test(text)
  );
}

function correctionMessageFromFraudReason(note) {
  const base = String(note || '').trim();
  if (!base) {
    return 'This proof does not match the requested task. Please upload a new photo showing the correct result.';
  }
  if (/please/i.test(base) && /photo|proof|upload|send/i.test(base)) return base;
  return `${base} Please upload a new photo showing the correct result.`;
}

function hasExplicitLocationProofRequirement(...values) {
  const texts = values.map((value) => String(value || '').toLowerCase()).filter(Boolean);
  if (texts.length === 0) return false;

  const locationWords =
    '(?:cabinet|cupboard|closet|drawer|shelf|room|bathroom|toilet|kitchen|garage|car|table|counter|desk|bag|box|basket|fridge|freezer)';
  const placementWords = '(?:in|inside|on|under|at|beside|next to|within)';
  const proofVerbs = '(?:show|photograph|take\\s+(?:a\\s+)?photo|send\\s+(?:me\\s+)?(?:a\\s+)?photo|verify|confirm|prove|proof)';

  return texts.some((text) =>
    new RegExp(`\\b${proofVerbs}\\b[\\s\\S]{0,80}\\b${placementWords}\\s+(?:the\\s+)?${locationWords}\\b`).test(text) ||
    new RegExp(`\\b(?:verify|confirm|prove|proof)\\b[\\s\\S]{0,80}\\b(?:location|where\\s+it\\s+is|it\\s+is\\s+${placementWords}\\s+(?:the\\s+)?${locationWords})\\b`).test(text)
  );
}

function isLocationOnlyCorrection(note) {
  const text = String(note || '').toLowerCase();
  if (!text) return false;

  const mentionsLocationContext =
    /\blocation\b/.test(text) ||
    /\bbackground\b/.test(text) ||
    /\bcontext\b/.test(text) ||
    /\bsurface\b/.test(text) ||
    /\bfabric\b/.test(text) ||
    /\bcouch\b/.test(text) ||
    /\bsofa\b/.test(text) ||
    /\bbed\b/.test(text) ||
    /\btable\b/.test(text) ||
    /\bcounter\b/.test(text) ||
    /\bfloor\b/.test(text) ||
    /\bcabinet\b/.test(text) ||
    /\bcupboard\b/.test(text) ||
    /\bcloset\b/.test(text) ||
    /\bdrawer\b/.test(text) ||
    /\bshelf\b/.test(text) ||
    /\bnot (?:in|inside|on|under|at)\b/.test(text) ||
    /\boutside (?:of )?(?:the )?\w+/.test(text);

  if (!mentionsLocationContext) return false;

  const itemMismatch =
    /\bwrong (?:item|product|object|bottle|brand|color|size|variant)\b/.test(text) ||
    /\bdifferent (?:item|product|object|bottle|brand|color|size|variant)\b/.test(text) ||
    /\bnot the (?:requested|correct|same) (?:item|product|object|bottle|brand|color|size|variant)\b/.test(text) ||
    /\bdoes(?: not|n't) match (?:the )?(?:item|product|object|bottle|brand|color|size|variant)\b/.test(text) ||
    /\bmissing (?:the )?(?:item|product|object|bottle)\b/.test(text);

  return !itemMismatch;
}

function normalizeReviewResult(parsed) {
  if (
    (parsed.status === 'correction_required' || parsed.status === 'fraud_suspected') &&
    isStyleOnlyRejectionReason(parsed.note)
  ) {
    return {
      status: 'approved',
      note: 'Proof shows the correct result; image style or polish is not a valid reason to reject.',
    };
  }

  if (
    parsed.status === 'correction_required' &&
    isLocationOnlyCorrection(parsed.note) &&
    !hasExplicitLocationProofRequirement(parsed.taskDescription, parsed.delegationMessage)
  ) {
    return {
      status: 'approved',
      note: 'Correct item is visible; location was not explicitly required.',
    };
  }

  if (
    parsed.status === 'fraud_suspected' &&
    isVisibleMismatchReason(parsed.note) &&
    !isConcreteNonLiveProofReason(parsed.note)
  ) {
    return {
      status: 'correction_required',
      note: correctionMessageFromFraudReason(parsed.note),
    };
  }

  return { status: parsed.status, note: parsed.note };
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

  if (hasExactReferenceDuplicate({ referenceImageBase64, proofImages })) {
    return {
      status: 'fraud_suspected',
      note: 'The proof photo is exactly the same uploaded image as the reference, not a new photo of the completed task.',
    };
  }

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
    parsed.taskDescription = taskDescription;
    parsed.delegationMessage = delegationMessage;

    // A CORRECTION_REQUIRED result with no usable message is not actionable
    // — fall back to uncertain rather than sending an empty WhatsApp message.
    if (parsed.status === 'correction_required' && !parsed.note) return fallback;

    if (parsed.status === 'fraud_suspected' && isUnsupportedReferenceReuseClaim(parsed.note)) {
      return {
        status: 'approved',
        note: 'Proof matches the requested result; no deterministic duplicate was detected.',
      };
    }

    return normalizeReviewResult(parsed);
  } catch {
    return fallback;
  } finally {
    clearTimeout(timeout);
  }
}
