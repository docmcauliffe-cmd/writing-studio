import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linePrefix, applyBlock, clearInline, smartChar, stripNotes, listDepth } from './markup.js';
import { wordCount } from './logic.js';

test('line prefixes', () => {
  assert.deepEqual(linePrefix('## Title'), { indent: 0, end: 3, kind: 'heading', level: 2 });
  assert.equal(linePrefix('- [x] done').kind, 'task');
  assert.equal(linePrefix('- [x] done').done, true);
  assert.equal(linePrefix('  * item').kind, 'bullet');
  assert.equal(linePrefix('  * item').end, 4);
  assert.equal(linePrefix('12. step').kind, 'number');
  assert.equal(linePrefix('> said').end, 2);
  assert.equal(linePrefix('*emphasis*').kind, null);
  assert.equal(linePrefix('#hashtag').kind, null);
  assert.equal(listDepth('    - x'), 2);
});

test('lists, headings and quotes toggle on and off', () => {
  assert.deepEqual(applyBlock(['one', 'two'], 'bullet'), ['- one', '- two']);
  assert.deepEqual(applyBlock(['- one', '- two'], 'bullet'), ['one', 'two']);
  assert.deepEqual(applyBlock(['one', '', 'two'], 'number'), ['1. one', '', '2. two']);
  assert.deepEqual(applyBlock(['- one', '  - two'], 'task'), ['- [ ] one', '  - [ ] two']);
  assert.deepEqual(applyBlock(['## Old'], 'h1'), ['# Old']);
  assert.deepEqual(applyBlock(['# Old'], 'h1'), ['Old']);
  assert.deepEqual(applyBlock(['- [ ] x'], 'body'), ['x']);
  assert.deepEqual(applyBlock([''], 'bullet'), ['- ']);
  assert.deepEqual(applyBlock(['text'], 'quote'), ['> text']);
});

test('clear formatting keeps the words', () => {
  assert.equal(clearInline('a **b** *c* ~~d~~ `e` [f](http://x)'), 'a b c d e f');
});

test('smart quotes, dashes and ellipses', () => {
  assert.equal(smartChar('', '"').insert, '“');
  assert.equal(smartChar('He said ', '"').insert, '“');
  assert.equal(smartChar('“Hi', '"').insert, '”');
  assert.equal(smartChar("don", "'").insert, '’');
  assert.equal(smartChar(' ', "'").insert, '‘');
  assert.deepEqual(smartChar('wait -', '-'), { insert: '—', replaceBefore: 1 });
  assert.equal(smartChar('-', '-'), null, 'line start stays for dividers');
  assert.deepEqual(smartChar('so..', '.'), { insert: '…', replaceBefore: 2 });
  assert.equal(smartChar('a', 'b'), null);
});

test('notes to self are not counted', () => {
  assert.equal(stripNotes('one <!-- two three --> four'), 'one  four');
  assert.equal(wordCount('one <!-- two three --> four'), 2);
});
