import { describe, expect, it } from 'vitest';
import {
  classifyOwnerCommand,
  normalizeOwnerReferences,
  parseOwnerReminderDue,
} from './_owner-command-executor.js';

describe('server owner-command classification', () => {
  it.each([
    ["Tell Grace I'll be home at 7.", 'direct_message', 'Grace'],
    ["Tell Christopher I'm running late.", 'direct_message', 'Christopher'],
    ['Ask Grace to call me.', 'direct_message', 'Grace'],
    ['Tell Christopher to wait for me in the kitchen.', 'direct_message', 'Christopher'],
    ['Ask Christopher to make pizza for dinner.', 'delegation', 'Christopher'],
    ['Ask Christopher to clean the kitchen.', 'delegation', 'Christopher'],
    ['Ask Grace to confirm the guest room is ready.', 'delegation', 'Grace'],
  ])('classifies %s as %s', (input, type, recipient) => {
    expect(classifyOwnerCommand(input)).toMatchObject({ type, recipient });
  });

  it.each([
    ['Remind me to pay the electricity bill tomorrow.', 'pay the electricity bill'],
    ['Remind me tomorrow at 5:30 PM.', 'Reminder'],
  ])('classifies one-off reminder %s', (input, text) => {
    expect(classifyOwnerCommand(input)).toMatchObject({ type: 'reminder', text });
  });

  it('keeps unquoted short answers, ambiguous commands, and compounds unsupported', () => {
    expect(classifyOwnerCommand('Yes')).toMatchObject({ type: 'unsupported' });
    expect(classifyOwnerCommand('No')).toMatchObject({ type: 'unsupported' });
    expect(classifyOwnerCommand('Tell Grace about tomorrow')).toMatchObject({ type: 'unsupported' });
    expect(classifyOwnerCommand('What is on my calendar and remind Grace')).toMatchObject({ type: 'unsupported' });
    expect(classifyOwnerCommand(
      'Remind me tomorrow at 5 and ask Christopher to clean the kitchen',
    )).toMatchObject({ type: 'unsupported', reason: 'compound_command' });
  });
});

describe('owner-reference normalization', () => {
  it.each([
    ['call me', 'call Sana'],
    ['wait for me', 'wait for Sana'],
    ['contact me', 'contact Sana'],
    ['bring me', 'bring Sana'],
    ['call myself', 'call Sana'],
  ])('%s becomes %s', (input, expected) => {
    expect(normalizeOwnerReferences(input, 'Sana')).toBe(expected);
  });
});

describe('owner reminder timezone parsing', () => {
  const now = new Date('2026-07-26T20:30:00.000Z'); // 23:30 Sunday in Istanbul

  it.each([
    ['tomorrow at 5:30 PM', '2026-07-27T14:30:00.000Z'],
    ['at 5', '2026-07-27T14:00:00.000Z'],
    ['next Monday', '2026-07-27T06:00:00.000Z'],
    ['tomorrow', '2026-07-27T06:00:00.000Z'],
  ])('%s resolves in the owner timezone', (input, expected) => {
    expect(parseOwnerReminderDue(input, 'Europe/Istanbul', now)).toBe(expected);
  });

  it('fails closed for unparseable text and invalid timezone', () => {
    expect(parseOwnerReminderDue('sometime later', 'Europe/Istanbul', now)).toBeNull();
    expect(parseOwnerReminderDue('tomorrow', 'Not/A_Timezone', now)).toBeNull();
  });
});
