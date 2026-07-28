/**
 * Normalizes owner-relative references in a direct-message body to refer to
 * the message's actual author — the owner — by name, so a staff recipient
 * never reads "me"/"I"/"my" as themselves.
 *
 * Both Talk and Type ultimately compose this body from the owner's own
 * words ("Tell Grace I have no Wi-Fi.", "Ask Grace to call me now.") —
 * without this step the worker receives that first-person text unchanged.
 * Called from the single shared delivery boundary every direct-message path
 * converges on (createDirectMessageRecord, in direct-messages.ts), so the
 * guarantee holds regardless of which channel or fast-path produced the
 * text — see direct-messages.ts and the "Type and Talk parity" tests in
 * carson-protected-behaviors.test.ts.
 *
 * Two deliberately conservative passes, not a blanket "me"/"I"/"my" ->
 * owner substitution:
 *   1. LEADING_SUBJECT_RULES — only the leading subject of the message
 *      ("I'm...", "I have...", "My...") is rewritten. Mid-sentence or
 *      quoted "I"/"my" is left untouched, since the speaker there may not
 *      be the owner.
 *   2. normalizeObjectPronoun — "me" as the object of a small, curated set
 *      of verbs/prepositions ("call me", "wait for me", "bring me the
 *      keys"). An unrelated mid-sentence "me" outside that list is left
 *      untouched.
 *
 * Never invents a gendered pronoun for the owner. The idiom "on my way" is
 * rewritten to the gender-neutral "on the way" rather than guessing "his"
 * or "her".
 */
export { normalizeFirstPersonForOwner } from "../../shared/owner-reference-normalization.js";
