import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, claudeTarget, cleanText, projectId, isStoryNote, APP_LIMIT, WEB_LIMIT, ACTIONS } from './claude.js';

const ctx = { text: 'The bench is empty.', bookTitle: 'The Bench', chapter: 'Why succession fails', section: 'The empty chair' };

test('every action builds a request with the passage and its place in the book', () => {
  for (const a of ACTIONS) {
    const p = buildPrompt(a.id, { ...ctx, question: 'Is this clear?' });
    assert.match(p, /“The Bench”/);
    assert.match(p, /“Why succession fails”/);
    assert.match(p, /a passage from the section “The empty chair”, in the chapter “Why succession fails”\./);
    assert.match(p, /The bench is empty\.$/m);
  }
});

test('about line and readers', () => {
  const p = buildPrompt('critique', { ...ctx, about: 'For executives: why leadership benches are vanishing' });
  assert.match(p, /“The Bench”\. For executives: why leadership benches are vanishing\./);
  assert.match(p, /keeping my intended readers in mind/);
  assert.doesNotMatch(buildPrompt('critique', ctx), /readers in mind/);
});

test('whole section vs passage wording', () => {
  assert.match(buildPrompt('tighten', { ...ctx, whole: true }), /tighten this section/);
  assert.match(buildPrompt('tighten', { ...ctx, whole: true }), /Below is the section “The empty chair”, from the chapter/);
  assert.match(buildPrompt('tighten', ctx), /tighten this passage/);
});

test('story prompts go only with Find a story', () => {
  const stories = '# Story prompts\n\n- The chess clock';
  assert.match(buildPrompt('story', { ...ctx, stories }), /My story prompts —\n\n# Story prompts/);
  assert.doesNotMatch(buildPrompt('critique', { ...ctx, stories }), /chess clock/);
  assert.doesNotMatch(buildPrompt('story', ctx), /story prompts/);
});

test('ask anything uses the question', () => {
  assert.match(buildPrompt('ask', { ...ctx, question: '  Is the opening too slow? ' }), /^Is the opening too slow\?$/m);
});

test('notes to self and pictures are left out', () => {
  assert.equal(cleanText('One <!-- private --> two\n\n\n\n![Chart](_Images/a.png)'), 'One  two\n\n[Picture: Chart]');
  assert.equal(cleanText('Unclosed <!-- note'), 'Unclosed');
});

test('short text opens prefilled; long text is copied', () => {
  const short = claudeTarget('Hi & bye');
  assert.equal(short.url, 'claude://claude.ai/new?q=Hi%20%26%20bye');
  assert.equal(short.copy, false);
  assert.deepEqual(claudeTarget('x'.repeat(APP_LIMIT + 1)), { url: 'claude://claude.ai/new', copy: true });
  assert.equal(claudeTarget('x'.repeat(WEB_LIMIT + 1), { via: 'web' }).url, 'https://claude.ai/new');
  assert.equal(claudeTarget('x'.repeat(WEB_LIMIT), { via: 'web' }).copy, false);
});

test('a Project opens the Project and copies the text', () => {
  const id = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
  assert.deepEqual(claudeTarget('Hi', { project: `https://claude.ai/project/${id}` }), { url: `claude://claude.ai/project/${id}`, copy: true });
  assert.equal(claudeTarget('Hi', { via: 'web', project: id }).url, `https://claude.ai/project/${id}`);
  assert.equal(projectId(`https://claude.ai/project/${id.toUpperCase()}?x=1`), id);
  assert.equal(projectId('https://claude.ai/new'), null);
  assert.equal(projectId(''), null);
});

test('story notes are picked by title', () => {
  assert.ok(isStoryNote('Story prompts'));
  assert.ok(isStoryNote('2026.11.24 Story prompts'));
  assert.ok(isStoryNote('Stories to use'));
  assert.ok(!isStoryNote('Research'));
  assert.ok(!isStoryNote('History'));
});
