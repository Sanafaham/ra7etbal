const WEB_SEARCH_TOOL = {
  type: "web_search_20250305",
  name: "web_search",
};

function searchCount(response) {
  return Number(response?.usage?.server_tool_use?.web_search_requests || 0);
}

function textFromResponse(response) {
  return (Array.isArray(response?.content) ? response.content : [])
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function collectSourceUrls(value, urls = new Set()) {
  if (!value || typeof value !== "object") return urls;
  if (
    typeof value.url === "string" &&
    /^https?:\/\//i.test(value.url)
  ) {
    urls.add(value.url);
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSourceUrls(item, urls);
  } else {
    for (const nested of Object.values(value)) collectSourceUrls(nested, urls);
  }
  return urls;
}

function buildRequest({ query, capability, model, messages }) {
  const deep = capability === "deep_research";
  return {
    model,
    max_tokens: deep ? 1200 : 600,
    system:
      "Retrieve the requested current information using web search. Answer only from retrieved evidence. If sources conflict or the answer cannot be confirmed, say so plainly. Be concise and include the relevant date, time, or status when available.",
    messages: messages ?? [{ role: "user", content: query }],
    tools: [{ ...WEB_SEARCH_TOOL, max_uses: deep ? 5 : 2 }],
  };
}

export async function performLiveInformationLookup({
  fetchFn,
  apiKey,
  query,
  capability,
  signal,
  model = "claude-haiku-4-5-20251001",
}) {
  if (!apiKey) {
    return { ok: false, error: "live retrieval is not configured" };
  }
  if (!query || !String(query).trim()) {
    return { ok: false, error: "no live information request was supplied" };
  }
  if (!["live_search", "deep_research"].includes(capability)) {
    return { ok: false, error: "unsupported live retrieval capability" };
  }

  const callProvider = async (body) => {
    const response = await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      signal,
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const detail =
        data?.error?.message || data?.error || `retrieval provider returned ${response.status}`;
      throw new Error(String(detail));
    }
    return data;
  };

  try {
    const first = await callProvider(
      buildRequest({ query: String(query).trim(), capability, model }),
    );
    let final = first;
    let searches = searchCount(first);

    if (first?.stop_reason === "pause_turn") {
      final = await callProvider(
        buildRequest({
          query: String(query).trim(),
          capability,
          model,
          messages: [
            { role: "user", content: String(query).trim() },
            { role: "assistant", content: first.content },
          ],
        }),
      );
      searches += searchCount(final);
    }

    const answer = textFromResponse(final);
    if (searches < 1) {
      return {
        ok: false,
        error: "the provider did not complete a live web search",
      };
    }
    if (!answer) {
      return {
        ok: false,
        error: "the live search completed without a confirmable answer",
      };
    }

    return {
      ok: true,
      answer,
      sources: [...collectSourceUrls([first, final])].slice(0, 8),
      searches,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "live retrieval failed",
    };
  }
}
