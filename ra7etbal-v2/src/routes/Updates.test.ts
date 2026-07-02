import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(__dirname, "Updates.tsx"), "utf-8");

/**
 * Clear My Head Inbox V1: a new "Inbox" tab in Updates, backed by the
 * ClearMyHeadInbox component. Source-scanning regression guard proving the
 * tab was added correctly and every pre-existing tab (Needs You / Waiting /
 * To-do / Notes / Automations / History) is untouched.
 */
describe("Updates.tsx — Clear My Head Inbox tab", () => {
  it("adds a tab labeled \"Inbox\" backed by ClearMyHeadInbox", () => {
    expect(SOURCE).toMatch(/\{ id: "clear-my-head",\s*label: "Inbox"\s*\}/);
    expect(SOURCE).toMatch(/import ClearMyHeadInbox from ["']\.\/ClearMyHeadInbox["']/);
    expect(SOURCE).toMatch(/\{activeTab === "clear-my-head" && <ClearMyHeadInbox headerless \/>\}/);
  });

  it("keeps every pre-existing tab untouched", () => {
    expect(SOURCE).toMatch(/\{ id: "needs-you",\s*label: "Needs You"\s*\}/);
    expect(SOURCE).toMatch(/\{ id: "waiting",\s*label: "Waiting"\s*\}/);
    expect(SOURCE).toMatch(/\{ id: "todo",\s*label: "To-do"\s*\}/);
    expect(SOURCE).toMatch(/\{ id: "inbox",\s*label: "Notes"\s*\}/);
    expect(SOURCE).toMatch(/\{ id: "routines",\s*label: "Automations"\s*\}/);
    expect(SOURCE).toMatch(/\{ id: "history",\s*label: "History"\s*\}/);
  });

  it("keeps the existing Notes tab rendering the pre-existing Inbox component (unrelated to Clear My Head)", () => {
    expect(SOURCE).toMatch(/\{activeTab === "inbox" && <Inbox headerless \/>\}/);
  });

  it("excludes the new tab from the tasks-store loading/error gates, like Notes/To-do/Automations", () => {
    expect(SOURCE).toMatch(/activeTab !== "clear-my-head"/);
  });
});
