import { test } from 'node:test';
import assert from 'node:assert/strict';
import { minimalChange } from '../src/sync.js';

const apply = (from: string, to: string) => { const c = minimalChange(from, to); return { c, out: from.slice(0, c.from) + c.text + from.slice(c.to) }; };
test('minimalChange touches only what differs, never half an emoji', () => {
  for (const [a, b] of [['abc', 'abc'], ['hello world', 'hello brave world'], ['a\nb\nc', 'a\nc'], ['', 'x'], ['x', ''], ['a😀b', 'a😁b'], ['aaa', 'aa'], ['😀', '😀😀']]) assert.equal(apply(a, b).out, b);
  assert.deepEqual(apply('hello world', 'hello brave world').c, { from: 6, to: 6, text: 'brave ' });
  assert.deepEqual(apply('x\ny', 'x\ny').c, { from: 3, to: 3, text: '' });
});
