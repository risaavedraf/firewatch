import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test } from 'vitest';

// The eyebrow started at `--forest-500` (3.71:1 on the canvas). The first fix
// scoped the readable token to the views that existed then, so the views merged
// later inherited the failing colour — and the notifications empty state, whose
// eyebrow is not in an intro row, failed even after that list grew. The default
// is now the readable token and no view re-colours it: a view added tomorrow is
// readable without touching this file.
test('the eyebrow default is the readable token, with no view-scoped override', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/styles/app.css'), 'utf8');

  const base = css
    .split('\n')
    .find((line) => /^\.eyebrow\s*\{/.test(line.trim()) && line.includes('color:'));

  expect(base, 'the base eyebrow rule is missing').toBeDefined();
  expect(base).toContain('var(--forest-700)');
  expect(base).not.toContain('var(--forest-500)');

  // No rule may re-colour an eyebrow to the unreadable token. A scoped rule that
  // repeats the readable one is fine; a per-view list that excludes the next
  // view is what the base default now makes unnecessary.
  const scoped = css
    .split('\n')
    .filter((line) => /\.eyebrow/.test(line) && line.includes('{') && !/^\.eyebrow\s*\{/.test(line.trim()))
    .filter((line) => line.includes('color:') && line.includes('forest-500'));
  expect(scoped, `rules that re-colour eyebrows to the unreadable token: ${scoped.join(' | ')}`).toEqual([]);
});
