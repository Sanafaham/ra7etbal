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
    expect(SOURCE).toMatch(/create_todo:\s*\(params[^)]*\)\s*=>\s*\{[\s\S]*guardCurrentToolInvocation\("create_todo"\)[\s\S]*runDirectToolWithDiagnostic\("create_todo",\s*params,\s*\(\)\s*=>\s*createTodoTool\(params\)\)/);
  });

  it("registers complete_todo in the clientTools map, wired to completeTodoTool", () => {
    expect(SOURCE).toMatch(/complete_todo:\s*\(params[^)]*\)\s*=>\s*\{[\s\S]*guardCurrentToolInvocation\("complete_todo"\)[\s\S]*runDirectToolWithDiagnostic\("complete_todo",\s*params,\s*\(\)\s*=>\s*completeTodoTool\(params\)\)/);
  });

  it("registers control_task in the clientTools map, wired to controlTaskTool", () => {
    expect(SOURCE).toMatch(/control_task:\s*\(params[^)]*\)\s*=>\s*\{[\s\S]*guardCurrentToolInvocation\("control_task"\)[\s\S]*runDirectToolWithDiagnostic\("control_task",\s*params,\s*\(\)\s*=>\s*controlTaskTool\(params\)\)/);
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
  const start = SOURCE.indexOf("const createReminder = useCallback(");
  const recurringStart = SOURCE.indexOf(
    "// ── Recurring-language detection (owner reminder path)",
    start,
  );
  const oneTimeStart = SOURCE.indexOf(
    "// ── Resolve due time (one-time reminder path)",
    start,
  );
  const end = SOURCE.indexOf("// ------------------------------------------------------------------\n  // Client tool: get_calendar_events", start);

  it("records create_reminder as override-eligible only after the reminder task is created (one-time path)", () => {
    expect(start).toBeGreaterThan(-1);
    expect(oneTimeStart).toBeGreaterThan(start);
    expect(end).toBeGreaterThan(oneTimeStart);

    const block = SOURCE.slice(oneTimeStart, end);
    const createIndex = block.indexOf("await createReminderTask({");
    // lastIndexOf: an earlier occurrence now legitimately exists in the
    // duplicate-cache-hit branch (restores override eligibility for an
    // already-verified cached reply) — this test cares about the genuine
    // creation path's own recording, which is always the later occurrence.
    const overrideIndex = block.lastIndexOf('toolName: "create_reminder"');

    expect(createIndex).toBeGreaterThan(-1);
    expect(overrideIndex).toBeGreaterThan(createIndex);
  });

  it("records create_reminder as override-eligible only after the automation is persisted (recurring path)", () => {
    expect(recurringStart).toBeGreaterThan(-1);
    expect(oneTimeStart).toBeGreaterThan(recurringStart);

    const block = SOURCE.slice(recurringStart, oneTimeStart);
    const createIndex = block.indexOf("createReminderRoutineFromInstruction(");
    const successesCheckIndex = block.indexOf("successes.length > 0");
    // lastIndexOf: an earlier occurrence now legitimately exists in the
    // duplicate-cache-hit branch (restores override eligibility for an
    // already-verified cached reply) — this test cares about the genuine
    // creation path's own recording, which is always the later occurrence.
    const overrideIndex = block.lastIndexOf('toolName: "create_reminder"');

    expect(createIndex).toBeGreaterThan(-1);
    expect(successesCheckIndex).toBeGreaterThan(createIndex);
    expect(overrideIndex).toBeGreaterThan(successesCheckIndex);
  });

  it("uses a clear verified failure when a recurring reminder needs an exact clock time", () => {
    expect(recurringStart).toBeGreaterThan(-1);
    expect(oneTimeStart).toBeGreaterThan(recurringStart);

    const block = SOURCE.slice(recurringStart, oneTimeStart);
    const exactClockFailureIndex = block.indexOf("I need the exact clock time for that recurring reminder");
    const outcomeIndex = block.indexOf('outcome: "failure"', exactClockFailureIndex);
    const returnIndex = block.indexOf("return recurringFailureText;", outcomeIndex);

    expect(exactClockFailureIndex).toBeGreaterThan(-1);
    expect(outcomeIndex).toBeGreaterThan(exactClockFailureIndex);
    expect(returnIndex).toBeGreaterThan(outcomeIndex);
  });

  it("restores override eligibility for a cached duplicate reply, without weakening the genuine-creation recording above", () => {
    const oneTimeBlock = SOURCE.slice(oneTimeStart, end);
    const recurringBlock = SOURCE.slice(recurringStart, oneTimeStart);

    // One-time path: cache-hit + the genuine success recording are still
    // inline object literals (unchanged). The five failure branches
    // (parseVoiceTime failure, invalid due_at, missing time, not-signed-in,
    // createReminderTask-threw) now go through the recordCreateReminderFailure
    // helper instead — see the "confirmed production failure" regression
    // tests below for why, and for per-branch verification.
    const oneTimeOccurrences = oneTimeBlock.split('toolName: "create_reminder"').length - 1;
    expect(oneTimeOccurrences).toBe(2);
    const oneTimeFailureHelperOccurrences = oneTimeBlock.split("recordCreateReminderFailure(failureText").length - 1;
    expect(oneTimeFailureHelperOccurrences).toBe(5);

    // Recurring path: cache-hit, full-success, partial-success-as-failure,
    // and the zero-success hard-block — four distinct, individually-verified
    // outcome recordings, one per real branch of the recurring flow.
    const recurringOccurrences = recurringBlock.split('toolName: "create_reminder"').length - 1;
    expect(recurringOccurrences).toBe(4);
    expect(recurringBlock).toContain('outcome: "success"');
    expect((recurringBlock.match(/outcome: "failure"/g) ?? []).length).toBe(2); // partial + hard-block
  });

  // Regression: confirmed production failure. A one-time reminder request
  // ("remind me at 1:40 AM to check on Google Council") produced no
  // persisted task row and no server-side trace of any kind, yet Carson
  // still spoke a "done" confirmation. Root cause: lastDirectToolSuccessRef
  // is cleared to null at the top of every create_reminder call (so a stale
  // prior tool's result can never leak into a new request), but the
  // one-time path's five failure returns — unlike the recurring path's
  // hard-block, and unlike every create_automation failure branch — never
  // re-recorded an outcome:"failure" before returning. With the ref left
  // null, carson-direct-tool-override.ts's resolveCarsonDisplayMessage has
  // nothing to correct against (`if (!lastSuccess) return agentMessage;`),
  // so a fabricated success from the agent's own separate generation could
  // never be caught. Every one-time-path failure return must now record a
  // failure outcome before returning, exactly like create_automation.
  describe("confirmed production failure: one-time path failures must be overridable", () => {
    function oneTimeBlock(): string {
      return SOURCE.slice(oneTimeStart, end);
    }

    // Each test below bounds recordIndex with this branch's own
    // returnIndex (not just "greater than failureIndex" with no upper
    // limit) — otherwise, if this specific branch's recording call were
    // accidentally removed, the unbounded search could still find a LATER
    // branch's recordCreateReminderFailure call and wrongly pass.
    it("records a failure outcome when parseVoiceTime cannot resolve time_text", () => {
      const block = oneTimeBlock();
      const failureIndex = block.indexOf('I could not understand the time "${time_text}"');
      const returnIndex = block.indexOf("return failureText;", failureIndex);
      const recordIndex = block.indexOf("recordCreateReminderFailure(failureText", failureIndex);
      expect(failureIndex).toBeGreaterThan(-1);
      expect(returnIndex).toBeGreaterThan(failureIndex);
      expect(recordIndex).toBeGreaterThan(failureIndex);
      expect(recordIndex).toBeLessThan(returnIndex);
    });

    it("records a failure outcome when the agent-supplied due_at is not a valid timestamp", () => {
      const block = oneTimeBlock();
      const failureIndex = block.indexOf("I did not receive a valid due time.");
      const returnIndex = block.indexOf("return failureText;", failureIndex);
      const recordIndex = block.indexOf("recordCreateReminderFailure(failureText", failureIndex);
      expect(failureIndex).toBeGreaterThan(-1);
      expect(returnIndex).toBeGreaterThan(failureIndex);
      expect(recordIndex).toBeGreaterThan(failureIndex);
      expect(recordIndex).toBeLessThan(returnIndex);
    });

    it("records a failure outcome when neither time_text nor due_at is provided", () => {
      const block = oneTimeBlock();
      const failureIndex = block.indexOf("I did not receive a time for the reminder.");
      const returnIndex = block.indexOf("return failureText;", failureIndex);
      const recordIndex = block.indexOf("recordCreateReminderFailure(failureText", failureIndex);
      expect(failureIndex).toBeGreaterThan(-1);
      expect(returnIndex).toBeGreaterThan(failureIndex);
      expect(recordIndex).toBeGreaterThan(failureIndex);
      expect(recordIndex).toBeLessThan(returnIndex);
    });

    it("records a failure outcome when the user is not signed in", () => {
      const block = oneTimeBlock();
      const failureIndex = block.indexOf("You are not signed in. Please sign in and try again.");
      const returnIndex = block.indexOf("return failureText;", failureIndex);
      const recordIndex = block.indexOf("recordCreateReminderFailure(failureText", failureIndex);
      expect(failureIndex).toBeGreaterThan(-1);
      expect(returnIndex).toBeGreaterThan(failureIndex);
      expect(recordIndex).toBeGreaterThan(failureIndex);
      expect(recordIndex).toBeLessThan(returnIndex);
    });

    it("records a failure outcome when createReminderTask throws (the exact branch implicated in the confirmed production failure)", () => {
      const block = oneTimeBlock();
      const catchIndex = block.indexOf("} catch (err) {");
      const failureIndex = block.indexOf("Could not save the reminder.", catchIndex);
      const recordIndex = block.indexOf("recordCreateReminderFailure(failureText", catchIndex);
      const returnIndex = block.indexOf("return failureText;", catchIndex);
      expect(catchIndex).toBeGreaterThan(-1);
      expect(failureIndex).toBeGreaterThan(catchIndex);
      expect(recordIndex).toBeGreaterThan(failureIndex);
      expect(returnIndex).toBeGreaterThan(recordIndex);
    });

    it("defines recordCreateReminderFailure mirroring the existing recordCreateAutomationFailure pattern, recording outcome: failure", () => {
      const start = SOURCE.indexOf("function recordCreateReminderFailure(");
      const end2 = SOURCE.indexOf("const createReminder = useCallback(");
      expect(start).toBeGreaterThan(-1);
      expect(end2).toBeGreaterThan(start);
      const block = SOURCE.slice(start, end2);
      expect(block).toContain('toolName: "create_reminder"');
      expect(block).toContain('outcome: "failure"');
    });
  });

  it("never falls through to the one-time task path when recurring language is detected but automation creation fails", () => {
    const block = SOURCE.slice(recurringStart, oneTimeStart);
    expect(block).toContain("const recurringFailureText = exactClockFailure");
    expect(block).toContain("I need the exact clock time for that recurring reminder.");
    expect(block).toContain("I could not create the recurring reminder.");
    expect(block).toContain("return recurringFailureText;");
  });

  it("records the recurring-path failure as an overridable outcome so a fabricated success can be corrected", () => {
    const block = SOURCE.slice(recurringStart, oneTimeStart);
    const failureConstIndex = block.indexOf("const recurringFailureText = exactClockFailure");
    const failureRecordIndex = block.indexOf('outcome: "failure"', failureConstIndex);
    const returnIndex = block.indexOf("return recurringFailureText;", failureConstIndex);

    expect(failureConstIndex).toBeGreaterThan(-1);
    expect(failureRecordIndex).toBeGreaterThan(failureConstIndex);
    expect(returnIndex).toBeGreaterThan(failureRecordIndex);
  });
});

