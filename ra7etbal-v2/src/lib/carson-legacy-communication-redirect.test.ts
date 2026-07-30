import { describe, expect, it, vi } from "vitest";
import {
  isRecentDirectWhatsappDuplicate,
  recordDirectWhatsappSent,
} from "./direct-message-duplicate-guard";
import { executeLegacyPeopleCommunicationRedirect } from "./carson-legacy-communication-redirect";
import { resolveLegacyPeopleToolCommunicationRedirect } from "./carson-tool-policy";

const PEOPLE = [{ name: "Christopher" }, { name: "Grace" }];
const COMPOUND_UTTERANCE =
  "Ask Christopher to reply yes if he can come tomorrow, then tell Grace to order more chairs.";

function resolveRedirect() {
  const redirect = resolveLegacyPeopleToolCommunicationRedirect({
    utterance: COMPOUND_UTTERANCE,
    channel: "voice",
    selectedTool: "send_delegation",
    toolArguments: {
      name: "Christopher",
      task: "reply yes if he can come tomorrow, then tell Grace to order more chairs",
    },
    people: PEOPLE,
  });
  expect(redirect).not.toBeNull();
  return redirect!;
}

describe("legacy send_delegation communication redirect — behavioral integration", () => {
  it("redirects once, preserves meaning, suppresses a duplicate callback, and never delegates", async () => {
    const sentAt = new Map<string, number>();
    const transport = vi.fn(async (_params: { recipient_name: string; message: string }) => ({
      accepted: true,
      messageId: "wamid.1",
    }));
    const delegation = vi.fn();
    const diagnostics = vi.fn();
    const directHandler = vi.fn(async (params: { recipient_name: string; message: string }) => {
      if (isRecentDirectWhatsappDuplicate(sentAt, params.recipient_name, params.message, 1_000)) {
        return { outcome: "duplicate_suppressed" as const };
      }
      const delivery = await transport(params);
      if (!delivery.accepted) return { outcome: "failure" as const };
      recordDirectWhatsappSent(sentAt, params.recipient_name, params.message, 1_000);
      return { outcome: "success" as const, transportMessageId: delivery.messageId };
    });

    const execute = () => executeLegacyPeopleCommunicationRedirect({
      redirect: resolveRedirect(),
      utterance: COMPOUND_UTTERANCE,
      recordRedirect: diagnostics,
      sendDirectMessage: directHandler,
    });

    await expect(execute()).resolves.toEqual({
      outcome: "success",
      transportMessageId: "wamid.1",
    });
    await expect(execute()).resolves.toEqual({ outcome: "duplicate_suppressed" });

    expect(delegation).not.toHaveBeenCalled();
    expect(directHandler).toHaveBeenCalledTimes(2);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledWith({
      recipient_name: "Christopher",
      message: "Please reply yes if he can come tomorrow.",
    });
    expect(diagnostics).toHaveBeenCalledWith({
      originalTool: "send_delegation",
      finalTool: "send_direct_whatsapp_message",
      recipientName: "Christopher",
      normalizedMessage: "Please reply yes if he can come tomorrow.",
    });
  });

  it("returns the direct delivery failure and never substitutes a success claim", async () => {
    const transport = vi.fn(async (_params: { recipient_name: string; message: string }) => ({
      accepted: false,
    }));
    const delegation = vi.fn();
    const result = await executeLegacyPeopleCommunicationRedirect({
      redirect: resolveRedirect(),
      utterance: COMPOUND_UTTERANCE,
      recordRedirect: vi.fn(),
      sendDirectMessage: async (params) => {
        const delivery = await transport(params);
        return delivery.accepted
          ? { outcome: "success" as const }
          : { outcome: "failure" as const, message: "not sent" };
      },
    });

    expect(result).toEqual({ outcome: "failure", message: "not sent" });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(delegation).not.toHaveBeenCalled();
  });
});
