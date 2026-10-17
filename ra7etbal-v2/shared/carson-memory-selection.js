/**
 * Server/browser-safe Carson memory selection, correction, and notes logic.
 *
 * One source of truth for every channel that hands memory to Carson:
 *   - Talk to Carson / Type to Carson (src/lib/carson-memory-context.ts)
 *   - WhatsApp Carson (api/_carson-agent-turn.js buildOwnerContextText)
 *
 * Pure functions only — no Supabase, no network, no clock except the `now`
 * argument. Callers fetch owner-scoped rows and pass them in.
 *
 * What this module decides:
 *   1. Subject — what a memory is ABOUT (people + topic + kind of value),
 *      separate from its value. "Christopher prefers dinner instructions
 *      before 4 PM" and "... before 3 PM" share a subject and differ only
 *      in value, so the newer one is a correction of the older one.
 *   2. Current memory — for each subject only the newest owner-stated memory
 *      is current. Superseded memories are never handed to Carson as
 *      guidance. Nothing is deleted here; callers decide storage.
 *   3. Relevance — which facts reach Carson's context, ranked by the people
 *      and topics in the current conversation, category importance and
 *      recency, with every category guaranteed a share so relationship and
 *      preference facts can never be systematically excluded.
 *   4. Person notes — merging a learned memory into people.notes replaces
 *      the outdated line it corrects, never truncates existing text, and
 *      rendering shows the newest lines first when space is short.
 *
 * Deliberate limits (documented, not hidden):
 *   - Subject matching is lexical. A correction phrased only with a pronoun
 *     ("he now wants them at 3") or a contradiction with no shared topic
 *     words ("Grace is shy" / "Grace is outgoing") is not detected here.
 *     The instruction block tells Carson that later instructions win, and
 *     the fact extractor is given existing keys so it updates in place.
 *   - Facts are not semantic-searched; there is no vector index.
 */

// ── Constants ────────────────────────────────────────────────────────────────

/** Prefix marking a carson_memory row as a session recap. */
export const RECAP_PREFIX = "• Session recap:";

export const SESSION_HISTORY_HEADER = [
  "SESSION HISTORY ONLY:",
  "For questions about last or previous sessions, use only these recaps.",
  "Never use durable memory, saved notes, people, tasks, routines, or completions as session history.",
].join("\n");

export const PERSISTENT_INSTRUCTIONS_HEADER =
  "Persistent instructions (follow these always, silently, without announcing them):";

export const PERSISTENT_INSTRUCTIONS_ORDER_NOTE =
  "They are listed oldest to newest. If two ever conflict, follow the newer one; an owner correction always replaces what it corrects.";

export const USER_MEMORY_HEADER_LINES = [
  "User memory (private behavioral context):",
  "Use memory silently.",
  "Do not recite memory, operating instructions, role descriptions, behavioral rules, internal preferences, or system guidance back to the user.",
  "Apply memory through behavior.",
  "When asked how you should work with the user, describe the practical outcome of the memory, not the instructions themselves.",
  "Sound like a trusted chief of staff who already knows the user, not an employee explaining policy.",
  "Never list memory facts. Never repeat category names or memory keys. Prefer natural language and assume an ongoing relationship.",
  "For questions about how you should work with the user, answer in conversational prose, not bullets or onboarding documentation.",
  "Private memory facts (do not quote labels, categories, or keys):",
];

export const DEFAULT_FACT_LIMIT = 60;
export const DEFAULT_FACT_CHAR_BUDGET = 7000;
export const DEFAULT_INSTRUCTION_LIMIT = 60;
/** Minimum slots each fact category gets before free ranking fills the rest. */
const CATEGORY_FLOOR = 2;

const DAY_MS = 24 * 60 * 60 * 1000;

// Words that carry no subject meaning.
const STOPWORDS = new Set([
  "a", "an", "the", "to", "of", "for", "and", "or", "but", "in", "on", "at",
  "with", "from", "as", "is", "are", "was", "were", "be", "been", "being",
  "it", "its", "that", "this", "these", "those", "them", "they", "he", "she",
  "him", "her", "his", "hers", "their", "theirs", "i", "me", "my", "mine",
  "we", "us", "our", "you", "your", "please", "remember", "also", "just",
  "so", "than", "then", "about", "before", "after", "until", "by", "into",
  "very", "really", "any", "all", "every", "each", "there", "here", "what",
  "when", "which", "who", "whom", "do", "does", "did", "done", "if", "up",
  "out", "over", "under", "again", "more", "most", "less", "some", "such",
  "only", "own", "same", "too", "user", "owner", "sana", "carson", "ll", "s",
  "re", "ve", "d", "m", "t",
]);

