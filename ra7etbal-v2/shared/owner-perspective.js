/**
 * The single authoritative owner-perspective boundary.
 *
 * Every recipient-facing text that Ra7etBal builds from the owner's words —
 * direct messages, tracked delegation messages, stored task descriptions,
 * follow-ups and no-response re-asks, and WhatsApp owner commands — passes
 * through resolveOwnerPerspective before it can reach a recipient.
 *
 * It works in two steps:
 *   1. ROLES. Every pronoun-like reference is assigned a semantic role before
 *      any text is produced: owner, recipient, third party, or quoted /
 *      reported speech. Roles depend on the input voice:
 *        - "owner_to_recipient": the owner's own words to the recipient
 *          (direct-message bodies, personal notes). First person is the
 *          owner, second person is the recipient, and a third-person pronoun
 *          with no other possible antecedent is the recipient.
 *        - "task_text": task text being created for an assignee (tracked
 *          delegation, WhatsApp delegation). First person is the owner,
 *          second person is the assignee; third-person pronouns stay third
 *          parties.
 *        - "task_record": a stored task description quoted later (follow-ups,
 *          no-response re-asks). First person is the owner. Second person is
 *          ambiguous in a stored record (older rows used "you" for the owner,
 *          newer rows for the assignee), so it fails closed.
 *   2. RENDERING. Only after every role is resolved is the text rendered for
 *      the recipient: owner references become the owner's name with correct
 *      English verb agreement; recipient references become "you".
 *
 * It never guesses. Reported speech carrying first person, an owner
 * reflexive after an owner subject ("I did it myself"; no gender data exists), a verb it cannot inflect, a
 * recipient pronoun that has another possible antecedent, mixed owner
 * references, a pronoun that rendering would make ambiguous, and any Arabic
 * or Turkish owner first person all return status "needs_composition". The
 * caller then fails closed into its existing clarification path; nothing is
 * sent.
 *
 * Language: roles are language-independent; detection uses small, bounded
 * per-language tables (data, not rewriting rules). Only English is rendered.
 * Arabic and Turkish owner first person is detected — pronouns, first-person
 * verb forms and suffixes, my-possessives — and always fails closed; it is
 * never rewritten. A stored task record in Arabic or Turkish is never quoted
 * (its perspective cannot be verified), so follow-ups use the neutral line.
 * Detection is conservative and bounded, not general morphology: see the
 * tables below for exactly what is and is not recognised.
 *
 * Text with no owner reference is returned byte-for-byte unchanged, so the
 * boundary is idempotent: rendered text passes through it again unchanged.
 */

export const OWNER_PERSPECTIVE_UNRESOLVED = 'owner_perspective_unresolved';

/** Why nothing was sent, for callers that already say "could not send to X". */
export function ownerPerspectiveDetail() {
  return 'I couldn\'t word it without risking who "I", "me" or "her" would refer to. Please say it again using names instead.';
}

export function ownerPerspectiveClarification(recipientName) {
  const who = String(recipientName || '').trim() || 'them';
  return `I didn't send anything to ${who}. ${ownerPerspectiveDetail()}`;
}

export class OwnerPerspectiveError extends Error {
  constructor(reason, recipientName) {
    super(ownerPerspectiveClarification(recipientName));
    this.name = 'OwnerPerspectiveError';
    this.code = OWNER_PERSPECTIVE_UNRESOLVED;
    this.reason = reason;
  }
}

export function isOwnerPerspectiveError(error) {
  return Boolean(error) && error.code === OWNER_PERSPECTIVE_UNRESOLVED;
}

// ── Bounded lexicons (data, not rules) ─────────────────────────────────────
const EN_FIRST_PERSON = new Set(['i', 'me', 'my', 'mine', 'myself', "i'm", "i'd", "i'll", "i've"]);
const EN_SECOND_PERSON = new Set(['you', 'your', 'yours', 'yourself', "you're", "you've", "you'll", "you'd"]);
const EN_THIRD_PERSON = new Set(['he', 'she', 'him', 'her', 'his', 'hers', 'himself', 'herself']);
const FEMININE = new Set(['she', 'her', 'hers', 'herself']);

