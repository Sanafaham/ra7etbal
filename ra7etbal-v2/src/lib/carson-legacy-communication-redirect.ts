import type { LegacyPeopleToolCommunicationRedirect } from "./carson-tool-policy";
import { preserveDirectCommunicationMeaning } from "./communication-vs-delegation";

export interface ExecutedLegacyCommunicationRedirect {
  originalTool: "send_delegation";
  finalTool: "send_direct_whatsapp_message";
  recipientName: string;
  normalizedMessage: string;
}

/**
 * Executes an already-authorized legacy communication redirect.
 *
 * Classification remains in resolveLegacyPeopleToolCommunicationRedirect.
 * This seam only normalizes the selected message, records the original/final
 * handlers, and calls the existing direct-message handler exactly once.
 */
export async function executeLegacyPeopleCommunicationRedirect<T>(input: {
  redirect: LegacyPeopleToolCommunicationRedirect;
  utterance: string;
  recordRedirect: (event: ExecutedLegacyCommunicationRedirect) => void;
  sendDirectMessage: (params: { recipient_name: string; message: string }) => Promise<T>;
}): Promise<T> {
  const normalizedMessage = preserveDirectCommunicationMeaning(
    input.utterance,
    input.redirect.params.recipient_name,
    input.redirect.params.message,
  );
  const params = {
    ...input.redirect.params,
    message: normalizedMessage,
  };

  input.recordRedirect({
    originalTool: input.redirect.originalTool,
    finalTool: input.redirect.finalTool,
    recipientName: params.recipient_name,
    normalizedMessage,
  });

  return input.sendDirectMessage(params);
}
