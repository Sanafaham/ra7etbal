import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(join(__dirname, "../", path), "utf8");

describe("owner-visible dark surface consistency", () => {
  it("keeps Notes and Automations on the shared card and nested-surface family", () => {
    const notes = source("routes/Inbox.tsx");
    const automations = source("routes/Routines.tsx");

    expect(notes).toContain("bg-surface p-4");
    expect(notes).toContain("bg-surface-subtle");
    expect(notes).not.toMatch(/bg-white(?:\/\d+)?/);
    expect(notes).not.toContain("bg-charcoal/5");

    expect(automations).toContain("bg-surface px-4 py-3.5");
    expect(automations).toContain("bg-surface-subtle");
    expect(automations).not.toMatch(/bg-white\/(?:60|80)/);
  });

  it("keeps shared owner-visible inputs and nested controls off literal light slabs", () => {
    const sharedSources = [
      source("components/people/PersonForm.tsx"),
      source("components/settings/SettingsModal.tsx"),
      source("components/home/CarsonTypedChat.tsx"),
    ].join("\n");

    expect(sharedSources).toContain("bg-surface-subtle");
    expect(sharedSources).not.toMatch(/bg-white px/);
    expect(sharedSources).not.toContain("bg-warm-white");
    expect(sharedSources).not.toContain("border-charcoal");
  });
});