// ── Arabic owner first person (compared after normalizeArabic) ──────────
// Only forms that cannot be read as an instruction to the recipient. Many
// Arabic first-person present forms are identical to the imperative staff
// messages use constantly ("اتصل" = "I call" and "Call!"), so those are
// deliberately NOT listed; Gulf imperatives drop the alef (روح، جيب، سوي،
// قول، شوف، كلم), which is what makes the forms below unambiguous.
const AR_FIRST_PERSON_WORDS = new Set(['انا', 'اني', 'انني', 'فيني', 'عندي', 'معي', 'لي', 'مني', 'نفسي', 'ابوي', 'امي',
  // "I / you" past forms that a third-person feminine subject would not use (she: راحت، جات، سوت، قالت، شافت، خلت)
  'رحت', 'جيت', 'سويت', 'قلت', 'شفت', 'خليت']);
/** First-person singular present (Gulf / MSA), unambiguous with the imperative. */
const AR_FIRST_PERSON_VERBS = ['ابغي', 'ابغا', 'ابي', 'اريد', 'احتاج', 'اقدر', 'اشوف', 'اكلم', 'اكون', 'اخلص',
  'اسوي', 'اقول', 'اظن', 'احب', 'اتمني', 'اجيب', 'اجي', 'اروح', 'انام', 'افكر', 'احس', 'ارجو', 'اتوقع', 'اوعدك'];
/** Object suffixes a first-person verb can carry (اكلمك، ابغاها، ابيه). */
const AR_OBJECT_SUFFIXES = ['', 'ك', 'كي', 'ه', 'ها', 'هم', 'كم'];
/** Gulf future "ب" + stem is first person singular (بروح = I'll go; he/you/we would add ي/ت/ن). */
const AR_FUTURE_STEMS = ['روح', 'جي', 'اجي', 'كلم', 'اتصل', 'رجع', 'طلع', 'وصل', 'خلص', 'سوي', 'قول', 'شوف', 'جيب', 'نام', 'ارسل', 'دفع', 'انتظر'];
/** "My <noun>" — household nouns with the first-person possessive ي. */
const AR_MY_NOUNS = new Set(['بيتي', 'غرفتي', 'سيارتي', 'ولدي', 'بنتي', 'اختي', 'اخوي', 'زوجي', 'زوجتي', 'جوالي', 'تلفوني',
  'مكتبي', 'شنطتي', 'مفاتيحي', 'فلوسي', 'شغلي', 'عيالي', 'اغراضي', 'ملابسي', 'اوراقي', 'موعدي', 'حجزي', 'اهلي', 'ضيوفي']);
/** Words ending in "ني" that are not "me" (يعني = "I mean"/filler, ثاني = second, …). */
const AR_NI_NOT_ME = new Set(['يعني', 'ثاني', 'بني', 'اغاني', 'ثواني', 'معاني', 'مباني', 'تهاني', 'اماني', 'اواني', 'حسني', 'ثماني', 'عثماني', 'لبناني', 'روحاني', 'مجاني']);

const AR_FIRST_PERSON_FORMS = (() => {
  const forms = new Set(AR_FIRST_PERSON_WORDS);
  for (const v of AR_FIRST_PERSON_VERBS) {
    for (const suffix of AR_OBJECT_SUFFIXES) {
      forms.add(v + suffix);
      if (suffix && /ي$/.test(v)) forms.add(v.slice(0, -1) + 'ا' + suffix); // ابغي + ك → ابغاك
    }
  }
  for (const stem of AR_FUTURE_STEMS) forms.add('ب' + stem);
  for (const n of AR_MY_NOUNS) forms.add(n);
  return forms;
})();

/** True when one normalized Arabic token is an owner first-person form. */
function arabicFirstPerson(token) {
  const candidates = [token];
  if (/^[وف]/.test(token) && token.length > 2) candidates.push(token.slice(1)); // one leading conjunction
  return candidates.some((t) =>
    AR_FIRST_PERSON_FORMS.has(t) ||
    (t.length >= 4 && t.endsWith('ني') && !t.startsWith('ال') && !AR_NI_NOT_ME.has(t))); // object "me": كلمني، خبرني، عطني
}

