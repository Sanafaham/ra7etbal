import { describe, expect, it } from 'vitest';
import { classifyOwnerCommand, normalizeOwnerReferences } from './_owner-command-executor.js';

describe('server owner-command classification', () => {
  it.each([
    ["Tell Grace I'll be home at 7.", 'direct_message', 'Grace'],
    ["Tell Christopher I'm running late.", 'direct_message', 'Christopher'],
    ['Ask Grace to call me.', 'direct_message', 'Grace'],
    ['Ask Christopher to make pizza for dinner.', 'delegation', 'Christopher'],
    ['Tell Christopher to clean the kitchen.', 'delegation', 'Christopher'],
  ])('classifies %s as %s', (input, type, recipient) => {
    expect(classifyOwnerCommand(input)).toMatchObject({ type, recipient });
  });

  it.each([
    ['Remind me to pay the electricity bill tomorrow.', 'pay the electricity bill'],
    ['Remind me tomorrow at 5:30 PM.', 'Reminder'],
  ])('classifies one-off reminder %s', (input, text) => {
    expect(classifyOwnerCommand(input)).toMatchObject({ type: 'reminder', text, tomorrow: true });
  });

  it('keeps unquoted short answers and complex commands unsupported', () => {
    expect(classifyOwnerCommand('Yes')).toMatchObject({ type: 'unsupported' });
    expect(classifyOwnerCommand('What is on my calendar and remind Grace')).toMatchObject({ type: 'unsupported' });
  });
});

describe('owner-reference normalization', () => {
  it.each([
    ['call me', 'call Sana'],
    ['wait for me', 'wait for Sana'],
    ['contact me', 'contact Sana'],
    ['bring me', 'bring Sana'],
  ])('%s becomes %s', (input, expected) => {
    expect(normalizeOwnerReferences(input, 'Sana')).toBe(expected);
  });
});
