import { afterEach, describe, expect, it, vi } from "vitest";
import handler from "./weather.js";

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockResponse() {
  const state = { status: 200, body: null };
  return {
    state,
    res: {
      status(code) {
        state.status = code;
        return this;
      },
      json(body) {
        state.body = body;
        return this;
      },
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("weather live-information boundary", () => {
  it("returns an explicit clarification for genuinely ambiguous locations", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response({
          results: [
            { name: "Cambridge", admin1: "England", country: "United Kingdom", population: 145700 },
            { name: "Cambridge", admin1: "Massachusetts", country: "United States", population: 118400 },
          ],
        }),
      ),
    );
    const { res, state } = mockResponse();

    await handler({ method: "GET", query: { city: "Cambridge" } }, res);

    expect(state.body).toMatchObject({
      ok: false,
      code: "ambiguous_location",
      candidates: [
        "Cambridge, England, United Kingdom",
        "Cambridge, Massachusetts, United States",
      ],
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("accepts a dominant international city instead of over-clarifying", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          response({
            results: [
              {
                name: "Hamburg",
                admin1: "Hamburg",
                country: "Germany",
                population: 1900000,
                latitude: 53.55,
                longitude: 10,
                timezone: "Europe/Berlin",
              },
              {
                name: "Hamburg",
                admin1: "New York",
                country: "United States",
                population: 60000,
              },
            ],
          }),
        )
        .mockResolvedValueOnce(
          response({
            current: { temperature_2m: 18, weathercode: 2, windspeed_10m: 10 },
            daily: { precipitation_sum: [0] },
          }),
        ),
    );
    const { res, state } = mockResponse();

    await handler({ method: "GET", query: { city: "Hamburg" } }, res);

    expect(state.body).toMatchObject({ ok: true, city: "Hamburg", temperature_c: 18 });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(fetch.mock.calls[1][1].signal).toBeInstanceOf(AbortSignal);
  });
});
