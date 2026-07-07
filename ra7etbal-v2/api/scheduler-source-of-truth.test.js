import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const WORKFLOWS_DIR = join(process.cwd(), '.github', 'workflows');

describe('scheduled push jobs - source of truth', () => {
  it('does not schedule reminder safety-net pushes from GitHub Actions', () => {
    const workflowFiles = existsSync(WORKFLOWS_DIR)
      ? readdirSync(WORKFLOWS_DIR).filter((file) => /\.ya?ml$/i.test(file))
      : [];

    const scheduledReminderWorkflows = workflowFiles
      .map((file) => ({
        file,
        source: readFileSync(join(WORKFLOWS_DIR, file), 'utf8'),
      }))
      .filter(({ source }) =>
        /schedule\s*:/i.test(source) &&
        /send-due-reminder-pushes/i.test(source),
      );

    expect(scheduledReminderWorkflows).toEqual([]);
  });
});
