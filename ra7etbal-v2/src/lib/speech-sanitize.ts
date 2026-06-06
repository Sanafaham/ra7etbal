/**
 * speech-sanitize.ts
 *
 * Replaces written brand-name variants with the Arabic pronunciation
 * before text is sent to ElevenLabs as a dynamic variable.
 *
 * ElevenLabs reads Latin strings phonetically and mangles "Ra7etBal"
 * into variants like "RA7 ball" or "Raetbal". Substituting the Arabic
 * "راحة بال" makes the TTS engine pronounce it correctly.
 *
 * ONLY used for speech output. Never applied to:
 *   - Stored task / reminder text
 *   - WhatsApp messages
 *   - UI labels
 *   - Database content
 */

// Covers: Ra7etBal, RahetBal, Rahet Bal, Rahatbal, Rahat Bal
// and case-insensitive variants.
// Pattern: "ra" + ("7"|"h") + ("e"|"a") + "t" + optional space + "bal"
const BRAND_PATTERN = /ra[7h][ae]t\s?bal/gi;

const ARABIC_BRAND = "راحة بال";

/**
 * Replace all written Ra7etBal variants in a string with the Arabic brand name.
 * Safe to call on any text — no-op if the pattern is absent.
 */
export function sanitizeForCarsonSpeech(text: string): string {
  return text.replace(BRAND_PATTERN, ARABIC_BRAND);
}
