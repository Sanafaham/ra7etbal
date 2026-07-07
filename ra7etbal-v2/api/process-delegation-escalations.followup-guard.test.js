import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('web-push', () => ({
  default: {
    sendNotification: vi.fn(),
    setVapidDetails: vi.fn(),
  },
}));

import {
  claimFollowupGuard,
  getDelegationSkipReason,
  getQualityIntelligenceSchedulerBlockReason,
  processFollowupDueTask,
  releaseFollowupGuard,
} from './process-delegation-escalations.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// ── claimFollowupGuard: the atomic conditional-UPDATE lock ────────────────────
//
// Real duplicate prevention happens in Postgres: `UPDATE tasks SET
// followup_sent_at=$1 WHERE id=$2 AND followup_sent_at IS NULL` can only match
// a row once — Postgres serializes concurrent UPDATEs to the same row, so
// exactly one request's WHERE clause is still true when it runs. These tests
// simulate that server-side guarantee with an in-memory row and assert the
// client code (claimFollowupGuard) makes the correct claimed/not-claimed
// decision based on rows-returned, which is what the fix actually relies on.
describe('claimFollowupGuard', () => {
  it('claims the guard when followup_sent_at is still null (PATCH matches, 1 row returned)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse([{ id: 'task-1', followup_sent_at: '2026-07-02T02:08:12.000Z' }]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const claimed = await claimFollowupGuard('https://example.supabase.co', 'service-key', 'task-1', '2026-07-02T02:08:12.000Z');

    expect(claimed).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/rest/v1/tasks?id=eq.task-1&followup_sent_at=is.null');
    expect(init.method).toBe('PATCH');
    expect(init.headers.Prefer).toBe('return=representation');
    expect(JSON.parse(init.body)).toEqual({ followup_sent_at: '2026-07-02T02:08:12.000Z' });
  });

  it('does not claim the guard when followup_sent_at is already set (PATCH matches 0 rows)', async () => {
    // This is what a concurrent/overlapping invocation observes: the
    // conditional WHERE clause no longer matches because another request
    // already flipped the column, so PostgREST returns an empty array.
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    const claimed = await claimFollowupGuard('https://example.supabase.co', 'service-key', 'task-1', '2026-07-02T02:08:12.000Z');

    expect(claimed).toBe(false);
  });

  it('treats a failed PATCH request as not-claimed (fails closed, never sends)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ message: 'boom' }, 500));
    vi.stubGlobal('fetch', fetchMock);

    const claimed = await claimFollowupGuard('https://example.supabase.co', 'service-key', 'task-1', '2026-07-02T02:08:12.000Z');

    expect(claimed).toBe(false);
  });
});

describe('releaseFollowupGuard', () => {
  it('clears followup_sent_at back to null so a later run can retry', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(emptyResponse());
    vi.stubGlobal('fetch', fetchMock);

    await releaseFollowupGuard('https://example.supabase.co', 'service-key', 'task-1');

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://example.supabase.co/rest/v1/tasks?id=eq.task-1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ followup_sent_at: null });
  });
});