// Correction cues — they mark a change but are not part of the subject.
const CUE_WORDS = new Set([
  "actually", "now", "instead", "anymore", "changed", "change", "changes",
  "update", "updated", "updating", "correction", "correct", "corrected",
  "rather", "going", "forward", "onward", "onwards", "today", "currently",
  "henceforth", "nowadays", "lately", "recently", "new", "newer", "latest",
]);

// Verbs/helpers that frame a preference but are not its topic.
const SOFT_WORDS = new Set([
  "prefer", "prefers", "preferred", "preference", "preferences", "like",
  "likes", "liked", "want", "wants", "wanted", "need", "needs", "needed",
  "receive", "receives", "received", "receiving", "get", "gets", "getting",
  "got", "give", "gives", "given", "giving", "send", "sends", "sent",
  "sending", "have", "has", "had", "having", "should", "must", "would",
  "will", "can", "could", "may", "might", "shall", "keep", "keeps", "make",
  "makes", "use", "uses", "using", "used", "be", "is", "am", "let", "lets",
  "know", "tell", "told", "ask", "asks", "asked", "say", "says", "said",
  "go", "goes", "come", "comes", "set", "sets",
]);

// Value vocabularies. A token in one of these is a VALUE, not topic; its
// class becomes part of the subject so different kinds of values
// (a time vs. a language) never collide.
const VALUE_CLASS_WORDS = {
  time: [
    "noon", "midnight", "morning", "mornings", "afternoon", "afternoons",
    "evening", "evenings", "night", "nights", "tonight", "early", "earlier",
    "late", "later", "oclock", "am", "pm",
  ],
  schedule: [
    "monday", "tuesday", "wednesday", "thursday", "friday", "saturday",
    "sunday", "mondays", "tuesdays", "wednesdays", "thursdays", "fridays",
    "saturdays", "sundays", "weekday", "weekdays", "weekend", "weekends",
    "daily", "weekly", "monthly", "hourly",
  ],
  channel: [
    "whatsapp", "email", "emails", "sms", "text", "texts", "call", "calls",
    "phone", "voicemail", "voice", "telegram", "signal",
  ],
  language: [
    "arabic", "english", "french", "spanish", "tagalog", "filipino", "hindi",
    "urdu", "malayalam", "tamil", "sinhala", "bengali", "bangla", "nepali",
    "amharic", "indonesian", "bahasa", "swahili", "german", "italian",
    "russian", "chinese", "mandarin", "portuguese", "turkish", "farsi",
    "persian",
  ],
  number: [
    "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
    "ten", "eleven", "twelve", "fifteen", "twenty", "thirty", "couple",
    "few", "half",
  ],
  polarity: ["always", "never", "not", "no", "dont", "don't", "cannot", "cant"],
  style: [
    "short", "shorter", "brief", "briefer", "concise", "detailed", "long",
    "longer", "formal", "informal", "casual", "warm", "direct",
  ],
};

const VALUE_CLASS_BY_WORD = new Map();
for (const [cls, words] of Object.entries(VALUE_CLASS_WORDS)) {
  for (const word of words) VALUE_CLASS_BY_WORD.set(word, cls);
}

const CATEGORY_WEIGHT = {
  correction: 40,
  notification_preference: 35,
  preference: 30,
  communication_style: 25,
  pronunciation: 25,
  relationship: 20,
  routine: 20,
  recurring_responsibility: 15,
  identity: 15,
  language: 15,
  product_direction: 5,
};

// Owner-stated sources outrank model inference. carson_facts rows are
// extracted only from the owner's own words, so they are owner-stated.
const AUTHORITY_OWNER = 2;
const AUTHORITY_INFERRED = 1;

// ── Text helpers ─────────────────────────────────────────────────────────────

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function toTime(value) {
  if (!value) return Number.NaN;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? Number.NaN : t;
}

/** Lower-case word tokens with times normalised ("4 PM" → "4pm"). */
export function tokenizeMemoryText(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/\bno longer\b/g, " ")
    .replace(/\bfrom now on\b/g, " ")
    .replace(/(\d)\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/g, (_m, d, ap) => `${d}${ap.replace(/\./g, "")}`)
    .replace(/o\s*clock/g, "oclock")
    .split(/[^a-z0-9:]+/)
    .map((t) => t.replace(/^:+|:+$/g, ""))
    .filter(Boolean);
}

