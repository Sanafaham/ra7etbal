export interface AutomationSupportFields {
  automation_type?: string | null;
  assignee_id?: string | null;
  cadence_type?: string | null;
}

export function isUnsupportedRecurringWhatsappAutomation(row: AutomationSupportFields): boolean {
  if (row.cadence_type === "once") return false;
  return row.automation_type === "message" || Boolean(row.assignee_id);
}

export function isSupportedOperationalAutomation(row: AutomationSupportFields): boolean {
  return !isUnsupportedRecurringWhatsappAutomation(row);
}

export function filterSupportedOperationalAutomations<T extends AutomationSupportFields>(rows: T[]): T[] {
  return rows.filter(isSupportedOperationalAutomation);
}
