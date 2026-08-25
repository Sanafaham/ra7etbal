/**
 * Quality Intelligence V1 — pure review logic, shared by api/task-confirm.js.
 *
 * Underscore-prefixed: Vercel does not deploy this as a Function (same
 * convention as _whatsapp-delivery.js), so it does not count against the
 * Hobby 12-function cap.
 */

const BUCKET = 'task-images';
const QUALITY_MODEL = 'claude-sonnet-4-6';

export const QUALITY_RESULTS = ['approved', 'correction_required', 'uncertain', 'fraud_suspected', 'substitute_review'];

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

/**
 * Christopher substitution / alternative-selection defect fix: the ONLY
 * recognized pre-existing authority for a same-category/different-attribute
 * substitution (see AUTHORIZATION FOR SUBSTITUTIONS in buildReviewPrompt and
 * isSubstituteReviewUnauthorized below). Same table/query shape already used
 * by api/_staff-comms-engine.js's loadStaffContext for the same purpose.
 * Never throws — a failure here must fail closed to "no authority", not
 * silently grant one, so any error returns null exactly like an empty rule.
 */
export async function fetchHouseholdRulesText({ supabaseUrl, serviceKey, userId }) {
  if (!userId || !supabaseUrl || !serviceKey) return null;
  try {
    const response = await fetch(
      `${supabaseUrl}/rest/v1/household_rules?user_id=eq.${encodeURIComponent(userId)}&select=rules&limit=1`,
      {
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
        },
      },
    );
    if (!response.ok) return null;
    const rows = await response.json();
    return Array.isArray(rows) && rows[0]?.rules ? rows[0].rules : null;
  } catch {
    return null;
  }
}