// ── Turkish owner first person ─────────────────────────────────────────────
/** Turkish owner first-person pronouns. "ben" counts only in Turkish text (it is also an English name). */
const TR_FIRST_PERSON = new Set(['beni', 'bana', 'benim', 'benimle', 'bende', 'benden', 'bence', 'kendim', 'kendime', 'kendimi']);
/** First-person singular endings specific enough to count in any text. */
const TR_SPECIFIC_SUFFIXES = /(?:[ıiuü]yorum|acağım|eceğim|acagim|ecegim|mışım|mişim|muşum|müşüm|malıyım|meliyim|[dt][ae]y[ıi]m)$/;
/** Broader first-person singular endings (past, aorist, copula): only in Turkish text. */
const TR_TURKISH_ONLY_SUFFIXES = /(?:dım|dim|dum|düm|tım|tim|tum|tüm|rım|rim|rum|rüm|yım|yim|yum|yüm)$/;
/** Nouns that merely end like a first-person form. */
const TR_SUFFIX_NOT_ME = new Set(['yorum', 'yardım', 'yardim', 'durum', 'forum', 'kurum', 'sürüm', 'dürüm', 'ürüm', 'kılım', 'program',
  'yarım', 'yarim', 'giyim', 'deneyim', 'kaldırım']);
/** "My <noun>" — common possessives; also counted with a case ending (annemde, odama, evimden). */
const TR_MY_NOUNS = new Set(['annem', 'babam', 'eşim', 'esim', 'kocam', 'karım', 'kızım', 'oğlum', 'evim', 'odam', 'arabam',
  'telefonum', 'çantam', 'anahtarım', 'param', 'işim', 'ofisim', 'adresim', 'numaram']);
const TR_CASE_ENDINGS = ['', 'a', 'e', 'ı', 'i', 'u', 'ü', 'da', 'de', 'dan', 'den', 'la', 'le', 'ın', 'in', 'un', 'ün', 'ya', 'ye', 'yı', 'yi'];
const TR_SIGNAL = /[çğışöüİ]/i;
/** Common Turkish words (incl. ASCII-typed forms, no English collisions): one is enough to treat the text as Turkish. */
const TR_FUNCTION_WORDS = new Set(['ve', 'bir', 'bu', 'için', 'icin', 'ile', 'değil', 'degil', 'ama', 'çok', 'cok', 'lütfen', 'lutfen', 'ara', 'söyle', 'soyle',
  'tamam', 'şimdi', 'simdi', 'yarın', 'yarin', 'bugün', 'bugun', 'sonra', 'hemen', 'nerede', 'neden', 'nasıl', 'nasil', 'merhaba', 'abi', 'abla', 'koy', 'getir', 'evde']);

const ADVERBS = new Set(['really', 'also', 'just', 'still', 'already', 'never', 'always', 'only', 'actually', 'definitely',
  'honestly', 'kindly', 'truly', 'simply', 'probably', 'usually', 'often', 'sometimes', 'certainly', 'personally',
  'absolutely', 'totally', 'urgently', 'sincerely', 'not']);
/** Forms that do not change with the subject. */
const INVARIANT = new Set(['will', 'would', 'shall', 'should', 'can', 'could', 'may', 'might', 'must', 'did', "didn't",
  'had', "hadn't", "can't", "won't", "wouldn't", "couldn't", "shouldn't", "mustn't", 'cannot', 'used',
  'went', 'left', 'got', 'came', 'saw', 'said', 'told', 'sent', 'made', 'took', 'gave', 'forgot', 'thought', 'bought',
  'brought', 'found', 'knew', 'felt', 'met', 'paid', 'spoke', 'wrote', 'ran', 'kept', 'lost', 'heard', 'became', 'began']);
/** First-person forms with an irregular third-person form. */
const IRREGULAR = {
  am: 'is', was: 'was', have: 'has', do: 'does', go: 'goes',
  "don't": "doesn't", "haven't": "hasn't", "wasn't": "wasn't",
};
/** Base verbs that are inflected regularly for the owner as subject. */
const BASE_VERBS = new Set(['want', 'need', 'like', 'love', 'miss', 'hope', 'think', 'know', 'wish', 'prefer', 'expect',
  'plan', 'feel', 'appreciate', 'understand', 'agree', 'apologize', 'apologise', 'get', 'come', 'see', 'say', 'ask',
  'mean', 'believe', 'remember', 'forget', 'guess', 'trust', 'suggest', 'owe', 'promise', 'insist', 'care', 'mind',
  'worry', 'look', 'leave', 'arrive', 'call', 'send', 'take', 'make', 'bring', 'give', 'keep', 'tell', 'try', 'work',
  'wait', 'stay', 'live', 'start', 'finish', 'visit', 'meet', 'check', 'confirm', 'hate', 'recommend', 'enjoy',
  'accept', 'allow', 'approve', 'expect', 'need', 'thank', 'request', 'reach', 'land', 'return']);
