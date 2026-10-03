import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const source = (name) => readFileSync(new URL(name, import.meta.url), 'utf8');

describe('Slice B execution boundary wiring', () => {
  it('blocks stale task confirmation before review or mutation', () => {
    const code = source('./task-confirm.js');
    const fetchTask = code.indexOf("step = 'fetch_task'");
    const guard = code.indexOf('checkAccountConsequentialAccess', fetchTask);
    const qualityReview = code.indexOf("step = 'quality_review'", fetchTask);
    const save = code.indexOf("step = 'save_approval'", fetchTask);
    expect(guard).toBeGreaterThan(fetchTask);
    expect(guard).toBeLessThan(qualityReview);
    expect(guard).toBeLessThan(save);
  });

  it('reconciles external cancellation only from the authenticated scheduler', () => {
    const code = source('./process-delegation-escalations.js');
    expect(code.indexOf('if (!(await isAuthorized(req)))')).toBeLessThan(code.indexOf('processAccountDeletionCancellations({'));
  });
});