function buildReviewPrompt({ taskDescription, delegationMessage, referenceImageCount, proofImageCount, workerReply, householdRulesText }) {
  const proofLabel = proofImageCount === 1 ? 'a proof photo' : `${proofImageCount} proof photos`;
  const referenceLabel = referenceImageCount === 1 ? 'A reference image' : `${referenceImageCount} reference images`;
  return `You are Carson, a meticulous quality reviewer for household/work task proof photos.

Task: "${taskDescription}"
Delegation message sent to the assignee: "${delegationMessage || 'none'}"
${workerReply ? `The assignee added this note when submitting proof: "${workerReply}"\n` : ''}${
  householdRulesText
    ? `Stored household rules (the ONLY recognized pre-existing authority for a substitution — see AUTHORIZATION below): "${householdRulesText}"\n`
    : ''
}${
  referenceImageCount > 0
    ? `${referenceLabel} showing what the result should look like ${referenceImageCount === 1 ? 'is' : 'are'} attached first, followed by ${proofLabel} submitted by the assignee.${
        referenceImageCount > 1 || proofImageCount > 1
          ? ' When there is more than one reference image or more than one proof photo, treat each group as a whole: the reference images together show everything that was requested, and the proof photos together show everything that was submitted. Do not assume any specific reference photo corresponds to any specific proof photo by position or order — judge whether the full set of proof photos, taken together, satisfies everything shown across the full set of reference photos.'
          : ''
      }`
    : `No reference image was provided for this task. Only ${proofLabel} submitted by the assignee ${proofImageCount === 1 ? 'is' : 'are'} attached. Judge them against the task description and delegation message alone.`
}
${proofImageCount > 1 ? 'Treat all attached proof photos together as one submission — approve only if they collectively satisfy the task.' : ''}

Image identity/similarity boundary — read carefully, this is a common source of wrongly rejecting a correct proof:
- A proof photo may be identical, nearly identical, or very similar to the reference image. That is NEVER by itself suspicious or a reason to reject — it usually just means the assignee completed the task correctly, or the requested item/state genuinely has not changed.
- Do NOT claim "pixel-for-pixel identical", "same image as the reference", "reused reference image", or "not a live/new photo" as a reason for CORRECTION_REQUIRED or FRAUD_SUSPECTED. Identity or similarity to the reference is never evidence of anything on its own — judge only whether the item/outcome shown is what the task actually asked for.
- A correct proof photo may look very similar to, or exactly like, the reference because the assignee completed the task correctly, or because the correct state of the item genuinely has not changed — that is expected and is a GOOD sign, not suspicious. Judge whether the proof satisfies the requested outcome, never how much it resembles the reference, how "live" it looks, or how polished it looks.

Reference and proof photo style — read carefully, this is a common source of wrongly rejecting a correct proof:
- The reference image can be any kind of image the user chose to show what they want: a real photo, a screenshot, a studio product photo, an AI-generated image, a stock/web image, or a photo found online. That the reference looks staged, AI-generated, or stock-like says nothing about the proof.
- The submitted proof does NOT have to look "live," casual, or amateur to be valid. Clean lighting, a white/neutral background, professional composition, high image quality, or a proof that closely resembles or exactly matches the reference in style are all normal and are NEVER by themselves a reason to reject.
- NEVER choose CORRECTION_REQUIRED or FRAUD_SUSPECTED only because the proof looks polished, studio-like, stock-like, internet-looking, found-online-looking, AI-generated, too clean, too similar, or identical to the reference in composition/style. Judge only whether the item/outcome shown is what the task actually asked for.

Item-vs-location judgment:
- For "find this item and send a photo" tasks, approve when the correct item is clearly visible and matches the requested/reference item, even if the item is photographed on a neutral surface, fabric, couch, table, floor, or a different background than the reference photo.
- Treat location/background/context as helpful evidence, not a hard requirement, unless the task or delegation message explicitly asks for location proof.
- Examples that do NOT require location proof: "Find the perfume and send a photo", "Take a photo of the Cheirosa 68 mist", "Find this in the closet and send a photo." For these, approve a live photo of the correct item on a couch/table/fabric.
- Examples that DO require location proof: "Show me the perfume inside the cabinet", "Verify it is in the cabinet", "Send proof that it is on the shelf." For these, reject if the correct item is visible but the required location is not shown.

AUTHORIZATION FOR SUBSTITUTIONS — read carefully, this is the difference between SUBSTITUTE_REVIEW/APPROVED and CORRECTION_REQUIRED for a same-category/different-attribute item:
- The default, for a same-category/different-attribute item (see SUBSTITUTE_REVIEW's definition below), is that it is NOT authorized. Authorization must have existed BEFORE the assignee acted — proof photo timing has no bearing on this, and an assignee's note asking "is this okay?" attached to the proof is asking AFTER acting, not before, and never counts as prior authorization.
- The ONLY recognized pre-existing authority available to you here is the stored household rules text supplied above (when present). If it EXPLICITLY and unambiguously covers this exact substitution for this exact item, the substitution is authorized: treat the submitted item as if it were the originally requested item and judge APPROVED/CORRECTION_REQUIRED/etc. normally against it — do not use SUBSTITUTE_REVIEW in this case, since there is no decision left for the owner to make.
- Never infer authorization merely because the substitute seems reasonable, low-stakes, same-category, cheaper, or more convenient, or because swapping it seems like an obviously normal thing to do — mere similarity, plausibility, or convenience is never authorization on its own. Only an explicit, on-point stored rule counts. "Blueberries are similar to strawberries" is never authorization; a stored rule that says "blueberries may substitute for strawberries" is.
- If there is no household rules text, or the household rules text does not explicitly cover this exact substitution, there is no authorization — do not use SUBSTITUTE_REVIEW; use CORRECTION_REQUIRED instead, exactly as if it were an unauthorized mismatched item, because it is one.

Decide exactly one outcome, in this order — check APPROVED first, then SUBSTITUTE_REVIEW, then CORRECTION_REQUIRED:
- APPROVED: the requested item/outcome is clearly correct, materially matches the task, and is a reasonable fulfillment of the request. This applies regardless of the proof photo's style, polish, or resemblance to the reference. This also applies to a same-category/different-attribute item that the stored household rules explicitly authorize (see AUTHORIZATION above) — judge it as the approved substitute item, not the original.
- SUBSTITUTE_REVIEW: reserved ONLY for a same-category/different-attribute item (different color, variant, brand, size, flavor, model, or an equivalent product serving the same purpose) that stored household rules explicitly authorize but where the specific terms still need owner confirmation. In practice this will be rare, since an explicit covering rule usually resolves straight to APPROVED. Do NOT use SUBSTITUTE_REVIEW merely because the item is a plausible, same-category, or similar substitute with no explicit prior authorization — see CORRECTION_REQUIRED below, that is the correct outcome for an unauthorized substitute regardless of how reasonable it looks. Do NOT use SUBSTITUTE_REVIEW for normal variation of the SAME item — a different plate, background, lighting, angle, portion, or garnish is still the same item and is APPROVED. Do NOT use SUBSTITUTE_REVIEW for a completely wrong/unrelated item in a different product category — that is CORRECTION_REQUIRED.
- CORRECTION_REQUIRED: the assignee sent an entirely different/mismatched item from a completely different product category, or an object with no plausible relationship to the task — wrong item entirely, missing item, visibly incomplete (e.g. shoes when a pen was requested, food when stationery was requested, IQOS sticks when a pen was requested, an empty shelf when an item was expected). Also use for wrong required placement/location. A photo showing the WRONG item is still a clear, describable, fixable problem — it is CORRECTION_REQUIRED, not UNCERTAIN, as long as you can say what's wrong and what should be sent instead. Only flag a problem you can actually see in the photo — never invent or guess at issues that aren't visible, and never treat polish, studio quality, or resemblance to the reference as a problem. Do not reject the correct item merely because it is on a different neutral surface/background unless location proof was explicitly requested. IMPORTANT (see AUTHORIZATION above): a same-category/different-attribute item — a white pen when a blue pen was requested, Pepsi when Coke was requested, mushroom pizza when pepperoni was requested, TEREA Turquoise when TEREA Silver was requested, a different brand of milk, an A5 notebook when A4 was requested, and similar — is CORRECTION_REQUIRED, not SUBSTITUTE_REVIEW, UNLESS stored household rules explicitly authorize that exact substitution. The assignee's own note explaining the swap is never sufficient authorization on its own, whether it accompanies the proof or arrives afterward — only a pre-existing stored rule is. When writing the correction message for an unauthorized substitute, ask for the originally requested item and note that any substitution needs to be proposed and approved before acting, not after.
- UNCERTAIN: reserve this only for genuine ambiguity where you cannot tell what's in the photo or whether it matches — for example the photo itself is blurry, too dark, or cropped so the relevant item isn't visible, the angle makes it impossible to judge, or there's no reference image and the task description is too vague to judge against. If you can clearly see the item and can clearly see that it does not match, that is CORRECTION_REQUIRED, never UNCERTAIN.
- FRAUD_SUSPECTED: the proof photo itself is not genuine proof of the completed task — not just wrong or unclear, but not real evidence of the task at all. Use this ONLY when there is strong, concrete evidence that the image is not a photo of a real physical item or scene at all, such as the photo being a screenshot (product listing, marketplace page, menu, app UI, etc.). This is about strong evidence the image isn't a photo, NOT about how polished, professional, stock-like, AI-generated, similar to, or identical to the reference it looks — those are never sufficient evidence on their own, and identity or similarity to the reference is never grounds for FRAUD_SUSPECTED. A real photo of the wrong item is CORRECTION_REQUIRED; a correct, well-composed, professional-looking, or reference-identical photo of the right item is APPROVED.

If CORRECTION_REQUIRED, write a short, specific message addressed directly to the assignee by name, describing only the visible difference and what to do about it. One or two sentences, friendly but direct. Do not invent issues that are not visible in the photo.

If FRAUD_SUSPECTED, write one short sentence in "reasoning" explaining specifically why the photo does not look like genuine proof (e.g. "this looks like a screenshot of a product listing, not a photo of the item"). Never justify FRAUD_SUSPECTED by describing the proof as identical, nearly identical, or similar to the reference — that is never valid evidence.

Respond with ONLY this JSON and nothing else — no markdown fences, no commentary:
{"result":"APPROVED"|"SUBSTITUTE_REVIEW"|"CORRECTION_REQUIRED"|"UNCERTAIN"|"FRAUD_SUSPECTED","correction_message":"string or null","reasoning":"one short sentence"}`;
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

// "not a new photo" / "exactly the same uploaded image" are deliberately
// excluded here — per product rule (QI V1), a proof being the same as or
// similar to the reference is never concrete evidence of anything on its
// own, so it must never count as a valid non-live reason either.
function isConcreteNonLiveProofReason(note) {
  const text = String(note || '').toLowerCase();
  return (
    /\bscreenshot\b/.test(text) ||
    /\bscreen shot\b/.test(text) ||
    /\bproduct listing\b/.test(text) ||
    /\bmenu\b/.test(text) ||
    /\bapp ui\b/.test(text)
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
    /\binternet\b/.test(text) ||
    /\bweb image\b/.test(text) ||
    /\bonline\b/.test(text) ||
    /\bai[-\s]?generated\b/.test(text) ||
    /\btoo (?:clean|perfect|professional|good)\b/.test(text) ||
    /\bprofessional(?:ly)?[-\s]?(?:lit|lighting|composition|photo|looking)\b/.test(text) ||
    /\bwhite background\b/.test(text) ||
    /\bclean background\b/.test(text) ||
    /\bsimilar(?:ity)? (?:to|in) (?:the )?(?:composition|reference|style)\b/.test(text) ||
    /\bresembles? the reference\b/.test(text) ||
    /\blooks like (?:a |an )?(?:stock|studio|product|internet|web) (?:photo|image)\b/.test(text);

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

// Christopher substitution / alternative-selection defect (product rule
// traced to July 15 work): the model is instructed not to use
// SUBSTITUTE_REVIEW without an explicit covering household rule, but that
// judgment is still a wording-dependent LLM decision. Per the owner's
// explicit architecture instruction, add a deterministic safety net for the
// one case that needs no semantic judgment at all — when NO household rules
// text exists for this user, no authority could possibly exist, so a
// model-returned SUBSTITUTE_REVIEW is always wrong and is downgraded here,
// unconditionally, to CORRECTION_REQUIRED. When household rules text DOES
// exist, whether it covers this specific substitution is a real judgment
// call the prompt instructions govern — this safety net does not touch that
// case, matching the regression requirement that SUBSTITUTE_REVIEW must not
// be blindly downgraded merely because some (possibly unrelated) rules text
// exists.
function isSubstituteReviewUnauthorized(status, householdRulesText) {
  return status === 'substitute_review' && !String(householdRulesText || '').trim();
}

function normalizeReviewResult(parsed) {
  if (isSubstituteReviewUnauthorized(parsed.status, parsed.householdRulesText)) {
    return {
      status: 'correction_required',
      note:
        parsed.note ||
        'This does not match what was requested. Please send the item originally asked for — any substitution needs to be proposed and approved before making a change, not after.',
    };
  }

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
  referenceImagesBase64,
  proofImagesBase64,
  workerReply,
  householdRulesText,
}) {
  const fallback = { status: 'uncertain', note: 'Could not complete an automated review — please check manually.' };

  const referenceImages = (Array.isArray(referenceImagesBase64) ? referenceImagesBase64 : []).filter(Boolean);
  const proofImages = (Array.isArray(proofImagesBase64) ? proofImagesBase64 : []).filter(Boolean);
  if (!apiKey || proofImages.length === 0) return fallback;

  // QI V1 product rule: a proof photo being identical or similar to the
  // reference is never on its own grounds for rejection — it usually just
  // means the task was completed correctly (or the correct state hasn't
  // changed). There is deliberately no deterministic exact-duplicate check
  // here; every proof is judged by the model against the requested outcome.
  const content = [
    {
      type: 'text',
      text: buildReviewPrompt({
        taskDescription,
        delegationMessage,
        referenceImageCount: referenceImages.length,
        proofImageCount: proofImages.length,
        workerReply,
        householdRulesText,
      }),
    },
  ];
  for (const referenceImageBase64 of referenceImages) {
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
    parsed.householdRulesText = householdRulesText;

    // A CORRECTION_REQUIRED result with no usable message is not actionable
    // — fall back to uncertain rather than sending an empty WhatsApp message.
    if (parsed.status === 'correction_required' && !parsed.note) return fallback;

    if (parsed.status === 'fraud_suspected' && isUnsupportedReferenceReuseClaim(parsed.note)) {
      return {
        status: 'approved',
        note: 'Proof matches the requested result; identity or similarity to the reference is not a valid reason to reject.',
      };
    }

    return normalizeReviewResult(parsed);
  } catch {
    return fallback;
  } finally {
    clearTimeout(timeout);
  }
}
