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
    // "wait for me" is a physical/presence action (like "bring me"), not a
    // communication-back request — it is operational, not personal-response,
    // and stays delegation regardless of recipient role. Role only gates the
    // bounded PERSONAL_RESPONSE_RE verb set (call/contact/text/message/reply/
    // get back), never physical-action phrasing.
    ['Tell Christopher to wait for me in the kitchen.', 'delegation', 'Christopher'],
    ['Ask Christopher to make pizza for dinner.', 'delegation', 'Christopher'],
    ['Ask Christopher to clean the kitchen.', 'delegation', 'Christopher'],
    ['Ask Grace to confirm the guest room is ready.', 'delegation', 'Grace'],
    // Workstream 3 repair — questions, plain information, and alternate
    // communication verbs must reach direct_message, not "unsupported".
    ['Ask Saeed if he likes avocado.', 'direct_message', 'Saeed'],
    ['Ask Saeed whether he likes avocado.', 'direct_message', 'Saeed'],
    ['Ask Saeed what time he is arriving.', 'direct_message', 'Saeed'],
    ["Tell Grace I have no Wi-Fi.", 'direct_message', 'Grace'],
    ['Text Christopher saying thank you.', 'direct_message', 'Christopher'],
    ['Message Grace that dinner is ready.', 'direct_message', 'Grace'],
    ['Send Ghulam a message saying I am running late.', 'direct_message', 'Ghulam'],
    ['Can you ask Saeed if he likes avocado?', 'direct_message', 'Saeed'],
    ['Can you tell Christopher to defrost the chicken?', 'delegation', 'Christopher'],
    // Grammar-based delegation signal — infinitive "to <verb>" generalizes
    // beyond the closed WORK_HINT list.
    ['Ask Christopher to measure the table.', 'delegation', 'Christopher'],
    ['Tell Grace to photograph the room.', 'delegation', 'Grace'],
    ['Tell Ghulam to charge the car.', 'delegation', 'Ghulam'],
    ['Ask Christopher to defrost the chicken.', 'delegation', 'Christopher'],
    // Personal-response candidates — Stage 1 always defaults to
    // direct_message; only executePersonCommand may upgrade for staff.
    ['Ask Saeed to text me.', 'direct_message', 'Saeed'],
    ['Ask Christopher to call me.', 'direct_message', 'Christopher'],
    ['Text Saeed to call me.', 'direct_message', 'Saeed'],
    // Concrete-action requests keep "me" as an object, not a response target
    // — they are never personal-response and stay delegation regardless of
    // recipient role.
    ['Ask Saeed to bring me the medicine.', 'delegation', 'Saeed'],
    ['Ask Saeed to bring me my passport.', 'delegation', 'Saeed'],
    ['Ask Saeed to buy me some milk.', 'delegation', 'Saeed'],
    ['Ask Saeed to buy the medicine.', 'delegation', 'Saeed'],
    ['Ask Christopher to bring me the medicine.', 'delegation', 'Christopher'],
  ])('classifies %s as %s', (input, type, recipient) => {
    expect(classifyOwnerCommand(input)).toMatchObject({ type, recipient });
  });

  it('flags personal-response candidates for role resolution downstream', () => {
    expect(classifyOwnerCommand('Ask Saeed to call me.')).toMatchObject({ personalResponse: true });
    expect(classifyOwnerCommand('Ask Christopher to call me.')).toMatchObject({ personalResponse: true });
    expect(classifyOwnerCommand('Text Saeed to call me.')).toMatchObject({ personalResponse: false });
    expect(classifyOwnerCommand('Ask Saeed to bring me the medicine.')).toMatchObject({ personalResponse: false });
    expect(classifyOwnerCommand('Ask Saeed to buy the medicine.')).toMatchObject({ personalResponse: false });
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
