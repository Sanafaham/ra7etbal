import { afterEach, describe, expect, it, vi } from "vitest";
import { getCarsonCallUrl, getCarsonWhatsAppUrl } from "./carson-channels";

/**
 * WhatsApp / Call Carson must never render a dead-end button: each channel
 * requires BOTH its destination and its visibility switch to be set.
 */
describe("carson-channels", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("hides WhatsApp when the switch is off, even if a number is configured", () => {
    vi.stubEnv("VITE_ENABLE_CARSON_WHATSAPP", "false");
    vi.stubEnv("VITE_CARSON_WHATSAPP_NUMBER", "+971501234567");
    expect(getCarsonWhatsAppUrl()).toBeNull();
  });

  it("hides WhatsApp when enabled but no number is configured", () => {
    vi.stubEnv("VITE_ENABLE_CARSON_WHATSAPP", "true");
    vi.stubEnv("VITE_CARSON_WHATSAPP_NUMBER", "");
    expect(getCarsonWhatsAppUrl()).toBeNull();
  });

  it("builds a wa.me link when both the number and switch are configured", () => {
    vi.stubEnv("VITE_ENABLE_CARSON_WHATSAPP", "true");
    vi.stubEnv("VITE_CARSON_WHATSAPP_NUMBER", "+971 50 123 4567");
    expect(getCarsonWhatsAppUrl()).toBe("https://wa.me/971501234567");
  });

  it("hides Call Carson when the switch is off, even if a number is configured", () => {
    vi.stubEnv("VITE_ENABLE_CARSON_CALL", "false");
    vi.stubEnv("VITE_CARSON_PHONE_NUMBER", "+971501234567");
    expect(getCarsonCallUrl()).toBeNull();
  });

  it("hides Call Carson when enabled but no number is configured", () => {
    vi.stubEnv("VITE_ENABLE_CARSON_CALL", "true");
    vi.stubEnv("VITE_CARSON_PHONE_NUMBER", "");
    expect(getCarsonCallUrl()).toBeNull();
  });

  it("builds a tel: link when both the number and switch are configured", () => {
    vi.stubEnv("VITE_ENABLE_CARSON_CALL", "true");
    vi.stubEnv("VITE_CARSON_PHONE_NUMBER", "+971501234567");
    expect(getCarsonCallUrl()).toBe("tel:+971501234567");
  });
});
