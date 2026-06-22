import { describe, expect, it } from 'vitest';
import { buildRoutineMessagePayload } from './send-whatsapp-task.js';

describe('routine message shared boundary', () => {
  it('preserves the approved routine template payload shape', () => {
    expect(
      buildRoutineMessagePayload({
        to: '971500000000',
        message: 'This is a recurring automation test.',
        templateName: 'ra7etbal_routine_message',
        templateLanguage: 'en_US',
      }),
    ).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '971500000000',
      type: 'template',
      template: {
        name: 'ra7etbal_routine_message',
        language: { code: 'en_US' },
        components: [
          {
            type: 'body',
            parameters: [
              {
                type: 'text',
                text: 'This is a recurring automation test.',
              },
            ],
          },
        ],
      },
    });
  });
});
