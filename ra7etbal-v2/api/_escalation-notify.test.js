import { afterEach, describe, expect, it, vi } from 'vitest';
import { notifyOwnerOfTaskReview } from './_escalation-notify.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  };
}

// ── Durable person attribution for task-based owner-decision rows ──────────
//
// claim_task_escalation_owner_decision (uncertain_proof/substitute_review/
// correction_limit) never resolved a person identity before this fix --
// the exact "Approve it" row that motivated it has person_id NULL and can
// never be recovered, because no call path ever had a Person.id available.
// This threads a resolved person_id in going forward, from the same
// userId/assignedTo notifyOwnerOfTaskReview already receives -- no new
// identity input, just an added exact-match lookup mirroring the shape
// already trusted elsewhere in this codebase (task-confirm.js's
// findAssigneePerson).

describe('notifyOwnerOfTaskReview — durable person_id resolution', () => {
  it('resolves assignedTo to a real people.id and passes it to claim_task_escalation_owner_decision', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'person-christopher', name: 'Christopher' }])) // people lookup
      .mockResolvedValueOnce(jsonResponse([{ id: 'esc-1' }])); // claim_task_escalation_owner_decision
    vi.stubGlobal('fetch', fetchMock);

    await notifyOwnerOfTaskReview(
      {
        taskId: 'task-1',
        userId: 'user-1',
        reviewType: 'substitute_review',
        assignedTo: 'Christopher',
      },
      { supabaseUrl: 'https://example.supabase.co', serviceKey: 'service-key', fetchImpl: fetchMock },
    );

    const peopleLookupUrl = fetchMock.mock.calls[0][0];
    expect(peopleLookupUrl).toContain('/rest/v1/people');
    expect(peopleLookupUrl).toContain('user_id=eq.user-1');

    const claimBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(claimBody).toMatchObject({
      p_task_id: 'task-1',
      p_user_id: 'user-1',
      p_review_type: 'substitute_review',
      p_person_id: 'person-christopher',
    });
  });

  it('leaves person_id null when assignedTo does not match exactly one person', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([])) // no matching person
      .mockResolvedValueOnce(jsonResponse([{ id: 'esc-2' }]));
    vi.stubGlobal('fetch', fetchMock);

    await notifyOwnerOfTaskReview(
      {
        taskId: 'task-2',
        userId: 'user-1',
        reviewType: 'uncertain_proof',
        assignedTo: 'Someone New',
      },
      { supabaseUrl: 'https://example.supabase.co', serviceKey: 'service-key', fetchImpl: fetchMock },
    );

    const claimBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(claimBody.p_person_id).toBeNull();
  });

  it('leaves person_id null rather than guessing when more than one person shares the name — no heuristic backfill', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([
          { id: 'person-a', name: 'Christopher' },
          { id: 'person-b', name: 'Christopher' },
        ]),
      )
      .mockResolvedValueOnce(jsonResponse([{ id: 'esc-3' }]));
    vi.stubGlobal('fetch', fetchMock);

    await notifyOwnerOfTaskReview(
      {
        taskId: 'task-3',
        userId: 'user-1',
        reviewType: 'substitute_review',
        assignedTo: 'Christopher',
      },
      { supabaseUrl: 'https://example.supabase.co', serviceKey: 'service-key', fetchImpl: fetchMock },
    );

    const claimBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(claimBody.p_person_id).toBeNull();
  });

  it('leaves person_id null (does not block the claim) when the people lookup itself fails', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([], 500)) // people lookup fails
      .mockResolvedValueOnce(jsonResponse([{ id: 'esc-4' }])); // claim still proceeds
    vi.stubGlobal('fetch', fetchMock);

    await notifyOwnerOfTaskReview(
      {
        taskId: 'task-4',
        userId: 'user-1',
        reviewType: 'correction_limit',
        assignedTo: 'Christopher',
      },
      { supabaseUrl: 'https://example.supabase.co', serviceKey: 'service-key', fetchImpl: fetchMock },
    );

    // The claim call still happens (person resolution failing is non-fatal),
    // just with person_id null instead of guessed.
    const claimBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(claimBody.p_task_id).toBe('task-4');
    expect(claimBody.p_person_id).toBeNull();
  });

  it('does not attempt person resolution when assignedTo is missing — the claim call is the first fetch, not a people lookup', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse([{ id: 'esc-5' }]));
    vi.stubGlobal('fetch', fetchMock);

    await notifyOwnerOfTaskReview(
      {
        taskId: 'task-5',
        userId: 'user-1',
        reviewType: 'substitute_review',
        assignedTo: null,
      },
      { supabaseUrl: 'https://example.supabase.co', serviceKey: 'service-key', fetchImpl: fetchMock },
    );

    // No people-lookup call precedes the claim — the very first fetch call
    // is the claim RPC itself, with person_id already null.
    expect(fetchMock.mock.calls[0][0]).toContain('/rest/v1/rpc/claim_task_escalation_owner_decision');
    const claimBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(claimBody.p_person_id).toBeNull();
  });
});
