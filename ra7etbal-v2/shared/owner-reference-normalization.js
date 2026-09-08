/**
 * Server/browser-safe canonical owner-reference normalization.
 * Conservative subject conversion plus a curated object-pronoun list.
 */

// Sentence-boundary splitter used only to let the leading-subject rules
// (below) see the start of EVERY sentence in a multi-sentence message, not
// just the start of the whole string. A production incident showed
// "Wait for me. I'm on my way." normalizing only the first clause (object
// pronoun, global) while leaving the second clause's leading "I'm" as the
// whole-string anchor never reached past sentence 1 — producing mixed
// first/third-person output ("Wait for Sana. I'm on my way."). Deliberately
// abbreviation/decimal-aware so "Tell Mr. Smith..." and "3.5 kg" don't get
// split at a false sentence boundary.
const SENTENCE_ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'st', 'jr', 'sr', 'prof', 'vs', 'etc', 'no',
]);

// Each returned clause carries whether its FIRST character sits inside an
// still-open double quote (an odd number of `"` seen in every prior clause),
// so normalizeFirstPersonForOwner can leave quoted reported speech alone even
// when the quote spans more than one clause — e.g. `She said, "I am leaving.
// I'll return later."` previously rewrote the second sentence's leading
// "I'll" (a real, reproduced bug) because clause-splitting has no concept of
// which clause is still inside the quote the first clause opened.
function splitIntoSentenceClauses(text) {
  const boundary = /[.!?]+(\s+)/g;
  const clauses = [];
  let start = 0;
  let quoteCountBeforeStart = 0;
  let match;
  while ((match = boundary.exec(text))) {
    const punctuationEnd = match.index + match[0].length - match[1].length;
    const before = text.slice(start, match.index);
    const after = text.slice(punctuationEnd);
    const lastWord = (before.match(/([A-Za-z]+)$/) || [])[1];
    const isAbbreviation = lastWord && SENTENCE_ABBREVIATIONS.has(lastWord.toLowerCase());
    const isDecimal = /\d$/.test(before) && /^\d/.test(after);
    if (isAbbreviation || isDecimal) continue;
    const clauseEnd = match.index + match[0].length;
    const clauseText = text.slice(start, clauseEnd);
    clauses.push({ text: clauseText, insideQuote: quoteCountBeforeStart % 2 === 1 });
    quoteCountBeforeStart += (clauseText.match(/"/g) || []).length;
    start = clauseEnd;
  }
  clauses.push({ text: text.slice(start), insideQuote: quoteCountBeforeStart % 2 === 1 });
  return clauses;
}

// The original single-clause normalization logic, unchanged in behavior —
// now applied per sentence clause instead of once to the whole message, so
// single-clause callers see byte-for-byte identical output to before.
function normalizeClause(clause, owner) {
  const possessive = clause.match(/^my\s+(.*)$/i);
  if (possessive?.[1]) return `${owner}'s ${possessive[1]}`;

  const subjectRules = [
    [/^i['’]m\s+/i, 'is'],
    [/^i am\s+/i, 'is'],
    [/^i['’]ve\s+/i, 'has'],
    [/^i have\s+/i, 'has'],
    [/^i['’]ll\s+/i, 'will'],
    [/^i will\s+/i, 'will'],
    [/^i['’]d\s+/i, 'would'],
    [/^i had\s+/i, 'had'],
  ];
  for (const [pattern, verb] of subjectRules) {
    const match = clause.match(pattern);
    if (!match) continue;
    const rest = clause.slice(match[0].length);
    if (!rest) return clause;
    const onMyWay = rest.match(/^on my way\b(.*)$/i);
    return onMyWay
      ? `${owner} ${verb} on the way${onMyWay[1]}`
      : `${owner} ${verb} ${rest}`;
  }

  if (/^i\b/i.test(clause)) return clause;

  let result = clause.replace(/\bmyself\b/gi, owner);
  for (const pattern of [
    /\b(?:call|contact|reach|text|message|phone|email)\s+me\b/gi,
    /\bwait\s+for\s+me\b/gi,
    /\b(?:bring|get|give|send|hand|pass|fetch|grab)\s+me\b/gi,
  ]) {
    result = result.replace(pattern, (match) => match.replace(/me$/i, owner));
  }
  return result;
}

export function normalizeFirstPersonForOwner(messageText, ownerName) {
  const owner = String(ownerName || '').trim();
  if (!owner) return messageText;
  const trimmed = String(messageText || '').trim();
  if (!trimmed) return messageText;

  const clauses = splitIntoSentenceClauses(trimmed);
  if (clauses.length <= 1) return normalizeClause(trimmed, owner);

  let changed = false;
  const normalized = clauses.map(({ text: clause, insideQuote }) => {
    if (insideQuote) return clause;
    const result = normalizeClause(clause, owner);
    if (result !== clause) changed = true;
    return result;
  });
  return changed ? normalized.join('') : messageText;
}
