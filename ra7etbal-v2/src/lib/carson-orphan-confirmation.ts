const SHORT_CONFIRMATION_RE =
  /^\s*(?:yes|yeah|yep|yup|sure|ok|okay|go ahead|do it|send it|please do)\s*[.!]?\s*$/i;

const PEOPLE_ACTION_TOOLS = new Set([
  "route_people_action",
  "send_direct_whatsapp_message",
  "send_delegation",
]);

export const ORPHANED_PEOPLE_CONFIRMATION_REPLY =
  "The previous request is already complete. There is no pending clarification waiting for your response.";

export function resolveOrphanedPeopleToolConfirmation(input: {
  utterance: string;
  selectedTool: string;
  hasPendingContinuation: boolean;
  hasRecentCompletedPeopleAction: boolean;
}): string | null {
  if (
    !input.hasPendingContinuation
    && input.hasRecentCompletedPeopleAction
    && PEOPLE_ACTION_TOOLS.has(input.selectedTool)
    && SHORT_CONFIRMATION_RE.test(input.utterance)
  ) {
    return ORPHANED_PEOPLE_CONFIRMATION_REPLY;
  }
  return null;
}
