/**
 * Slice 1 — task-only owner decision page (no_response handoff).
 * Pure view, rendered with renderToStaticMarkup (same convention as
 * OwnerEscalationDecision.test.tsx).
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TaskOnlyEscalationDetail } from "../types/staff-message";
import {
  TaskOnlyDecisionView,
  answeredText,
  resultText,
  type TaskOnlyDecisionViewProps,
} from "./TaskOnlyDecisionView";

function detail(over: Partial<TaskOnlyEscalationDetail> = {}): TaskOnlyEscalationDetail {
  return {
    kind: "task_only",
    id: "decision-1",
    status: "open",
    createdAt: "2026-09-28T17:00:00.000Z",
    alreadyAnswered: false,
    reviewType: "no_response",
    taskId: "task-1",
    taskDescription: "call me now.",
    assigneeName: "Christopher",
    taskNotCurrentReason: null,
    ownerChoice: null,
    ...over,
  };
}

function render(over: Partial<TaskOnlyDecisionViewProps> = {}): string {
  const props: TaskOnlyDecisionViewProps = {
    detail: detail(),
    submitPhase: "idle",
    submitError: null,
    result: null,
    onChoose: () => {},
    onConfirmAskAgain: () => {},
    onCancel: () => {},
    onRetryDelivery: () => {},
    ...over,
  };
  return renderToStaticMarkup(<TaskOnlyDecisionView {...props} />);
}

const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1].trim());

describe("no_response — current task", () => {
  it("11. offers ONLY Ask again and Keep waiting", () => {
    expect(buttons(render())).toEqual(["Ask again", "Keep waiting"]);
  });

  it("never offers Approve, Reject or Custom instruction", () => {
    const html = render();
    expect(html).not.toMatch(/Approve|Reject|Custom instruction/);
  });

  it("shows the real task and assignee, and no fabricated inbound text or reply", () => {
    const html = render();
    expect(html).toContain("call me now.");
    expect(html).toContain("Christopher");
    expect(html).not.toMatch(/italic/); // the staff-message quote block is never rendered
    expect(html).not.toMatch(/Christopher (said|wrote|replied|asked)/);
    expect(html).toContain("hadn&#x27;t replied after the follow-up");
  });

  it("Ask again requires an explicit confirmation naming the one message", () => {
    const html = render({ submitPhase: "confirming_ask_again" });
    expect(html).toContain("Carson will send Christopher one message asking again about this task.");
    expect(buttons(html)).toEqual(["Send", "Cancel"]);
  });
});

describe("no_response — non-actionable states", () => {
  it.each([
    ["completed", "already done"],
    ["confirmed", "already done"],
    ["archived", "was closed"],
    ["dismissed", "was closed"],
    ["not_pending", "no longer open"],
    ["task_unavailable", "no longer available"],
  ] as const)("9/10. a %s task shows no choices and says why", (reason, text) => {
    const html = render({ detail: detail({ taskNotCurrentReason: reason }) });
    expect(buttons(html)).toEqual([]);
    expect(html).toContain(text);
  });

  it("KEEP WAITING already recorded: truthful, no buttons, nothing claimed as sent", () => {
    const d = detail({ status: "answered", alreadyAnswered: true, ownerChoice: "keep_waiting" });
    const html = render({ detail: d });
    expect(buttons(html)).toEqual([]);
    expect(answeredText(d)).toBe("You chose to keep waiting. Nothing was sent to Christopher.");
  });

  it("ASK AGAIN delivered: states one message was sent", () => {
    expect(answeredText(detail({ status: "delivered_to_staff", ownerChoice: "ask_again" })))
      .toBe("You chose to ask again. Carson sent Christopher one message.");
  });

  it("ASK AGAIN failed on a current task: offers only a retry", () => {
    const html = render({ detail: detail({ status: "failed", alreadyAnswered: true, ownerChoice: "ask_again" }) });
    expect(buttons(html)).toEqual(["Try sending again"]);
  });

  it("ASK AGAIN failed on a finished task: no retry", () => {
    const html = render({
      detail: detail({ status: "failed", ownerChoice: "ask_again", taskNotCurrentReason: "completed" }),
    });
    expect(buttons(html)).toEqual([]);
  });

  it("answered ASK AGAIN that was never confirmed as sent is not called sent", () => {
    expect(answeredText(detail({ status: "answered", ownerChoice: "ask_again" })))
      .toBe("You chose to ask again. The message to Christopher hasn't been confirmed as sent.");
  });
});

describe("server results are shown verbatim-truthfully", () => {
  it("keep waiting says nothing was sent and the task stays open", () => {
    expect(resultText("kept_waiting", "Christopher")).toMatch(/Nothing was sent to Christopher, and the task stays open/);
  });
  it("delivered keeps the task open until confirmed", () => {
    expect(resultText("delivered", "Christopher")).toMatch(/stays open until it's confirmed done/);
  });
  it("not_sent_no_longer_current never claims a send", () => {
    expect(resultText("not_sent_no_longer_current", "Christopher")).toMatch(/^Nothing was sent/);
  });
  it("after a result, no further buttons are shown", () => {
    expect(buttons(render({ result: "kept_waiting" }))).toEqual([]);
  });
});

describe("12. other task-only review types are read-only here", () => {
  it.each(["substitute_review", "uncertain_proof", "correction_limit"])("%s: no actions, honest notice", (reviewType) => {
    const html = render({ detail: detail({ reviewType }) });
    expect(buttons(html)).toEqual([]);
    expect(html).toContain("can&#x27;t be answered from this link");
    expect(html).not.toMatch(/Ask again|Keep waiting|Approve|Reject/);
  });
});

describe("Option A — a superseded no_response decision is history, never actionable", () => {
  it.each([null, "ask_again", "keep_waiting"] as const)(
    "superseded (earlier choice %s): no Ask again / Keep waiting / retry buttons",
    (ownerChoice) => {
      const d = detail({ status: "superseded", alreadyAnswered: ownerChoice !== null, ownerChoice });
      const html = render({ detail: d });
      expect(buttons(html)).toEqual([]);
      expect(html).toContain("no longer applies");
    },
  );

  it("superseded text preserves the earlier choice without claiming a send or a prevention", () => {
    const t = answeredText(detail({ status: "superseded", ownerChoice: "ask_again" }));
    expect(t).toMatch(/Newer information arrived for this task/);
    expect(t).toMatch(/Your earlier choice \(Ask again\) is kept in history/);
    expect(t).not.toMatch(/sent|prevented|done|completed|cancel/i);
  });

  it("superseded with a failed-looking history still offers no retry", () => {
    const html = render({ detail: detail({ status: "superseded", ownerChoice: "ask_again", alreadyAnswered: true }) });
    expect(html).not.toContain("Try sending again");
  });

  it("sent_then_superseded is truthful: the message was sent, the proof is now current", () => {
    const t = resultText("sent_then_superseded", "Christopher");
    expect(t).toMatch(/message to Christopher was sent/);
    expect(t).toMatch(/proof is now the current review/);
    expect(t).not.toMatch(/prevented|not sent|Nothing was sent/i);
  });
});

