interface BuildCarsonOpeningLineInput {
  isFirstSessionToday: boolean;
  displayName?: string | null;
  spokenBrief?: string | null;
  now?: Date;
  variantIndex?: number;
  /**
   * Short, standalone clauses (each ending with a period) for material
   * items that are new or changed since they were last surfaced — only
   * consulted on non-first sessions. Never repeats an unchanged item.
   */
  newOrChangedMaterialText?: string[];
}

const FOLLOW_UP_OPENINGS_WITH_NAME = [
  (greeting: string, name: string) => `${greeting}, ${name}.`,
  (_greeting: string, name: string) => `Welcome back, ${name}.`,
  (greeting: string, name: string) => `${greeting}, ${name}. I'm ready.`,
  (_greeting: string, name: string) => `Hi ${name}. What needs attention?`,
  (greeting: string, name: string) => `${greeting}, ${name}. What can I help with?`,
] as const;

const FOLLOW_UP_OPENINGS_WITHOUT_NAME = [
  (greeting: string) => `${greeting}.`,
  () => "Welcome back.",
  (greeting: string) => `${greeting}. I'm ready.`,
  () => "Hi. What needs attention?",
  (greeting: string) => `${greeting}. What can I help with?`,
] as const;

export function buildCarsonOpeningLine({
  isFirstSessionToday,
  displayName,
  spokenBrief,
  now = new Date(),
  variantIndex = 0,
  newOrChangedMaterialText = [],
}: BuildCarsonOpeningLineInput): string {
  const greeting = getTimeGreeting(now);
  const name = displayName?.trim() || "";

  if (!isFirstSessionToday) {
    const variants = name ? FOLLOW_UP_OPENINGS_WITH_NAME : FOLLOW_UP_OPENINGS_WITHOUT_NAME;
    const variant = variants[positiveModulo(variantIndex, variants.length)];
    const base = name ? variant(greeting, name) : variant(greeting, "");

    if (newOrChangedMaterialText.length === 0) return base;

    const MAX_ITEMS = 3;
    const shown = newOrChangedMaterialText.slice(0, MAX_ITEMS);
    const extra = newOrChangedMaterialText.length - shown.length;
    const extraClause = extra > 0 ? ` And ${extra} more thing${extra === 1 ? "" : "s"} to cover.` : "";
    return `${base} ${shown.join(" ")}${extraClause}`;
  }

  const prefix = name ? `${greeting}, ${name}.` : `${greeting}.`;
  const brief = stripBriefGreeting(spokenBrief ?? "");
  if (!brief) return `${prefix} I'm ready.`;
  return `${prefix} ${brief}`;
}

function getTimeGreeting(now: Date): "Good morning" | "Good afternoon" | "Good evening" {
  const hour = now.getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

function stripBriefGreeting(text: string): string {
  return text
    .trim()
    .replace(/^(Good morning|Good afternoon|Good evening)[^.]*\.\s*/i, "")
    .replace(/\bI(?:'|’)m here(?: if you want anything handled)?\.?/gi, "")
    .replace(/\bOne moment\.?/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}
