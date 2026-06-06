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

const ARABIC_BRAND = "راحة بال";

// ---------------------------------------------------------------------------
// Pattern list — ordered longest/most-specific first.
//
// Group 1 — written / typed variants (what appears in stored text or memory):
//   Ra7etBal, RahetBal, Rahet Bal, Rahatbal, Rahat Bal, Raetbal
//   Pattern: "ra" + ("7"|"h")? + ("e"|"a")? + "t"? + optional space + "bal"
//
// Group 2 — TTS mispronunciations that might echo back through the transcript:
//   RA7 ball, RA7 at ball, Rassetbal
//   Handled by individual literal patterns since they diverge from Group 1.
// ---------------------------------------------------------------------------

const PATTERNS: RegExp[] = [
  // Group 1: written variants — catches Ra7etBal, RahetBal, Rahet Bal,
  // Rahatbal, Rahat Bal, Raetbal, and all case variants.
  // "ra" + optional("7"|"h") + optional("e"|"a") + optional("t") + space? + "bal"
  /ra[7h]?[ae]?t?\s?bal/gi,

  // Group 2: TTS mispronunciation echoes
  /ra\s?7\s?at\s?ball?/gi,   // RA7 at ball / ra7 at bal
  /ra\s?7\s?ball?/gi,        // RA7 ball / ra7 bal
  /rass?etbal/gi,             // Rassetbal / Rasetbal
];

/**
 * Replace all Ra7etBal variants in a string with the Arabic brand name.
 * Safe to call on any text — no-op if no pattern matches.
 */
export function sanitizeForCarsonSpeech(text: string): string {
  let result = text;
  for (const pattern of PATTERNS) {
    result = result.replace(pattern, ARABIC_BRAND);
  }
  return result;
}