describe("ElevenLabsAgentWidget — hosting planning gate", () => {
  it("imports the reusable hosting planning gate from ops-intelligence", () => {
    expect(SOURCE).toContain("evaluateHostingPlanningGate");
    expect(SOURCE).toContain('from "../../lib/ops-intelligence"');
  });

  it("checks missing hosting details before direct send_delegation can build or execute a guest plan", () => {
    const start = SOURCE.indexOf("const sendDelegation = useCallback(");
    const end = SOURCE.indexOf("const matches = people.filter(", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = SOURCE.slice(start, end);
    const actionIndex = block.indexOf("const guestAction = resolveGuestOutcomeAction(latestUserMessageForOps)");
    const gateIndex = block.indexOf("const hostingGate = evaluateHostingPlanningGate(latestUserMessageForOps)");
    const buildIndex = block.indexOf("const plan = await buildOperationalPlanFromOutcome(latestUserMessageForOps, people)");
    expect(actionIndex).toBeGreaterThan(-1);
    expect(gateIndex).toBeGreaterThan(actionIndex);
    expect(buildIndex).toBeGreaterThan(gateIndex);
    expect(block).toContain('hostingGate.status === "needs_clarification"');
  });

  it("checks missing hosting details before execute_instruction can build or execute a guest plan", () => {
    const start = SOURCE.indexOf("// ── Operations Intelligence — outcome leg");
    const end = SOURCE.indexOf("// ── Carson Weekly Planning V1 — outcome leg", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = SOURCE.slice(start, end);
    const actionIndex = block.indexOf("const outcomeAction = resolveGuestOutcomeAction(rawInstruction)");
    const gateIndex = block.indexOf("const hostingGate = evaluateHostingPlanningGate(rawInstruction)");
    const buildIndex = block.indexOf("const plan = await buildOperationalPlanFromOutcome(rawInstruction, people)");
    expect(actionIndex).toBeGreaterThan(-1);
    expect(gateIndex).toBeGreaterThan(actionIndex);
    expect(buildIndex).toBeGreaterThan(gateIndex);
    expect(block).toContain('hostingGate.status === "needs_clarification"');
  });
});

describe("ElevenLabsAgentWidget — guest plan proposal regression guards", () => {
  function guestOutcomeBlock(): string {
    const start = SOURCE.indexOf("const outcomeAction = resolveGuestOutcomeAction(rawInstruction);");
    const end = SOURCE.indexOf("// ── Recurring-language detection", start);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    return SOURCE.slice(start, end);
  }

  it("executes immediately on operating authority and reports the tool result", () => {
    const block = guestOutcomeBlock();
    const executeBranch = block.indexOf('if (outcomeAction === "execute")');
    const execCall = block.indexOf("executeProposedPlan(plan", executeBranch);
    const execReturn = block.indexOf("return execSummary", executeBranch);

    expect(executeBranch).toBeGreaterThan(-1);
    expect(execCall).toBeGreaterThan(executeBranch);
    expect(execReturn).toBeGreaterThan(execCall);
    // The spoken result is the actual tool summary, not a fabricated success.
    expect(block.slice(executeBranch, execReturn)).toContain("resultText: execSummary");
    expect(block.slice(executeBranch, execReturn)).toContain('kind: "guest_plan_execute"');
  });

  it("proposes (confirm-before-send) when there is no operating authority", () => {
    const block = guestOutcomeBlock();
    const overrideIndex = block.indexOf('kind: "guest_plan_proposal"');
    const returnIndex = block.indexOf("return plan.proposalSpeech", overrideIndex);

    expect(overrideIndex).toBeGreaterThan(-1);
    expect(returnIndex).toBeGreaterThan(overrideIndex);
    expect(block).toContain("pendingPlanRef.current = plan;");
  });

  it("does not let a detected guest event fall through to generic delegation when planning fails", () => {
    const block = guestOutcomeBlock();
    const failureIndex = block.indexOf("return \"I couldn't put that guest plan together right now. Please try again.\";");

    expect(failureIndex).toBeGreaterThan(-1);
    expect(block).not.toMatch(/If plan building fails,\s*fall through to normal delegation/i);
  });
});

// CodeRabbit finding (PR #1): send_delegation, execute_instruction, and
// create_automation each POST to /api/automations and previously treated any
// 2xx response as success without checking that the body actually echoed
// back a persisted automation id — the same class of false-success bug
// already fixed in routine-detection.ts's createReminderRoutineFromInstruction
// for the recurring-reminder path. Locks in that all three call sites now
// require result.automation?.id before reporting success.
describe("ElevenLabsAgentWidget — /api/automations POST responses require a confirmed automation id", () => {
  it("send_delegation's recurring-automation POST checks result.automation.id before returning summary", () => {
    const start = SOURCE.indexOf('[automation:SEND_DELEGATION_FAILED]');
    const end = SOURCE.indexOf('[automation:SEND_DELEGATION_ERROR]', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const block = SOURCE.slice(start, end);
    expect(block).toContain("if (!result?.automation?.id)");
    expect(block).toContain("return null;");
  });

  it("execute_instruction's recurring-automation POST checks result.automation.id before returning summary", () => {
    const start = SOURCE.indexOf('[automation:CREATE_FAILED]');
    const end = SOURCE.indexOf('[automation:CREATE_ERROR]', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const block = SOURCE.slice(start, end);
    expect(block).toContain("if (!result?.automation?.id)");
    expect(block).toContain("return { summary: null, error: \"Automation create response was unconfirmed.\" };");
  });

  it("execute_instruction returns the exact-clock prompt when its recurring fallback cannot create an ambiguous owner reminder", () => {
    const start = SOURCE.indexOf('const results = await Promise.all(', SOURCE.indexOf("[routine:VOICE_INPUT]"));
    const end = SOURCE.indexOf("// ── FINAL SAFETY BLOCK", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const block = SOURCE.slice(start, end);
    const exactClockIndex = block.indexOf("const exactClockFailure = results.some");
    const failuresIndex = block.indexOf("const failures = results.filter");
    const failureTextIndex = block.indexOf("const automationFailureText = exactClockFailure");
    const overrideIndex = block.indexOf('outcome: "failure"', failureTextIndex);
    const returnIndex = block.indexOf("return automationFailureText;", overrideIndex);

    expect(block).toContain("err instanceof Error ? err.message : String(err)");
    expect(exactClockIndex).toBeGreaterThan(-1);
    expect(failuresIndex).toBeGreaterThan(exactClockIndex);
    expect(block).toContain("I need the exact clock time for that recurring reminder.");
    expect(failureTextIndex).toBeGreaterThan(failuresIndex);
    expect(overrideIndex).toBeGreaterThan(failureTextIndex);
    expect(returnIndex).toBeGreaterThan(overrideIndex);
  });

  it("execute_instruction classifies no-person and mixed recurring results as failures, not clean success", () => {
    const start = SOURCE.indexOf('const results = await Promise.all(', SOURCE.indexOf("[routine:VOICE_INPUT]"));
    const end = SOURCE.indexOf("// ── FINAL SAFETY BLOCK", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const block = SOURCE.slice(start, end);
    const noPersonIndex = block.indexOf("[automation:NO_PERSON]");
    const failuresIndex = block.indexOf("const failures = results.filter");
    const partialIndex = block.indexOf("const partialFailureText =", failuresIndex);
    const partialOverrideIndex = block.indexOf('outcome: "failure"', partialIndex);
    const cleanSuccessIndex = block.indexOf("if (successes.length > 0 && failures.length === 0)");

    expect(noPersonIndex).toBeGreaterThan(-1);
    expect(block.slice(noPersonIndex, failuresIndex)).toContain("summary: null");
    expect(block.slice(noPersonIndex, failuresIndex)).toContain("error: \"I could not find a person in your contacts");
    expect(cleanSuccessIndex).toBeGreaterThan(failuresIndex);
    expect(partialIndex).toBeGreaterThan(cleanSuccessIndex);
    expect(block).toContain("successes.length > 0 && failures.length > 0");
    expect(block).toContain("I could not create the recurring reminder for the rest of what you asked");
    expect(partialOverrideIndex).toBeGreaterThan(partialIndex);
  });

  it("create_automation checks result.automation.id before speaking a success confirmation", () => {
    const start = SOURCE.indexOf("const createAutomation = useCallback(");
    const end = SOURCE.indexOf("[create_automation] created id=", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const block = SOURCE.slice(start, end);
    expect(block).toContain("if (!result?.automation?.id)");
    expect(block).toMatch(/I could not confirm that automation was saved\./);
    expect(block).toContain("return failureText;");
  });
});

// Regression (Part C, self-directed automation safety): create_automation's
// assignee resolution previously fell back through a generic multi-key
// extractor (name/person_name/recipient_name/to) shared with genuinely
// person-directed tools. For create_automation specifically — routinely
// self-directed, unlike those other tools — that fallback risked pulling an
// unrelated stray field into assignee_name and silently misrouting an
// owner-only reminder into a rejected/misattributed staff automation.
describe("ElevenLabsAgentWidget — create_automation self-directed assignee scoping", () => {
  function createAutomationBlock(): string {
    const start = SOURCE.indexOf("const createAutomation = useCallback(");
    const end = SOURCE.indexOf("[create_automation] created id=", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return SOURCE.slice(start, end);
  }

  it("resolves assignee_name from its own exact key only, not the generic multi-key person extractor", () => {
    const block = createAutomationBlock();
    expect(block).toContain(
      'const rawAssigneeName = typeof params?.assignee_name === "string" ? params.assignee_name : "";',
    );
    expect(block).not.toContain('extractPersonNameParam(params, "assignee_name")');
  });

  it("still resolves an explicitly-provided assignee_name against People (staff automation behavior unchanged)", () => {
    const block = createAutomationBlock();
    expect(block).toMatch(/if \(assignee_name\?\.trim\(\)\)\s*\{/);
    expect(block).toContain("people.find(");
    expect(block).toContain("assigneeId = match.id;");
  });

  // Regression: confirmed production failure. Carson called create_automation
  // with assignee_name set to the account owner's own name for a
  // self-directed "remind me" request. The owner also had a People contact
  // literally named the same as her own display name (profiles.display_name),
  // so the exact-match lookup resolved a real assignee_id, and the resulting
  // request was rejected server-side as an unsupported recurring WhatsApp
  // automation — Carson never created the owner's reminder at all. A name
  // matching the owner's own display name must never be treated as a
  // delegation target.
  //
  // This is asserted via source-pattern matching, consistent with every other
  // test in this file (createReminder, execute_instruction, send_delegation,
  // etc.) — createAutomation is a private useCallback inside this ~5000-line
  // component with Supabase auth, the ElevenLabs SDK, and browser media APIs
  // as dependencies, so behaviorally invoking it in isolation would require
  // extracting it into a standalone module, which is out of scope for this
  // fix. The assertions below are structural rather than a single loose
  // substring check specifically so a change to the comparison's polarity,
  // trim/case handling, or which store field is read would fail this test.
  it("treats an assignee_name matching the owner's own display name as no assignee at all", () => {
    const block = createAutomationBlock();
    expect(block).toContain(
      "if (profileState.status === \"ready\" && profileState.loadedForUserId === authUserId) {",
    );
    expect(block).toContain("const ownerDisplayName = (profileState.displayName ?? \"\").trim();");
    expect(block).toMatch(
      /assignee_name\.trim\(\) !== ""\s*&&\s*ownerDisplayName !== ""\s*&&\s*assignee_name\.trim\(\)\.toLowerCase\(\) === ownerDisplayName\.toLowerCase\(\)/,
    );
    // The self-referential branch must clear assignee_name entirely, so the
    // downstream lookup (if (assignee_name?.trim())) is skipped — never a
    // definite person for the owner's own name.
    expect(block).toMatch(/\{\s*assignee_name = "";\s*\}/);
  });

  // Regression (CodeRabbit finding on this fix's first pass): the owner-name
  // comparison must only run against a profile actually loaded for the
  // current signed-in user. useProfileStore's displayName can be null (not
  // yet loaded this session) or, in principle, stale from a previous account
  // if the store isn't fully reset on sign-out — comparing against either
  // would either silently reintroduce the original bug (profile not yet
  // loaded when the very first request of a session is self-directed) or
  // wrongly null out a genuine third-party assignee_name (stale cross-account
  // name coincidentally matching this request). loadedForUserId exists on
  // the store precisely to detect this ("Re-fetch when it changes").
  it("only trusts the profile store once it is ready and loaded for the current signed-in user", () => {
    const block = createAutomationBlock();
    expect(block).toContain(
      "if (profileState.loadedForUserId !== authUserId || profileState.status !== \"ready\") {",
    );
    expect(block).toContain("await useProfileStore.getState().loadFor(authUserId);");
    expect(block).toContain("profileState = useProfileStore.getState();");
  });
});

// Regression: confirmed production failure. A daily automation requested
// ~2 minutes ahead ("charge your phone" at 1:36 AM, created at 1:34 AM) was
// scheduled for the following day instead of firing that morning. Root
// cause (reproduced directly against parseVoiceTime with the real
// timestamps): first_run_text — Carson's own tool-call argument — contained
// the literal word "tomorrow", which parseVoiceTime's absolute-time branch
// always honors literally (documented, intentional behavior for its
// general one-time-task contract, used unchanged by other tools). For a
// recurring loop specifically, silently skipping a whole day when the
// requested time is still safely ahead today is never correct.
//
// CodeRabbit finding: the actual date-adjustment logic (including
// DST-safety) is behaviorally tested against its real output in
// parse-voice-time.test.ts (resolveRecurringAutomationFirstRun), a pure,
// standalone, dependency-free function extracted specifically so it could
// be tested that way rather than only via source-pattern matching. This
// block only verifies createAutomation actually wires nextRunAt through
// that tested helper, using the resolved cadenceType and parsed result —
// not a reimplementation of the date logic itself.
describe("ElevenLabsAgentWidget — create_automation prefers today's occurrence for recurring first runs", () => {
  function createAutomationBlock(): string {
    const start = SOURCE.indexOf("const createAutomation = useCallback(");
    const end = SOURCE.indexOf("[create_automation] created id=", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return SOURCE.slice(start, end);
  }

  it("imports the recurring first-run helpers from parse-voice-time, alongside parseVoiceTime", () => {
    expect(SOURCE).toContain("parseVoiceTime,");
    expect(SOURCE).toContain("resolveRecurringAutomationFirstRun,");
    expect(SOURCE).toContain("resolveRecurringFirstRunTextForParsing,");
  });

  it("assigns nextRunAt from resolveRecurringAutomationFirstRun(parsed, cadenceType), called after cadenceType is resolved", () => {
    const block = createAutomationBlock();
    const cadenceTypeIndex = block.lastIndexOf('let cadenceType: CadenceType = "once";');
    const callIndex = block.indexOf(
      "nextRunAt = resolveRecurringAutomationFirstRun(parsed, cadenceType);",
      cadenceTypeIndex,
    );
    expect(cadenceTypeIndex).toBeGreaterThan(-1);
    expect(callIndex).toBeGreaterThan(cadenceTypeIndex);
  });

  it("declares nextRunAt as mutable (let), not const, since it is reassigned after parseVoiceTime resolves it", () => {
    const block = createAutomationBlock();
    expect(block).toContain("let nextRunAt = parsed.dueAt;");
    expect(block).not.toContain("const nextRunAt = parsed.dueAt;");
  });
});

// Regression: confirmed production failure. "Remind me every morning ...
// at 3:15 AM" was correctly heard and correctly spoken back by Carson
// ("I'll remind you every morning at 3:15 AM..."), but the stored
// automation ran at 3:15 PM instead (automations.id=2b0153f2,
// cadence_value.time "15:15" — confirmed via Supabase). Reproduced
// exactly against parseVoiceTime with the real creation timestamp: a
// first_run_text of "3:15" (no AM/PM marker) hits parseVoiceTime's own
// documented ambiguous-hour heuristic — "no AM/PM and hour 1–7 almost
// always means PM" — see parse-voice-time.test.ts for the underlying
// AM/PM-resolution tests this fix depends on. create_automation now
// disambiguates toward AM before calling parseVoiceTime when
// cadence_phrase itself says "morning" and first_run_text has no explicit
// am/pm marker.
describe("ElevenLabsAgentWidget — create_automation disambiguates morning cadence toward AM", () => {
  function createAutomationBlock(): string {
    const start = SOURCE.indexOf("const createAutomation = useCallback(");
    const end = SOURCE.indexOf("[create_automation] created id=", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return SOURCE.slice(start, end);
  }

  it("resolves the recurring first-run parse text through the shared helper before calling parseVoiceTime", () => {
    const block = createAutomationBlock();
    expect(block).toContain("const firstRunTextForParsing = resolveRecurringFirstRunTextForParsing({");
    expect(block).toContain("firstRunText: first_run_text,");
    expect(block).toContain("cadencePhrase: cadence_phrase,");
    expect(block).toContain("cadenceType,");
  });

  it("calls parseVoiceTime with the helper's exact time text, not the raw first_run_text", () => {
    const block = createAutomationBlock();
    const helperIndex = block.indexOf("const firstRunTextForParsing = resolveRecurringFirstRunTextForParsing({");
    const parseCallIndex = block.indexOf("const parsed = parseVoiceTime(firstRunTextForParsing.timeText);", helperIndex);
    expect(helperIndex).toBeGreaterThan(-1);
    expect(parseCallIndex).toBeGreaterThan(helperIndex);
    expect(block).not.toContain("const parsed = parseVoiceTime(first_run_text.trim());");
  });

  it("records a verified failure when recurring first-run text lacks an exact clock", () => {
    const block = createAutomationBlock();
    const failClosedIndex = block.indexOf("I need the exact clock time for that recurring reminder");
    const recordIndex = block.indexOf("recordCreateAutomationFailure(failureText", failClosedIndex);
    expect(failClosedIndex).toBeGreaterThan(-1);
    expect(recordIndex).toBeGreaterThan(failClosedIndex);
  });

  it("the error message shown to the user still quotes the original first_run_text, not the internally-disambiguated version", () => {
    const block = createAutomationBlock();
    expect(block).toContain('I could not understand "${first_run_text}" as a time.');
  });
});

// Regression (Part A, tool-failure truthfulness): create_automation's three
// definite-failure return points must record a verified failure outcome so
// the display-override system can correct a fabricated success — mirroring
// what create_reminder's recurring path already does.
describe("ElevenLabsAgentWidget — create_automation records verified outcomes", () => {
  function createAutomationBlock(): string {
    const start = SOURCE.indexOf("const createAutomation = useCallback(");
    const end = SOURCE.indexOf("[create_automation] created id=", start);
    return SOURCE.slice(start, end);
  }

  it("records a failure outcome when the API rejects the request", () => {
    const block = createAutomationBlock();
    const failIndex = block.indexOf("I could not create that automation.");
    const recordIndex = block.indexOf("recordCreateAutomationFailure(failureText", failIndex);
    expect(failIndex).toBeGreaterThan(-1);
    expect(recordIndex).toBeGreaterThan(failIndex);
  });

  it("records a failure outcome when persistence is unconfirmed (2xx with no automation id)", () => {
    const block = createAutomationBlock();
    const unconfirmedIndex = block.indexOf("I could not confirm that automation was saved");
    const recordIndex = block.indexOf("recordCreateAutomationFailure(failureText", unconfirmedIndex);
    expect(unconfirmedIndex).toBeGreaterThan(-1);
    expect(recordIndex).toBeGreaterThan(unconfirmedIndex);
  });

  it("records a failure outcome when the network request itself throws", () => {
    const block = createAutomationBlock();
    const networkFailIndex = block.indexOf("I could not reach the server");
    const recordIndex = block.indexOf("recordCreateAutomationFailure(failureText", networkFailIndex);
    expect(networkFailIndex).toBeGreaterThan(-1);
    expect(recordIndex).toBeGreaterThan(networkFailIndex);
  });

  it("records a success outcome only at the verified success return", () => {
    const start = SOURCE.indexOf("const createAutomation = useCallback(");
    const end = SOURCE.indexOf("  );\n\n  // ------------------------------------------------------------------\n  // Client tool: send_direct_whatsapp_message", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = SOURCE.slice(start, end);

    const successTextIndex = block.indexOf("const successText = ");
    const outcomeIndex = block.indexOf('outcome: "success"', successTextIndex);
    const returnIndex = block.indexOf("return successText;", outcomeIndex);

    expect(successTextIndex).toBeGreaterThan(-1);
    expect(outcomeIndex).toBeGreaterThan(successTextIndex);
    expect(returnIndex).toBeGreaterThan(outcomeIndex);
  });
});