/** After "I'd": these read as "would". */
const WOULD_NEXT = new Set([...BASE_VERBS, 'rather', 'be']);
/** After "I'd": these read as "had". */
const HAD_NEXT = new Set(['better', 'been', 'already', 'never', 'just']);
const REPORT_VERBS = new Set(['said', 'says', 'say', 'told', 'tells', 'texted', 'texts', 'wrote', 'writes', 'mentioned',
  'mentions', 'replied', 'replies', 'messaged', 'thinks', 'thought', 'claims', 'claimed', 'asked', 'asks', 'heard',
  'hears', 'explained', 'explains', 'promised', 'promises', 'agreed', 'agrees']);
const NON_THIRD_SUBJECTS = new Set(['i', 'you', 'we']);
const SUBORDINATORS = new Set(['and', 'but', 'so', 'if', 'when', 'that', 'because', 'before', 'after', 'until', 'once',
  'while', 'or', 'as', 'since', 'unless', 'then', 'whether']);
/** Words after "her" that make it an object ("call her now"), not a possessive ("her room"). */
const OBJECT_FOLLOWERS = new Set(['to', 'now', 'back', 'later', 'again', 'when', 'if', 'at', 'in', 'on', 'from', 'and',
  'that', 'about', 'today', 'tomorrow', 'tonight', 'soon', 'please', 'first', 'before', 'after', 'as', 'for', 'with',
  'know', 'so', 'or', 'by', 'once', 'right', 'asap', 'yet']);
/** Nouns that can name a person and so compete as an antecedent for he/she. */
const PERSON_NOUNS = new Set(['mother', 'mom', 'mum', 'mama', 'father', 'dad', 'baba', 'brother', 'sister', 'son',
  'daughter', 'husband', 'wife', 'driver', 'doctor', 'friend', 'guest', 'boss', 'teacher', 'nanny', 'maid', 'chef',
  'cook', 'gardener', 'guard', 'neighbour', 'neighbor', 'uncle', 'aunt', 'grandma', 'grandmother', 'grandfather',
  'grandpa', 'cousin', 'baby', 'child', 'kid', 'colleague', 'assistant', 'manager', 'nurse', 'tutor', 'cleaner']);
/** A sentence starting with one of these (after "please") is an instruction to the recipient. */
const IMPERATIVE_STARTS = new Set(['tell', 'ask', 'call', 'let', 'bring', 'take', 'give', 'send', 'remind', 'make',
  'have', 'get', 'help', 'wait', 'meet', 'text', 'message', 'show', 'pay', 'pick', 'drop', 'put', 'keep', 'inform',
  'update', 'check', 'find', 'buy', 'book', 'arrange', 'pass', 'hand', 'fetch', 'grab', 'contact', 'phone', 'email']);
const SENTENCE_LEADERS = new Set(['please', 'and', 'also', 'then', 'so', 'kindly']);
const OWNER_SUBJECT_FORMS = new Set(['i', "i'm", "i'd", "i'll", "i've"]);
const SENTENCE_ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'dr', 'st', 'jr', 'sr', 'prof', 'vs', 'etc', 'no']);

