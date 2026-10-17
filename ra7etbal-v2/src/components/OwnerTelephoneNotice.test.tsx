import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
vi.mock('../lib/supabase', () => ({ supabase: { auth: { getSession: vi.fn() } } }));
import OwnerTelephoneNotice from './OwnerTelephoneNotice';

describe('Owner telephone verification notice', () => {
  it('requires a deliberate consent action; never renders an initial code or implies authorization', () => {
    const html = renderToStaticMarkup(<MemoryRouter><OwnerTelephoneNotice receiptId="receipt" userId="owner" /></MemoryRouter>);
    expect(html).toContain('agree to transcription');
    expect(html).toContain('Verify Carson’s call');
    expect(html).toContain('Review call response');
    expect(html).not.toContain('Read this code');
    expect(html).not.toContain('Recorded telephone response:');
  });
});
