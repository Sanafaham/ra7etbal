/**
 * Server/browser-safe automation-support classification.
 *
 * PURE RELOCATION from src/lib/automation-support.ts (2026-08-28, Second
 * Brain typed hard-grounding slice) — no behavior change. Needed
 * server-side because buildMorningBrief()'s routineAutomationTaskIds
 * exclusion (see carson-morning-brief-classifier.js) depends on this exact
 * classification, and it must not be duplicated. src/lib/automation-support.ts
 * re-exports from here so every existing caller's import path
 * (`./automation-support`) and behavior are unchanged.
 */

export function isUnsupportedRecurringWhatsappAutomation(row) {
  if (row.cadence_type === "once") return false;
  return row.automation_type === "message" || Boolean(row.assignee_id);
}

export function isSupportedOperationalAutomation(row) {
  return !isUnsupportedRecurringWhatsappAutomation(row);
}

export function filterSupportedOperationalAutomations(rows) {
  return rows.filter(isSupportedOperationalAutomation);
}
