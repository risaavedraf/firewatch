import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test } from 'vitest';

// The eyebrow fix landed scoped to the views that existed then, so the three
// views merged later inherited `--forest-500` and axe flagged 3.71:1 on each of
// them at both widths. The rule now targets the structure, not a list of ids: a
// view added tomorrow gets the readable colour without touching this file.
test('the eyebrow rule targets the structure, not a list of views', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/styles/app.css'), 'utf8');
  const rule = css
    .split('\n')
    .find((line) => line.includes('.eyebrow') && line.includes('var(--forest-700)'));

  expect(rule, 'no eyebrow rule uses the readable forest token').toBeDefined();

  const selectors = (rule as string)
    .slice(0, (rule as string).indexOf('{'))
    .split(',')
    .map((selector) => selector.trim());

  // Every intro row carries the readable colour, whichever view renders it.
  expect(selectors).toContain('.intro-row .eyebrow');
  // The two eyebrow contexts that do not sit in an intro row keep their own names.
  expect(selectors).toContain('#sources > .eyebrow');
  expect(selectors).toContain('#jobs .job-result .eyebrow');
  // A view-prefixed intro-row selector is the defect: it silently excludes every
  // view added after the fix.
  const prefixed = selectors.filter((selector) => /^#[a-z-]+\s+\.intro-row\s+\.eyebrow$/.test(selector));
  expect(prefixed, `view-scoped eyebrow selectors: ${prefixed.join(', ')}`).toEqual([]);
});
