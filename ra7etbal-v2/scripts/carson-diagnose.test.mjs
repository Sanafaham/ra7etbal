import { describe, it, expect } from "vitest";
import {
  expectedClientTools,
  zipInlineToolsWithIds,
  evaluateTavilyMcpSecurityContract,
  TAVILY_SECURITY_CONTRACT,
} from "./carson-diagnose.mjs";

// Regression coverage for the tool-registration-drift check born from the
// Blue Pen incident's true root cause: get_commitment_history was correct in
// the widget and in the prompt, but was never registered on the live
// ElevenLabs agent, so the model could never call it. `audit()` itself needs
// a live ElevenLabs API key and isn't unit-tested here, but the part that
// reads the widget's actual source — the thing that must never silently
// return a stale or empty list — is deterministic and covered directly.
describe("expectedClientTools (Carson Reliability Engineering — tool-registration-drift check)", () => {
  it("extracts get_commitment_history from the live widget source", () => {
    const names = expectedClientTools();
    expect(names).toContain("get_commitment_history");
  });

  it("extracts every known client tool, not a truncated subset", () => {
    const names = expectedClientTools();
    // A representative spread across the widget's tool categories — if any
    // of these silently disappear from the scan, the regex-based extraction
    // itself has drifted from the widget's actual shape.
    for (const name of [
      "execute_instruction",
      "send_delegation",
      "search_calendar_history",
      "get_task_delivery_status",
      "get_operations_summary",
      "get_commitment_history",
      "create_calendar_event",
      "save_instruction",
    ]) {
      expect(names).toContain(name);
    }
  });

  it("never returns an empty or near-empty list — an empty result must throw, not pass silently", () => {
    const names = expectedClientTools();
    expect(names.length).toBeGreaterThan(15);
  });

  it("returns no duplicate tool names", () => {
    const names = expectedClientTools();
    expect(new Set(names).size).toBe(names.length);
  });
});

