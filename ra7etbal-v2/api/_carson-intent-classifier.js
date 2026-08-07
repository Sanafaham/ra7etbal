/**
 * Owner WhatsApp intent classifier.
 *
 * This module mirrors src/lib/carson-router.ts for API compatibility.
 * When the routing layer can share a common implementation, these two
 * classifiers must be consolidated into one canonical implementation.
 *
 * Why a separate file: src/lib/carson-router.ts is TypeScript compiled only
 * by Vite for the frontend bundle. API functions (api/*.js) are plain Node.js
 * ES modules deployed by Vercel as-is and cannot import the TS source
 * directly. Until the context-builder refactoring PR extracts a shared
 * isomorphic JS module, this file is the API-layer equivalent and must be
 * kept in sync with src/lib/carson-router.ts manually.
 *
 * Sync checklist (update both files together):
 *   - Domain names and domain set
 *   - Pattern matchers for reminder / calendar / memory / whatsapp / delegation
 *   - Social acknowledgement and greeting patterns
 *   - Question detection patterns
 *
 * Execution domains (→ persistAndExecuteOwnerCommand):
 *   reminder   — "remind me ...", "set a reminder", etc.
 *   delegation — "tell/ask [name] to [work]..."
 *   whatsapp   — "tell/ask [name] [direct]...", "send [name] a message"
 *
 * Conversational domains (→ runOwnerConversationalTurn):
 *   social_ack     — greetings, acknowledgements
 *   general_answer — questions, factual queries, status checks
 *   calendar       — calendar queries
 *   todo / note / task / memory — work items passed to Carson
 *   unknown        — unclassified; Carson handles
 */

// ── Constants ─────────────────────────────────────────────────────────────────

const EXECUTION_DOMAINS = new Set(['reminder', 'delegation', 'whatsapp']);

// Patterns ported from src/lib/carson-router.ts — update both in sync.
const REMINDER_RE_PRIMARY    = /\bremind\s+me\b/i;
const REMINDER_RE_EXPLICIT   = /\bset\s+(a\s+)?reminder\b/i;
const REMINDER_RE_FORGET     = /\bdon'?t\s+let\s+me\s+forget\b/i;
const REMINDER_RE_ALERT      = /\balert\s+me\b/i;
const REMINDER_RE_REMEMBER   = /\bremember\s+to\s+\w+/i;

const CALENDAR_RE_WORD       = /\bcalendar\b/i;
const CALENDAR_RE_WHAT_HAVE  = /\bwhat\s+do\s+I\s+have\s+(today|tomorrow|this\s+week|tonight|this\s+morning|this\s+afternoon)\b/i;
const CALENDAR_RE_BOOK       = /\b(schedule|book)\s+(a\s+)?(meeting|appointment|call|event)\b/i;
const CALENDAR_RE_ADD        = /\b(add|put)\s+.+\s+(to|on)\s+(my\s+)?schedule\b/i;

const MEMORY_RE_THAT         = /\bremember\s+that\b/i;
const MEMORY_RE_FROM_NOW_ON  = /\bfrom\s+now\s+on\b/i;
const MEMORY_RE_ALWAYS_NEVER = /\b(always|never)\s+(tell|ask|use|send|give|call|write|message|say)\b/i;
const MEMORY_RE_SAVE_PREF    = /\bsave\s+(this\s+)?(preference|instruction|rule|behavior|habit)\b/i;
const MEMORY_RE_I_PREFER     = /\bI\s+prefer\b/i;

const WHATSAPP_RE_DIRECT     = /\bwhatsapp\s+\w+/i;
const WHATSAPP_RE_SEND       = /\bsend\s+\w+\s+(a\s+)?message\b/i;
const WHATSAPP_RE_TEXT       = /\btext\s+\w+\s+(saying|that)\b/i;
const WHATSAPP_RE_DM         = /\b(dm|direct\s+message)\s+\w+/i;

// "tell/ask [name] to ..." or "tell/ask [name] ..." — includes delegation
// and direct messages (classifyOwnerCommand in the executor does the
// grammar/verb/role-based sub-classification).
const DIRECTED_RE            = /^(?:tell|ask)\s+([A-Za-z][A-Za-z''-]*)\s+(?:to\s+)?(.+)$/i;
// Bounded politeness prefix ("Can you ask...", "Could you tell...", "Please
// ask...") stripped before matching so these still route to the executor
// instead of falling through to general_answer/unknown.
const POLITENESS_PREFIX_RE   = /^(?:(?:can|could|would)\s+you\s+(?:please\s+)?|please\s+)/i;
const SOCIAL_GREETING_RE     = /^(?:hi|hello|hey|good\s+(?:morning|afternoon|evening|night)|morning|evening|howdy|greetings|salam|مرحبا|أهلاً|صباح الخير|مساء الخير)(?:\s+[A-Za-z]+)?[\s!.,?]*$/i;
const SOCIAL_ACK_RE          = /^(?:thanks|thank\s+you|ok|okay|got\s+it|perfect|great|sounds\s+good|alright|noted|understood|sure|awesome|cool)[\s!.,?]*$/i;
const QUESTION_RE            = /^(?:did|does|has|have|is|are|can|what|when|where|who|how|why|which)/i;
const QUESTION_MARK_RE       = /\?/;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * @param {string} text
 * @returns {{ primary_domain: string, domains: string[], confidence: number, isExecutionDomain: boolean }}
 */