function normalizeArabic(text) {
  return text.replace(/[ً-ْـ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه');
}
const ARABIC = /[؀-ۿ]/;

// ── Tokens ─────────────────────────────────────────────────────────────────
function tokenize(text) {
  const tokens = [];
  const re = /[\p{L}\p{M}\p{N}]+(?:['’][\p{L}]+)*|[^\p{L}\p{M}\p{N}]+/gu;
  let m;
  while ((m = re.exec(text))) {
    const t = m[0];
    const isWord = /[\p{L}\p{N}]/u.test(t[0]);
    tokens.push({ text: t, isWord, lower: isWord ? t.toLowerCase().replace(/’/g, "'") : t });
  }
  return tokens;
}

/** Marks quoted words and sentence starts. Double quotes and curly single quotes only. */
function annotate(tokens) {
  let inDouble = false;
  let inSingle = false;
  let sentence = 0;
  let atSentenceStart = true;
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t.isWord) {
      t.quoted = inDouble || inSingle;
      t.sentence = sentence;
      t.sentenceStart = atSentenceStart;
      atSentenceStart = false;
      continue;
    }
    for (const ch of t.text) {
      if (ch === '"') inDouble = !inDouble;
      else if (ch === '“') inDouble = true;
      else if (ch === '”') inDouble = false;
      else if (ch === '‘') inSingle = true;
      else if (ch === '’') inSingle = false;
      else if (ch === '«') inDouble = true;
      else if (ch === '»') inDouble = false;
    }
    if (/[.!?]/.test(t.text) && (/\s/.test(t.text) || i === tokens.length - 1)) {
      const prev = tokens[i - 1];
      const next = tokens[i + 1];
      const abbreviation = prev?.isWord && SENTENCE_ABBREVIATIONS.has(prev.lower) && t.text.startsWith('.');
      const decimal = prev?.isWord && /\d$/.test(prev.text) && next?.isWord && /^\d/.test(next.text) && !/\s/.test(t.text);
      if (!abbreviation && !decimal) {
        sentence += 1;
        atSentenceStart = true;
      }
    }
  }
  return tokens;
}

function wordIndexes(tokens) {
  return tokens.map((t, i) => (t.isWord ? i : -1)).filter((i) => i >= 0);
}

function isTurkishMyNoun(w) {
  for (const noun of TR_MY_NOUNS) {
    if (w.startsWith(noun) && TR_CASE_ENDINGS.includes(w.slice(noun.length))) return true;
  }
  return false;
}

function isTurkishText(words, tokens) {
  return words.some((i) => {
    const w = tokens[i].text.toLocaleLowerCase('tr');
    return TR_SIGNAL.test(tokens[i].text) || TR_FUNCTION_WORDS.has(w) || TR_FIRST_PERSON.has(w) || isTurkishMyNoun(w) ||
      (TR_SPECIFIC_SUFFIXES.test(w) && !TR_SUFFIX_NOT_ME.has(w));
  });
}

/** True when one Turkish (Latin-script) token is an owner first-person form. */
function turkishFirstPerson(text, turkish) {
  const w = text.toLocaleLowerCase('tr');
  if (TR_FIRST_PERSON.has(w) || (turkish && w === 'ben')) return true;
  if (TR_SUFFIX_NOT_ME.has(w)) return false;
  if (isTurkishMyNoun(w)) return true;
  if (TR_SPECIFIC_SUFFIXES.test(w) && w.length >= 6) return true;
  if (!turkish) return false;
  return TR_TURKISH_ONLY_SUFFIXES.test(w) && w.length >= 5;
}

function thirdPersonForm(word) {
  if (IRREGULAR[word]) return IRREGULAR[word];
  if (INVARIANT.has(word)) return word;
  if (!BASE_VERBS.has(word)) return /ed$/.test(word) ? word : null; // regular past tense is subject-invariant
  if (/(s|sh|ch|x|z|o)$/.test(word)) return `${word}es`;
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

function matchCase(original, replacement) {
  if (original === original.toUpperCase() && original.length > 1) return replacement.toUpperCase();
  return replacement;
}

/**
 * @param {string} text
 * @param {{ ownerName?: string | null, recipientName?: string | null, voice: 'owner_to_recipient' | 'task_text' | 'task_record' }} options
 * @returns {{ status: 'unchanged' | 'rendered' | 'needs_composition', text: string, reason: string | null, language: string[] }}
 */
export function resolveOwnerPerspective(text, { ownerName, recipientName = null, voice }) {
  const input = String(text ?? '');
  const owner = String(ownerName || '').trim();
  const recipient = String(recipientName || '').trim().toLowerCase();
  if (!['owner_to_recipient', 'task_text', 'task_record'].includes(voice)) throw new Error('resolveOwnerPerspective: unknown voice');
  const recordVoice = voice !== 'owner_to_recipient';

  const tokens = annotate(tokenize(input));
  const words = wordIndexes(tokens);
  const language = [];
  if (words.some((i) => /[a-z]/i.test(tokens[i].text))) language.push('en');
  if (ARABIC.test(input)) language.push('ar');
  const turkish = isTurkishText(words, tokens);
  if (turkish) language.push('tr');

  const fail = (reason) => ({ status: 'needs_composition', text: input, reason, language });

  // ── 1. Roles ────────────────────────────────────────────────────────────
  // Arabic / Turkish owner first person: detected, never rendered.
  for (const i of words) {
    const t = tokens[i];
    if (t.quoted) continue;
    if (ARABIC.test(t.text)) {
      if (arabicFirstPerson(normalizeArabic(t.text))) return fail('arabic_owner_first_person');
    } else if (turkishFirstPerson(t.text, turkish)) {
      return fail('turkish_owner_first_person');
    }
  }
  // A stored task record in a language the boundary cannot render is never
  // quoted: its perspective cannot be verified, so the follow-up stays neutral.
  if (voice === 'task_record' && (language.includes('ar') || language.includes('tr'))) {
    return fail('unverifiable_language_in_task_record');
  }

  if (voice === 'task_record' && words.some((i) => !tokens[i].quoted && EN_SECOND_PERSON.has(tokens[i].lower))) {
    return fail('second_person_in_task_record');
  }
  const ownerRefs = words.filter((i) => !tokens[i].quoted && EN_FIRST_PERSON.has(tokens[i].lower));
  if (!ownerRefs.length) return { status: 'unchanged', text: input, reason: null, language };
  if (!owner) return fail('no_owner_name');

  // Reported speech: a third party's reporting verb makes later first person ambiguous.
  for (const i of words) {
    const t = tokens[i];
    if (t.quoted || !REPORT_VERBS.has(t.lower) || t.sentenceStart) continue;
    const before = words.filter((j) => j < i && tokens[j].sentence === t.sentence && !tokens[j].quoted && !ADVERBS.has(tokens[j].lower));
    const subject = before[before.length - 1];
    if (subject === undefined || NON_THIRD_SUBJECTS.has(tokens[subject].lower)) continue;
    if (ownerRefs.some((j) => j > i && tokens[j].sentence === t.sentence)) return fail('reported_speech_first_person');
  }

  // Mixed owner references: the owner's name together with owner pronouns.
  const ownerLower = owner.toLowerCase();
  if (words.some((i) => !tokens[i].quoted && tokens[i].lower === ownerLower)) return fail('mixed_owner_reference');

  // Recipient / third-party roles for third-person pronouns.
  const third = words.filter((i) => !tokens[i].quoted && EN_THIRD_PERSON.has(tokens[i].lower));
  const recipientRefs = new Map();
  if (third.length) {
    const genders = new Set(third.map((i) => (FEMININE.has(tokens[i].lower) ? 'f' : 'm')));
    if (genders.size > 1) return fail('third_party_reference_ambiguous');
  }
  const sentenceWords = (s) => words.filter((j) => tokens[j].sentence === s && !tokens[j].quoted);
  const isImperative = (s) => {
    const ws = sentenceWords(s).filter((j) => !SENTENCE_LEADERS.has(tokens[j].lower));
    return ws.length > 0 && IMPERATIVE_STARTS.has(tokens[ws[0]].lower);
  };
  const hasCompetingAntecedent = (i) => words.some((j) => {
    if (j >= i || tokens[j].quoted) return false;
    const w = tokens[j];
    if (PERSON_NOUNS.has(w.lower)) return true;
    const capitalized = /^\p{Lu}/u.test(w.text) && !w.sentenceStart;
    return capitalized && w.lower !== 'i' && !w.lower.startsWith("i'") && w.lower !== recipient && w.lower !== ownerLower;
  });
  const nextWordAfter = (i) => {
    const nextIdx = words.find((j) => j > i);
    if (nextIdx === undefined) return null;
    if (/[.!?,;:]/.test(tokens.slice(i + 1, nextIdx).map((t) => t.text).join(''))) return null;
    return tokens[nextIdx].lower;
  };
  let previousRole = null;
  for (const i of third) {
    const w = tokens[i].lower;
    const next = nextWordAfter(i);
    let role;
    if (previousRole) role = previousRole;
    else if (recordVoice || isImperative(tokens[i].sentence) || hasCompetingAntecedent(i)) role = 'third';
    else role = 'recipient';
    previousRole = role;
    const objectForm = w === 'him' || (w === 'her' && (next === null || OBJECT_FOLLOWERS.has(next)));

    if (role === 'recipient') {
      if (!recipient) return fail('recipient_reference_unresolved');
      if (w === 'he' || w === 'she') return fail('recipient_subject_reference');
      if (w === 'him') recipientRefs.set(i, 'you');
      else if (w === 'himself' || w === 'herself') recipientRefs.set(i, 'yourself');
      else if (w === 'hers') recipientRefs.set(i, 'yours');
      else if (w === 'his') recipientRefs.set(i, next === null ? 'yours' : 'your');
      else if (objectForm) recipientRefs.set(i, 'you');
      else return fail('recipient_reference_ambiguous');
      continue;
    }

    // A kept third-party pronoun must not become readable as the owner once
    // the owner's name is inserted earlier in the same sentence. The only
    // safe case: an object pronoun in the same clause as an owner subject
    // ("Sana will speak to him" cannot mean Sana).
    const priorOwner = ownerRefs.filter((j) => j < i && tokens[j].sentence === tokens[i].sentence).pop();
    if (priorOwner === undefined) continue;
    const between = words.filter((j) => j > priorOwner && j < i);
    const sameClause = !between.some((j) => SUBORDINATORS.has(tokens[j].lower)) &&
      !/[,;:]/.test(tokens.slice(priorOwner + 1, i).map((t) => t.text).join(''));
    if (!(objectForm && OWNER_SUBJECT_FORMS.has(tokens[priorOwner].lower) && sameClause)) return fail('third_party_ambiguity_introduced');
  }

  // ── 2. Rendering (English) ─────────────────────────────────────────────
  const out = tokens.map((t) => t.text);
  const possessive = `${owner}'s`;
  const nextVerb = (i) => words.find((j) => j > i && !ADVERBS.has(tokens[j].lower) && tokens[j].sentence === tokens[i].sentence);

  for (const i of ownerRefs) {
    const t = tokens[i];
    const w = t.lower;
    const name = t.sentenceStart ? owner.charAt(0).toUpperCase() + owner.slice(1) : owner;
    if (w === 'myself') {
      // Emphatic / reflexive with the owner as subject ("I did it myself")
      // would need a gendered "herself"/"himself"; no gender data exists.
      const ownerSubjectBefore = ownerRefs.some((j) => j < i && tokens[j].sentence === t.sentence && OWNER_SUBJECT_FORMS.has(tokens[j].lower));
      if (ownerSubjectBefore) return fail('owner_reflexive');
      out[i] = name; // plain object: "call myself" / "buy it for myself" means the owner
      continue;
    }
    if (w === 'me') { out[i] = name; continue; }
    if (w === 'my' && tokens[words[words.indexOf(i) - 1]]?.lower === 'on' && tokens[words[words.indexOf(i) + 1]]?.lower === 'way') {
      out[i] = 'the'; // gender-neutral idiom: "on my way" -> "on the way"
      continue;
    }
    if (w === 'my' || w === 'mine') {
      out[i] = t.sentenceStart ? `${name}'s` : possessive;
      continue;
    }
    if (w === "i'm") { out[i] = `${name} is`; continue; }
    if (w === "i've") { out[i] = `${name} has`; continue; }
    if (w === "i'll") { out[i] = `${name} will`; continue; }
    const v = nextVerb(i);
    if (w === "i'd") {
      const nv = v === undefined ? null : tokens[v].lower;
      if (nv && (HAD_NEXT.has(nv) || (/ed$/.test(nv) && !BASE_VERBS.has(nv)))) { out[i] = `${name} had`; continue; }
      if (nv && WOULD_NEXT.has(nv)) { out[i] = `${name} would`; continue; }
      return fail('unresolved_owner_verb');
    }
    // Subject "I".
    if (v === undefined) return fail('unresolved_owner_verb');
    const inflected = thirdPersonForm(tokens[v].lower);
    if (inflected === null) return fail('unresolved_owner_verb');
    out[i] = name;
    if (inflected !== tokens[v].lower) out[v] = matchCase(tokens[v].text, inflected);
  }
  for (const [i, replacement] of recipientRefs) {
    out[i] = tokens[i].sentenceStart ? replacement.charAt(0).toUpperCase() + replacement.slice(1) : replacement;
  }
  return { status: 'rendered', text: out.join(''), reason: null, language };
}

/** Resolve, or throw OwnerPerspectiveError so the caller fails closed. */
export function renderOwnerPerspective(text, options) {
  const result = resolveOwnerPerspective(text, options);
  if (result.status === 'needs_composition') throw new OwnerPerspectiveError(result.reason, options.recipientName);
  return result.text;
}
