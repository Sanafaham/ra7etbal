import { describe, expect, it } from 'vitest';

import { derivePersistedEscalationDecision } from './task-confirm.js';

describe('recipient-bound owner decision winner semantics', () => {
  const context = {
    reviewType: 'substitute_review',
    staffName: 'Christopher',
    staffContextText: 'Can I buy the alternative?',
  };

  it('derives approval only from the persisted first-write winner', () => {
    expect(derivePersistedEscalationDecision({ ...context, replyText: 'Yes buy it' }))
      .toBe('approved_alternative');
  });

  it('derives rejection only from the persisted first-write winner', () => {
    expect(derivePersistedEscalationDecision({ ...context, replyText: 'No' }))
      .toBe('rejected_alternative');
  });

  it('preserves a persisted custom instruction as custom', () => {
    expect(derivePersistedEscalationDecision({
      ...context,
      replyText: 'Buy the silver pack only.',
    })).toBe('custom_instruction');
  });

  it('recognizes the canonical stored approval and rejection text for staff questions', () => {
    const staffReview = { ...context, reviewType: 'staff_escalation' };
    expect(derivePersistedEscalationDecision({
      ...staffReview,
      replyText: 'Christopher, this was approved: "Can I buy the alternative?" — please go ahead.',
    })).toBe('approved');
    expect(derivePersistedEscalationDecision({
      ...staffReview,
      replyText: 'Christopher, this was not approved: "Can I buy the alternative?" — please hold off for now.',
    })).toBe('rejected');
  });
});
