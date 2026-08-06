import { describe, expect, it } from 'vitest';

import { buildCanonicalStaffDecisionMessage } from './_staff-decision-message.js';

describe('buildCanonicalStaffDecisionMessage — exact canonical copy', () => {
  it.each(['approved', 'approved_alternative'])('%s → exact approval sentence', (decision) => {
    expect(buildCanonicalStaffDecisionMessage({ decision })).toBe('Approved. You can go ahead.');
  });

  it.each(['rejected', 'rejected_alternative'])('%s → exact rejection sentence, no reasoning', (decision) => {
    expect(buildCanonicalStaffDecisionMessage({ decision })).toBe(
      'Please wait. The owner did not approve this. You will receive further instructions shortly.',
    );
  });

  it('custom_instruction → "From the owner:" prefix plus the owner\'s exact words', () => {
    expect(buildCanonicalStaffDecisionMessage({
      decision: 'custom_instruction',
      instructionText: 'Buy the Turquoise instead.',
    })).toBe('From the owner: Buy the Turquoise instead.');
  });

  it('custom_instruction with empty/missing instructionText falls back to a generic instruction, never throws', () => {
    expect(buildCanonicalStaffDecisionMessage({ decision: 'custom_instruction', instructionText: '' }))
      .toBe('From the owner: please see instructions.');
    expect(buildCanonicalStaffDecisionMessage({ decision: 'custom_instruction' }))
      .toBe('From the owner: please see instructions.');
  });

  it('an unrecognized decision value falls through to the custom_instruction shape rather than throwing', () => {
    expect(buildCanonicalStaffDecisionMessage({ decision: 'something_unexpected', instructionText: 'x' }))
      .toBe('From the owner: x');
  });
});

describe('buildCanonicalStaffDecisionMessage — confirmation link, one canonical rule', () => {
  it('approved: link appended when provided', () => {
    const msg = buildCanonicalStaffDecisionMessage({
      decision: 'approved', confirmationUrl: 'https://app.ra7etbal.com/confirm?task=abc',
    });
    expect(msg).toBe('Approved. You can go ahead.\n\nhttps://app.ra7etbal.com/confirm?task=abc');
  });

  it('rejected: link appended when provided — no special-case suppression on rejection', () => {
    const msg = buildCanonicalStaffDecisionMessage({
      decision: 'rejected', confirmationUrl: 'https://app.ra7etbal.com/confirm?task=abc',
    });
    expect(msg).toContain('https://app.ra7etbal.com/confirm?task=abc');
  });

  it('rejected_alternative: link appended when provided — no special-case suppression on rejection', () => {
    const msg = buildCanonicalStaffDecisionMessage({
      decision: 'rejected_alternative', confirmationUrl: 'https://app.ra7etbal.com/confirm?task=abc',
    });
    expect(msg).toContain('https://app.ra7etbal.com/confirm?task=abc');
  });

  it('custom_instruction: link appended when provided', () => {
    const msg = buildCanonicalStaffDecisionMessage({
      decision: 'custom_instruction', instructionText: 'Wait until Friday.',
      confirmationUrl: 'https://app.ra7etbal.com/confirm?task=abc',
    });
    expect(msg).toBe('From the owner: Wait until Friday.\n\nhttps://app.ra7etbal.com/confirm?task=abc');
  });

  it('no link when confirmationUrl is null/omitted, for every decision type', () => {
    expect(buildCanonicalStaffDecisionMessage({ decision: 'approved' })).not.toContain('http');
    expect(buildCanonicalStaffDecisionMessage({ decision: 'rejected' })).not.toContain('http');
    expect(buildCanonicalStaffDecisionMessage({ decision: 'custom_instruction', instructionText: 'x' }))
      .not.toContain('http');
  });
});

describe('buildCanonicalStaffDecisionMessage — structurally cannot leak internal reasoning', () => {
  // Mutation-style: feed deliberately obvious internal-AI-reasoning text
  // through every channel this function accepts, and prove none of it can
  // reach the output except via the one legitimate channel (the owner's own
  // custom instructionText).
  const OBVIOUS_QI_TEXT =
    'QUALITY INTELLIGENCE ANALYSIS: confidence 0.42. Internal reasoning: the model believes this is a ' +
    'proposed substitute based on synthesized context and review notes, not yet verified.';

  it('QI-shaped text passed as instructionText on an approved decision never reaches output (approved ignores instructionText entirely)', () => {
    const msg = buildCanonicalStaffDecisionMessage({ decision: 'approved', instructionText: OBVIOUS_QI_TEXT });
    expect(msg).toBe('Approved. You can go ahead.');
    expect(msg).not.toContain('QUALITY INTELLIGENCE');
    expect(msg).not.toContain('confidence');
    expect(msg).not.toContain('reasoning');
    expect(msg).not.toContain('synthesized');
    expect(msg).not.toContain('proposed substitute');
  });

  it('QI-shaped text passed as instructionText on a rejected decision never reaches output (rejected ignores instructionText entirely)', () => {
    const msg = buildCanonicalStaffDecisionMessage({ decision: 'rejected', instructionText: OBVIOUS_QI_TEXT });
    expect(msg).toBe('Please wait. The owner did not approve this. You will receive further instructions shortly.');
    expect(msg).not.toContain('QUALITY INTELLIGENCE');
    expect(msg).not.toContain('review notes');
  });

  it('there is no parameter name this function accepts that is documented or used as a raw QI/review-note field', () => {
    // Exhaustive over the function's actual signature: decision,
    // instructionText, confirmationUrl. Passing QI text under any other key
    // is silently ignored — proving the function has no back door for it.
    const msg = buildCanonicalStaffDecisionMessage({
      decision: 'approved',
      quality_review_note: OBVIOUS_QI_TEXT,
      escalation_reason: OBVIOUS_QI_TEXT,
      reasoning: OBVIOUS_QI_TEXT,
      staffContextText: OBVIOUS_QI_TEXT,
    });
    expect(msg).toBe('Approved. You can go ahead.');
  });
});
