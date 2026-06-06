/**
 * GET /api/weather?city=Fethiye
 *
 * Geocodes the city with Open-Meteo, fetches current conditions + today's
 * rain forecast, and returns a clean JSON object plus a Carson-ready spoken
 * sentence. No API key required. Fails safely — errors return HTTP 200 with
 * { ok: false, spoken: "" } so the frontend never crashes.
 *
 * Response shape:
 *   {
 *     ok: true,
 *     city: "Fethiye",
 *     temperature_c: 29,
 *     feels_like_c: 31,       // not available from Open-Meteo free tier — omitted
 *     description: "Partly cloudy",
 *     wind_kmh: 14,
 *     rain_today_mm: 0,
 *     spoken: "In Fethiye it's 29°C and partly cloudy. No rain expected today."
 *   }
 */

// WMO weather code → human-readable description
const WMO = {
  0: "clear sky",
  1: "mainly clear",
  2: "partly cloudy",
  3: "overcast",
  45: "foggy",
  48: "icy fog",
  51: "light drizzle",
  53: "moderate drizzle",
  55: "heavy drizzle",
  61: "light rain",
  63: "moderate rain",
  65: "heavy rain",
  71: "light snow",
  73: "moderate snow",
  75: "heavy snow",
  77: "snow grains",
  80: "light showers",
  81: "moderate showers",
  82: "violent showers",
  85: "light snow showers",
  86: "heavy snow showers",
  95: "thunderstorm",
  96: "thunderstorm with hail",
  99: "thunderstorm with heavy hail",
};

function weatherDescription(code) {
  return WMO[code] ?? "unknown conditions";
}

function spokenSentence(city, tempC, code, rainMm) {
  const desc = weatherDescription(code);
  const rain =
    rainMm > 0
      ? `About ${rainMm} mm of rain expected today.`
      : "No rain expected today.";
  return `In ${city} it's ${Math.round(tempC)}°C and ${desc}. ${rain}`;
}

export default async function handler(req, res) {
  // Allow GET only.
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Method not allowed", spoken: "" });
  }

  const city = (req.query?.city ?? "").trim();
  if (!city) {
    return res
      .status(400)
      .json({ ok: false, error: "city param required", spoken: "" });
  }

  try {
    // ── 1. Geocode ───────────────────────────────────────────────────────────
    const geoUrl =
      `https://geocoding-api.open-meteo.com/v1/search` +
      `?name=${encodeURIComponent(city)}&count=1&language=en&format=json`;

    const geoRes = await fetch(geoUrl);
    if (!geoRes.ok) {
      return res.status(200).json({ ok: false, error: "Geocoding failed", spoken: "" });
    }

    const geoData = await geoRes.json().catch(() => null);
    const place = geoData?.results?.[0];
    if (!place) {
      return res
        .status(200)
        .json({ ok: false, error: `City "${city}" not found`, spoken: "" });
    }

    const { latitude, longitude, name: resolvedName, timezone } = place;

    // ── 2. Fetch current weather + daily rain ────────────────────────────────
    const wxUrl =
      `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${latitude}&longitude=${longitude}` +
      `&current=temperature_2m,weathercode,windspeed_10m` +
      `&daily=precipitation_sum` +
      `&timezone=${encodeURIComponent(timezone ?? "auto")}` +
      `&forecast_days=1`;

    const wxRes = await fetch(wxUrl);
    if (!wxRes.ok) {
      return res.status(200).json({ ok: false, error: "Weather fetch failed", spoken: "" });
    }

    const wxData = await wxRes.json().catch(() => null);
    const current = wxData?.current;
    if (!current) {
      return res.status(200).json({ ok: false, error: "No weather data", spoken: "" });
    }

    const tempC = current.temperature_2m ?? 0;
    const code = current.weathercode ?? 0;
    const windKmh = current.windspeed_10m ?? 0;
    const rainMm = Math.round((wxData?.daily?.precipitation_sum?.[0] ?? 0) * 10) / 10;

    const spoken = spokenSentence(resolvedName, tempC, code, rainMm);

    return res.status(200).json({
      ok: true,
      city: resolvedName,
      temperature_c: Math.round(tempC),
      description: weatherDescription(code),
      wind_kmh: Math.round(windKmh),
      rain_today_mm: rainMm,
      spoken,
    });
  } catch (err) {
    console.error("[weather] unexpected error:", err?.message);
    return res.status(200).json({ ok: false, error: "Internal error", spoken: "" });
  }
}
