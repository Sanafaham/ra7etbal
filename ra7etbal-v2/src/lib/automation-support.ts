// PURE RELOCATION (2026-08-28, Second Brain typed hard-grounding slice):
// moved to shared/ so the server-side attention read path can reuse the
// exact same routineAutomationTaskIds classification rules that
// buildMorningBrief() depends on. Re-exported here so every existing
// caller's import path (`./automation-support`) and behavior are unchanged.
export {
  isUnsupportedRecurringWhatsappAutomation,
  isSupportedOperationalAutomation,
  filterSupportedOperationalAutomations,
} from "../../shared/automation-support-classifier.js";
export type { AutomationSupportFields } from "../../shared/automation-support-classifier";
