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
 * decision     — involves selecting, choosing, planning, or coordinating
 *               something where judgment or aesthetic taste matters.
 * execution    — doing a defined task that doesn't require choices
 *               (clean, set the table, buy a specific known item, run an errand).
 */
type TaskContext = "verification" | "decision" | "execution";

/**
 * Classify the task so personality notes are only applied where relevant.
 * Verification is checked first — it overrides all other signals.
 *
 * Dinner is a decision signal only when the task is about supporting,
 * planning, choosing, or suggesting for dinner — not when "dinner" is
 * just a time reference in an execution task (e.g. "set the table for dinner",
 * "buy ingredients for dinner").
 */
function classifyTask(taskLower: string): TaskContext {
  // Verification: primary action is checking, finding, or reporting.
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
    /\bsuggest\b/.test(taskLower) ||
    // Dinner as a decision signal only when the task is about supporting or
    // planning dinner — not when dinner is just a time reference.
    /\bhelp\s+\w+.*\bdinner\b/.test(taskLower)
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
  const rawTask = cleanTaskText(taskText);
  const { task, hadPlease } = stripLeadingPlease(rawTask);
  const p = hadPlease ? "please " : "";
  const notes = (personNotes ?? "").toLowerCase();
  const taskLower = task.toLowerCase();
  const context = classifyTask(taskLower);

  // ── Over-control / bossy ──────────────────────────────────────────────────
  // Decision-boundary language only makes sense when the task involves
  // real choices. Verification and execution tasks get no control language.
  if (hasAny(notes, ["over-control", "over control", "controlling", "bossy", "take over", "takes over"])) {
    const collaborativeTask = lowerFirst(task);

    if (context === "verification") {
      return `Hi ${name}, could you ${p}${collaborativeTask} and let ${owner} know what you find?`;
    }

    if (context === "decision") {
      // Flowers: visual choice → ask for a photo first.
      if (/\bflowers\b/.test(taskLower)) {
        return `Hi ${name}, could you ${p}${collaborativeTask}? Please send ${owner} a photo before you choose.`;
      }
      // Supporting someone with dinner → keep it simple, don't override.
      if (/\bhelp\s+\w+.*\bdinner\b/.test(taskLower)) {
        return `Hi ${name}, could you ${p}${collaborativeTask}? Please check with ${owner} before changing anything important.`;
      }
      // General choice task (menu, plan, organize, suggest, etc.).
      return `Hi ${name}, could you ${p}${collaborativeTask}? Please check with ${owner} before choosing.`;
    }

    // Execution: no choices — just confirm.
    return `Hi ${name}, could you ${p}${collaborativeTask}? Confirm when done.`;
  }

  // ── Menu / misses details ─────────────────────────────────────────────────
  if (hasAny(notes, ["menu", "miss details", "misses details", "clear menu", "dinner preparation"])) {
    if (context === "verification") {
      return `Hi ${name}, ${p}${lowerFirst(task)}. Let ${owner} know what you find.`;
    }
    const detailLine = taskLower.includes("dinner")
      ? "Stick to the plan and let me know when it is ready."
      : "Keep to the details and confirm when done.";
    return `Hi ${name}, ${p}${lowerFirst(task)}. ${detailLine}`;
  }

  // ── Needs clear instructions ──────────────────────────────────────────────
  if (hasAny(notes, ["clear instructions", "firmer follow-up", "firmer follow up", "needs clear", "specific instructions"])) {
    return `Hi ${name}, ${p}${lowerFirst(task)}. Confirm when finished.`;
  }

  // ── Reliable / responsible ────────────────────────────────────────────────
  if (hasAny(notes, ["reliable", "punctual", "responsible", "always on time"])) {
    return `Hi ${name}, ${p}${lowerFirst(task)}. Confirm when done.`;
  }

  // ── Protective / bodyguard ────────────────────────────────────────────────
  if (hasAny(notes, ["protective", "bodyguard", "strong"])) {
    return `Hi ${name}, ${p}${lowerFirst(task)}. Confirm when done.`;
  }

  // ── Default: no matching personality note ─────────────────────────────────
  if (context === "verification") {
    return `Hi ${name}, could you ${p}${lowerFirst(task)} and let ${owner} know what you find?`;
  }

  // Safety net: if urgency words reached the description (instead of going to
  // personalNote via extraction), surface them naturally in the request.
  // This handles the case where the extraction model embedded urgency in the
  // task text rather than routing it through personalNote.
  const urgencyInTask = /\b(urgent(ly)?|asap|as soon as possible|right away|immediately)\b/i.test(taskLower);
  if (urgencyInTask) {
    // Strip the urgency adverb from the task so we can control placement.
    const cleanedTask = task.replace(/\b(urgent(ly)?|asap|as soon as possible|right away|immediately)\b/gi, "").replace(/\s{2,}/g, " ").trim().replace(/[,]+$/, "").trim();
    return `Hi ${name}, could you ${p}${lowerFirst(cleanedTask)} as soon as possible? ${owner} would appreciate it.`;
  }

  // Use lowerFirst so "call Sana" stays lowercase after "could you".
  return `Hi ${name}, could you ${p}${lowerFirst(task)}? Let ${owner} know when done.`;
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

function stripLeadingPlease(text: string): { task: string; hadPlease: boolean } {
  const match = /^please\s+/i.exec(text);
  if (match) {
    return { task: text.slice(match[0].length), hadPlease: true };
  }
  return { task: text, hadPlease: false };
}
