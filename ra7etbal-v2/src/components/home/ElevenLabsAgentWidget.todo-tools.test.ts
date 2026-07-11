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
    expect(SOURCE).toMatch(/create_todo:\s*\(params[^)]*\)\s*=>\s*\{[\s\S]*guardCurrentVoiceCapture\("create_todo"\)[\s\S]*runDirectToolWithDiagnostic\("create_todo",\s*params,\s*\(\)\s*=>\s*createTodoTool\(params\)\)/);
  });

  it("registers complete_todo in the clientTools map, wired to completeTodoTool", () => {
    expect(SOURCE).toMatch(/complete_todo:\s*\(params[^)]*\)\s*=>\s*\{[\s\S]*guardCurrentVoiceCapture\("complete_todo"\)[\s\S]*runDirectToolWithDiagnostic\("complete_todo",\s*params,\s*\(\)\s*=>\s*completeTodoTool\(params\)\)/);
  });

  it("registers control_task in the clientTools map, wired to controlTaskTool", () => {
    expect(SOURCE).toMatch(/control_task:\s*\(params[^)]*\)\s*=>\s*\{[\s\S]*guardCurrentVoiceCapture\("control_task"\)[\s\S]*runDirectToolWithDiagnostic\("control_task",\s*params,\s*\(\)\s*=>\s*controlTaskTool\(params\)\)/);
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

    it("records a failure outcome when parseVoiceTime cannot resolve time_text", () => {
      const block = oneTimeBlock();
      const failureIndex = block.indexOf('I could not understand the time "${time_text}"');
      const recordIndex = block.indexOf("recordCreateReminderFailure(failureText", failureIndex);
      expect(failureIndex).toBeGreaterThan(-1);
      expect(recordIndex).toBeGreaterThan(failureIndex);
    });

    it("records a failure outcome when the agent-supplied due_at is not a valid timestamp", () => {
      const block = oneTimeBlock();
      const failureIndex = block.indexOf("I did not receive a valid due time.");
      const recordIndex = block.indexOf("recordCreateReminderFailure(failureText", failureIndex);
      expect(failureIndex).toBeGreaterThan(-1);
      expect(recordIndex).toBeGreaterThan(failureIndex);
    });

    it("records a failure outcome when neither time_text nor due_at is provided", () => {
      const block = oneTimeBlock();
      const failureIndex = block.indexOf("I did not receive a time for the reminder.");
      const recordIndex = block.indexOf("recordCreateReminderFailure(failureText", failureIndex);
      expect(failureIndex).toBeGreaterThan(-1);
      expect(recordIndex).toBeGreaterThan(failureIndex);
    });

    it("records a failure outcome when the user is not signed in", () => {
      const block = oneTimeBlock();
      const failureIndex = block.indexOf("You are not signed in. Please sign in and try again.");
      const recordIndex = block.indexOf("recordCreateReminderFailure(failureText", failureIndex);
      expect(failureIndex).toBeGreaterThan(-1);
      expect(recordIndex).toBeGreaterThan(failureIndex);
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
    expect(block).toContain('const recurringFailureText = "I could not create the recurring reminder.";');
    expect(block).toContain("return recurringFailureText;");
  });

  it("records the recurring-path failure as an overridable outcome so a fabricated success can be corrected", () => {
    const block = SOURCE.slice(recurringStart, oneTimeStart);
    const failureConstIndex = block.indexOf('const recurringFailureText = "I could not create the recurring reminder.";');
    const failureRecordIndex = block.indexOf('outcome: "failure"', failureConstIndex);
    const returnIndex = block.indexOf("return recurringFailureText;", failureConstIndex);

    expect(failureConstIndex).toBeGreaterThan(-1);
    expect(failureRecordIndex).toBeGreaterThan(failureConstIndex);
    expect(returnIndex).toBeGreaterThan(failureRecordIndex);
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
    expect(block).toContain("return null;");
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
describe("ElevenLabsAgentWidget — create_automation prefers today's occurrence for recurring first runs", () => {
  function createAutomationBlock(): string {
    const start = SOURCE.indexOf("const createAutomation = useCallback(");
    const end = SOURCE.indexOf("[create_automation] created id=", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return SOURCE.slice(start, end);
  }

  it("only snaps back when parseVoiceTime resolved an explicit tomorrow day-word, for a recurring cadence", () => {
    const block = createAutomationBlock();
    expect(block).toContain(
      'if (cadenceType !== "once" && parsed.parsedAs.includes(\'day="tomorrow"\')) {',
    );
  });

  it("subtracts exactly one day rather than reusing today's date components (immune to next-Friday/next-week miscorrection)", () => {
    const block = createAutomationBlock();
    expect(block).toContain(
      "const oneDayEarlier = new Date(new Date(nextRunAt).getTime() - 24 * 60 * 60 * 1000);",
    );
  });

  it("never snaps the first run earlier than now (would make the runner treat it as immediately overdue)", () => {
    const block = createAutomationBlock();
    expect(block).toContain("if (oneDayEarlier.getTime() > Date.now() + 60_000) {");
    expect(block).toContain("nextRunAt = oneDayEarlier.toISOString();");
  });

  it("does not apply the snap-back to a one-time (cadenceType === \"once\") automation", () => {
    const block = createAutomationBlock();
    const guardIndex = block.indexOf('parsed.parsedAs.includes(\'day="tomorrow"\')');
    expect(guardIndex).toBeGreaterThan(-1);
    // The same line's condition must require cadenceType !== "once" — a
    // "once" automation is a genuinely one-time task, where an explicit
    // "tomorrow" from the user must be respected exactly as parseVoiceTime
    // resolved it.
    const guardLineStart = block.lastIndexOf("if (cadenceType", guardIndex);
    expect(guardLineStart).toBeGreaterThan(-1);
    const guardLine = block.slice(guardLineStart, guardIndex + 40);
    expect(guardLine).toContain('cadenceType !== "once"');
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
