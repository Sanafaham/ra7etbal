import { afterEach, describe, expect, it, vi } from 'vitest';

// sendProofImageMessage does its own multi-step raw-fetch image
// download/Meta-upload/send (byte-level, form-data) that is already its
// own concern, not this module's — everything else in this file exercises
// real send-whatsapp-task.js functions (sendMetaMessage,
// buildDirectMessagePayload, normalizeWhatsAppPhone) unmocked, same as
// before this addition.
const sendProofImageMessageMock = vi.hoisted(() => vi.fn(async () => ({ sent: true, messageId: 'wamid.image-mock' })));
vi.mock('./send-whatsapp-task.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, sendProofImageMessage: sendProofImageMessageMock };
});

import { notifyOwnerOfTaskReview, notifyOwnerOfEscalation, buildTaskReviewMessage } from './_escalation-notify.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  sendProofImageMessageMock.mockClear();
  sendProofImageMessageMock.mockResolvedValue({ sent: true, messageId: 'wamid.image-mock' });
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

// ── Pre-action substitution proposal photo threading ────────────────────────
//
// Follow-up to the substitute-approval production failure (2026-08-26,
// Christopher/TEREA Silver -> Turquoise): a pre-action proposal with a
// photo now reaches notifyOwnerOfEscalation (not the completion-proof
// pipeline). This proves the photo is (a) persisted durably via
// claim_escalation_owner_decision's new p_proposed_photo_path parameter,
// and (b) sent to the owner over WhatsApp, mirroring
// notifyOwnerOfTaskReview's already-proven proofImagePath pattern -- never
// invented, reused.

function dispatchByUrl(handlers, fallback = jsonResponse({})) {
  return vi.fn(async (url, options = {}) => {
    const requestUrl = String(url);
    for (const [pattern, handler] of handlers) {
      if (requestUrl.includes(pattern)) return handler(requestUrl, options);
    }
    return fallback;
  });
}

describe('notifyOwnerOfEscalation — pre-action substitution proposal photo', () => {
  it('persists proposedPhotoPath on claim_escalation_owner_decision and sends it to the owner over WhatsApp', async () => {
    const calls = [];
    const fetchMock = dispatchByUrl([
      ['/rpc/claim_owner_escalation_notification', () => jsonResponse({ claimed: true, claim_token: 'claim-1' })],
      ['/rpc/claim_escalation_owner_decision', (u, o) => {
        calls.push({ kind: 'claim_escalation_owner_decision', body: JSON.parse(o.body) });
        return jsonResponse({ id: 'esc-photo-1', deep_link_token: 'token-1' });
      }],
      ['/rest/v1/people?', () => jsonResponse([{ name: 'Sana', role: 'boss', phone: '+15551234567' }])],
      ['/v20.0/', (u, o) => {
        const body = o.body ? JSON.parse(o.body) : {};
        calls.push({ kind: 'meta_message', type: body.type });
        return jsonResponse({ messages: [{ id: `wamid.${body.type}` }] });
      }],
      ['/rpc/complete_owner_escalation_notification', () => jsonResponse({ owner_notified_at: '2026-08-26T00:00:00Z' })],
      ['/whatsapp_deliveries', () => jsonResponse([{ id: 'delivery-1' }])],
      ['/rpc/', () => jsonResponse({})],
    ]);

    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('WHATSAPP_ACCESS_TOKEN', 'meta-access-token');
    vi.stubEnv('WHATSAPP_PHONE_NUMBER_ID', 'meta-phone-id');
    const result = await notifyOwnerOfEscalation(
      {
        staffMessageId: 'staff-msg-1',
        userId: 'user-1',
        taskId: 'task-1',
        escalationReason: 'Christopher is asking whether to substitute TEREA Turquoise for TEREA Silver.',
        staffName: 'Christopher',
        proposedPhotoPath: 'task-images/user-1/task-1/proposal/whatsapp-msg1.jpg',
      },
      { supabaseUrl: 'https://example.supabase.co', serviceKey: 'service-key', fetchImpl: fetchMock },
    );

    expect(result.status).toBe('sent');
    const claim = calls.find((c) => c.kind === 'claim_escalation_owner_decision');
    expect(claim.body).toMatchObject({
      p_staff_message_id: 'staff-msg-1',
      p_user_id: 'user-1',
      p_task_id: 'task-1',
      p_proposed_photo_path: 'task-images/user-1/task-1/proposal/whatsapp-msg1.jpg',
    });

    // The photo is sent via the same proven helper notifyOwnerOfTaskReview
    // uses — never a reinvented image-send path.
    expect(sendProofImageMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({ imagePath: 'task-images/user-1/task-1/proposal/whatsapp-msg1.jpg' }),
    );
  });

  it('never blocks or fails the notification when proposedPhotoPath is absent — text-only escalation is unaffected', async () => {
    const fetchMock = dispatchByUrl([
      ['/rpc/claim_owner_escalation_notification', () => jsonResponse({ claimed: true, claim_token: 'claim-2' })],
      ['/rpc/claim_escalation_owner_decision', (u, o) => {
        const body = JSON.parse(o.body);
        expect(body.p_proposed_photo_path).toBeNull();
        return jsonResponse({ id: 'esc-text-1', deep_link_token: 'token-2' });
      }],
      ['/rest/v1/people?', () => jsonResponse([{ name: 'Sana', role: 'boss', phone: '+15551234567' }])],
      ['/v20.0/', (u, o) => jsonResponse({ messages: [{ id: 'wamid.text' }] })],
      ['/rpc/complete_owner_escalation_notification', () => jsonResponse({ owner_notified_at: '2026-08-26T00:00:00Z' })],
      ['/whatsapp_deliveries', () => jsonResponse([{ id: 'delivery-2' }])],
    ]);
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('WHATSAPP_ACCESS_TOKEN', 'meta-access-token');
    vi.stubEnv('WHATSAPP_PHONE_NUMBER_ID', 'meta-phone-id');

    const result = await notifyOwnerOfEscalation(
      {
        staffMessageId: 'staff-msg-2',
        userId: 'user-1',
        taskId: 'task-2',
        escalationReason: 'Christopher is asking for permission to leave early.',
        staffName: 'Christopher',
        proposedPhotoPath: null,
      },
      { supabaseUrl: 'https://example.supabase.co', serviceKey: 'service-key', fetchImpl: fetchMock },
    );

    expect(result.status).toBe('sent');
    // No image-send call for a text-only escalation.
    expect(sendProofImageMessageMock).not.toHaveBeenCalled();
  });
});

