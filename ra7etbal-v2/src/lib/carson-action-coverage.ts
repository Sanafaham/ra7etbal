import type { Person } from "../types/person";

export type DelegationCoverageConfidence = "high" | "medium";

export interface ExpectedDelegationCandidate {
  personName: string;
  actionText: string;
  sourceSpan: string;
  confidence: DelegationCoverageConfidence;
}

export interface ExecutedDelegationRecord {
  personName?: string | null;
  actionText?: string | null;
  type?: "delegation" | "message" | "followup" | string;
  status?: "created" | "sent" | "blocked" | "failed" | string;
}

export interface DelegationCoverageResult {
  expected: ExpectedDelegationCandidate[];
  missing: ExpectedDelegationCandidate[];
}

const DELEGATION_ACTION_VERBS =
  /\b(?:calls?|sends?|brings?|takes?|pick(?:s|ed|ing)?\s+up|drops?|checks?|clean(?:s|ed|ing)?|wash(?:es|ed|ing)?|buys?|books?|arranges?|schedules?|confirms?|completes?|finish(?:es|ed|ing)?|prepares?|replaces?|fix(?:es|ed|ing)?|pays?|files?|orders?|has|have|makes?|gets?|ensures?|ready)\b/i;

const STOP_WORD_PATTERN =
  /\s+(?:and|also|then)\s+(?:please\s+)?(?:ask|tell|get|have|remind|make\s+sure)\s+/i;

export function extractExpectedDelegationCandidates(
  transcript: string,
  people: Pick<Person, "name">[],
): ExpectedDelegationCandidate[] {
  const text = transcript.trim();
  if (!text) return [];

  const candidates: ExpectedDelegationCandidate[] = [];
  const seen = new Set<string>();
  const knownPeople = people
    .map((person) => person.name.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);

  for (const personName of knownPeople) {
    const personPattern = escapeRegExp(personName);
    const patterns: Array<{ regex: RegExp; confidence: DelegationCoverageConfidence }> = [
      {
        regex: new RegExp(`\\b(?:ask|tell|get)\\s+${personPattern}\\s+to\\s+([^.!?;]+)`, "gi"),
        confidence: "high",
      },
      {
        regex: new RegExp(`\\bremind\\s+${personPattern}\\s+to\\s+([^.!?;]+)`, "gi"),
        confidence: "high",
      },
      {
        regex: new RegExp(`\\bhave\\s+${personPattern}\\s+([^.!?;]+)`, "gi"),
        confidence: "high",
      },
      {
        regex: new RegExp(`\\bmake\\s+sure\\s+${personPattern}\\s+([^.!?;]+)`, "gi"),
        confidence: "medium",
      },
    ];

    for (const { regex, confidence } of patterns) {
      for (const match of text.matchAll(regex)) {
        const fullMatch = match[0]?.trim();
        const rawAction = match[1]?.trim();
        if (!fullMatch || !rawAction) continue;

        const actionText = cleanActionText(rawAction);
        if (!isDelegationLikeAction(actionText)) continue;

        const sourceSpan = trimSourceSpan(fullMatch, rawAction, actionText);
        const key = `${personName.toLowerCase()}::${normalizeCoverageText(actionText)}`;
        if (seen.has(key)) continue;
        seen.add(key);

        candidates.push({
          personName,
          actionText,
          sourceSpan,
          confidence,
        });
      }
    }
  }

  return candidates.sort((a, b) => {
    const aIndex = text.toLowerCase().indexOf(a.sourceSpan.toLowerCase());
    const bIndex = text.toLowerCase().indexOf(b.sourceSpan.toLowerCase());
    return aIndex - bIndex;
  });
}

export function findMissingDelegationCandidates(
  expected: ExpectedDelegationCandidate[],
  executed: ExecutedDelegationRecord[],
): ExpectedDelegationCandidate[] {
  return expected.filter((candidate) => !hasExecutedDelegation(candidate, executed));
}

export function checkDelegationCoverage(
  transcript: string,
  people: Pick<Person, "name">[],
  executed: ExecutedDelegationRecord[],
): DelegationCoverageResult {
  const expected = extractExpectedDelegationCandidates(transcript, people);
  return {
    expected,
    missing: findMissingDelegationCandidates(expected, executed),
  };
}

function hasExecutedDelegation(
  candidate: ExpectedDelegationCandidate,
  executed: ExecutedDelegationRecord[],
): boolean {
  const candidatePerson = normalizeCoverageText(candidate.personName);
  const candidateAction = normalizeCoverageText(candidate.actionText);

  return executed.some((record) => {
    if (record.type && record.type !== "delegation" && record.type !== "followup") {
      return false;
    }
    const recordPerson = normalizeCoverageText(record.personName ?? "");
    if (!recordPerson || recordPerson !== candidatePerson) return false;

    const recordAction = normalizeCoverageText(record.actionText ?? "");
    if (!recordAction) return true;

    return actionTextsOverlap(candidateAction, recordAction);
  });
}

function cleanActionText(actionText: string): string {
  const beforeNextCommand = actionText.split(STOP_WORD_PATTERN)[0] ?? actionText;
  return beforeNextCommand
    .replace(/\s+/g, " ")
    .replace(/^[,:\-\s]+|[,:\-\s]+$/g, "")
    .trim();
}

function trimSourceSpan(fullMatch: string, rawAction: string, cleanAction: string): string {
  if (rawAction === cleanAction) return fullMatch;
  const actionIndex = fullMatch.toLowerCase().indexOf(rawAction.toLowerCase());
  if (actionIndex < 0) return fullMatch;
  return `${fullMatch.slice(0, actionIndex)}${cleanAction}`.trim();
}

function isDelegationLikeAction(actionText: string): boolean {
  const normalized = normalizeCoverageText(actionText);
  if (!normalized) return false;
  if (/^(?:that|if|whether)\b/.test(normalized)) return false;
  return DELEGATION_ACTION_VERBS.test(actionText);
}

function actionTextsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;

  const aTokens = meaningfulTokens(a);
  const bTokens = meaningfulTokens(b);
  if (aTokens.length === 0 || bTokens.length === 0) return false;

  const overlap = aTokens.filter((token) => bTokens.includes(token)).length;
  return overlap >= Math.min(3, aTokens.length, bTokens.length);
}

function meaningfulTokens(text: string): string[] {
  const stop = new Set(["the", "a", "an", "and", "to", "by", "at", "for", "with", "have"]);
  return normalizeCoverageText(text)
    .split(" ")
    .filter((token) => token.length > 2 && !stop.has(token));
}

function normalizeCoverageText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
