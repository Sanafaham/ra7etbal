interface DelegationMessageInput {
  personName: string;
  taskText: string;
  personNotes?: string | null;
  ownerName?: string | null;
}

/**
 * Three broad task contexts used to gate which parts of a person's
 * personality notes are actually relevant.
 *
 * verification — factual check, finding an item, confirming existence,
 *               taking a photo, reporting back. No choices involved.
 * decision     — involves selecting, choosing, planning, arranging, or
 *               coordinating something where judgment matters.
 * execution    — doing a defined task that doesn't require choices
 *               (clean, pick up a specific known item, run an errand).
 */
type TaskContext = "verification" | "decision" | "execution";

/**
 * Classify the task so personality notes are only applied where relevant.
 * Verification is checked first — it overrides all other signals.
 */
function classifyTask(taskLower: string): TaskContext {
  // Verification: primary action is checking, confirming, finding, or
  // reporting on the existence / state of something.
  if (
    /\bcheck\s+(if|whether|on|that)\b/.test(taskLower) ||
    /\bverify\b/.test(taskLower) ||
    /\bsee\s+if\b/.test(taskLower) ||
    /\bfind\s+out\b/.test(taskLower) ||
    /\bis\s+(there|it|this)\b/.test(taskLower) ||
    /\btake\s+a?\s*photo\b/.test(taskLower) ||
    /\breport\s+back\b/.test(taskLower) ||
    /\bconfirm\s+(if|whether)\b/.test(taskLower)
  ) {
    return "verification";
  }

  // Decision: involves choosing, planning, selecting, or aesthetic judgment.
  if (
    /\b(choose|select|decide)\b/.test(taskLower) ||
    /\bpick\s+out\b/.test(taskLower) ||
    /\b(plan|coordinate|organize|arrange)\b/.test(taskLower) ||
    /\bflowers\b/.test(taskLower) ||
    /\b(decor|decorations?|menu)\b/.test(taskLower) ||
    /\bdinner\b/.test(taskLower)
  ) {
    return "decision";
  }

  return "execution";
}

export function buildDelegationMessage({
  personName,
  taskText,
  personNotes,
  ownerName,
}: DelegationMessageInput): string {
  const name = personName.trim();
  const owner = ownerName?.trim() || "Sana";
  const task = cleanTaskText(taskText);
  const notes = (personNotes ?? "").toLowerCase();
  const taskLower = task.toLowerCase();
  const taskSentence = sentenceCase(task);
  const context = classifyTask(taskLower);

  // ── Over-control / bossy ──────────────────────────────────────────────────
  // Decision-control language only makes sense when the task involves
  // actual choices. For verification and execution tasks, skip it entirely.
  if (hasAny(notes, ["over-control", "over control", "controlling", "bossy", "take over", "takes over"])) {
    const collaborativeTask = lowerFirst(task);

    if (context === "verification") {
      // Simple factual check — no decisions involved, no control language.
      return `Hi ${name}, could you ${collaborativeTask} and let ${owner} know what you find?`;
    }

    if (context === "decision") {
      // Task involves choices or planning — apply the control boundary.
      const decisionLine = taskLower.includes("dinner")
        ? `Please help keep things on track while letting ${owner} handle the final decisions.`
        : `Please check with ${owner} before making final selections.`;
      return `Hi ${name}, could you ${collaborativeTask}? ${decisionLine}`;
    }

    // Execution: no choices involved — just confirm completion.
    return `Hi ${name}, could you ${collaborativeTask}? Confirm when done.`;
  }

  // ── Menu / misses details ─────────────────────────────────────────────────
  // "Follow the details" / "follow the menu" language is irrelevant for a
  // simple check — don't append it when the task is verification.
  if (hasAny(notes, ["menu", "miss details", "misses details", "clear menu", "dinner preparation"])) {
    if (context === "verification") {
      return `Hi ${name}, please ${lowerFirst(task)}. Let ${owner} know what you find.`;
    }
    const detailLine = taskLower.includes("dinner")
      ? "Follow the menu closely and confirm when it is ready."
      : "Follow the details closely and confirm when it is done.";
    return `Hi ${name}, please ${lowerFirst(task)}. ${detailLine}`;
  }

  // ── Needs clear instructions ──────────────────────────────────────────────
  if (hasAny(notes, ["clear instructions", "firmer follow-up", "firmer follow up", "needs clear", "specific instructions"])) {
    return `Hi ${name}, please ${lowerFirst(task)}. Confirm when finished.`;
  }

  // ── Reliable / responsible ────────────────────────────────────────────────
  if (hasAny(notes, ["reliable", "punctual", "responsible", "always on time"])) {
    return `Hi ${name}, please ${lowerFirst(task)}. Confirm when done.`;
  }

  // ── Protective / bodyguard ────────────────────────────────────────────────
  if (hasAny(notes, ["protective", "bodyguard", "strong"])) {
    return `Hi ${name}, please ${lowerFirst(task)}. Confirm when done.`;
  }

  // ── Default: no matching personality note ─────────────────────────────────
  if (context === "verification") {
    return `Hi ${name}, could you ${lowerFirst(task)} and let ${owner} know what you find?`;
  }
  return `Hi ${name}, could you please ${taskSentence}? Let ${owner} know when done.`;
}

function hasAny(value: string, needles: string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}

function cleanTaskText(value: string): string {
  return value.trim().replace(/\s+/g, " ").replace(/[?.!]+$/g, "");
}

function lowerFirst(value: string): string {
  return value ? value.charAt(0).toLowerCase() + value.slice(1) : value;
}

function sentenceCase(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}
