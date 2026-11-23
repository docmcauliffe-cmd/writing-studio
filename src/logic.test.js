import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paragraphRange, lineDiff, wordCount, snapshotDue, otherDeviceOn, dropIndex, stamp } from './logic.js';

test('paragraphRange finds the block around the cursor', () => {
  const lines = ['# Title', '', 'one', 'two', '', 'three'];
  const get = (n) => lines[n - 1];
  assert.deepEqual(paragraphRange(get, lines.length, 3), [3, 4]);
  assert.deepEqual(paragraphRange(get, lines.length, 4), [3, 4]);
  assert.deepEqual(paragraphRange(get, lines.length, 6), [6, 6]);
  assert.deepEqual(paragraphRange(get, lines.length, 2), [2, 2]);
});

test('lineDiff marks lines only on one side', () => {
  const rows = lineDiff('a\nb\nc', 'a\nB\nc\nd');
  assert.deepEqual(rows.map((r) => r.type + ':' + r.text), ['same:a', 'left:b', 'right:B', 'same:c', 'right:d']);
});

test('wordCount ignores bare Markdown symbols', () => {
  assert.equal(wordCount('# The **empty** chair\n\n> quote - here'), 5);
});

test('snapshotDue waits an hour', () => {
  assert.equal(snapshotDue(0, 1000), true);
  assert.equal(snapshotDue(1000, 1000 + 59 * 60 * 1000), false);
  assert.equal(snapshotDue(1000, 1000 + 60 * 60 * 1000), true);
});

test('otherDeviceOn only flags the other Mac, recently, on this section', () => {
  const now = 10_000_000;
  const acts = [
    { device: 'iMac', section: 'B/C/s.md', at: now - 1000 },
    { device: 'MacBook Pro', section: 'B/C/s.md', at: now - 60_000 },
    { device: 'Old', section: 'B/C/s.md', at: now - 60 * 60_000 },
  ];
  assert.equal(otherDeviceOn(acts, 'iMac', 'B/C/s.md', now).device, 'MacBook Pro');
  assert.equal(otherDeviceOn(acts, 'iMac', 'B/C/x.md', now), null);
});

test('dropIndex', () => {
  assert.equal(dropIndex(['a', 'b', 'c'], 'c', 'a'), 0);
  assert.equal(dropIndex(['a', 'b', 'c'], 'a', 'c'), 1);
  assert.equal(dropIndex(['a', 'b', 'c'], 'a', null), 2);
});

test('stamp uses YYYY.MM.DD HHMM', () => {
  assert.equal(stamp(new Date(2026, 10, 3, 9, 5)), '2026.11.03 0905');
});
