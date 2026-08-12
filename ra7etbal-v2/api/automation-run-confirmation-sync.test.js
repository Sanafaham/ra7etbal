import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadCanonicalConfirmedTask,
  synchronizeAutomationRunFromConfirmedTask,
} from './_automation-run-confirmation-sync.js';

const context = {
  supabaseUrl: 'https://example.supabase.co',
  serviceKey: 'service-key',
};
const confirmedTask = {
  id: 'task-1',
  user_id: 'owner-1',
  status: 'done',
  confirmed_at: '2026-08-12T01:40:00.123Z',
};

afterEach(() => vi.unstubAllGlobals());

describe('automation run confirmation projection', () => {
  it.each(['task_created', 'sent', 'followup_sent', 'escalated', 'failed'])(
    'converges %s to confirmed using the task timestamp and exact task/owner binding',
    async (currentState) => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(jsonResponse([run(currentState)]))
        .mockResolvedValueOnce(jsonResponse([{ ...run('confirmed'), confirmed_at: confirmedTask.confirmed_at }]));
      vi.stubGlobal('fetch', fetchMock);

      const result = await synchronizeAutomationRunFromConfirmedTask({ ...context, task: confirmedTask });

      expect(result).toEqual({ synchronized: true, reason: 'confirmed', runId: 'run-1' });
      expect(fetchMock.mock.calls[0][0]).toContain('task_id=eq.task-1&user_id=eq.owner-1');
      const [patchUrl, patchInit] = fetchMock.mock.calls[1];
      expect(patchUrl).toContain('id=eq.run-1&task_id=eq.task-1&user_id=eq.owner-1');
      expect(patchUrl).toContain('current_state=in.(task_created,sent,followup_sent,escalated,failed)');
      expect(JSON.parse(patchInit.body)).toEqual({
        current_state: 'confirmed',
        confirmed_at: confirmedTask.confirmed_at,
      });
      expect(patchInit.body).not.toContain('failure_reason');
    },
  );

  it('does nothing for an ordinary non-automation task', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    await expect(synchronizeAutomationRunFromConfirmedTask({ ...context, task: confirmedTask }))
      .resolves.toEqual({ synchronized: false, reason: 'not_an_automation_task' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails closed when more than one run matches the exact task and owner', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse([run('sent'), { ...run('sent'), id: 'run-2' }]));
    vi.stubGlobal('fetch', fetchMock);

    await expect(synchronizeAutomationRunFromConfirmedTask({ ...context, task: confirmedTask }))
      .resolves.toMatchObject({ synchronized: false, reason: 'multiple_matching_runs' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['skipped', 'confirmed', 'completed'])(
    'never overwrites protected state %s',
    async (state) => {
      const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse([run(state)]));
      vi.stubGlobal('fetch', fetchMock);

      const result = await synchronizeAutomationRunFromConfirmedTask({ ...context, task: confirmedTask });
      expect(result.synchronized).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    [{ ...confirmedTask, status: 'cancelled' }],
    [{ ...confirmedTask, confirmed_at: null }],
    [{ ...confirmedTask, user_id: null }],
  ])('does not query for a task that is not canonically confirmed', async (task) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(synchronizeAutomationRunFromConfirmedTask({ ...context, task }))
      .resolves.toEqual({ synchronized: false, reason: 'task_not_canonically_confirmed' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats a lost conditional-update race as an idempotent no-op', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([run('sent')]))
      .mockResolvedValueOnce(jsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    await expect(synchronizeAutomationRunFromConfirmedTask({ ...context, task: confirmedTask }))
      .resolves.toEqual({ synchronized: false, reason: 'concurrent_noop', runId: 'run-1' });
  });

  it('reloads only the exact owner task in a confirmed canonical state for repair', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([confirmedTask]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'confirmation-1', task_id: confirmedTask.id, confirmed_at: confirmedTask.confirmed_at }]));
    vi.stubGlobal('fetch', fetchMock);

    await expect(loadCanonicalConfirmedTask({
      ...context,
      taskId: confirmedTask.id,
      userId: confirmedTask.user_id,
    })).resolves.toEqual(confirmedTask);
    const url = fetchMock.mock.calls[0][0];
    expect(url).toContain('id=eq.task-1&user_id=eq.owner-1&status=eq.done&confirmed_at=not.is.null');
    expect(fetchMock.mock.calls[1][0]).toContain(
      `task_id=eq.task-1&confirmed_at=eq.${encodeURIComponent(confirmedTask.confirmed_at)}`,
    );
  });

  it('rejects done + confirmed_at when no canonical confirmation evidence exists', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([confirmedTask]))
      .mockResolvedValueOnce(jsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    await expect(loadCanonicalConfirmedTask({ ...context, taskId: 'task-1', userId: 'owner-1' }))
      .resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects wrong-task confirmation evidence by querying only the exact task', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([confirmedTask]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'confirmation-wrong', task_id: 'task-2', confirmed_at: confirmedTask.confirmed_at }]));
    vi.stubGlobal('fetch', fetchMock);

    await expect(loadCanonicalConfirmedTask({ ...context, taskId: 'task-1', userId: 'owner-1' }))
      .resolves.toBeNull();
    expect(fetchMock.mock.calls[1][0]).toContain('task_id=eq.task-1');
    expect(fetchMock.mock.calls[1][0]).not.toContain('task_id=eq.task-2');
  });

  it('rejects wrong-owner repair before consulting confirmation evidence', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    await expect(loadCanonicalConfirmedTask({ ...context, taskId: 'task-1', userId: 'wrong-owner' }))
      .resolves.toBeNull();
    expect(fetchMock.mock.calls[0][0]).toContain('id=eq.task-1&user_id=eq.wrong-owner');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([400, 500])('does not disguise a database %s error as an idempotent no-op', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({ message: 'database error' }, status)));
    await expect(synchronizeAutomationRunFromConfirmedTask({ ...context, task: confirmedTask }))
      .rejects.toThrow(`automation_run lookup failed (${status})`);
  });
});

function run(currentState) {
  return {
    id: 'run-1',
    task_id: confirmedTask.id,
    user_id: confirmedTask.user_id,
    current_state: currentState,
    confirmed_at: null,
    failure_reason: currentState === 'failed' ? 'prior transport failure' : null,
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  };
}
