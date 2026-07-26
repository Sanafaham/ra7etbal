/**
 * Confirmed production bug: a photo of a handwritten note (groceries, call
 * the doctor, tell Grace guests arrive at 7 PM) was attached to Christopher's
 * task even though the spoken instruction only said "buy groceries" — the
 * delegation code forwarded whatever photo was pending, regardless of
 * whether the instruction referenced it. The note's unrelated personal
 * items were exposed to staff.
 *
 * Owner-provided photos are private source material by default. The
 * original image may only be attached to a staff delegation when the
 * instruction either (a) explicitly asks to send/share/forward/show the
 * photo itself, or (b) refers to the photographed subject as the task's
 * actual content (e.g. "make this pizza", "order these"). Verbs like
 * "handle", "prepare", "make", "check", "review", or "respond" alone do not
 * qualify — only a deictic reference to the attached image does.
 */

const EXPLICIT_IMAGE_SHARE_RE =
  /\b(?:send|share|forward|show)\b[\s\S]{0,40}\b(?:photo|picture|pic|image|screenshot|snapshot)s?\b/i;

// Words that, immediately after a demonstrative, mean the demonstrative is
// pointing at the source material itself (the note/photo) or at a time
// expression — neither implies the photographed subject is the task.
const NON_VISUAL_FOLLOWERS = new Set([
  "photo", "photos", "picture", "pictures", "pic", "pics", "image", "images",
  "screenshot", "screenshots", "snapshot", "snapshots", "note", "notes",
  "list", "lists", "document", "documents", "message", "messages",
  "week", "weeks", "month", "months", "year", "years", "morning", "afternoon",
  "evening", "night", "time", "weekend", "one", "ones",
]);

function hasVisualTaskReference(text: string): boolean {
  const match = text.match(/\b(?:this|that|these|those)\b\s*([a-zA-Z]+)?/i);
  if (!match) return false;
  const followingWord = match[1]?.toLowerCase();
  // A bare demonstrative ("make this", "prepare these") points at the
  // attached photo itself with nothing else to name it by.
  if (!followingWord) return true;
  return !NON_VISUAL_FOLLOWERS.has(followingWord);
}

/**
 * Whether an attached photo may be forwarded to a staff delegation, based on
 * the raw instruction text. Defaults to false (private) — see module comment.
 */
export function shouldForwardAttachedImage(rawText: string | null | undefined): boolean {
  const text = (rawText ?? "").trim();
  if (!text) return false;
  if (EXPLICIT_IMAGE_SHARE_RE.test(text)) return true;
  return hasVisualTaskReference(text);
}