// ── processFollowupDueTask under concurrent execution ──────────────────────
//
// This is the direct proof requested: simulate two overlapping scheduler
// invocations (e.g. the per-task QStash follow-up message racing the periodic
// sweep) both discovering the SAME due task and both calling
// processFollowupDueTask at "the same time" (Promise.all). A single shared
// in-memory task row stands in for the real Postgres row; its conditional
// check-and-set models the atomic UPDATE the fix relies on. Only one of the
// two concurrent calls may reach sendFollowupWhatsApp (i.e. only one WhatsApp
// send may occur) — this is exactly the bug that produced 3-4 duplicate
// follow-ups per task in production (whatsapp_deliveries evidence: task
// f2c557c0 received 4 independent follow-up sends within ~0.6s, each with a
// distinct meta_message_id, after followup_sent_at had already been stamped).
describe('processFollowupDueTask — concurrent scheduler executions', () => {
  function sharedTaskRow(overrides = {}) {
    return {
      id: 'task-1',
      user_id: 'user-1',
      assigned_to: 'Christopher',
      description: 'Prepare dinner at home at 9:00 PM tomorrow.',
      confirmation_url: 'https://ra7etbal.com/confirm/task-1',
      status: 'pending',
      followup_sent_at: null,
      ...overrides,
    };
  }

  /**
   * Builds a fetch mock backed by a single mutable `row` object. The claim
   * PATCH (`followup_sent_at=is.null`) performs a synchronous check-and-set
   * against `row.followup_sent_at` before returning — this is the stand-in
   * for Postgres's atomic row-level UPDATE. All other calls needed by
   * sendFollowupWhatsApp (people lookup, profile lookup, WhatsApp send) are
   * also handled so the full path can run for whichever call wins the claim.
   */
  function makeSharedFetchMock(row, { sendOk = true } = {}) {
    return vi.fn(async (url, init = {}) => {
      const u = String(url);
      const method = init.method || 'GET';

      if (u.includes('/rest/v1/tasks') && method === 'PATCH' && u.includes('followup_sent_at=is.null')) {
        // Atomic claim: only succeeds while row.followup_sent_at is still null.
        if (row.followup_sent_at === null) {
          row.followup_sent_at = JSON.parse(init.body).followup_sent_at;
          return jsonResponse([{ id: row.id, followup_sent_at: row.followup_sent_at }]);
        }
        return jsonResponse([]);
      }

      if (u.includes('/rest/v1/tasks') && method === 'PATCH') {
        // releaseFollowupGuard (unconditional) — used only on send failure.
        row.followup_sent_at = JSON.parse(init.body).followup_sent_at;
        return emptyResponse();
      }

      if (u.includes('/rest/v1/people')) {
        return jsonResponse([{ name: 'Christopher', phone: '+971500000001' }]);
      }
      if (u.includes('/rest/v1/profiles')) {
        return jsonResponse([{ display_name: 'Sana' }]);
      }
      if (u.includes('/api/send-whatsapp-task')) {
        return sendOk
          ? jsonResponse({ success: true, messageId: 'wamid.1' })
          : jsonResponse({ success: false, errorMessage: 'Meta rejected the message' }, 400);
      }

      throw new Error(`Unexpected fetch in test: ${method} ${u}`);
    });
  }

  it('sends the WhatsApp follow-up exactly once when two invocations race the same task', async () => {
    const row = sharedTaskRow();
    const fetchMock = makeSharedFetchMock(row);
    vi.stubGlobal('fetch', fetchMock);

    const ctx = {
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      appBaseUrl: 'https://ra7etbal.com',
      testMode: false,
      now: new Date('2026-07-02T02:08:12.000Z'),
    };

    // Two "concurrent scheduler executions" — e.g. the per-task QStash
    // follow-up trigger and an overlapping periodic sweep — both discover the
    // same due task and both attempt to process its follow-up at once.
    const [resultA, resultB] = await Promise.all([
      processFollowupDueTask(sharedTaskRow(), ctx),
      processFollowupDueTask(sharedTaskRow(), ctx),
    ]);

    const results = [resultA, resultB];
    const claimedCount = results.filter((r) => r.claimed).length;
    const sentCount = results.filter((r) => r.sent).length;

    expect(claimedCount).toBe(1);
    expect(sentCount).toBe(1);

    // The decisive assertion: exactly one WhatsApp send reached Meta, no
    // matter how many overlapping invocations tried to process this task.
    const sendCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes('/api/send-whatsapp-task'));
    expect(sendCalls).toHaveLength(1);

    expect(row.followup_sent_at).toBe('2026-07-02T02:08:12.000Z');
  });

  it('sends exactly once across four overlapping invocations (matches the observed 3-4x production duplication)', async () => {
    const row = sharedTaskRow();
    const fetchMock = makeSharedFetchMock(row);
    vi.stubGlobal('fetch', fetchMock);

    const ctx = {
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      appBaseUrl: 'https://ra7etbal.com',
      testMode: false,
      now: new Date('2026-07-02T02:08:12.000Z'),
    };

    const results = await Promise.all(
      Array.from({ length: 4 }, () => processFollowupDueTask(sharedTaskRow(), ctx)),
    );

    expect(results.filter((r) => r.claimed).length).toBe(1);
    expect(results.filter((r) => r.sent).length).toBe(1);

    const sendCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes('/api/send-whatsapp-task'));
    expect(sendCalls).toHaveLength(1);
  });

  // Named explicitly for the production incident this fix resolves, so a
  // future reader cannot mistake its purpose or safely remove it.
  //
  // Real incident (2026-07-01/02, task f2c557c0-8343-42c0-8fb2-e91eeb9226b1,
  // recipient Christopher): a guest-prep plan created 4 delegation tasks
  // together. api/qstash-reminder.js schedules a PER-TASK QStash follow-up
  // message for each one (notBefore = created + 10 min). Separately, this
  // endpoint is also invoked by a PERIODIC 10-minute QStash cron that
  // processes every due task in one batch. Both trigger sources landed in
  // the same ~10-minute window, producing overlapping invocations that each
  // independently decided Christopher's task was due and each sent — 4
  // independent WhatsApp sends within 0.6s. This test models exactly that:
  // one call standing in for the per-task trigger, one for the periodic
  // sweep, both racing the SAME task at once.
  it('reproduces the exact Christopher/f2c557c0 incident shape: per-task QStash trigger racing the periodic sweep sends exactly once', async () => {
    const row = sharedTaskRow({ id: 'f2c557c0', assigned_to: 'Christopher' });
    const fetchMock = makeSharedFetchMock(row);
    vi.stubGlobal('fetch', fetchMock);

    const ctx = {
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      appBaseUrl: 'https://ra7etbal.com',
      testMode: false,
      now: new Date('2026-07-02T02:08:15.000Z'),
    };

    const perTaskQstashTrigger = processFollowupDueTask(
      sharedTaskRow({ id: 'f2c557c0', assigned_to: 'Christopher' }),
      ctx,
    );
    const periodicSweep = processFollowupDueTask(
      sharedTaskRow({ id: 'f2c557c0', assigned_to: 'Christopher' }),
      ctx,
    );

    const [triggerResult, sweepResult] = await Promise.all([perTaskQstashTrigger, periodicSweep]);

    // Exactly one of the two trigger sources actually claims and sends —
    // never both, regardless of which one "wins" the race.
    const winners = [triggerResult, sweepResult].filter((r) => r.sent);
    expect(winners).toHaveLength(1);

    const sendCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes('/api/send-whatsapp-task'));
    expect(sendCalls).toHaveLength(1);
    expect(row.followup_sent_at).toBe('2026-07-02T02:08:15.000Z');
  });

  it('releases the claim on send failure so a later run can retry (preserves existing retry behavior)', async () => {
    const row = sharedTaskRow();
    const fetchMock = makeSharedFetchMock(row, { sendOk: false });
    vi.stubGlobal('fetch', fetchMock);

    const ctx = {
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      appBaseUrl: 'https://ra7etbal.com',
      testMode: false,
      now: new Date('2026-07-02T02:08:12.000Z'),
    };

    const result = await processFollowupDueTask(sharedTaskRow(), ctx);

    expect(result.claimed).toBe(true);
    expect(result.sent).toBe(false);
    // Guard was released — a subsequent scheduler run will see NULL again and
    // may legitimately retry, matching the pre-fix behavior for failures.
    expect(row.followup_sent_at).toBeNull();
  });

  it('a second invocation cannot claim (and cannot send) once the first has claimed but before it finishes sending', async () => {
    const row = sharedTaskRow();
    const fetchMock = makeSharedFetchMock(row);
    vi.stubGlobal('fetch', fetchMock);

    const claimedFirst = await claimFollowupGuard('https://example.supabase.co', 'service-key', row.id, '2026-07-02T02:08:12.000Z');
    expect(claimedFirst).toBe(true);

    // A second, overlapping invocation attempts the same task after the first
    // has claimed but potentially before send-whatsapp-task has resolved.
    const claimedSecond = await claimFollowupGuard('https://example.supabase.co', 'service-key', row.id, '2026-07-02T02:08:12.100Z');
    expect(claimedSecond).toBe(false);
  });

  it('QI proof submitted blocks direct worker follow-up before claiming the guard', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await processFollowupDueTask(
      sharedTaskRow({
        proof_image_path: 'task-images/user-1/task-1/proof/0.jpg',
        quality_review_status: 'uncertain',
      }),
      {
        supabaseUrl: 'https://example.supabase.co',
        serviceKey: 'service-key',
        appBaseUrl: 'https://ra7etbal.com',
        testMode: false,
        now: new Date('2026-07-02T02:08:12.000Z'),
      },
    );

    expect(result).toEqual({ claimed: false, sent: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Quality Intelligence scheduler eligibility', () => {
  function pendingDelegation(overrides = {}) {
    return {
      id: 'task-1',
      user_id: 'user-1',
      description: 'Bring the pizza.',
      type: 'delegation',
      assigned_to: 'Christopher',
      status: 'pending',
      needs_follow_up: true,
      confirmation_url: 'https://ra7etbal.com/confirm/task-1',
      followup_sent_at: null,
      escalated_at: null,
      image_path: null,
      attachment_count: 0,
      proof_image_path: null,
      quality_review_status: null,
      ...overrides,
    };
  }

  it('QI proof submitted blocks worker follow-up and owner escalation eligibility', () => {
    const task = pendingDelegation({
      image_path: 'task-images/user-1/task-1/photo.jpg',
      proof_image_path: 'task-images/user-1/task-1/proof/0.jpg',
      quality_review_status: 'uncertain',
    });

    expect(getQualityIntelligenceSchedulerBlockReason(task)).toBe('quality review uncertain');
    expect(getDelegationSkipReason(task)).toBe('quality review uncertain');
  });

  it('QI rejected proof stays out of generic scheduler follow-up', () => {
    const task = pendingDelegation({
      image_path: 'task-images/user-1/task-1/photo.jpg',
      proof_image_path: 'task-images/user-1/task-1/proof/0.jpg',
      quality_review_status: 'correction_required',
    });

    expect(getDelegationSkipReason(task)).toBe('quality review correction_required');
  });

  it('unknown proof status does not enter generic scheduler follow-up path', () => {
    const task = pendingDelegation({
      proof_image_path: 'task-images/user-1/task-1/proof/0.jpg',
      quality_review_status: 'needs_human_review',
    });

    expect(getDelegationSkipReason(task)).toBe('quality review needs_human_review');
  });

  it('missing proof status with a submitted proof does not create a wrong owner escalation', () => {
    const task = pendingDelegation({
      proof_image_path: 'task-images/user-1/task-1/proof/0.jpg',
      quality_review_status: null,
    });

    expect(getDelegationSkipReason(task)).toBe('quality review proof submitted');
  });

  it('QI accepted proof is blocked by canonical done status', () => {
    expect(getDelegationSkipReason(pendingDelegation({
      status: 'done',
      proof_image_path: 'task-images/user-1/task-1/proof/0.jpg',
      quality_review_status: 'approved',
    }))).toBe('status is done');
  });

  it('normal pending non-QI delegation remains eligible for follow-up and owner escalation', () => {
    expect(getDelegationSkipReason(pendingDelegation())).toBeNull();
  });

  it('normal confirmed non-QI delegation receives no follow-up and no owner escalation', () => {
    expect(getDelegationSkipReason(pendingDelegation({ status: 'done' }))).toBe('status is done');
  });
});

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function emptyResponse(status = 204) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => null,
    text: async () => '',
  };
}
