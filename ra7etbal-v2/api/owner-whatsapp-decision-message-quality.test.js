import { describe, expect, it } from 'vitest';
import {
  MAX_ESCALATION_REASON_LENGTH,
  SYSTEM_PROMPT,
  normalizeEscalationReason,
  parseClassificationResponse,
} from './_staff-comms-engine.js';
import { buildEscalationMessage } from './_escalation-notify.js';

const REPLY_INSTRUCTION = 'Reply to this message with your decision.';

describe('owner WhatsApp decision message quality — protected contract', () => {
  const ownerReadyCases = [
    ['simple purchase', 'Christopher is asking for permission to buy two bottles of sparkling water for tonight.'],
    ['bouquet', 'Christopher is asking for permission to buy a small bouquet of flowers for the dining table tonight.'],
    ['substitution plus purchase', 'Christopher is asking whether to substitute red wine vinegar for the unavailable balsamic vinegar and buy a bottle.'],
    ['real ownership conflict', 'Christopher is asking to arrange the flower order himself, but flower orders are normally placed by Nasira. Should Christopher proceed?'],
    ['no material ownership conflict', 'Christopher is asking for permission to buy flowers for the dining table tonight.'],
    ['two genuine decisions', 'Christopher is asking whether to replace the salmon with sea bass and approve spending up to ₺2,000.'],
    ['irrelevant rules excluded', 'Christopher is asking for permission to buy two bottles of sparkling water.'],
    ['material purchase limit', 'Christopher is asking to buy the replacement appliance for ₺1,500, which exceeds his ₺1,000 purchase limit.'],
    ['invention prevention', 'Christopher is asking for permission to buy candles for the dining table tonight.'],
  ];

  it.each(ownerReadyCases)('%s produces the exact concise reply-first owner message', (_name, summary) => {
    const message = buildEscalationMessage('Christopher', summary);
    expect(message).toBe(`${summary} ${REPLY_INSTRUCTION}`);
    expect(message.split(REPLY_INSTRUCTION)).toHaveLength(2);
    expect(message).not.toMatch(/Visit Task|View Task|https?:\/\/|ra7etbal\.com/i);
  });

  it('bouquet and invention-prevention cases contain no source-absent people, items, tasks, or choices', () => {
    const bouquet = buildEscalationMessage('Christopher', ownerReadyCases[1][1]);
    expect(bouquet).not.toMatch(/Nasira|driver|reassign|arrange the flowers|guest safety/i);

    const candles = buildEscalationMessage('Christopher', ownerReadyCases[8][1]);
    expect(candles).not.toMatch(/Nasira|flowers|driver|alternative|guest safety/i);
  });

  it('normalizes Meta-unsafe whitespace for newly stored summaries', () => {
    const normalized = normalizeEscalationReason('  Christopher\tis asking\nfor permission to buy candles.  ');
    expect(normalized).not.toMatch(/[\r\n\t]/);
    expect(normalized).not.toMatch(/ {2}/);
    expect(normalized).toBe('Christopher is asking for permission to buy candles.');
  });

  it('rejects an over-limit reason rather than truncating a decision-critical constraint', () => {
    const padding = 'background detail '.repeat(35);
    const constraint = 'Do not serve it to guests.';
    const reason = `Christopher is asking for permission to buy candles. ${padding}${constraint}`;
    expect(reason.length).toBeGreaterThan(MAX_ESCALATION_REASON_LENGTH);
    expect(reason).toContain(constraint);
    expect(normalizeEscalationReason(reason)).toBeNull();
  });

  it('stores the normalized owner-ready wording returned by classification', () => {
    const outcome = parseClassificationResponse(JSON.stringify({
      classification: 'owner_decision_required',
      reply_to_staff: "I'm checking with the owner. I'll come back to you.",
      escalate: true,
      escalation_reason: ' Christopher is asking for permission to buy two bottles of sparkling water.\n',
      recommended_option: null,
      next_action_owner: 'owner',
      user_facing_state: 'Needs You',
      owner_attention_required: true,
    }));
    expect(outcome.escalationReason).toBe(
      'Christopher is asking for permission to buy two bottles of sparkling water.',
    );
  });

  it('preserves legacy stored wording on retries instead of regenerating it', () => {
    const legacy = 'Oven broken, needs a decision';
    expect(buildEscalationMessage('Christopher', legacy)).toBe(
      `Christopher needs your decision: ${legacy} ${REPLY_INSTRUCTION}`,
    );
    const namedLegacy = 'Christopher wants to buy the alternative. Decision needed: approve the purchase.';
    expect(buildEscalationMessage('Christopher', namedLegacy)).toBe(
      `Christopher needs your decision: ${namedLegacy} ${REPLY_INSTRUCTION}`,
    );
  });

  it('requires ambiguous requests to clarify with staff and never contact the owner', () => {
    const prompt = SYSTEM_PROMPT.toLowerCase();
    expect(prompt).toContain('classify it as unclear');
    expect(prompt).toContain('one focused clarification question');
    expect(prompt).toContain('do not escalate to the owner');
  });

  it('locks source fidelity, material-rule filtering, and owner-facing exclusions into the classifier contract', () => {
    const prompt = SYSTEM_PROMPT.toLowerCase();
    expect(prompt).toContain('smallest unresolved decision');
    expect(prompt).toContain('never introduce a person, item, task, responsibility, rule, or choice absent from the source evidence');
    expect(prompt).toContain('optional responsibilities, background memory, and unrelated household rules must never appear');
    expect(prompt).toContain('real blocking conflict');
    expect(prompt).toContain('no newline or tab characters');
    expect(prompt).toContain('no more than 500 characters');
    expect(prompt).toContain('must not contain a url, visit task, view task');
  });
});
