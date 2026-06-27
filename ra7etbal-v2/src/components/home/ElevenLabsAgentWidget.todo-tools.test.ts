import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * P0 regression guard — Voice Carson To-do execution.
 *
 * Live bug: a user asked Talk to Carson to add a to-do and Carson responded
 * with a generic "I don't have visibility into technical issues with the
 * To-Do feature itself" — i.e. it never called a to-do tool at all.
 *
 * Root cause audit confirmed the create_todo/complete_todo client tools are
 * fully implemented and registered in ElevenLabsAgentWidget.tsx's clientTools
 * map (the only registration surface that exists in code — the ElevenLabs SDK's
 * clientTools type is `Record<string, handler>`, so tool descriptions and
 * routing intent live entirely in the ElevenLabs dashboard agent config, not
 * in this codebase). This test cannot verify the dashboard side, but it locks
 * in the code side: if either tool name is ever renamed, removed, or its
 * handler call dropped from the clientTools map, this test fails immediately
 * instead of silently shipping a regression that only shows up live.
 */
const SOURCE = readFileSync(
  join(__dirname, "ElevenLabsAgentWidget.tsx"),
  "utf-8",
);

describe("ElevenLabsAgentWidget — To-do client tool registration", () => {
  it("registers create_todo in the clientTools map, wired to createTodoTool", () => {
    expect(SOURCE).toMatch(/create_todo:\s*\(params[^)]*\)\s*=>\s*\n?\s*runDirectToolWithDiagnostic\("create_todo",\s*params,\s*\(\)\s*=>\s*createTodoTool\(params\)\)/);
  });

  it("registers complete_todo in the clientTools map, wired to completeTodoTool", () => {
    expect(SOURCE).toMatch(/complete_todo:\s*\(params[^)]*\)\s*=>\s*\n?\s*runDirectToolWithDiagnostic\("complete_todo",\s*params,\s*\(\)\s*=>\s*completeTodoTool\(params\)\)/);
  });

  it("defines a createTodoTool implementation that calls the carson-todos createTodo helper", () => {
    expect(SOURCE).toContain("const createTodoTool = useCallback(");
    expect(SOURCE).toMatch(/createTodoTool[\s\S]{0,400}await createTodo\(/);
  });

  it("defines a completeTodoTool implementation that calls the carson-todos completeTodo helper", () => {
    expect(SOURCE).toContain("const completeTodoTool = useCallback(");
    expect(SOURCE).toMatch(/completeTodoTool[\s\S]{0,1200}await completeTodo\(/);
  });

  it("execute_instruction fallback pipeline is also registered (shared extraction path for any to-do phrasing the dashboard routes there instead)", () => {
    expect(SOURCE).toMatch(/execute_instruction:\s*async\s*\(params/);
  });
});
