import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
// @ts-expect-error a plain .mjs script without types
import { FROM, TO, generate } from '../scripts/md.mjs';

const there = existsSync(FROM);
test('src/md.js is what npm run md makes from dodo\'s public/md.js', { skip: !there && `${FROM} finns inte (dodo bredvid?): src/md.js prövas inte mot den` }, () => {
  assert.ok(readFileSync(TO, 'utf8') === generate(readFileSync(FROM, 'utf8')), 'src/md.js är inaktuell: kör npm run md');
});