export function classifyOwnerWhatsAppIntent(text) {
  const input = String(text || '').trim();

  // Social acknowledgements and greetings — highest-confidence shortcut.
  if (SOCIAL_GREETING_RE.test(input) || SOCIAL_ACK_RE.test(input)) {
    return result('social_ack', ['social_ack'], 0.99, false);
  }

  // Reminder — anchored at start or strong keyword.
  if (REMINDER_RE_PRIMARY.test(input))    return result('reminder',  ['reminder'],  0.95, true);
  if (REMINDER_RE_EXPLICIT.test(input))   return result('reminder',  ['reminder'],  0.95, true);
  if (REMINDER_RE_FORGET.test(input))     return result('reminder',  ['reminder'],  0.90, true);
  if (REMINDER_RE_ALERT.test(input))      return result('reminder',  ['reminder'],  0.88, true);
  if (REMINDER_RE_REMEMBER.test(input))   return result('reminder',  ['reminder'],  0.80, true);

  // Memory — "remember that" before "remember to" so they don't collide.
  if (MEMORY_RE_THAT.test(input))         return result('memory', ['memory'], 0.93, false);
  if (MEMORY_RE_FROM_NOW_ON.test(input))  return result('memory', ['memory'], 0.92, false);
  if (MEMORY_RE_ALWAYS_NEVER.test(input)) return result('memory', ['memory'], 0.85, false);
  if (MEMORY_RE_SAVE_PREF.test(input))    return result('memory', ['memory'], 0.90, false);
  if (MEMORY_RE_I_PREFER.test(input))     return result('memory', ['memory'], 0.82, false);

  // Calendar.
  if (CALENDAR_RE_WORD.test(input))       return result('calendar', ['calendar'], 0.95, false);
  if (CALENDAR_RE_WHAT_HAVE.test(input))  return result('calendar', ['calendar'], 0.90, false);
  if (CALENDAR_RE_BOOK.test(input))       return result('calendar', ['calendar'], 0.88, false);
  if (CALENDAR_RE_ADD.test(input))        return result('calendar', ['calendar'], 0.85, false);

  // WhatsApp direct message.
  if (WHATSAPP_RE_DIRECT.test(input))     return result('whatsapp', ['whatsapp'], 0.95, true);
  if (WHATSAPP_RE_SEND.test(input))       return result('whatsapp', ['whatsapp'], 0.92, true);
  if (WHATSAPP_RE_TEXT.test(input))       return result('whatsapp', ['whatsapp'], 0.90, true);
  if (WHATSAPP_RE_DM.test(input))         return result('whatsapp', ['whatsapp'], 0.88, true);

  // Directed command — "tell/ask [name] to/[verb]" — may be delegation or
  // direct message. Both route to the command executor; executor's own
  // classifyOwnerCommand handles the sub-classification. DIRECTED_RE is
  // anchored at the start, so a bounded politeness prefix ("Can you ask...")
  // is stripped first — otherwise it falls through to general_answer below.
  const directed = DIRECTED_RE.exec(input.replace(POLITENESS_PREFIX_RE, ''));
  if (directed) return result('delegation', ['delegation', 'whatsapp'], 0.85, true);

  // Questions — factual queries to Carson.
  if (QUESTION_RE.test(input) || QUESTION_MARK_RE.test(input)) {
    return result('general_answer', ['general_answer'], 0.80, false);
  }

  // No pattern matched — pass to Carson for full reasoning.
  return result('unknown', ['unknown'], 0.30, false);
}

/**
 * Returns true when the classified domain should be handled by the command
 * executor rather than the conversational bridge.
 *
 * @param {{ primary_domain: string }} classification
 */
export function isExecutionDomain(classification) {
  return EXECUTION_DOMAINS.has(classification.primary_domain);
}

function result(primary_domain, domains, confidence, isExec) {
  return { primary_domain, domains, confidence, isExecutionDomain: isExec };
}
