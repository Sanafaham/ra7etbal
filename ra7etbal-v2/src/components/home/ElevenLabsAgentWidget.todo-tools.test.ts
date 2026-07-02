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

  it("registers control_task in the clientTools map, wired to controlTaskTool", () => {
    expect(SOURCE).toMatch(/control_task:\s*\(params[^)]*\)\s*=>\s*\n?\s*runDirectToolWithDiagnostic\("control_task",\s*params,\s*\(\)\s*=>\s*controlTaskTool\(params\)\)/);
  });

  it("defines a createTodoTool implementation that calls the carson-todos createTodo helper", () => {
    expect(SOURCE).toContain("const createTodoTool = useCallback(");
    expect(SOURCE).toMatch(/createTodoTool[\s\S]{0,900}await createTodo\(/);
  });

  it("defines a completeTodoTool implementation that calls the carson-todos completeTodo helper", () => {
    expect(SOURCE).toContain("const completeTodoTool = useCallback(");
    expect(SOURCE).toMatch(/completeTodoTool[\s\S]{0,1200}await completeTodo\(/);
  });

  it("execute_instruction fallback pipeline is also registered (shared extraction path for any to-do phrasing the dashboard routes there instead)", () => {
    expect(SOURCE).toMatch(/execute_instruction:\s*async\s*\(params/);
  });

  it("execute_instruction checks task control before creating new work", () => {
    expect(SOURCE).toMatch(/const taskControlResolution = resolveVoiceTaskControl\(/);
    expect(SOURCE).toMatch(/if \(taskControlResolution\.status !== "not_task_control"\)[\s\S]{0,250}controlTaskTool\(\{ instruction: rawInstruction \}\)/);
  });
});

// P0 root-cause fix: createTodoTool/completeTodoTool used to destructure
// {title}/{query} with no fallback, unlike execute_instruction's
// extractInstructionParam which already tries several plausible keys. A
// mismatch between the key the agent actually sends and the one literal key
// the code read meant createTodo()/completeTodo() were never called at all —
// see carson-todo-tool-params.test.ts for the actual parsing-logic tests.
// This just locks in that the tool bodies use the defensive parser instead
// of a bare destructure.
describe("ElevenLabsAgentWidget — To-do tools use defensive parameter parsing", () => {
  it("imports the defensive param extractors from carson-todo-tool-params", () => {
    expect(SOURCE).toContain('from "../../lib/carson-todo-tool-params"');
    expect(SOURCE).toContain("extractTodoTitleParam");
    expect(SOURCE).toContain("extractTodoDescriptionParam");
    expect(SOURCE).toContain("extractTodoQueryParam");
  });

  it("createTodoTool no longer destructures {title, description} directly", () => {
    expect(SOURCE).not.toMatch(/createTodoTool = useCallback\(\s*async\s*\(\s*\{\s*title/);
    expect(SOURCE).toMatch(/createTodoTool = useCallback\(\s*async\s*\(params: CreateTodoParams\)/);
  });

  it("completeTodoTool no longer destructures {query} directly", () => {
    expect(SOURCE).not.toMatch(/completeTodoTool = useCallback\(\s*async\s*\(\s*\{\s*query/);
    expect(SOURCE).toMatch(/completeTodoTool = useCallback\(\s*async\s*\(params: CompleteTodoParams\)/);
  });
});

// P0 follow-up: a live failed to-do creation produced a tech-support
// deflection instead of a clean retry request. createTodoTool's own catch
// message must never contain that language, and must match the required
// wording exactly — this is the source-of-truth message before the shared
// sanitizeCarsonReplyText() defense-in-depth filter (carson-social.ts) even
// runs.
describe("ElevenLabsAgentWidget — createTodoTool failure message", () => {
  it("returns the required clean retry message on failure, not a technical/support deflection", () => {
    expect(SOURCE).toContain('return "I wasn\'t able to save that. Please say the to-do again.";');
  });

  it("the createTodoTool catch block never mentions technical issues or support", () => {
    const match = SOURCE.match(/const createTodoTool = useCallback\([\s\S]{0,2500}?\n  \);/);
    expect(match).not.toBeNull();
    const block = match![0];
    expect(block.toLowerCase()).not.toMatch(/technical issue|contact support|support team|visibility into/);
  });
});

describe("ElevenLabsAgentWidget — createReminder success override", () => {
  it("records create_reminder as override-eligible only after the reminder task is created", () => {
    const start = SOURCE.indexOf("const createReminder = useCallback(");
    const end = SOURCE.indexOf("// ------------------------------------------------------------------\n  // Client tool: get_calendar_events", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const block = SOURCE.slice(start, end);
    const createIndex = block.indexOf("await createReminderTask({");
    const overrideIndex = block.indexOf('toolName: "create_reminder"');

    expect(createIndex).toBeGreaterThan(-1);
    expect(overrideIndex).toBeGreaterThan(createIndex);
  });
});

describe("ElevenLabsAgentWidget — guest plan proposal regression guards", () => {
  function guestOutcomeBlock(): string {
    const start = SOURCE.indexOf("const outcomeType = detectHouseholdOutcome(rawInstruction);");
    const end = SOURCE.indexOf("// ── Recurring-language detection", start);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    return SOURCE.slice(start, end);
  }

  it("records a guest-plan proposal as an override-eligible execute_instruction result before returning it", () => {
    const block = guestOutcomeBlock();
    const planSuccessIndex = block.indexOf("if (plan) {");
    const overrideIndex = block.indexOf("lastDirectToolSuccessRef.current", planSuccessIndex);
    const returnIndex = block.indexOf("return plan.proposalSpeech", planSuccessIndex);

    expect(planSuccessIndex).toBeGreaterThan(-1);
    expect(overrideIndex).toBeGreaterThan(planSuccessIndex);
    expect(returnIndex).toBeGreaterThan(overrideIndex);
    expect(block.slice(overrideIndex, returnIndex)).toContain('toolName: "execute_instruction"');
    expect(block.slice(overrideIndex, returnIndex)).toContain("resultText: plan.proposalSpeech");
    expect(block.slice(overrideIndex, returnIndex)).toContain('kind: "guest_plan_proposal"');
  });

  it("does not let a detected guest event fall through to generic delegation when planning fails", () => {
    const block = guestOutcomeBlock();
    const failureIndex = block.indexOf("return \"I couldn't put that guest plan together right now. Please try again.\";");

    expect(failureIndex).toBeGreaterThan(-1);
    expect(block).not.toMatch(/If plan building fails,\s*fall through to normal delegation/i);
  });
});
