import { afterEach, describe, expect, it, vi } from 'vitest';

import handler from './transcribe.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('transcribe security boundary', () => {
  it('rejects an unauthenticated caller before reading audio or calling a provider', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const req = createRequest({ headers: { 'content-type': 'multipart/form-data; boundary=x' } });
    const res = createRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid session before calling OpenAI', async () => {
    stubConfig();
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false, json: vi.fn() });
    vi.stubGlobal('fetch', fetchMock);
    const req = createRequest({
      headers: { authorization: 'Bearer invalid', 'content-type': 'multipart/form-data; boundary=x' },
    });
    const res = createRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/auth/v1/user');
  });

  it('allows a valid session and does not reflect provider errors', async () => {
    stubConfig();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: vi.fn().mockResolvedValue({ id: 'user-1' }) })
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: vi.fn().mockResolvedValue({ error: { message: 'sensitive provider detail' } }),
      });
    vi.stubGlobal('fetch', fetchMock);
    const req = createRequest({
      headers: { authorization: 'Bearer valid', 'content-type': 'multipart/form-data; boundary=x' },
      chunks: [Buffer.from('audio')],
    });
    const res = createRes();

    await handler(req, res);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Transcription failed. Please try again.' });
    expect(JSON.stringify(res.json.mock.calls)).not.toContain('sensitive provider detail');
  });
});

function stubConfig() {
  vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co');
  vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key');
  vi.stubEnv('OPENAI_API_KEY', 'openai-key');
}

function createRequest({ headers, chunks = [] }) {
  return {
    method: 'POST',
    headers,
    async *[Symbol.asyncIterator]() {
      yield* chunks;
    },
  };
}

function createRes() {
  const res = {
    status: vi.fn(() => res),
    json: vi.fn(() => res),
  };
  return res;
}
