import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * GitHub Actions only ever discovers and runs workflows at
 * <repository-root>/.github/workflows — never inside a package
 * subdirectory. This test previously resolved its target directory from
 * `process.cwd()` directly, which is this package's own directory
 * (ra7etbal-v2/) when tests run, not the repository root one level up.
 * That meant the check silently inspected a directory that doesn't exist
 * and passed trivially, while a forbidden scheduled workflow sat undetected
 * at the real repository root for two months. Walk up from `startDir` to
 * find the actual repository root instead of assuming cwd is it.
 */
export function findRepoRoot(startDir) {
  let dir = startDir;
  while (true) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return startDir;
    dir = parent;
  }
}

/** Scans a `.github/workflows`-shaped directory for any YAML workflow that
 * both declares a `schedule:` trigger and references `send-due-reminder-pushes` —
 * i.e. a forbidden second scheduler for the reminder safety-net endpoint. */
export function findScheduledReminderWorkflows(workflowsDir) {
  const workflowFiles = existsSync(workflowsDir)
    ? readdirSync(workflowsDir).filter((file) => /\.ya?ml$/i.test(file))
    : [];

  return workflowFiles
    .map((file) => ({
      file,
      source: readFileSync(join(workflowsDir, file), 'utf8'),
    }))
    .filter(({ source }) =>
      /schedule\s*:/i.test(source) &&
      /send-due-reminder-pushes/i.test(source),
    );
}

describe('scheduled push jobs - source of truth', () => {
  it('resolves the repository root, not this package subdirectory', () => {
    const root = findRepoRoot(process.cwd());
    expect(existsSync(join(root, '.git'))).toBe(true);
    expect(existsSync(join(root, '.github'))).toBe(true);
  });

  it('does not schedule reminder safety-net pushes from GitHub Actions at the real repository root', () => {
    const workflowsDir = join(findRepoRoot(process.cwd()), '.github', 'workflows');
    expect(findScheduledReminderWorkflows(workflowsDir)).toEqual([]);
  });

  it('counterfactual: the detector actually flags a forbidden scheduled workflow when one is present', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'scheduler-source-of-truth-'));
    try {
      writeFileSync(
        join(tempDir, 'send-due-reminder-pushes.yml'),
        'name: Send due reminder pushes\non:\n  schedule:\n    - cron: "*/10 * * * *"\n' +
          'jobs:\n  call:\n    steps:\n      - run: curl https://ra7etbal-v2.vercel.app/api/send-due-reminder-pushes\n',
      );
      expect(findScheduledReminderWorkflows(tempDir)).not.toEqual([]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('counterfactual: reports clean when no scheduled reminder workflow exists', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'scheduler-source-of-truth-'));
    try {
      writeFileSync(join(tempDir, 'unrelated.yml'), 'name: unrelated\non:\n  push:\n');
      expect(findScheduledReminderWorkflows(tempDir)).toEqual([]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
