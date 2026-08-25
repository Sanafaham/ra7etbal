import { afterEach, describe, expect, it, vi } from 'vitest';

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));

vi.mock('./supabase', () => ({
  supabase: { auth: { getSession } },
}));

import { transcribeAudio } from './transcribe';

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('transcribeAudio authentication', () => {
  it('attaches the active Supabase session without exposing it in the URL', async () => {
    getSession.mockResolvedValue({ data: { session: { access_token: 'session-token' } } });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ text: 'hello' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(transcribeAudio(new Blob(['audio'], { type: 'audio/webm' }))).resolves.toBe('hello');

    expect(fetchMock).toHaveBeenCalledWith('/api/transcribe', expect.objectContaining({
      method: 'POST',
      headers: { Authorization: 'Bearer session-token' },
    }));
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('session-token');
  });

  it('fails closed when there is no signed-in session', async () => {
    getSession.mockResolvedValue({ data: { session: null } });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(transcribeAudio(new Blob(['audio']))).rejects.toThrow('Not signed in.');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
