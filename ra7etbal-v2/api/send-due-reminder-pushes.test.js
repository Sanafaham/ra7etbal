import { describe, expect, it } from 'vitest';

import { getUnauthorizedCallerDiagnostic } from './send-due-reminder-pushes.js';

describe('send-due-reminder-pushes authorization diagnostics', () => {
  it('redacts unauthorized caller auth while preserving scheduler-identifying headers', () => {
    expect(
      getUnauthorizedCallerDiagnostic({
        method: 'POST',
        url: '/api/send-due-reminder-pushes',
        headers: {
          authorization: 'Bearer secret-value',
          host: 'ra7etbal-v2.vercel.app',
          'user-agent': 'Upstash-QStash',
          'upstash-schedule-id': 'schedule-1',
          'upstash-signature': 'signature-value',
          'x-vercel-id': 'iad1::abc',
        },
      }),
    ).toEqual({
      method: 'POST',
      url: '/api/send-due-reminder-pushes',
      host: 'ra7etbal-v2.vercel.app',
      userAgent: 'Upstash-QStash',
      hasAuthorization: true,
      authorizationScheme: 'Bearer',
      qstashHeaders: ['upstash-schedule-id', 'upstash-signature'],
      vercelId: 'iad1::abc',
    });
  });
});