function stem(token) {
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

function valueClassOf(token) {
  if (/^\d{1,2}(:\d{2})?(am|pm)$/.test(token) || /^\d{1,2}:\d{2}$/.test(token)) return "time";
  if (/^\d+$/.test(token)) return "number";
  return VALUE_CLASS_BY_WORD.get(token) ?? null;
}

/**
 * Build a name index from household people rows.
 * @param {Array<{id?: string, name?: string|null}>} people
 */
export function buildPeopleIndex(people) {
  const byToken = new Map(); // token -> Set(personKey)
  const entries = [];
  for (const person of people ?? []) {
    const full = cleanText(person?.name).toLowerCase();
    if (!full) continue;
    const key = person.id ? String(person.id) : full;
    const tokens = tokenizeMemoryText(full).filter((t) => t.length > 1);
    entries.push({ key, full, tokens, first: tokens[0] ?? "" });
    for (const t of tokens) {
      if (!byToken.has(t)) byToken.set(t, new Set());
      byToken.get(t).add(key);
    }
  }
  return { byToken, entries };
}

// Phrases/words that mark the newer statement as a correction of the older.
const CORRECTION_CUE_WORDS = new Set([
  "actually", "now", "instead", "anymore", "changed", "change", "update",
  "updated", "correction", "correct", "corrected", "rather", "nowadays",
  "henceforth",
]);
const CORRECTION_CUE_PHRASES = [/\bno longer\b/, /\bfrom now on\b/, /\bgoing forward\b/, /\bnot anymore\b/];
// A standing preference (one value at a time by nature).
const PREFERENCE_WORDS = new Set(["prefer", "prefers", "preferred", "preference", "want", "wants", "wanted"]);
// Words that ADD to what is known rather than replace it.
const ADDITIVE_WORDS = new Set(["too", "also", "additionally", "another", "both", "plus"]);
const ADDITIVE_PHRASES = [/\bas well\b/, /\bin addition\b/];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * People mentioned in a text. A person matches by full name, or by a first
 * name that is unique in the household. In free text (not fact keys) the
 * name must be capitalised, so names that are also words ("Will", "May",
 * "Faith") only match when written as names.
 */
function peopleIn(text, peopleIndex, { requireCapital = true } = {}) {
  const found = new Set();
  const matchedTokens = new Set();
  if (!peopleIndex || !text) return { found, matchedTokens };
  const raw = String(text).replace(/[’']/g, "");
  const has = (token) => {
    const re = new RegExp(`\\b${escapeRegExp(token)}\\b`, requireCapital ? "" : "i");
    if (!requireCapital) return re.test(raw);
    const cap = token.charAt(0).toUpperCase() + token.slice(1);
    return new RegExp(`\\b${escapeRegExp(cap)}\\b`).test(raw) || new RegExp(`\\b${escapeRegExp(token.toUpperCase())}\\b`).test(raw);
  };
  for (const entry of peopleIndex.entries) {
    if (entry.tokens.length === 0) continue;
    const fullMatch = entry.tokens.every(has);
    const firstUnique = (peopleIndex.byToken.get(entry.first)?.size ?? 0) === 1;
    if (fullMatch || (firstUnique && has(entry.first))) {
      found.add(entry.key);
      for (const t of entry.tokens) matchedTokens.add(t);
    }
  }
  return { found, matchedTokens };
}

/**
 * What a memory is about, separated from its value.
 *
 * key = people + topic words + value kinds + specific days. Days are part of
 * the subject ("cleans on Mondays" and "cleans on Thursdays" are different
 * memories); times, numbers, languages, channels and always/never are values.
 *
 * @param {string} text
 * @param {ReturnType<typeof buildPeopleIndex>} [peopleIndex]
 * @param {string} [peopleText] extra text scanned only for people (e.g. a fact key)
 */
export function memorySubject(text, peopleIndex, peopleText = "") {
  const tokens = tokenizeMemoryText(text);
  const lower = String(text ?? "").toLowerCase().replace(/[’']/g, "");
  const inText = peopleIn(text, peopleIndex);
  const inKey = peopleIn(String(peopleText ?? "").replace(/[_\-./]+/g, " "), peopleIndex, { requireCapital: false });
  const people = new Set([...inText.found, ...inKey.found]);
  const nameTokens = new Set([...inText.matchedTokens, ...inKey.matchedTokens]);
  const core = new Set();
  const classes = new Set();
  const schedule = new Set();
  const values = [];
  for (const raw of tokens) {
    if (nameTokens.has(raw)) continue;
    const cls = valueClassOf(raw);
    if (cls === "schedule") {
      classes.add(cls);
      schedule.add(stem(raw));
      continue;
    }
    if (cls) {
      classes.add(cls);
      values.push(raw);
      continue;
    }
    if (STOPWORDS.has(raw) || CUE_WORDS.has(raw) || SOFT_WORDS.has(raw)) continue;
    if (ADDITIVE_WORDS.has(raw) || raw.length < 2) continue;
    core.add(stem(raw));
  }
  const coreList = [...core].sort();
  const peopleList = [...people].sort();
  const classList = [...classes].sort();
  const scheduleList = [...schedule].sort();
  return {
    people: peopleList,
    core: coreList,
    classes: classList,
    values: values.sort(),
    cue: tokens.some((t) => CORRECTION_CUE_WORDS.has(t)) || CORRECTION_CUE_PHRASES.some((re) => re.test(lower)),
    preference: tokens.some((t) => PREFERENCE_WORDS.has(t)),
    additive: tokens.some((t) => ADDITIVE_WORDS.has(t)) || ADDITIVE_PHRASES.some((re) => re.test(lower)),
    key: coreList.length === 0
      ? null
      : `${peopleList.join(",")}|${coreList.join(",")}|${classList.join(",")}|${scheduleList.join(",")}`,
  };
}

/** True when two memory texts are about the same subject. */
export function isSameMemorySubject(a, b, peopleIndex) {
  const sa = typeof a === "string" ? memorySubject(a, peopleIndex) : a;
  const sb = typeof b === "string" ? memorySubject(b, peopleIndex) : b;
  return Boolean(sa.key) && sa.key === sb.key;
}

/**
 * Does `newer` replace `older`? Conservative on purpose: wrongly hiding a
 * true memory is worse than keeping a duplicate. Same subject AND one of:
 *   - a restatement (same values);
 *   - the newer statement is an explicit correction ("actually", "now",
 *     "instead", "no longer", "from now on", ...);
 *   - both are standing preferences ("prefers", "wants");
 *   - the only difference is always ↔ never.
 * Additive statements ("too", "also", "as well") never replace anything.
 * Two plain facts that merely differ in a value ("meds at 8am" / "meds at
 * 8pm") are both kept.
 */
export function supersedes(newer, older) {
  if (!newer?.key || newer.key !== older?.key) return false;
  if (newer.additive) return false;
  const nv = newer.values.join(",");
  const ov = older.values.join(",");
  if (nv === ov) return true;
  if (newer.cue) return true;
  if (newer.preference && older.preference) return true;
  const POLARITY = VALUE_CLASS_WORDS.polarity;
  const strip = (vals) => vals.filter((v) => !POLARITY.includes(v)).join(",");
  return strip(newer.values) === strip(older.values);
}

// ── Current-memory resolution ────────────────────────────────────────────────

/**
 * @typedef {Object} MemoryItem
 * @property {string} id
 * @property {"instruction"|"fact"} kind
 * @property {string} text          text the subject is computed from
 * @property {string} [peopleText]  extra text scanned for people only
 * @property {number} at            epoch ms of when the owner said it
 * @property {number} authority     AUTHORITY_OWNER | AUTHORITY_INFERRED
 */

/**
 * Decide which memories are current. A memory is superseded when a newer
 * memory about the same subject replaces it (see `supersedes`). Inferred
 * memories never supersede owner-stated ones; an owner-stated memory wins
 * over a conflicting inferred one regardless of age. Memories whose subject
 * cannot be determined are always current (never silently hidden).
 *
 * @param {MemoryItem[]} items
 * @param {ReturnType<typeof buildPeopleIndex>} [peopleIndex]
 * @returns {{ currentIds: Set<string>, supersededBy: Map<string, string> }}
 */
export function resolveCurrentMemories(items, peopleIndex) {
  const groups = new Map();
  const currentIds = new Set();
  const supersededBy = new Map();
  for (const item of items) {
    const subject = memorySubject(item.text, peopleIndex, item.peopleText);
    if (!subject.key) {
      currentIds.add(item.id);
      continue;
    }
    if (!groups.has(subject.key)) groups.set(subject.key, []);
    groups.get(subject.key).push({ item, subject });
  }
  const isOwner = (x) => x.item.authority >= AUTHORITY_OWNER;
  const at = (x) => (Number.isNaN(x.item.at) ? -Infinity : x.item.at);
  for (const group of groups.values()) {
    // Owner-stated first, then newest first; id breaks ties deterministically.
    group.sort((a, b) =>
      Number(isOwner(b)) - Number(isOwner(a)) || at(b) - at(a) || String(b.item.id).localeCompare(String(a.item.id)));
    const sameValues = (a, b) => a.subject.values.join(",") === b.subject.values.join(",");
    // A fact that merely restates a standing instruction never hides it: the
    // owner's explicit instruction stays where Carson already reads it.
    const restatesInstruction = (fact, instruction) =>
      fact.item.kind === "fact" && instruction.item.kind === "instruction" && sameValues(fact, instruction);
    const seen = [];
    for (const entry of group) {
      const replacedBy = seen.find((prev) => {
        if (restatesInstruction(prev, entry)) return false;
        if (isOwner(prev) && !isOwner(entry)) {
          return supersedes(prev.subject, entry.subject) || supersedes(entry.subject, prev.subject);
        }
        return at(prev) >= at(entry) && supersedes(prev.subject, entry.subject);
      });
      if (replacedBy) supersededBy.set(entry.item.id, replacedBy.item.id);
      else currentIds.add(entry.item.id);
      seen.push(entry);
    }
    for (const fact of group) {
      if (fact.item.kind !== "fact" || !currentIds.has(fact.item.id)) continue;
      const instruction = group.find((x) => currentIds.has(x.item.id) && restatesInstruction(fact, x));
      if (instruction) {
        currentIds.delete(fact.item.id);
        supersededBy.set(fact.item.id, instruction.item.id);
      }
    }
  }
  return { currentIds, supersededBy };
}

// ── Rows → items ─────────────────────────────────────────────────────────────

function instructionItem(row) {
  return {
    id: `instruction:${row.id ?? `${row.created_at}:${row.instruction}`}`,
    kind: "instruction",
    text: cleanText(row.instruction),
    at: toTime(row.created_at) || toTime(row.confirmed_at),
    authority: row.source === "session_inference" ? AUTHORITY_INFERRED : AUTHORITY_OWNER,
    row,
  };
}

function factKeyText(row) {
  return `${row.category ?? ""} ${String(row.key ?? "").replace(/[_\-./]+/g, " ")}`;
}

function factItem(row) {
  const at = [row.updated_at, row.last_seen_at, row.created_at].map(toTime).filter((t) => !Number.isNaN(t));
  return {
    id: `fact:${row.id ?? `${row.category}:${row.key}`}`,
    kind: "fact",
    text: cleanText(row.value),
    peopleText: factKeyText(row),
    at: at.length ? Math.max(...at) : Number.NaN,
    authority: AUTHORITY_OWNER,
    row,
  };
}

/** Drop rows that do not belong to the expected owner (defense in depth). */
export function ownedRows(rows, ownerId) {
  const list = Array.isArray(rows) ? rows : [];
  if (!ownerId) return list;
  return list.filter((row) => !row || row.user_id == null || row.user_id === ownerId);
}

// ── Relevance selection ──────────────────────────────────────────────────────

function recencyScore(at, now) {
  if (Number.isNaN(at)) return 0;
  const days = Math.max(0, (now - at) / DAY_MS);
  return 20 * Math.exp(-days / 60);
}

/**
 * Rank and pick facts for Carson's context.
 *
 * @param {Array<object>} factRows    current (already resolved) fact rows
 * @param {object} opts
 * @param {string} [opts.contextText] text of the current conversation/state
 * @param {ReturnType<typeof buildPeopleIndex>} [opts.peopleIndex]
 * @param {number} [opts.limit]
 * @param {number} [opts.charBudget]
 * @param {number} [opts.now]
 */
export function selectRelevantFacts(factRows, opts = {}) {
  const limit = opts.limit ?? DEFAULT_FACT_LIMIT;
  const charBudget = opts.charBudget ?? DEFAULT_FACT_CHAR_BUDGET;
  const now = opts.now ?? Date.now();
  const contextTokens = tokenizeMemoryText(opts.contextText ?? "");
  const contextPeople = peopleIn(opts.contextText ?? "", opts.peopleIndex, { requireCapital: false }).found;
  const contextCore = new Set(
    contextTokens
      .filter((t) => !STOPWORDS.has(t) && !SOFT_WORDS.has(t) && !CUE_WORDS.has(t) && t.length > 2)
      .map(stem),
  );

  const scored = (factRows ?? [])
    .filter((row) => cleanText(row?.value))
    .map((row) => {
      const item = factItem(row);
      const subject = memorySubject(item.text, opts.peopleIndex, item.peopleText);
      const mentionsContextPerson = subject.people.some((p) => contextPeople.has(p));
      const overlap = subject.core.filter((t) => contextCore.has(t)).length;
      const score =
        (mentionsContextPerson ? 100 : 0) +
        Math.min(overlap, 4) * 5 +
        (CATEGORY_WEIGHT[row.category] ?? 5) +
        recencyScore(item.at, now) +
        (typeof row.confidence === "number" ? row.confidence * 5 : 0);
      return { row, score, at: item.at, relevant: mentionsContextPerson || overlap > 0 };
    })
    .sort((a, b) => b.score - a.score || (b.at || 0) - (a.at || 0));

  const chosen = new Set();
  let chars = 0;
  const take = (entry) => {
    if (chosen.has(entry) || chosen.size >= limit) return false;
    const size = factLine(entry.row).length + 1;
    if (chars + size > charBudget) return false;
    chosen.add(entry);
    chars += size;
    return true;
  };

  const pinned = opts.pinnedRows ?? new Set();
  // 0. Facts that replaced a standing instruction must reach Carson, or the
  //    owner's correction would vanish from context entirely.
  for (const entry of scored) if (pinned.has(entry.row)) take(entry);
  // 1. Anything about the people/topics in this conversation.
  for (const entry of scored) if (entry.relevant) take(entry);
  // 2. A floor per category so no category is systematically excluded.
  const perCategory = new Map();
  for (const entry of chosen) {
    const cat = entry.row.category ?? "";
    perCategory.set(cat, (perCategory.get(cat) ?? 0) + 1);
  }
  for (const entry of scored) {
    const cat = entry.row.category ?? "";
    if ((perCategory.get(cat) ?? 0) < CATEGORY_FLOOR && take(entry)) {
      perCategory.set(cat, (perCategory.get(cat) ?? 0) + 1);
    }
  }
  // 3. Fill the remaining budget by score.
  for (const entry of scored) take(entry);

  return scored.filter((e) => chosen.has(e)).map((e) => e.row);
}

function factLine({ category, key, value }) {
  const c = cleanText(category);
  const k = cleanText(key);
  const v = cleanText(value);
  if (!v) return "";
  if (c && k) return `- ${c} / ${k}: ${v}`;
  if (c) return `- ${c}: ${v}`;
  if (k) return `- ${k}: ${v}`;
  return `- ${v}`;
}

/** Format fact rows exactly like the long-standing user-memory block. */
export function formatUserMemoryBlock(facts) {
  const lines = (facts ?? []).map(factLine).filter(Boolean);
  return lines.length > 0 ? [...USER_MEMORY_HEADER_LINES, ...lines].join("\n") : "";
}

// ── Combined builder (single decision point for every channel) ───────────────

/**
 * Resolve corrections across standing instructions and facts, pick relevant
 * facts, and format both context blocks.
 *
 * @param {object} input
 * @param {string} [input.ownerId]          rows for other owners are dropped
 * @param {Array<object>} [input.instructions] carson_persistent_memory rows
 * @param {Array<object>} [input.facts]        active carson_facts rows
 * @param {Array<object>} [input.people]       household people rows (names)
 * @param {string} [input.contextText]         current conversation/state text
 * @param {number} [input.now]
 * @param {number} [input.factLimit]
 * @param {number} [input.staleDays]           instruction freshness threshold
 * @returns {{ persistentInstructions: string, userMemory: string,
 *   currentInstructions: object[], selectedFacts: object[],
 *   supersededInstructionIds: string[], supersededFactIds: string[] }}
 */
export function buildCarsonMemoryContext(input = {}) {
  const now = input.now ?? Date.now();
  const peopleIndex = buildPeopleIndex(input.people);
  const instructions = ownedRows(input.instructions, input.ownerId).filter((r) => cleanText(r?.instruction));
  const facts = ownedRows(input.facts, input.ownerId).filter((r) => !r?.archived_at && cleanText(r?.value));

  const items = [...instructions.map(instructionItem), ...facts.map(factItem)];
  const { currentIds, supersededBy } = resolveCurrentMemories(items, peopleIndex);

  const currentInstructions = items
    .filter((i) => i.kind === "instruction" && currentIds.has(i.id))
    .sort((a, b) => (a.at || 0) - (b.at || 0))
    .slice(-(input.instructionLimit ?? DEFAULT_INSTRUCTION_LIMIT))
    .map((i) => i.row);
  const currentFacts = items.filter((i) => i.kind === "fact" && currentIds.has(i.id)).map((i) => i.row);
  const itemById = new Map(items.map((i) => [i.id, i]));
  const pinnedRows = new Set();
  for (const [lostId, winnerId] of supersededBy) {
    if (lostId.startsWith("instruction:") && winnerId.startsWith("fact:")) {
      pinnedRows.add(itemById.get(winnerId).row);
    }
  }

  const selectedFacts = selectRelevantFacts(currentFacts, {
    contextText: input.contextText,
    peopleIndex,
    limit: input.factLimit,
    now,
    pinnedRows,
  }).sort((a, b) =>
    String(a.category ?? "").localeCompare(String(b.category ?? "")) ||
    String(a.key ?? "").localeCompare(String(b.key ?? "")),
  );

  const staleMs = (input.staleDays ?? 90) * DAY_MS;
  const instructionLines = currentInstructions.map((row) => {
    const confirmed = toTime(row.confirmed_at);
    const stale = !Number.isNaN(confirmed) && now - confirmed > staleMs;
    const suffix = stale
      ? ` [last confirmed ${Math.floor((now - confirmed) / DAY_MS)} days ago — may need re-confirmation]`
      : "";
    const label = cleanText(row.category) || "general";
    return `- ${label}: ${cleanText(row.instruction)}${suffix}`;
  });

  return {
    persistentInstructions: instructionLines.length
      ? [PERSISTENT_INSTRUCTIONS_HEADER, PERSISTENT_INSTRUCTIONS_ORDER_NOTE, ...instructionLines].join("\n")
      : "",
    userMemory: formatUserMemoryBlock(selectedFacts),
    currentInstructions,
    selectedFacts,
    supersededInstructionIds: [...supersededBy.keys()].filter((id) => id.startsWith("instruction:")).map((id) => id.slice(12)),
    supersededFactIds: [...supersededBy.keys()].filter((id) => id.startsWith("fact:")).map((id) => id.slice(5)),
  };
}

/**
 * Existing active facts that a freshly extracted batch corrects: same
 * subject, different (category, key). The caller archives them only after
 * the new facts are saved, so a failed save never loses the original.
 *
 * @param {Array<object>} existingFacts active rows (with id)
 * @param {Array<{category: string, key: string, value: string}>} newFacts
 * @param {Array<object>} [people]
 * @returns {string[]} ids of existing facts to archive
 */
export function findFactsSupersededBy(existingFacts, newFacts, people) {
  const peopleIndex = buildPeopleIndex(people);
  const fresh = (newFacts ?? [])
    .map((f) => ({ f, subject: memorySubject(f.value, peopleIndex, factKeyText(f)) }))
    .filter((x) => x.subject.key);
  const ids = [];
  for (const row of existingFacts ?? []) {
    if (!row?.id || row.archived_at) continue;
    const subject = memorySubject(row.value, peopleIndex, factKeyText(row));
    if (!subject.key) continue;
    const corrected = fresh.some(
      (x) => !(x.f.category === row.category && x.f.key === row.key) && supersedes(x.subject, subject),
    );
    if (corrected) ids.push(String(row.id));
  }
  return ids;
}

// ── Session recaps (WhatsApp + app share one formatter) ─────────────────────

/** True when a summary row is a session recap rather than a durable fact. */
export function isRecapRow(summary) {
  return typeof summary === "string" && summary.trimStart().startsWith(RECAP_PREFIX);
}

/**
 * Format newest-first carson_memory rows ({created_at, summary}) for the
 * `recent_memory` variable. Non-recap rows never appear as session history.
 */
export function formatSessionRecaps(rows, opts = {}) {
  const staleMs = (opts.staleDays ?? 30) * DAY_MS;
  const now = opts.now ?? Date.now();
  const recaps = (Array.isArray(rows) ? rows : []).filter((row) => isRecapRow(row?.summary));
  if (recaps.length === 0) {
    return `${SESSION_HISTORY_HEADER}\n\nNo previous sessions.`;
  }
  const newestRecapAt = recaps[0].created_at;
  const formatWhen = (iso) => {
    const base = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
    try {
      return new Date(iso).toLocaleString(opts.locale, opts.timeZone ? { ...base, timeZone: opts.timeZone } : base);
    } catch {
      // An invalid saved timezone must never drop the owner's context.
      return new Date(iso).toLocaleString(opts.locale, { ...base, timeZone: "UTC" });
    }
  };
  const labeled = recaps.map((row) => {
    const when = formatWhen(row.created_at);
    const summary = row.summary.trim().replace(/\n{3,}/g, "\n");
    const isNewest = row.created_at === newestRecapAt;
    const created = toTime(row.created_at);
    const isOld = !isNewest && !Number.isNaN(created) && now - created > staleMs;
    const label = isNewest
      ? `[Most recent session — ${when}]`
      : isOld
        ? `[Older context — ${when} — treat as background only]`
        : `[Earlier session — ${when}]`;
    return `${label}\n${summary}`;
  });
  return `${SESSION_HISTORY_HEADER}\n\n${labeled.reverse().join("\n\n")}`;
}

// ── Person notes ─────────────────────────────────────────────────────────────

function noteLines(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean);
}

/**
 * Merge a learned memory into a person's notes.
 *
 * - Exact or contained duplicates leave notes unchanged.
 * - Lines about the same subject (a correction) are replaced; the new line
 *   is written at the end so it is the newest.
 * - Existing lines and line breaks are preserved; nothing is truncated.
 *   (The old 1,000-character slice kept the oldest text and silently cut
 *   both new corrections and longer owner-written notes.)
 *
 * @param {string|null|undefined} existing
 * @param {string} addition
 * @returns {{ notes: string, changed: boolean, replaced: string[] }}
 */
export function mergePersonMemoryNotes(existing, addition) {
  const original = String(existing ?? "");
  const add = cleanText(addition);
  if (!add) return { notes: original, changed: false, replaced: [] };
  // Duplicate only on a whole-word match ("Likes tea." is not inside
  // "Dislikes tea."). Unchanged notes are returned byte-for-byte.
  const core = add.replace(/[.!?]+$/, "");
  const dup = new RegExp(`(^|[^a-z0-9])${escapeRegExp(core)}([^a-z0-9]|$)`, "i");
  if (noteLines(original).some((line) => dup.test(line))) {
    return { notes: original, changed: false, replaced: [] };
  }
  const addSubject = memorySubject(add);
  const replaced = [];
  // Owner formatting (blank lines, spacing) is kept: only a line that
  // contains the corrected sentence is rewritten.
  const out = [];
  for (const rawLine of original.split(/\r?\n/)) {
    const line = rawLine.replace(/[ \t]+/g, " ").trim();
    if (!line || !addSubject.key || line.startsWith("[Behavior:")) {
      out.push(rawLine);
      continue;
    }
    // A line may hold several sentences; drop only the corrected sentence(s).
    const sentences = line.split(/(?<=[.!?])\s+/).filter(Boolean);
    const remaining = sentences.filter((s) => !supersedes(addSubject, memorySubject(s)));
    if (remaining.length === sentences.length) {
      out.push(rawLine);
      continue;
    }
    replaced.push(line);
    if (remaining.length > 0) out.push(remaining.join(" "));
  }
  const base = out.join("\n").replace(/\s+$/, "");
  return { notes: base ? `${base}\n${add}` : add, changed: true, replaced };
}

/**
 * Render notes for Carson's context within a character budget. When the
 * notes are too long, the newest (last) lines are kept so corrections are
 * never the part that falls off.
 */
export function renderPersonNotesForContext(notes, budget) {
  const lines = noteLines(notes);
  const full = lines.join(" / ");
  if (full.length <= budget) return full;
  const picked = [];
  let used = 1; // leading ellipsis
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const size = lines[i].length + (picked.length ? 3 : 0);
    if (used + size > budget) {
      if (picked.length === 0) return `…${lines[i].slice(lines[i].length - (budget - 1))}`;
      break;
    }
    picked.unshift(lines[i]);
    used += size;
  }
  return `…${picked.join(" / ")}`;
}
