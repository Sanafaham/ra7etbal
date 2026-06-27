import { describe, expect, it } from "vitest";
import {
  extractTodoTitleParam,
  extractTodoDescriptionParam,
  extractTodoQueryParam,
} from "./carson-todo-tool-params";

/**
 * P0 root-cause fix — Voice Carson To-do creation.
 *
 * Root cause traced end-to-end: database/RLS insert reproduced successfully
 * via direct SQL with an authenticated role, ruling out the table, policies,
 * grants, and Supabase client config. carson_todos had zero rows ever
 * inserted in production despite live attempts — pointing at the client-side
 * parameter parsing, not the database.
 *
 * createTodoTool/completeTodoTool previously destructured {title}/{query}
 * with no fallback (unlike execute_instruction's extractInstructionParam,
 * which already tries several plausible keys). Any mismatch between the
 * key name the agent actually sends and the one literal key our code read
 * meant createTodo() / completeTodo() were never even called — the function
 * returned an internal-sounding string with no real failure to report,
 * which the model then dramatized into a tech-support deflection.
 */
describe("extractTodoTitleParam", () => {
  it("reads the expected 'title' key", () => {
    expect(extractTodoTitleParam({ title: "Gemini plan" })).toBe("Gemini plan");
  });

  it.each(["text", "item", "todo", "name"])("falls back to '%s' when 'title' is absent", (key) => {
    expect(extractTodoTitleParam({ [key]: "Gemini plan" })).toBe("Gemini plan");
  });

  it("accepts a bare string param", () => {
    expect(extractTodoTitleParam("Gemini plan")).toBe("Gemini plan");
  });

  it("returns '' for null/undefined/empty object", () => {
    expect(extractTodoTitleParam(null)).toBe("");
    expect(extractTodoTitleParam(undefined)).toBe("");
    expect(extractTodoTitleParam({})).toBe("");
  });

  it("ignores blank/whitespace-only values and keeps looking", () => {
    expect(extractTodoTitleParam({ title: "   ", text: "Gemini plan" })).toBe("Gemini plan");
  });

  it("prefers 'title' over later fallback keys when both are present", () => {
    expect(extractTodoTitleParam({ title: "Gemini plan", text: "wrong" })).toBe("Gemini plan");
  });
});

describe("extractTodoDescriptionParam", () => {
  it("reads description/details/note", () => {
    expect(extractTodoDescriptionParam({ title: "x", description: "from the meeting" })).toBe(
      "from the meeting",
    );
    expect(extractTodoDescriptionParam({ title: "x", details: "from the meeting" })).toBe(
      "from the meeting",
    );
    expect(extractTodoDescriptionParam({ title: "x", note: "from the meeting" })).toBe(
      "from the meeting",
    );
  });

  it("returns undefined when no description field is present", () => {
    expect(extractTodoDescriptionParam({ title: "x" })).toBeUndefined();
    expect(extractTodoDescriptionParam("just a string")).toBeUndefined();
    expect(extractTodoDescriptionParam(null)).toBeUndefined();
  });
});

describe("extractTodoQueryParam", () => {
  it("reads the expected 'query' key", () => {
    expect(extractTodoQueryParam({ query: "buy flowers" })).toBe("buy flowers");
  });

  it.each(["title", "text", "item", "todo", "name"])(
    "falls back to '%s' when 'query' is absent",
    (key) => {
      expect(extractTodoQueryParam({ [key]: "buy flowers" })).toBe("buy flowers");
    },
  );

  it("accepts a bare string param", () => {
    expect(extractTodoQueryParam("buy flowers")).toBe("buy flowers");
  });

  it("returns '' for null/undefined/empty object", () => {
    expect(extractTodoQueryParam(null)).toBe("");
    expect(extractTodoQueryParam(undefined)).toBe("");
    expect(extractTodoQueryParam({})).toBe("");
  });
});
