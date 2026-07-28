/**
 * Server/browser-safe canonical owner-reference normalization.
 * Conservative subject conversion plus a curated object-pronoun list.
 */
export function normalizeFirstPersonForOwner(messageText, ownerName) {
  const owner = String(ownerName || '').trim();
  if (!owner) return messageText;
  const trimmed = String(messageText || '').trim();
  if (!trimmed) return messageText;

  const possessive = trimmed.match(/^my\s+(.*)$/i);
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
    const match = trimmed.match(pattern);
    if (!match) continue;
    const rest = trimmed.slice(match[0].length);
    if (!rest) return messageText;
    const onMyWay = rest.match(/^on my way\b(.*)$/i);
    return onMyWay
      ? `${owner} ${verb} on the way${onMyWay[1]}`
      : `${owner} ${verb} ${rest}`;
  }

  if (/^i\b/i.test(trimmed)) return messageText;

  let result = trimmed.replace(/\bmyself\b/gi, owner);
  for (const pattern of [
    /\b(?:call|contact|reach|text|message|phone|email)\s+me\b/gi,
    /\bwait\s+for\s+me\b/gi,
    /\b(?:bring|get|give|send|hand|pass|fetch|grab)\s+me\b/gi,
  ]) {
    result = result.replace(pattern, (match) => match.replace(/me$/i, owner));
  }
  return result;
}
