/**
 * Daily inspiration — a single quiet line that rotates once per calendar day.
 *
 * The owner sees the same line all day; it changes overnight. The rotation
 * is deterministic by day-of-year so it survives refresh, navigation, and
 * cold starts without any storage.
 *
 * Tone rules (don't add lines that break these):
 *   - calm, not motivational
 *   - quiet, not loud
 *   - never about productivity, optimization, performance, efficiency
 *   - never imperative ("Do this", "Achieve that")
 *   - never childish or cheesy
 *   - reads like a handwritten note in a luxury hotel room
 */

const LINES = [
  "Clarity is a form of luxury.",
  "You do not need to remember everything.",
  "Peace comes from trusted systems.",
  "Your mind was not built to hold every task.",
  "The goal is not control. It is relief.",
  "Say it once. Let the system hold it.",
  "A calm mind begins with a trusted place.",
  "Peace of mind is knowing what is handled.",
  "Speak gently. The world will follow.",
  "What you set down, you no longer carry.",
  "Quiet is also a form of progress.",
  "You are allowed to put it down for a moment.",
  "Trust the people you have. Trust the system you built.",
  "A still mind sees the next step clearly.",
  "Tasks are lighter when shared.",
  "The day softens when nothing is forgotten.",
  "Order is a kindness you give yourself.",
  "Not every thought needs to be solved at once.",
  "Set the load down. The list will keep.",
  "Less in your head. More in your hands.",
  "You handled enough today by arriving.",
  "Peace is the absence of unfinished noise.",
  "What is captured cannot be lost.",
  "Speak the thing once. That is enough.",
  "The luxury is forgetting, on purpose.",
  "Small acts of order, often.",
  "Quietly, things are taken care of.",
  "A clear desk. A clear hour. A clear breath.",
  "Some tasks are best handed to someone else.",
  "Carrying less is not the same as caring less.",
  "Order is permission to rest.",
  "What gets written down stops echoing.",
  "Trust is the foundation of every quiet home.",
  "A calm voice carries further than a loud one.",
  "The mind needs margin, not maximum.",
  "Today does not need to be perfect to be peaceful.",
  "Hand off what you can. Hold only what you must.",
  "Peace of mind is built one small offload at a time.",
  "The household runs better when the head does not.",
  "Slow is also a kind of beautiful.",
];

/**
 * Returns the inspiration line for the given date. Defaults to today.
 * Stable for the entire calendar day in the user's local timezone.
 */
export function dailyInspiration(now: Date = new Date()): string {
  // Day-of-year, 0-indexed. Crosses midnight in the user's local timezone.
  const start = new Date(now.getFullYear(), 0, 0);
  const diff = now.getTime() - start.getTime();
  const dayOfYear = Math.floor(diff / (1000 * 60 * 60 * 24));
  const idx = dayOfYear % LINES.length;
  return LINES[idx]!;
}
