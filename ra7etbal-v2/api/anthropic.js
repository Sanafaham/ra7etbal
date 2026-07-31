import { performLiveInformationLookup } from '../shared/live-information-provider.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Key is stored in Vercel environment variables -- never hardcoded
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured on server' });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);

  try {
    if (req.body?.ra7etbal_mode === 'live_information') {
      const result = await performLiveInformationLookup({
        fetchFn: fetch,
        apiKey,
        query: req.body?.query,
        capability: req.body?.capability,
        signal: controller.signal,
        model: process.env.LIVE_INFORMATION_MODEL || 'claude-haiku-4-5-20251001',
      });
      return res.status(result.ok ? 200 : 502).json(result);
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      signal: controller.signal,
      body: JSON.stringify(req.body)
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    return res.status(200).json(data);
  } catch (error) {
    if (error.name === 'AbortError') {
      return res.status(504).json({ error: 'Anthropic request timed out. Please try again.' });
    }
    return res.status(500).json({ error: 'Anthropic request failed. Please try again.' });
  } finally {
    clearTimeout(timeout);
  }
}
