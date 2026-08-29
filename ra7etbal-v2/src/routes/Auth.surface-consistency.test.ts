import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const auth = readFileSync(join(__dirname, "Auth.tsx"), "utf8");
const reset = readFileSync(join(__dirname, "Reset.tsx"), "utf8");
const password = readFileSync(join(__dirname, "../components/auth/PasswordField.tsx"), "utf8");

describe("authentication dark surface consistency", () => {
  it("uses the shared card, input, border, and text hierarchy across sign-in and reset", () => {
    expect(auth).toContain("border border-border bg-surface p-6");
    expect(reset).toContain("border border-border bg-surface p-6");
    expect(password).toContain("border border-border bg-surface-subtle");
    expect(password).toContain("placeholder:text-text-muted");
    expect(password).toContain("focus:border-gold");
  });

  it("does not reintroduce literal light input or card slabs", () => {
    for (const source of [auth, reset, password]) {
      expect(source).not.toMatch(/bg-white(?:\/\d+)?/);
    }
  });
});