// ── Owner notification composition — word-safe, non-duplicated (Repair #5) ──
//
// Confirmed production defect: buildTaskReviewMessage hard-truncates
// taskDescription at 80 chars and reviewNote at 120 chars via .slice(),
// with no word-boundary awareness. Combined with PR #344's
// buildPreActionSubstituteReviewNote (task-confirm.js), which produces a
// substitute_review note that (a) restates the task description inside
// itself ("...substitute for: <task>...") and (b) puts the assignee's
// actual question near the end, a real note routinely exceeds 120 chars
// and gets cut mid-word, and the task name is duplicated (once in the
// outer template's `"<task>"` quote, once again inside the note).
describe('buildTaskReviewMessage — word-safe, non-duplicated composition', () => {
  const task = 'Buy one packet of TEREA Silver';
  // Realistic long substitute-review note, shaped exactly like
  // buildPreActionSubstituteReviewNote's real output (task-confirm.js,
  // PR #344) -- boilerplate framing first, the assignee's actual question
  // buried after it, past the old 120-char cutoff.
  const longNote =
    'Christopher is asking for approval before buying a substitute for: ' +
    'Buy one packet of TEREA Silver. Their note: "I only found TEREA ' +
    'Turquoise at the store, is it ok if I get that instead of Silver ' +
    'please let me know soon" No purchase has been made yet -- please ' +
    'review and approve or reject the alternative.';

  it('never cuts a word in half', () => {
    const message = buildTaskReviewMessage({
      reviewType: 'substitute_review',
      taskDescription: task,
      assignedTo: 'Christopher',
      reviewNote: longNote,
    });

    // The specific malformed run-on from the real production defect
    // ("...I only f Reply to approve...") must not appear -- this fails
    // against the current .slice(0,120) implementation (which cuts
    // "found" to "f" mid-word) and passes once truncation is word-safe.
    expect(message).not.toMatch(/\bf Reply\b/);
    expect(message).not.toMatch(/[a-z]{1,3} [A-Z][a-z]+ to approve/);
    // The note is short enough to need no shortening at all once the
    // task-quote duplication is removed -- it survives completely intact.
    expect(message).toContain(longNote);
  });

  it('does not repeat the task description -- the item name appears exactly once', () => {
    const message = buildTaskReviewMessage({
      reviewType: 'substitute_review',
      taskDescription: task,
      assignedTo: 'Christopher',
      reviewNote: longNote,
    });

    expect(message.match(/TEREA Silver/g) || []).toHaveLength(1);
  });

  it('preserves the assignee\'s actual question -- the decision context survives shortening', () => {
    const message = buildTaskReviewMessage({
      reviewType: 'substitute_review',
      taskDescription: task,
      assignedTo: 'Christopher',
      reviewNote: longNote,
    });

    expect(message).toContain('Christopher');
    expect(message).toMatch(/is it ok if I get that instead of Silver/);
    expect(message).toMatch(/approve|reject/i);
  });

  it('still shortens a genuinely excessive note, but only at a word boundary', () => {
    const veryLongNote = `${longNote} ${'Extra context that keeps going on and on. '.repeat(10)}`;
    const message = buildTaskReviewMessage({
      reviewType: 'substitute_review',
      taskDescription: task,
      assignedTo: 'Christopher',
      reviewNote: veryLongNote,
    });

    expect(message.length).toBeLessThan(veryLongNote.length + task.length);
    // Whatever the shortening point is, it must land after a complete word
    // (immediately preceded by a space or start of string, and the last
    // character kept is not a letter cut off mid-token followed directly
    // by more letters elsewhere in the sentence).
    expect(message).not.toMatch(/[a-zA-Z]-?$/m);
  });

  it('non-substitute review types are unaffected -- unrelated escalation behavior unchanged', () => {
    const message = buildTaskReviewMessage({
      reviewType: 'uncertain_proof',
      taskDescription: task,
      assignedTo: 'Christopher',
      reviewNote: null,
    });

    expect(message).toBe(
      `The proof for "${task}" needs your review. Reply Yes to mark it done, or No to request a correction from Christopher.`,
    );
  });

  it('flows through to the real Meta template payload unmangled', async () => {
    const calls = [];
    const fetchMock = dispatchByUrl([
      ['/rest/v1/people?', () =>
        jsonResponse([
          { id: 'person-christopher', name: 'Christopher', role: 'staff', phone: '+15557654321' },
          { name: 'Sana', role: 'boss', phone: '+15551234567' },
        ]),
      ],
      ['/rpc/claim_task_escalation_owner_decision', () => jsonResponse({ id: 'esc-note-long', deep_link_token: 'token-long' })],
      ['/rpc/claim_task_review_owner_notification', () => jsonResponse({ claimed: true, claim_token: 'claim-long' })],
      ['/rest/v1/tasks', () => jsonResponse([{ id: 'task-long-note', user_id: 'user-1' }])],
      ['/v20.0/', (u, o) => {
        const body = JSON.parse(o.body);
        calls.push(body);
        return jsonResponse({ messages: [{ id: 'wamid.long-note' }] });
      }],
      ['/whatsapp_deliveries', () => jsonResponse([{ id: 'delivery-long' }])],
      ['/rpc/', () => jsonResponse({})],
    ]);
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('WHATSAPP_ACCESS_TOKEN', 'meta-access-token');
    vi.stubEnv('WHATSAPP_PHONE_NUMBER_ID', 'meta-phone-id');

    const result = await notifyOwnerOfTaskReview(
      {
        taskId: 'task-long-note',
        userId: 'user-1',
        reviewType: 'substitute_review',
        taskDescription: task,
        assignedTo: 'Christopher',
        reviewNote: longNote,
      },
      { supabaseUrl: 'https://example.supabase.co', serviceKey: 'service-key', fetchImpl: fetchMock },
    );

    expect(result.status).toBe('sent');
    const sentText = calls[0]?.template?.components?.[0]?.parameters?.[1]?.text;
    expect(sentText).toBeTruthy();
    expect(sentText).not.toMatch(/\bf Reply\b/);
    expect(sentText.match(/TEREA Silver/g) || []).toHaveLength(1);
    expect(sentText).toMatch(/is it ok if I get that instead of Silver/);
  });
});
