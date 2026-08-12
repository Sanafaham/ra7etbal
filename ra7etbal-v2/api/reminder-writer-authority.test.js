import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = new URL('../src', import.meta.url).pathname;

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx)$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}

describe('production-reachable one-off reminder writers', () => {
  it('routes every client reminder writer through createReminderTask and never a direct createTask reminder draft', () => {
    const calls = [];
    for (const path of sourceFiles(SRC_ROOT)) {
      const source = readFileSync(path, 'utf8');
      expect(source, path).not.toMatch(/createTask\(\{[\s\S]{0,500}?type:\s*["']reminder["']/);
      for (const match of source.matchAll(/createReminderTask\(\{[\s\S]{0,350}?source:\s*["']([^"']+)["']/g)) {
        calls.push(match[1]);
      }
    }
    expect(calls.sort()).toEqual([
      'act_on_note',
      'inbox',
      'save',
      'save',
      'todos',
      'voice',
    ]);
  });

  it('keeps the canonical helper free of authenticated task INSERTs', () => {
    const source = readFileSync(join(SRC_ROOT, 'lib/reminders.ts'), 'utf8');
    expect(source).toContain('createRoutedReminder');
    expect(source).not.toContain('createTask(');
    expect(source).not.toContain('.from("tasks")');
  });
});
