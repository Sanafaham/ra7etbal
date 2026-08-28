export interface AutomationSupportFields {
  automation_type?: string | null;
  assignee_id?: string | null;
  cadence_type?: string | null;
}

export function isUnsupportedRecurringWhatsappAutomation(row: AutomationSupportFields): boolean;

export function isSupportedOperationalAutomation(row: AutomationSupportFields): boolean;

export function filterSupportedOperationalAutomations<T extends AutomationSupportFields>(rows: T[]): T[];