// Regression guard for a real bug found while registering get_person_history
// (2026-08-04): fetchLiveAgentToolNames() tried to match the inline
// `prompt.tools` array back to `tool_ids` by an `.id`/`.tool_id` field that
// doesn't exist on inline entries. It silently matched nothing, so every
// tool got resolved a SECOND time via a redundant /tools/{id} call — a live
// audit run reported 42 registered tools instead of the real 21, with every
// orphaned tool listed twice. `tools` and `tool_ids` are parallel arrays
// (same order, same length); zipping by index is the correct match.
describe("zipInlineToolsWithIds (regression: must not double-resolve tools)", () => {
  const toolIds = ["tool_a", "tool_b", "tool_c"];
  const inlineTools = [
    { type: "client", name: "send_followup" },
    { type: "client", name: "create_reminder" },
    { type: "client", name: "get_commitment_history" },
  ];

  it("resolves each tool exactly once when tools and tool_ids are parallel arrays", () => {
    const { resolved, unresolvedIds } = zipInlineToolsWithIds(toolIds, inlineTools);
    expect(resolved).toHaveLength(3);
    expect(unresolvedIds).toHaveLength(0);
  });

  it("pairs each resolved tool with its correct id by position, not by a nonexistent id field on the inline entry", () => {
    const { resolved } = zipInlineToolsWithIds(toolIds, inlineTools);
    expect(resolved.find((r) => r.name === "get_commitment_history")?.id).toBe("tool_c");
    expect(resolved.find((r) => r.name === "send_followup")?.id).toBe("tool_a");
  });

  it("never returns duplicate ids — the exact shape of the bug this guards against", () => {
    const { resolved } = zipInlineToolsWithIds(toolIds, inlineTools);
    const ids = resolved.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("falls back to per-id resolution only when the arrays don't align in length", () => {
    const { resolved, unresolvedIds } = zipInlineToolsWithIds(toolIds, inlineTools.slice(0, 2));
    expect(resolved).toHaveLength(0);
    expect(unresolvedIds).toEqual(toolIds);
  });
});

// Regression guard for the Tavily MCP Credential-Security remediation
// (2026-09-10 — see RA7ETBAL_STATE.md). Mutation-style: start from the exact
// healthy production shape, prove it passes, then mutate ONE field at a time
// to reproduce each forbidden condition (A-G from the protected contract) and
// prove the guard fails on it — then the healthy fixture is re-asserted
// clean so no test above it silently broke the baseline.
describe("evaluateTavilyMcpSecurityContract (Tavily MCP Credential-Security protected contract)", () => {
  const c = TAVILY_SECURITY_CONTRACT;

  function healthyFixture() {
    return {
      agent: {
        conversation_config: {
          agent: {
            prompt: {
              mcp_server_ids: [c.perplexityMcpId, c.activeTavilyMcpId],
            },
          },
        },
      },
      tavilyMcp: {
        id: c.activeTavilyMcpId,
        config: {
          url: "https://mcp.tavily.com/mcp/",
          secret_token: { secret_id: c.expectedSecretId },
          request_headers: {},
          approval_policy: "require_approval_per_tool",
          tool_approval_hashes: [
            { tool_name: "tavily_search", approval_policy: "auto_approved", tool_hash: "h1" },
            { tool_name: "tavily_extract", approval_policy: "auto_approved", tool_hash: "h2" },
            { tool_name: "tavily_research", approval_policy: "auto_approved", tool_hash: "h3" },
          ],
        },
      },
      perplexityMcp: { id: c.perplexityMcpId },
    };
  }

  it("passes clean on the exact healthy production shape", () => {
    const result = evaluateTavilyMcpSecurityContract(healthyFixture());
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("[A] fails when the Tavily MCP URL carries a query string (embedded credential shape)", () => {
    const fixture = healthyFixture();
    fixture.tavilyMcp.config.url = "https://mcp.tavily.com/mcp/?tavilyApiKey=tvly-fake-mutation-only";
    const result = evaluateTavilyMcpSecurityContract(fixture);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.startsWith("[A]"))).toBe(true);
  });

  it("[B] fails when Carson references the retired old Tavily MCP", () => {
    const fixture = healthyFixture();
    fixture.agent.conversation_config.agent.prompt.mcp_server_ids = [c.perplexityMcpId, c.retiredTavilyMcpId];
    const result = evaluateTavilyMcpSecurityContract(fixture);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.startsWith("[B]"))).toBe(true);
    // Also correctly reports G — the secure MCP is now absent too.
    expect(result.violations.some((v) => v.startsWith("[G]"))).toBe(true);
  });

  it("[C] fails when secret_token no longer references the expected secret id", () => {
    const fixture = healthyFixture();
    fixture.tavilyMcp.config.secret_token = { secret_id: "SomeOtherSecretId" };
    const result = evaluateTavilyMcpSecurityContract(fixture);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.startsWith("[C]"))).toBe(true);
  });

  it("[C] fails when secret_token is unexpectedly absent", () => {
    const fixture = healthyFixture();
    fixture.tavilyMcp.config.secret_token = null;
    const result = evaluateTavilyMcpSecurityContract(fixture);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.startsWith("[C]"))).toBe(true);
  });

  it("[D] fails when approval_policy drifts away from require_approval_per_tool", () => {
    const fixture = healthyFixture();
    fixture.tavilyMcp.config.approval_policy = "always_approved";
    const result = evaluateTavilyMcpSecurityContract(fixture);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.startsWith("[D]"))).toBe(true);
  });

  it("[E] fails when tavily_crawl becomes unexpectedly auto_approved", () => {
    const fixture = healthyFixture();
    fixture.tavilyMcp.config.tool_approval_hashes.push({
      tool_name: "tavily_crawl",
      approval_policy: "auto_approved",
      tool_hash: "h4",
    });
    const result = evaluateTavilyMcpSecurityContract(fixture);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.startsWith("[E]"))).toBe(true);
  });

  it("[E] fails when tavily_map becomes unexpectedly auto_approved", () => {
    const fixture = healthyFixture();
    fixture.tavilyMcp.config.tool_approval_hashes.push({
      tool_name: "tavily_map",
      approval_policy: "auto_approved",
      tool_hash: "h5",
    });
    const result = evaluateTavilyMcpSecurityContract(fixture);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.startsWith("[E]"))).toBe(true);
  });

  it("[F] fails when Perplexity is removed from Carson's mcp_server_ids as a side effect", () => {
    const fixture = healthyFixture();
    fixture.agent.conversation_config.agent.prompt.mcp_server_ids = [c.activeTavilyMcpId];
    const result = evaluateTavilyMcpSecurityContract(fixture);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.startsWith("[F]"))).toBe(true);
  });

  it("[G] fails when the secure Tavily MCP disappears from Carson's mcp_server_ids", () => {
    const fixture = healthyFixture();
    fixture.agent.conversation_config.agent.prompt.mcp_server_ids = [c.perplexityMcpId];
    const result = evaluateTavilyMcpSecurityContract(fixture);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.startsWith("[G]"))).toBe(true);
  });

  it("fails when request_headers becomes non-empty without an approved architecture change", () => {
    const fixture = healthyFixture();
    fixture.tavilyMcp.config.request_headers = { Authorization: "Bearer something" };
    const result = evaluateTavilyMcpSecurityContract(fixture);
    expect(result.ok).toBe(false);
  });

  it("fails when one of the three required tools loses its auto_approved status", () => {
    const fixture = healthyFixture();
    fixture.tavilyMcp.config.tool_approval_hashes = fixture.tavilyMcp.config.tool_approval_hashes.filter(
      (a) => a.tool_name !== "tavily_extract",
    );
    const result = evaluateTavilyMcpSecurityContract(fixture);
    expect(result.ok).toBe(false);
  });

  it("re-confirms the healthy fixture is still clean after every mutation above (fixture isolation)", () => {
    const result = evaluateTavilyMcpSecurityContract(healthyFixture());
    expect(result.ok).toBe(true);
  });

  it("never inspects or requires the actual secret VALUE — only the secret_id reference", () => {
    const fixture = healthyFixture();
    // No "value" field exists anywhere in a real secret_token shape; confirm
    // the evaluator doesn't expect or read one.
    expect(fixture.tavilyMcp.config.secret_token).not.toHaveProperty("value");
    const result = evaluateTavilyMcpSecurityContract(fixture);
    expect(result.ok).toBe(true);
  });
});
