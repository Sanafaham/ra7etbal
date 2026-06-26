/**
 * Merges a newly generated photo description into the existing session photo
 * context string used for Carson's voice contextual updates. Used when a
 * photo is attached mid-session, after the initial context for the call has
 * already been sent — the new description is appended rather than replacing
 * what Carson already knows.
 */
export function appendPhotoContextDescription(
  existing: string | null,
  addition: string | null,
): string | null {
  if (!addition) return existing;
  if (!existing) return addition;
  return `${existing}\n${addition}`;
}
