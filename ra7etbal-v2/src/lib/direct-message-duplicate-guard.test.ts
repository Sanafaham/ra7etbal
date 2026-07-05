import { describe, expect, it } from "vitest";
import {
  DIRECT_WHATSAPP_DUPLICATE_WINDOW_MS,
  directWhatsappDuplicateKey,
  isRecentDirectWhatsappDuplicate,
  recordDirectWhatsappSent,
} from "./direct-message-duplicate-guard";

describe("direct WhatsApp duplicate guard", () => {
  it("allows the first direct WhatsApp send and blocks the same recipient/message inside the cooldown", () => {
    const sent = new Map<string, number>();

    expect(isRecentDirectWhatsappDuplicate(sent, "Christopher", "Please bring the files", 1_000)).toBe(false);

    recordDirectWhatsappSent(sent, "Christopher", "Please bring the files", 1_000);

    expect(isRecentDirectWhatsappDuplicate(sent, "Christopher", "Please bring the files", 1_500)).toBe(true);
  });

  it("normalizes message spacing, casing, and recipient casing for duplicate keys", () => {
    const sent = new Map<string, number>();
    recordDirectWhatsappSent(sent, "Christopher", "Please   bring THE files", 10_000);

    expect(isRecentDirectWhatsappDuplicate(sent, " christopher ", " please bring the files ", 10_500)).toBe(true);
    expect(directWhatsappDuplicateKey(" Christopher ", " Please   Bring the Files ")).toBe(
      "christopher::please bring the files",
    );
  });

  it("allows a different message to the same recipient", () => {
    const sent = new Map<string, number>();
    recordDirectWhatsappSent(sent, "Christopher", "Please bring the files", 10_000);

    expect(isRecentDirectWhatsappDuplicate(sent, "Christopher", "Please bring the receipts", 10_500)).toBe(false);
  });

  it("allows the same message to a different recipient", () => {
    const sent = new Map<string, number>();
    recordDirectWhatsappSent(sent, "Christopher", "Please bring the files", 10_000);

    expect(isRecentDirectWhatsappDuplicate(sent, "Ghulam", "Please bring the files", 10_500)).toBe(false);
  });

  it("allows the same recipient/message after the cooldown and prunes stale entries", () => {
    const sent = new Map<string, number>();
    recordDirectWhatsappSent(sent, "Christopher", "Please bring the files", 10_000);

    expect(
      isRecentDirectWhatsappDuplicate(
        sent,
        "Christopher",
        "Please bring the files",
        10_000 + DIRECT_WHATSAPP_DUPLICATE_WINDOW_MS,
      ),
    ).toBe(false);
    expect(sent.size).toBe(0);
  });
});
