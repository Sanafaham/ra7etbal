import { describe, expect, it } from 'vitest';
import { classifyOwnerWhatsAppIntent, isExecutionDomain } from './_carson-intent-classifier.js';

// ── Execution domains ─────────────────────────────────────────────────────────

describe('classifyOwnerWhatsAppIntent — reminder domain', () => {
  it.each([
    'Remind me to call the bank.',
    'remind me tomorrow at 9am to pay the bill',
    'Remind me at 6pm today.',
    "Don't let me forget to buy milk.",
    'Set a reminder for 8am.',
    'Alert me at 7pm to check the pool.',
    'Remember to call Ahmed.',
  ])('"%s" → reminder', (text) => {
    const r = classifyOwnerWhatsAppIntent(text);
    expect(r.primary_domain).toBe('reminder');
    expect(r.isExecutionDomain).toBe(true);
  });
});

describe('classifyOwnerWhatsAppIntent — delegation/whatsapp execution domains', () => {
  it.each([
    ['Tell Christopher to clean the kitchen.', 'delegation'],
    ['Ask Grace to prepare lunch.', 'delegation'],
    ['tell ahmed to buy milk', 'delegation'],
    ['Send Christopher a message.', 'whatsapp'],
    ['Text Grace saying hi.', 'whatsapp'],
    ['WhatsApp Ahmed now.', 'whatsapp'],
  ])('"%s" → %s (execution)', (text, expectedDomain) => {
    const r = classifyOwnerWhatsAppIntent(text);
    expect(r.primary_domain).toBe(expectedDomain);
    expect(r.isExecutionDomain).toBe(true);
  });
});

// ── Conversational domains ────────────────────────────────────────────────────

describe('classifyOwnerWhatsAppIntent — social_ack (conversational)', () => {
  it.each([
    'Hi',
    'Hi Carson',
    'Hello',
    'Hey',
    'Good morning',
    'Good evening',
    'Thanks',
    'Thank you',
    'ok',
    'Okay',
    'Got it',
    'Perfect',
    'Great',
    'Noted',
  ])('"%s" → social_ack', (text) => {
    const r = classifyOwnerWhatsAppIntent(text);
    expect(r.primary_domain).toBe('social_ack');
    expect(r.isExecutionDomain).toBe(false);
  });
});

describe('classifyOwnerWhatsAppIntent — question/general_answer (conversational)', () => {
  it.each([
    'What still needs my attention?',
    'Did Christopher reply?',
    'Has Grace confirmed?',
    'Is the task done?',
    'How many tasks are pending?',
    'What happened with the delegation?',
    'Did Ahmed get the message?',
    'What is the status?',
    'Can you check on it?',
    'Are there any pending items?',
  ])('"%s" → general_answer', (text) => {
    const r = classifyOwnerWhatsAppIntent(text);
    expect(r.primary_domain).toBe('general_answer');
    expect(r.isExecutionDomain).toBe(false);
  });
});

describe('classifyOwnerWhatsAppIntent — calendar (conversational)', () => {
  it.each([
    "What's on my calendar?",
    'What do I have today?',
    'Schedule a meeting tomorrow at 10am.',
    'Add a call to my schedule.',
  ])('"%s" → calendar', (text) => {
    const r = classifyOwnerWhatsAppIntent(text);
    expect(r.primary_domain).toBe('calendar');
    expect(r.isExecutionDomain).toBe(false);
  });
});

describe('classifyOwnerWhatsAppIntent — memory (conversational)', () => {
  it.each([
    'Remember that Christopher prefers morning tasks.',
    'From now on, always send Grace the task by 8am.',
    'I prefer tasks to be sent in the morning.',
  ])('"%s" → memory', (text) => {
    const r = classifyOwnerWhatsAppIntent(text);
    expect(r.primary_domain).toBe('memory');
    expect(r.isExecutionDomain).toBe(false);
  });
});

describe('classifyOwnerWhatsAppIntent — unknown (conversational)', () => {
  it.each([
    'Let me think about this.',
    'Never mind.',
    'Maybe later.',
    'Just checking in.',
  ])('"%s" → unknown', (text) => {
    const r = classifyOwnerWhatsAppIntent(text);
    expect(r.isExecutionDomain).toBe(false);
  });
});

// ── Reminder requires explicit "remind me" — bare time expressions are not reminders ──

describe('classifyOwnerWhatsAppIntent — reminder does not fire on bare time expressions', () => {
  it.each([
    'Tomorrow at 9am is the meeting.',
    'At 3pm we need to leave.',
  ])('"%s" is not a reminder', (text) => {
    const r = classifyOwnerWhatsAppIntent(text);
    expect(r.primary_domain).not.toBe('reminder');
  });
});

// ── isExecutionDomain helper ──────────────────────────────────────────────────

describe('isExecutionDomain', () => {
  it('returns true for reminder', () => {
    expect(isExecutionDomain({ primary_domain: 'reminder' })).toBe(true);
  });
  it('returns true for delegation', () => {
    expect(isExecutionDomain({ primary_domain: 'delegation' })).toBe(true);
  });
  it('returns true for whatsapp', () => {
    expect(isExecutionDomain({ primary_domain: 'whatsapp' })).toBe(true);
  });
  it('returns false for social_ack', () => {
    expect(isExecutionDomain({ primary_domain: 'social_ack' })).toBe(false);
  });
  it('returns false for general_answer', () => {
    expect(isExecutionDomain({ primary_domain: 'general_answer' })).toBe(false);
  });
  it('returns false for unknown', () => {
    expect(isExecutionDomain({ primary_domain: 'unknown' })).toBe(false);
  });
  it('returns false for calendar', () => {
    expect(isExecutionDomain({ primary_domain: 'calendar' })).toBe(false);
  });
});
