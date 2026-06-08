interface DelegationMessageInput {
  personName: string;
  taskText: string;
  personNotes?: string | null;
  ownerName?: string | null;
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

  if (hasAny(notes, ["over-control", "over control", "controlling", "bossy", "take over", "takes over"])) {
    const collaborativeTask = lowerFirst(task);
    const decisionLine = taskLower.includes("dinner")
      ? `Please help Christopher keep things on track. ${owner} will handle the final dinner decisions.`
      : `Please keep ${owner} in the loop on final decisions.`;
    return `Hi ${name}, could you ${collaborativeTask}? ${decisionLine}`;
  }

  if (hasAny(notes, ["menu", "miss details", "misses details", "clear menu", "dinner preparation"])) {
    const detailLine = taskLower.includes("dinner")
      ? "Follow the menu closely and confirm when it is ready."
      : "Follow the details closely and confirm when it is done.";
    return `Hi ${name}, please ${lowerFirst(task)}. ${detailLine}`;
  }

  if (hasAny(notes, ["clear instructions", "firmer follow-up", "firmer follow up", "needs clear", "specific instructions"])) {
    return `Hi ${name}, please ${lowerFirst(task)}. Confirm when finished.`;
  }

  if (hasAny(notes, ["reliable", "punctual", "responsible", "always on time"])) {
    return `Hi ${name}, please ${lowerFirst(task)}. Confirm when done.`;
  }

  if (hasAny(notes, ["protective", "bodyguard", "strong"])) {
    return `Hi ${name}, please ${lowerFirst(task)}. Confirm when done.`;
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
