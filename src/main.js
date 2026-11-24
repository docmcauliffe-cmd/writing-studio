import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/400-italic.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-sans/600-italic.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/400-italic.css';
import '@fontsource/ibm-plex-mono/600.css';
import '@fontsource/literata/400.css';
import '@fontsource/literata/400-italic.css';
import '@fontsource/literata/600.css';
import '@fontsource/newsreader/400.css';
import '@fontsource/newsreader/400-italic.css';
import '@fontsource/newsreader/600.css';
import '@fontsource/source-serif-4/400.css';
import '@fontsource/source-serif-4/400-italic.css';
import '@fontsource/source-serif-4/600.css';

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { homeDir } from '@tauri-apps/api/path';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { check as checkUpdate } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { getVersion } from '@tauri-apps/api/app';
import { createEditor } from './editor.js';
import { lineDiff, wordCount, formatCount, stamp, snapshotDue, otherDeviceOn, dropIndex, minutesAgo } from './logic.js';

const INBOX = 'Writing Studio - Inbox';
const REFERENCE = '_Reference Notes'; // per book; not part of the manuscript
const FONTS = {
  plex: { name: 'Plex Sans', css: '"IBM Plex Sans", -apple-system, system-ui, sans-serif' },
  literata: { name: 'Literata', css: '"Literata", Georgia, serif' },
  newsreader: { name: 'Newsreader', css: '"Newsreader", Georgia, serif' },
  source: { name: 'Source Serif', css: '"Source Serif 4", Georgia, serif' },
  mono: { name: 'Plex Mono', css: '"IBM Plex Mono", ui-monospace, Menlo, monospace' },
};
const LOOKS = { sepia: 'Sepia', paper: 'Paper', studio: 'Studio', night: 'Night' };
const DEFAULTS = { look: 'sepia', font: 'plex', size: 19, measure: 34, typewriter: false, smart: true, dailyGoal: null, targets: {} };

// ------------------------------------------------------------------ small helpers

const $ = (sel, el = document) => el.querySelector(sel);
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
};
const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked: drafts are a bonus */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function toast(msg, ms = 3200) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const t = h('div', { class: 'toast', role: 'status' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), ms);
}

function dialog(build, { wide = false } = {}) {
  closeMenus();
  const overlay = h('div', { class: 'overlay' });
  const box = h('div', { class: 'dialog' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true' });
  overlay.append(box);
  const close = () => { overlay.remove(); S.dialogOpen = false; editor?.focus(); };
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay && !overlay.dataset.locked) close(); });
  S.dialogOpen = true;
  build(box, close, overlay);
  document.body.append(overlay);
  const first = box.querySelector('input, button.primary, button');
  first?.focus();
  return close;
}

function ask(title, { label, value = '', okText = 'OK', note } = {}) {
  return new Promise((resolve) => {
    dialog((box, close) => {
      const input = h('input', { type: 'text', value, id: 'ask-input' });
      const done = (v) => { close(); resolve(v); };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(input.value.trim() || null); if (e.key === 'Escape') done(null); });
      box.append(
        h('h2', {}, title),
        note ? h('p', {}, note) : null,
        h('label', { class: 'field' }, h('span', {}, label || 'Name'), input),
        h('div', { class: 'actions' },
          h('button', { class: 'btn', onclick: () => done(null) }, 'Cancel'),
          h('button', { class: 'btn primary', onclick: () => done(input.value.trim() || null) }, okText)),
      );
      setTimeout(() => { input.focus(); input.select(); });
    });
  });
}

function confirmBox(title, text, okText) {
  return new Promise((resolve) => {
    dialog((box, close) => {
      const done = (v) => { close(); resolve(v); };
      box.append(h('h2', {}, title), h('p', {}, text),
        h('div', { class: 'actions' },
          h('button', { class: 'btn', onclick: () => done(false) }, 'Cancel'),
          h('button', { class: 'btn primary', onclick: () => done(true) }, okText)));
    });
  });
}

function closeMenus() { document.querySelectorAll('.menu').forEach((m) => m.remove()); }
function menu(x, y, items) {
  closeMenus();
  const m = h('div', { class: 'menu', role: 'menu' });
  for (const it of items) {
    if (it === '-') { m.append(h('hr')); continue; }
    m.append(h('button', { class: it.danger ? 'danger' : '', role: 'menuitem', onclick: () => { closeMenus(); it.run(); } }, it.label));
  }
  document.body.append(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  m.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
  setTimeout(() => document.addEventListener('mousedown', function off(e) {
    if (!m.contains(e.target)) { closeMenus(); document.removeEventListener('mousedown', off); }
  }));
}

// ------------------------------------------------------------------ state

const S = {
  root: store.get('ws-root'),
  device: 'This Mac',
  lib: null,
  book: store.get('ws-book'),
  current: null, // { rel, book, chapter, file, title, hash, inbox }
  dirty: false,
  saving: false,
  again: false,
  conflictOpen: false,
  dialogOpen: false,
  savedHashes: [],
  settings: { ...DEFAULTS },
  collapsed: new Set(store.get('ws-collapsed', [])),
  editedBooks: new Set(),
  snappedThisSession: new Set(),
};
let editor = null;
let saveTimer = null;

const call = (cmd, args = {}) => invoke(cmd, { rootDir: S.root, ...args });

// ------------------------------------------------------------------ settings and looks

function applySettings() {
  const s = S.settings;
  document.documentElement.dataset.look = s.look;
  const r = document.documentElement.style;
  r.setProperty('--font', (FONTS[s.font] || FONTS.plex).css);
  r.setProperty('--size', s.size + 'px');
  r.setProperty('--measure', s.measure + 'em');
  r.setProperty('--lh', s.font === 'mono' ? '1.7' : '1.65');
  editor?.setTypewriter(!!s.typewriter);
  editor?.setSmartTyping(s.smart !== false);
}

let settingsTimer = null;
function saveSettings() {
  applySettings();
  store.set('ws-settings', S.settings);
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => call('settings_write', { json: JSON.stringify(S.settings, null, 2) }).catch(() => {}), 600);
}

// ------------------------------------------------------------------ boot

async function boot() {
  S.settings = { ...DEFAULTS, ...store.get('ws-settings', {}) };
  applySettings();
  try { S.device = await invoke('device_name'); } catch { /* keep default */ }
  if (!S.root || !(await invoke('folder_exists', { path: S.root }))) return welcome();
  await start();
}

function welcome() {
  const app = $('#app');
  app.replaceChildren(h('div', { class: 'welcome' }, h('div', { class: 'card' },
    h('h1', {}, 'Welcome to Writing Studio'),
    h('p', {}, 'Choose the Writing Studio folder in your Google Drive. Everything you write is kept there as plain Markdown files, so it syncs to your other Mac and is backed up by Drive.'),
    h('p', {}, 'In Finder, look under Google Drive › My Drive for the folder named Writing Studio.'),
    h('div', {}, h('button', { class: 'btn primary', onclick: chooseFolder }, 'Choose folder…')),
  )));
}

async function chooseFolder() {
  let defaultPath;
  try { defaultPath = (await homeDir()) + '/Library/CloudStorage'; } catch { /* no default */ }
  const picked = await openDialog({ directory: true, defaultPath, title: 'Choose your Writing Studio folder' });
  if (!picked) return;
  await flushSave();
  S.root = picked;
  store.set('ws-root', picked);
  S.current = null;
  await start();
}

async function start() {
  try {
    const shared = JSON.parse(await call('settings_read'));
    S.settings = { ...DEFAULTS, ...S.settings, ...shared };
  } catch { /* keep local */ }
  applySettings();
  shell();
  await refresh();
  const last = store.get('ws-last-' + S.book);
  const first = firstSection();
  if (last && findSection(last)) await openSection(last);
  else if (first) await openSection(first);
  else showEmptyMain();
  const lastPanel = store.get('ws-panel');
  if (lastPanel && findSection(lastPanel)) openPanel(lastPanel);
  loadProgress();
  try { await call('watch_start'); } catch (e) { toast(String(e)); }
}

// ------------------------------------------------------------------ layout

function shell() {
  const app = $('#app');
  app.replaceChildren(
    h('aside', { class: 'side', 'aria-label': 'Library' },
      h('div', { class: 'drag', 'data-tauri-drag-region': true }),
      h('div', { class: 'side-scroll', id: 'side' }),
      h('div', { class: 'side-foot' },
        h('button', { onclick: () => newChapter(), title: 'New chapter (⇧⌘N)' }, '+ Chapter'),
        h('button', { onclick: () => backupsDialog() }, 'Backups'),
        h('button', { onclick: () => settingsDialog(), title: 'Settings (⌘,)' }, 'Look & settings'))),
    h('main', { class: 'main' },
      h('div', { class: 'topbar', 'data-tauri-drag-region': true },
        h('span', { class: 'crumb', id: 'crumb' }),
        h('span', { class: 'top-right' },
          h('span', { id: 'update-slot' }),
          h('span', { class: 'status', id: 'status' }, h('i'), h('span', {}, 'Saved')))),
      h('div', { id: 'banner-slot' }),
      h('div', { class: 'editor-host', id: 'editor-host' }),
      h('div', { class: 'foot', id: 'foot' })),
    h('aside', { class: 'ref-panel', id: 'ref-panel', 'aria-label': 'Reference note' }),
  );
  editor = createEditor($('#editor-host'), {
    onChange,
    onLink: linkDialog,
    onAction: (id) => runAction(id),
    extraKeys: [
      { key: 'Mod-s', run: () => { flushSave(); return true; } },
    ],
  });
  applySettings();
}

function setStatus(kind, text) {
  const el = $('#status');
  if (!el) return;
  el.className = 'status ' + kind;
  el.lastChild.textContent = text;
}

// ------------------------------------------------------------------ library

const book = () => S.lib?.books.find((b) => b.name === S.book) || null;
const relOf = (b, c, f) => `${b}/${c}/${f}`;
function firstSection() {
  const b = book();
  for (const c of b?.chapters || []) if (c.sections[0]) return relOf(b.name, c.name, c.sections[0].file);
  return null;
}
function findSection(rel) {
  if (!rel) return null;
  if (rel.startsWith(INBOX + '/')) return S.lib.inbox.find((s) => `${INBOX}/${s.file}` === rel) || null;
  const [b, c, f] = rel.split('/');
  const bk = S.lib.books.find((x) => x.name === b);
  if (c === REFERENCE) return bk?.notes.find((x) => x.file === f) || null;
  return bk?.chapters.find((x) => x.name === c)?.sections.find((x) => x.file === f) || null;
}

async function refresh() {
  try {
    S.lib = await call('library_list');
  } catch (e) {
    setStatus('error', 'Folder not found');
    toast(String(e), 6000);
    return;
  }
  if (!book()) S.book = S.lib.books[0]?.name || null;
  store.set('ws-book', S.book);
  renderSidebar();
  renderFoot();
}

function renderSidebar() {
  const side = $('#side');
  if (!side) return;
  const b = book();
  const kids = [];

  kids.push(h('div', { class: 'label' }, h('span', {}, 'Book')));
  const select = h('select', { id: 'book-select', 'aria-label': 'Book', onchange: async (e) => {
    if (e.target.value === '__new') { e.target.value = S.book || ''; return newBook(); }
    await switchBook(e.target.value);
  } },
  ...S.lib.books.map((x) => h('option', { value: x.name, selected: x.name === S.book }, x.title)),
  h('option', { value: '__new' }, 'New book…'));
  kids.push(h('div', { class: 'book-pick' }, select,
    b ? h('button', { class: 'icon-btn', title: 'Book options', 'aria-label': 'Book options', onclick: (e) => bookMenu(e) }, '⋯') : null));

  if (b?.goal) {
    const pct = Math.min(100, Math.round((liveBookWords() / b.goal) * 100));
    kids.push(h('div', { class: 'goal' },
      h('span', {}, `${formatCount(liveBookWords())} of ${formatCount(b.goal)} words`),
      h('div', { class: 'bar' }, h('i', { style: `width:${pct}%` }))));
  }

  // Inbox from the iPhone
  if (S.lib.inbox.length) {
    const open = !S.collapsed.has('__inbox');
    kids.push(h('div', { class: 'label' }, h('span', {}, 'Inbox')));
    const li = h('li', { class: open ? '' : 'collapsed' },
      h('div', { class: 'row inbox-row', onclick: () => toggle('__inbox') },
        h('span', { class: 'name' }, 'From iPhone'), h('span', { class: 'count' }, S.lib.inbox.length)),
      h('ol', { class: 'secs' }, S.lib.inbox.map((s) => sectionRow(`${INBOX}/${s.file}`, s, true))));
    kids.push(h('ol', { class: 'tree' }, li));
  }

  kids.push(h('div', { class: 'label' }, h('span', {}, 'Chapters'),
    b ? h('button', { title: 'New chapter', 'aria-label': 'New chapter', onclick: () => newChapter() }, '+') : null));

  if (!b) {
    kids.push(h('div', { class: 'row' }, h('span', { class: 'name', style: 'color:var(--dim)' }, 'No book yet')));
  } else {
    const tree = h('ol', { class: 'tree', id: 'tree' });
    for (const c of b.chapters) tree.append(chapterItem(b, c));
    if (!b.chapters.length) tree.append(h('li', {}, h('div', { class: 'row', onclick: () => newChapter() }, h('span', { class: 'name', style: 'color:var(--dim)' }, '+ Add a chapter'))));
    // dropping a chapter below the last one
    tree.addEventListener('dragover', (e) => {
      if (drag?.kind === 'chapter' && e.target === tree) { e.preventDefault(); clearDrop(); }
    });
    tree.addEventListener('drop', (e) => { if (drag?.kind === 'chapter' && e.target === tree) { e.preventDefault(); dropChapter(null); } });
    kids.push(tree);
    kids.push(...referenceSection(b));
  }
  side.replaceChildren(...kids);
}

// Reference notes: material to consult while writing. Saved, synced and backed up like
// everything else, but left out of word counts, goals and export.
function referenceSection(b) {
  const nrel = `${b.name}/${REFERENCE}`;
  const label = h('div', { class: 'label ref-label' }, h('span', {}, 'Reference'),
    h('button', { title: 'New reference note', 'aria-label': 'New reference note', onclick: () => newNote() }, '+'));
  label.addEventListener('dragover', (e) => { if (drag?.kind === 'section') { e.preventDefault(); clearDrop(); label.classList.add('drop-into'); } });
  label.addEventListener('drop', (e) => { if (drag?.kind === 'section') { e.preventDefault(); dropSection(nrel, null); } });
  const list = h('ol', { class: 'tree secs ref-list' }, b.notes.map((s) => sectionRow(`${nrel}/${s.file}`, s, false)));
  if (!b.notes.length) {
    const empty = h('div', { class: 'row', onclick: () => newNote() }, h('span', { class: 'name', style: 'color:var(--dim)' }, '+ Add a note (prompts, research, characters)'));
    empty.addEventListener('dragover', (e) => { if (drag?.kind === 'section') { e.preventDefault(); clearDrop(); empty.classList.add('drop-into'); } });
    empty.addEventListener('drop', (e) => { if (drag?.kind === 'section') { e.preventDefault(); dropSection(nrel, null); } });
    list.append(h('li', {}, empty));
  }
  return [label, list];
}

async function newNote() {
  const b = book();
  if (!b) return;
  const title = await ask('New reference note', { label: 'Note title', okText: 'Add note', note: 'Reference notes sit beside your chapters for you to consult. They aren’t counted or exported.' });
  if (!title) return;
  try {
    const file = await call('section_create', { chapter: `${b.name}/${REFERENCE}`, title, after: b.notes.at(-1)?.file || null });
    await refresh();
    await openSection(`${b.name}/${REFERENCE}/${file}`);
  } catch (e) { toast(String(e)); }
}

function chapterItem(b, c) {
  const crel = `${b.name}/${c.name}`;
  const collapsed = S.collapsed.has(crel);
  const row = h('div', { class: 'row ch-row', draggable: 'true', dataset: { chapter: c.name } },
    h('span', { class: 'twist', onclick: (e) => { e.stopPropagation(); toggle(crel); } }, collapsed ? '▸' : '▾'),
    h('span', { class: 'name' }, c.name),
    h('small', {}, formatCount(liveChapterWords(c))));
  row.addEventListener('dblclick', () => inlineRename(row, crel, c.name));
  row.addEventListener('contextmenu', (e) => { e.preventDefault(); chapterMenu(e, b, c); });
  row.addEventListener('dragstart', (e) => startDrag(e, { kind: 'chapter', name: c.name, rel: crel }, row));
  row.addEventListener('dragend', endDrag);
  row.addEventListener('dragover', (e) => {
    if (!drag) return;
    if (drag.kind === 'chapter' && drag.name !== c.name) { e.preventDefault(); clearDrop(); row.classList.add('drop-before'); }
    if (drag.kind === 'section') { e.preventDefault(); clearDrop(); row.classList.add('drop-into'); }
  });
  row.addEventListener('drop', (e) => {
    if (!drag) return;
    e.preventDefault();
    if (drag.kind === 'chapter') dropChapter(c.name);
    else dropSection(crel, null);
  });
  const secs = h('ol', { class: 'secs' }, c.sections.map((s) => sectionRow(relOf(b.name, c.name, s.file), s, false)));
  if (!c.sections.length) {
    const empty = h('li', {}, h('div', { class: 'row', onclick: () => newSection(crel) }, h('span', { class: 'name', style: 'color:var(--dim)' }, '+ Add a section')));
    secs.append(empty);
  }
  return h('li', { class: collapsed ? 'collapsed' : '' }, row, secs);
}

function sectionRow(rel, s, inbox) {
  const active = S.current?.rel === rel;
  const words = active ? wordCount(editor.text()) : s.words;
  const row = h('div', {
    class: 'row' + (active ? ' active' : '') + (s.conflict ? ' conflict' : ''),
    draggable: 'true',
    title: s.conflict ? 'This looks like a duplicate made by Google Drive. Compare it with the original and keep what you need.' : s.title,
  }, h('span', { class: 'name' }, s.title), h('small', {}, formatCount(words)));
  row.addEventListener('click', () => openSection(rel));
  row.addEventListener('dblclick', () => inlineRename(row, rel, s.title));
  row.addEventListener('contextmenu', (e) => { e.preventDefault(); sectionMenu(e, rel, s, inbox); });
  row.addEventListener('dragstart', (e) => startDrag(e, { kind: 'section', rel, file: s.file, inbox }, row));
  row.addEventListener('dragend', endDrag);
  if (!inbox) {
    row.addEventListener('dragover', (e) => { if (drag?.kind === 'section' && drag.rel !== rel) { e.preventDefault(); clearDrop(); row.classList.add('drop-before'); } });
    row.addEventListener('drop', (e) => {
      if (drag?.kind !== 'section') return;
      e.preventDefault();
      const [b, c, f] = rel.split('/');
      dropSection(`${b}/${c}`, f);
    });
  }
  return h('li', {}, row);
}

function toggle(key) {
  S.collapsed.has(key) ? S.collapsed.delete(key) : S.collapsed.add(key);
  store.set('ws-collapsed', [...S.collapsed]);
  renderSidebar();
}

// ------------------------------------------------------------------ drag and drop

let drag = null;
function startDrag(e, info, row) {
  drag = info;
  row.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  try { e.dataTransfer.setData('text/plain', info.rel); } catch { /* fine */ }
  e.stopPropagation();
}
function endDrag() { document.querySelectorAll('.dragging').forEach((x) => x.classList.remove('dragging')); clearDrop(); drag = null; }
function clearDrop() { document.querySelectorAll('.drop-before, .drop-into').forEach((x) => x.classList.remove('drop-before', 'drop-into')); }

async function dropSection(chapterRel, beforeFile) {
  const d = drag; endDrag();
  if (!d) return;
  const [bName, cName] = chapterRel.split('/');
  const bk = S.lib.books.find((x) => x.name === bName);
  const list = cName === REFERENCE ? bk?.notes : bk?.chapters.find((x) => x.name === cName)?.sections;
  if (!list) return;
  const sameChapter = d.rel.startsWith(chapterRel + '/');
  const names = list.map((s) => s.file);
  const index = dropIndex(names, sameChapter ? d.file : null, beforeFile);
  await moveItem(d.rel, chapterRel, index);
}

async function dropChapter(beforeName) {
  const d = drag; endDrag();
  const b = book();
  if (!d || !b) return;
  const names = b.chapters.map((c) => c.name).filter((n) => n !== d.name);
  const i = beforeName == null ? names.length : Math.max(0, names.indexOf(beforeName));
  names.splice(i, 0, d.name);
  try { await call('order_set', { dir: b.name, names }); } catch (e) { toast(String(e)); }
  await refresh();
}

async function moveItem(fromRel, toDir, index) {
  const isCurrent = S.current?.rel === fromRel;
  if (isCurrent) await flushSave();
  try {
    const newRel = await call('item_move', { from: fromRel, toDir, index });
    remapTargets(fromRel, newRel);
    if (isCurrent) setCurrentRel(newRel);
  } catch (e) { toast(String(e)); }
  await refresh();
  if (isCurrent) updateChrome();
}

/** "Book/Chapter/Section.md" or "Writing Studio - Inbox/Note.md" → its parts. */
function parseRel(rel) {
  const parts = rel.split('/');
  const file = parts.at(-1);
  return { rel, book: parts[0], chapter: parts.length > 2 ? parts[1] : null, file, title: file.replace(/\.md$/i, ''), inbox: parts[0] === INBOX, note: parts[1] === REFERENCE };
}

function setCurrentRel(rel) {
  Object.assign(S.current, parseRel(rel));
  if (!S.current.inbox) store.set('ws-last-' + S.book, rel);
}

// ------------------------------------------------------------------ creating, renaming, deleting

async function newBook() {
  const title = await ask('New book', { label: 'Title', okText: 'Create book' });
  if (!title) return;
  await flushSave();
  try {
    const name = await call('book_create', { title });
    S.book = name;
    await refresh();
    await openSection(firstSection());
  } catch (e) { toast(String(e)); }
}

async function newChapter(after) {
  const b = book();
  if (!b) return newBook();
  const title = await ask('New chapter', { label: 'Chapter title', okText: 'Add chapter' });
  if (!title) return;
  try {
    const after2 = after ?? (S.current && !S.current.inbox ? S.current.chapter : b.chapters.at(-1)?.name);
    const name = await call('chapter_create', { book: b.name, title, after: after2 || null });
    const file = await call('section_create', { chapter: `${b.name}/${name}`, title: 'Opening', after: null });
    await refresh();
    await openSection(relOf(b.name, name, file));
  } catch (e) { toast(String(e)); }
}

async function newSection(chapterRel, afterFile) {
  let target = chapterRel;
  if (!target) {
    if (S.current && !S.current.inbox) { target = `${S.current.book}/${S.current.chapter}`; afterFile = S.current.file; }
    else { const b = book(); const c = b?.chapters.at(-1); if (!c) return newChapter(); target = `${b.name}/${c.name}`; }
  }
  const title = await ask('New section', { label: 'Section title', okText: 'Add section' });
  if (!title) return;
  try {
    const file = await call('section_create', { chapter: target, title, after: afterFile || null });
    await refresh();
    await openSection(`${target}/${file}`);
  } catch (e) { toast(String(e)); }
}

function inlineRename(row, rel, current) {
  const nameEl = row.querySelector('.name');
  const input = h('input', { class: 'rename', type: 'text', value: current, 'aria-label': 'New name' });
  nameEl.replaceWith(input);
  row.draggable = false;
  input.focus(); input.select();
  let done = false;
  const finish = async (commit) => {
    if (done) return; done = true;
    const v = input.value.trim();
    if (commit && v && v !== current) await renameItem(rel, v); else renderSidebar();
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); e.stopPropagation(); });
  input.addEventListener('blur', () => finish(true));
}

async function renameItem(rel, title) {
  const affectsCurrent = S.current && (S.current.rel === rel || S.current.rel.startsWith(rel + '/'));
  if (affectsCurrent) await flushSave();
  try {
    const newRel = await call('item_rename', { rel, title });
    remapTargets(rel, newRel);
    if (affectsCurrent) setCurrentRel(S.current.rel === rel ? newRel : newRel + S.current.rel.slice(rel.length));
    if (S.book === rel) S.book = newRel;
    const parts = rel.split('/');
    if (parts.length === 2 && S.collapsed.has(rel)) { S.collapsed.delete(rel); S.collapsed.add(newRel); }
  } catch (e) { toast(String(e)); }
  await refresh();
  updateChrome();
}

async function trashItem(rel, label) {
  const ok = await confirmBox(`Move “${label}” to the Trash folder?`,
    'It moves to “Writing Studio - Trash” in your Drive folder with today’s date, so you can always get it back.', 'Move to Trash');
  if (!ok) return;
  const affectsCurrent = S.current && (S.current.rel === rel || S.current.rel.startsWith(rel + '/'));
  if (affectsCurrent) { await flushSave(); S.current = null; }
  try { await call('item_trash', { rel }); toast('Moved to Writing Studio - Trash'); } catch (e) { toast(String(e)); }
  await refresh();
  if (affectsCurrent || !S.current) {
    const first = firstSection();
    if (first) await openSection(first); else showEmptyMain();
  }
}

function sectionMenu(e, rel, s, inbox) {
  const items = [{ label: 'Rename', run: () => { const row = e.target.closest('.row'); inlineRename(row, rel, s.title); } }];
  const isNote = rel.split('/')[1] === REFERENCE;
  if (isNote || inbox) items.push({ label: 'Open beside your writing', run: () => openPanel(rel) });
  if (isNote) {
    items.push({ label: 'New note', run: () => newNote() });
  } else if (!inbox) {
    const [b, c, f] = rel.split('/');
    items.push({ label: 'New section below', run: () => newSection(`${b}/${c}`, f) });
    items.push({ label: S.settings.targets?.[rel] ? 'Change word target…' : 'Set a word target…', run: () => targetDialog(rel, s.title) });
  } else {
    items.push({ label: 'File into a chapter…', run: async () => { await openSection(rel); } });
  }
  items.push('-', { label: 'Move to Trash', danger: true, run: () => trashItem(rel, s.title) });
  menu(e.clientX, e.clientY, items);
}

function chapterMenu(e, b, c) {
  const crel = `${b.name}/${c.name}`;
  menu(e.clientX, e.clientY, [
    { label: 'Rename chapter', run: () => inlineRename(e.target.closest('.row'), crel, c.name) },
    { label: 'New section in this chapter', run: () => newSection(crel, c.sections.at(-1)?.file) },
    { label: 'New chapter below', run: () => newChapter(c.name) },
    '-',
    { label: 'Move chapter to Trash', danger: true, run: () => trashItem(crel, c.name) },
  ]);
}

function bookMenu(e) {
  const b = book();
  const r = e.currentTarget.getBoundingClientRect();
  menu(r.left, r.bottom + 4, [
    { label: 'Rename book', run: async () => {
      const t = await ask('Rename book', { label: 'Title', value: b.title, okText: 'Rename' });
      if (t) await renameItem(b.name, t);
    } },
    { label: b.goal ? 'Change word goal' : 'Set a word goal', run: goalDialog },
    { label: 'Export to Word…', run: exportWord },
    { label: 'Export to PDF…', run: exportPdf },
    { label: 'Export to Markdown…', run: exportBook },
    { label: 'Backups and restore…', run: backupsDialog },
    '-',
    { label: 'New book…', run: newBook },
    { label: 'Move book to Trash', danger: true, run: () => trashItem(b.name, b.title) },
  ]);
}

async function goalDialog() {
  const b = book();
  const v = await ask('Word goal for this book', { label: 'Words', value: b.goal ? String(b.goal) : '', okText: 'Save goal', note: 'Leave empty to remove the goal.' });
  if (v === null && b.goal == null) return;
  const n = parseInt(String(v || '').replace(/[^\d]/g, ''), 10);
  try {
    if (!v || !n) await call('book_meta_set', { book: b.name, clearGoal: true });
    else await call('book_meta_set', { book: b.name, goal: n });
  } catch (e) { toast(String(e)); }
  await refresh();
}

async function exportBook() {
  const b = book();
  await flushSave();
  try {
    const text = await call('book_export', { book: b.name });
    const path = await saveDialog({ defaultPath: `${b.title} - Manuscript ${stamp().slice(0, 10)}.md`, filters: [{ name: 'Markdown', extensions: ['md'] }] });
    if (!path) return;
    await invoke('export_write', { path, text });
    toast('Exported the whole book');
  } catch (e) { toast(String(e)); }
}

async function switchBook(name) {
  await flushSave();
  S.book = name;
  store.set('ws-book', name);
  renderSidebar();
  const last = store.get('ws-last-' + name);
  const target = last && findSection(last) ? last : firstSection();
  if (target) await openSection(target); else { S.current = null; showEmptyMain(); }
}

// ------------------------------------------------------------------ opening and saving

function showEmptyMain() {
  S.current = null;
  editor.load('');
  $('#crumb').textContent = '';
  const slot = $('#banner-slot');
  if (!S.lib.books.length) {
    const input = h('input', { type: 'text', placeholder: 'Book title', id: 'first-book' });
    slot.replaceChildren(h('div', { class: 'banner', style: 'margin-top:40px' },
      h('span', {}, 'Start your first book:'), input,
      h('button', { onclick: async () => {
        const title = input.value.trim(); if (!title) return input.focus();
        const name = await call('book_create', { title });
        S.book = name; await refresh(); await openSection(firstSection());
      } }, 'Create')));
    input.focus();
  } else slot.replaceChildren();
  renderFoot();
}

async function openSection(rel) {
  if (!rel) return;
  if (S.current?.rel === rel) { editor.focus(); return; }
  await flushSave();
  let loaded;
  try { loaded = await call('section_read', { rel }); } catch (e) { toast(String(e)); await refresh(); return; }
  S.current = { ...parseRel(rel), hash: loaded.hash, words: wordCount(loaded.text) };
  const b = S.current.book;
  if (!S.current.inbox) { S.book = b; store.set('ws-book', b); store.set('ws-last-' + b, rel); }
  S.dirty = false;
  editor.load(loaded.text);
  setStatus('', 'Saved');
  renderSidebar();
  updateChrome();
  editor.focus();
  // Text from a save that never finished (power cut, crash)?
  const draft = store.get('ws-draft:' + rel);
  if (draft && draft.text !== loaded.text && draft.base === loaded.hash) {
    S.dirty = true;
    editor.load(draft.text);
    toast('Recovered text that had not finished saving');
    scheduleSave(200);
  } else if (draft && draft.text !== loaded.text) {
    showConflict(draft.text, loaded.text, loaded.hash, { recovered: true });
  } else if (draft) store.del('ws-draft:' + rel);
  pingActivity();
  checkOtherDevice();
}

function updateChrome() {
  const c = S.current;
  $('#crumb').textContent = !c ? '' : c.inbox ? `Inbox › ${c.title}` : `${book()?.title || c.book} › ${c.note ? 'Reference' : c.chapter} › ${c.title}`;
  renderBanner();
  renderFoot();
}

function renderBanner(otherDevice) {
  const slot = $('#banner-slot');
  if (!slot) return;
  const kids = [];
  if (otherDevice) {
    kids.push(h('div', { class: 'banner' },
      h('span', {}, `Also open on ${otherDevice.device} (active ${minutesAgo(otherDevice.at)}). Its changes appear here once Google Drive syncs them; neither version is ever overwritten.`),
      h('button', { onclick: () => renderBanner() }, 'OK')));
  }
  if (S.current?.inbox) {
    const b = book();
    const sel = h('select', { id: 'file-into', 'aria-label': 'Chapter' },
      ...(b?.chapters || []).map((c) => h('option', { value: `${b.name}/${c.name}` }, c.name)),
      b ? h('option', { value: `${b.name}/${REFERENCE}` }, 'Reference notes') : null);
    kids.push(h('div', { class: 'banner' },
      h('span', {}, 'Captured on your iPhone. File it into'), sel,
      h('button', { onclick: async () => {
        if (!sel.value) return;
        const bk = S.lib.books.find((x) => x.name === b.name);
        const isRef = sel.value.endsWith('/' + REFERENCE);
        const ch = isRef ? { name: 'Reference notes', sections: bk.notes } : bk.chapters.find((x) => `${b.name}/${x.name}` === sel.value);
        await moveItem(S.current.rel, sel.value, ch.sections.length);
        toast(`Filed into ${ch.name}`);
      } }, 'Move')));
  }
  slot.replaceChildren(...kids);
}

function liveChapterWords(c) {
  const cur = S.current;
  if (!cur || cur.inbox || cur.book !== S.book || cur.chapter !== c.name) return c.words;
  const s = c.sections.find((x) => x.file === cur.file);
  return c.words - (s?.words || 0) + wordCount(editor.text());
}
function liveBookWords() {
  const b = book();
  return b ? b.chapters.reduce((n, c) => n + liveChapterWords(c), 0) : 0;
}

let footTimer = null;
function renderFoot() {
  const foot = $('#foot');
  if (!foot) return;
  const b = book();
  const parts = [];
  if (S.current) parts.push(`${formatCount(wordCount(editor.text()))} words`);
  if (S.current && !S.current.inbox) {
    const c = b?.chapters.find((x) => x.name === S.current.chapter);
    if (c) parts.push(`Chapter ${formatCount(liveChapterWords(c))}`);
  }
  if (b) parts.push(b.goal ? `Book ${formatCount(liveBookWords())} / ${formatCount(b.goal)}` : `Book ${formatCount(liveBookWords())}`);
  const kids = parts.map((p) => h('span', {}, p));
  const target = S.current && S.settings.targets?.[S.current.rel];
  if (target) kids.unshift(goalChip(wordCount(editor.text()), target, `Section target: ${formatCount(wordCount(editor.text()))} of ${formatCount(target)} words`, () => targetDialog(S.current.rel, S.current.title)));
  if (S.settings.dailyGoal) {
    const today = todayWords();
    const streak = streakDays();
    kids.unshift(goalChip(Math.max(0, today), S.settings.dailyGoal, `Today: ${formatCount(Math.max(0, today))} of ${formatCount(S.settings.dailyGoal)} words${streak > 1 ? ` · ${streak}-day streak` : ''}`, goalsDialog, `Today ${formatCount(Math.max(0, today))}${streak > 1 ? ` · ${streak} days` : ''}`));
  }
  foot.replaceChildren(...kids);
}

function onChange(text) {
  if (!S.current || S.conflictOpen) return;
  S.dirty = true;
  store.set('ws-draft:' + S.current.rel, { text, base: S.current.hash, at: Date.now() });
  setStatus('editing', 'Editing');
  clearTimeout(footTimer);
  footTimer = setTimeout(() => { renderFoot(); const row = $('#side .row.active small'); if (row) row.textContent = formatCount(wordCount(text)); }, 250);
  if (!S.current.inbox) bookEdited(S.current.book);
  scheduleSave(1000);
}

function scheduleSave(ms) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, ms);
}

async function save() {
  clearTimeout(saveTimer);
  const cur = S.current;
  if (!cur || !S.dirty || S.conflictOpen) return;
  if (S.saving) { S.again = true; return; }
  S.saving = true;
  setStatus('editing', 'Saving');
  const text = editor.text();
  try {
    const res = await call('section_save', { rel: cur.rel, text, baseHash: cur.hash });
    if (S.current !== cur) return; // switched away meanwhile; that path flushed already
    if (res.status === 'conflict') {
      showConflict(editor.text(), res.disk_text, res.hash);
    } else {
      cur.hash = res.hash;
      const words = wordCount(text);
      if (!cur.inbox && !cur.note) addProgress(words - (cur.words ?? words));
      cur.words = words;
      S.savedHashes = [res.hash, ...S.savedHashes].slice(0, 20);
      if (editor.text() === text) {
        S.dirty = false;
        store.del('ws-draft:' + cur.rel);
        setStatus('', 'Saved');
        if (panelRel === cur.rel) renderPanel();
      }
    }
  } catch (e) {
    setStatus('error', 'Not saved yet, retrying');
    console.error(e);
    scheduleSave(5000);
  } finally {
    S.saving = false;
    if (S.again) { S.again = false; scheduleSave(300); }
  }
}

/** Save now and wait until everything typed so far is on disk. */
async function flushSave() {
  clearTimeout(saveTimer); saveTimer = null;
  for (let i = 0; i < 50 && S.saving; i++) await sleep(60);
  if (S.dirty && !S.conflictOpen) await save();
  for (let i = 0; i < 50 && S.saving; i++) await sleep(60);
}

// ------------------------------------------------------------------ changes from the other Mac

let changeTimer = null;
let changedPaths = new Set();
function onLibraryChanged(paths) {
  paths.forEach((p) => changedPaths.add(p));
  clearTimeout(changeTimer);
  changeTimer = setTimeout(async () => {
    const paths2 = [...changedPaths]; changedPaths = new Set();
    // Ignore our own housekeeping files.
    if (paths2.every((p) => p.startsWith('Writing Studio - App Data') || p.startsWith('Writing Studio - Backups'))) return;
    await refresh();
    if (S.current && paths2.some((p) => p === S.current.rel)) await checkCurrentOnDisk();
    if (panelRel && paths2.some((p) => p === panelRel)) await renderPanel();
  }, 500);
}

async function checkCurrentOnDisk() {
  const cur = S.current;
  if (!cur || S.conflictOpen) return;
  if (S.saving) { setTimeout(checkCurrentOnDisk, 400); return; }
  let disk;
  try { disk = await call('section_read', { rel: cur.rel }); } catch {
    if (S.current === cur) toast('This section was moved or renamed elsewhere. Your text is safe here and will be saved again.');
    return;
  }
  if (S.current !== cur || disk.hash === cur.hash || S.savedHashes.includes(disk.hash)) return;
  if (!S.dirty) {
    const pos = editor.cursor();
    cur.hash = disk.hash;
    cur.words = wordCount(disk.text);
    editor.load(disk.text, pos);
    S.dirty = false;
    renderFoot();
    toast('Updated with changes from your other Mac');
  } else {
    showConflict(editor.text(), disk.text, disk.hash);
  }
}

function showConflict(mine, theirs, theirHash, { recovered = false } = {}) {
  if (S.conflictOpen) return;
  S.conflictOpen = true;
  clearTimeout(saveTimer);
  const cur = S.current;
  const rows = lineDiff(mine, theirs);
  const col = (side) => h('pre', {}, rows.filter((r) => r.type === 'same' || r.type === side)
    .map((r) => h('span', { class: r.type === 'same' ? '' : 'only' }, r.text + '\n')));
  const finish = async (choice, close) => {
    try {
      if (choice === 'mine' || choice === 'both') {
        const res = await call('section_save', { rel: cur.rel, text: mine, baseHash: theirHash });
        cur.hash = res.hash;
      }
      if (choice === 'theirs') {
        cur.hash = theirHash;
        if (S.current === cur) editor.load(theirs);
      }
      if (choice === 'both') {
        const dir = cur.rel.split('/').slice(0, -1).join('/');
        const label = recovered ? 'unsaved text' : 'other Mac';
        const file = await call('section_create', { chapter: dir, title: `${cur.title} (${label} ${stamp()})`, after: cur.file });
        await call('section_save', { rel: `${dir}/${file}`, text: theirs, baseHash: null });
        // In "both", the copy holds the disk version and this section keeps the text from this Mac.
      }
      store.del('ws-draft:' + cur.rel);
      S.dirty = false;
      setStatus('', 'Saved');
    } catch (e) { toast(String(e), 6000); return; }
    S.conflictOpen = false;
    close();
    await refresh();
  };
  dialog((box, close, overlay) => {
    overlay.dataset.locked = '1';
    box.append(
      h('h2', {}, recovered ? 'Unsaved text was recovered' : 'This section changed on another Mac'),
      h('p', {}, recovered
        ? 'Writing Studio found text that hadn’t finished saving, and the file has changed since. Choose what to keep. Highlighted lines are different.'
        : `“${cur.title}” was edited somewhere else while you were writing here. Nothing has been overwritten. Choose what to keep. Highlighted lines are different.`),
      h('div', { class: 'compare' },
        h('div', {}, h('h3', {}, recovered ? 'Recovered text' : `On this Mac (${S.device})`), col('left')),
        h('div', {}, h('h3', {}, recovered ? 'Saved file' : 'From the other Mac'), col('right'))),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: () => finish('theirs', close) }, recovered ? 'Keep the saved file' : 'Keep the other version'),
        h('button', { class: 'btn', onclick: () => finish('mine', close) }, recovered ? 'Keep the recovered text' : 'Keep this Mac’s version'),
        h('button', { class: 'btn primary', onclick: () => finish('both', close) }, 'Keep both')),
    );
  }, { wide: true });
}

// ------------------------------------------------------------------ two Macs: activity notes

async function pingActivity() {
  if (!S.root) return;
  try { await call('activity_write', { activity: { device: S.device, section: S.current?.rel || null, at: Date.now() } }); } catch { /* not critical */ }
}

async function checkOtherDevice() {
  if (!S.current) return;
  try {
    const acts = await call('activity_read');
    const other = otherDeviceOn(acts, S.device, S.current.rel, Date.now());
    if (other) renderBanner(other);
  } catch { /* not critical */ }
}

// ------------------------------------------------------------------ backups

async function bookEdited(name) {
  S.editedBooks.add(name);
  // Snapshot before the first change of a session, so a bad edit can always be undone.
  if (!S.snappedThisSession.has(name)) {
    S.snappedThisSession.add(name);
    if (snapshotDue(store.get('ws-snap-' + name, 0), Date.now())) await takeSnapshot(name);
  }
}

async function takeSnapshot(name) {
  try {
    await call('snapshot_take', { book: name, device: S.device });
    store.set('ws-snap-' + name, Date.now());
    S.editedBooks.delete(name);
  } catch (e) { console.error('Snapshot failed', e); }
}

async function snapshotTick() {
  for (const name of [...S.editedBooks]) {
    if (snapshotDue(store.get('ws-snap-' + name, 0), Date.now())) { await flushSave(); await takeSnapshot(name); }
  }
}

async function backupsDialog() {
  const b = book();
  if (!b) return;
  await flushSave();
  const list = await call('snapshot_list', { book: b.name }).catch(() => []);
  const local = await invoke('local_backup_folder').catch(() => '');
  dialog((box, close) => {
    const items = list.map((s) => h('div', { class: 'snap' },
      h('span', {}, s.when, ' ', h('small', {}, `from ${s.device}`)),
      h('button', { class: 'btn', onclick: async () => {
        try {
          const name = await call('snapshot_restore', { book: b.name, file: s.file });
          close();
          await refresh();
          await switchBook(name);
          toast('Restored as a separate book. Copy what you need back into the original.', 6000);
        } catch (e) { toast(String(e)); }
      } }, 'Restore as a copy')));
    box.append(
      h('h2', {}, `Backups of “${b.title}”`),
      h('p', {}, 'A snapshot is taken when you start writing in a session and then every hour while you write. Restoring never replaces your book: it opens the snapshot as a separate book next to it.'),
      list.length ? h('div', { class: 'snap-list' }, items) : h('p', {}, 'No snapshots yet. The first one is taken as soon as you start typing.'),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: async () => { await takeSnapshot(b.name); close(); toast('Snapshot saved'); } }, 'Take a snapshot now'),
        h('button', { class: 'btn primary', onclick: close }, 'Done')),
      h('p', { class: 'path' }, `Also copied on this Mac to: ${local}`),
    );
  });
}

// ------------------------------------------------------------------ settings

function settingsDialog() {
  dialog((box, close) => {
    const chips = (id, options, key) => h('div', { class: 'chips', id },
      ...Object.entries(options).map(([v, label]) => h('button', {
        id: `${id}-${v}`, 'aria-pressed': String(S.settings[key] === v),
        onclick: (e) => {
          S.settings[key] = v; saveSettings();
          e.currentTarget.parentElement.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === e.currentTarget)));
        },
      }, label)));
    const sizeOut = h('span', {}, `Text size · ${S.settings.size}px`);
    const measureOut = h('span', {}, `Line width · about ${Math.round(S.settings.measure * 2)} characters`);
    box.append(
      h('h2', {}, 'Look & settings'),
      h('div', { class: 'field' }, h('span', {}, 'Look'), chips('look', LOOKS, 'look')),
      h('div', { class: 'field' }, h('span', {}, 'Writing font'), chips('font', Object.fromEntries(Object.entries(FONTS).map(([k, v]) => [k, v.name])), 'font')),
      h('label', { class: 'field' }, sizeOut, h('input', { type: 'range', id: 'size', min: 14, max: 26, value: S.settings.size,
        oninput: (e) => { S.settings.size = +e.target.value; sizeOut.textContent = `Text size · ${S.settings.size}px`; saveSettings(); } })),
      h('label', { class: 'field' }, measureOut, h('input', { type: 'range', id: 'measure', min: 24, max: 46, value: S.settings.measure,
        oninput: (e) => { S.settings.measure = +e.target.value; measureOut.textContent = `Line width · about ${Math.round(S.settings.measure * 2)} characters`; saveSettings(); } })),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', id: 'typewriter', checked: !!S.settings.typewriter,
        onchange: (e) => { S.settings.typewriter = e.target.checked; saveSettings(); } }), 'Typewriter scrolling (keep the line you’re writing in the middle)'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', id: 'smart', checked: S.settings.smart !== false,
        onchange: (e) => { S.settings.smart = e.target.checked; saveSettings(); } }), 'Smart quotes and dashes (“curly” quotes, -- becomes —, ... becomes …)'),
      h('p', {}, h('a', { href: '#', onclick: (e) => { e.preventDefault(); close(); shortcutsDialog(); } }, 'Formatting and keyboard shortcuts')),
      h('div', { class: 'field' }, h('span', {}, 'Writing folder'), h('div', { class: 'path' }, S.root),
        h('div', {}, h('button', { class: 'btn', onclick: () => { close(); chooseFolder(); } }, 'Change folder…'))),
      h('div', { class: 'field' }, h('span', {}, 'Updates'), h('div', { class: 'path', id: 'version-line' }, 'Writing Studio'),
        h('div', {}, h('button', { class: 'btn', onclick: () => checkForUpdates(true) }, 'Check for updates'))),
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: close }, 'Done')),
    );
    getVersion().then((v) => { const el = $('#version-line'); if (el) el.textContent = `Writing Studio ${v}`; }).catch(() => {});
  });
}

// ------------------------------------------------------------------ reference panel (read beside the text)

let panelRel = null;

const escHtml = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function inline(text) {
  const span = document.createElement('span');
  span.innerHTML = escHtml(text)
    .replace(/\*\*(?=\S)(.+?\S)\*\*/g, '<b>$1</b>').replace(/__(?=\S)(.+?\S)__/g, '<b>$1</b>')
    .replace(/~~(?=\S)(.+?\S)~~/g, '<s>$1</s>')
    .replace(/\*(?=\S)(.+?\S)\*/g, '<i>$1</i>').replace(/(^|\W)_(?=\S)(.+?\S)_(?=\W|$)/g, '$1<i>$2</i>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<u>$1</u>');
  return span;
}

function lightMarkdown(text) {
  // Headings and list bullets get a little shape; everything else stays as written.
  text = text.replace(/<!--[\s\S]*?(-->|$)/g, '');
  return text.split('\n').map((line) => {
    const m = line.match(/^(#{1,6})\s+(.*)$/);
    if (m) return h('div', { class: `ref-h ref-h${Math.min(m[1].length, 3)}` }, inline(m[2]));
    const task = line.match(/^\s*[-*+]\s+\[([ xX])\]\s*(.*)$/);
    if (task) return h('div', { class: 'ref-li' + (task[1] === ' ' ? '' : ' ref-done') }, h('span', { class: 'ref-bullet' }, task[1] === ' ' ? '☐' : '☑'), inline(task[2]));
    const li = line.match(/^\s*([-*+]|\d+\.)\s+(.*)$/);
    if (li) return h('div', { class: 'ref-li' }, h('span', { class: 'ref-bullet' }, /\d/.test(li[1]) ? li[1] : '•'), inline(li[2]));
    if (!line.trim()) return h('div', { class: 'ref-gap' });
    const q = line.match(/^>\s?(.*)$/);
    if (q) return h('div', { class: 'ref-p ref-q' }, inline(q[1]));
    return h('div', { class: 'ref-p' }, inline(line));
  });
}

async function openPanel(rel) {
  panelRel = rel;
  store.set('ws-panel', rel);
  document.body.classList.add('with-ref');
  await renderPanel();
}

function closePanel() {
  document.body.classList.remove('with-ref');
  panelRel = null;
  store.del('ws-panel');
}

async function renderPanel() {
  const panel = $('#ref-panel');
  if (!panel || !panelRel) return;
  const b = book();
  const notes = b?.notes || [];
  let text = '';
  try { text = (await call('section_read', { rel: panelRel })).text; } catch { closePanel(); return; }
  const title = panelRel.split('/').at(-1).replace(/\.md$/i, '');
  const pick = h('select', { id: 'ref-pick', 'aria-label': 'Reference note', onchange: (e) => openPanel(e.target.value) },
    ...notes.map((n) => h('option', { value: `${b.name}/${REFERENCE}/${n.file}`, selected: `${b.name}/${REFERENCE}/${n.file}` === panelRel }, n.title)),
    notes.some((n) => `${b.name}/${REFERENCE}/${n.file}` === panelRel) ? null : h('option', { value: panelRel, selected: true }, title));
  panel.replaceChildren(
    h('div', { class: 'ref-head' }, pick,
      h('button', { class: 'icon-btn', title: 'Edit this note', onclick: () => openSection(panelRel) }, 'Edit'),
      h('button', { class: 'icon-btn', title: 'Close (⌘2)', 'aria-label': 'Close', onclick: closePanel }, '✕')),
    h('div', { class: 'ref-body' }, text.trim() ? lightMarkdown(text) : h('p', { class: 'ref-p', style: 'color:var(--dim)' }, 'This note is empty.')),
  );
}

function togglePanel() {
  if (document.body.classList.contains('with-ref')) return closePanel();
  const b = book();
  const last = store.get('ws-panel');
  const target = last && findSection(last) ? last : b?.notes[0] ? `${b.name}/${REFERENCE}/${b.notes[0].file}` : null;
  if (target) openPanel(target); else toast('Add a reference note first (the + next to Reference)');
}

// ------------------------------------------------------------------ updates

let pendingUpdate = null;
async function checkForUpdates(manual = false) {
  try {
    const u = await checkUpdate();
    if (u) {
      pendingUpdate = u;
      const slot = $('#update-slot');
      if (slot) slot.replaceChildren(h('button', { class: 'update-pill', onclick: installUpdate, title: 'Install the new version and restart' }, `Update to ${u.version}`));
      if (manual) toast(`Version ${u.version} is available`);
    } else if (manual) toast('Writing Studio is up to date');
  } catch (e) {
    if (manual) toast(`Couldn’t check for updates: ${e}`, 6000);
  }
}

async function installUpdate() {
  if (!pendingUpdate) return;
  const ok = await confirmBox(`Update to version ${pendingUpdate.version}?`,
    'Your writing is saved first. Writing Studio then installs the update and restarts, which takes a few seconds.', 'Update and restart');
  if (!ok) return;
  await flushSave();
  setStatus('editing', 'Updating');
  try {
    await pendingUpdate.downloadAndInstall();
    await relaunch();
  } catch (e) {
    setStatus('error', 'Update failed');
    toast(`The update didn’t install: ${e}. Your writing is untouched.`, 8000);
  }
}

// ------------------------------------------------------------------ links

async function linkDialog() {
  const url = await ask('Add a link', { label: 'Web address', value: 'https://', okText: 'Add link', note: 'Select words first to turn them into the link; otherwise the address itself is added.' });
  if (url && url !== 'https://') editor.link(/^[a-z]+:/i.test(url) ? url : 'https://' + url);
}

// ------------------------------------------------------------------ quick open (⌘O)

function allSections() {
  const out = [];
  for (const b of S.lib?.books || []) {
    for (const c of b.chapters) for (const s of c.sections) out.push({ rel: relOf(b.name, c.name, s.file), title: s.title, where: `${b.title} › ${c.name}`, book: b.name });
    for (const s of b.notes) out.push({ rel: `${b.name}/${REFERENCE}/${s.file}`, title: s.title, where: `${b.title} › Reference`, book: b.name });
  }
  for (const s of S.lib?.inbox || []) out.push({ rel: `${INBOX}/${s.file}`, title: s.title, where: 'Inbox' });
  return out;
}

/** Letters of `q` appear in order in `text`; a lower score is a better match. */
export function fuzzyScore(q, text) {
  q = q.toLowerCase(); text = text.toLowerCase();
  if (!q) return 0;
  const at = text.indexOf(q);
  if (at >= 0) return at === 0 ? 0 : 1 + at / 100;
  let i = 0, gaps = 0, last = -1;
  for (const ch of q) {
    const j = text.indexOf(ch, i);
    if (j < 0) return null;
    if (last >= 0) gaps += j - last - 1;
    last = j; i = j + 1;
  }
  return 10 + gaps;
}

function quickOpen() {
  if (!S.lib) return;
  dialog((box, close) => {
    const items = allSections();
    let shown = [], sel = 0;
    const input = h('input', { type: 'text', id: 'qo-input', placeholder: 'Type a section name…', autocomplete: 'off', spellcheck: 'false' });
    const list = h('div', { class: 'qo-list', role: 'listbox' });
    const go = async (it) => { if (!it) return; close(); await openSection(it.rel); };
    const render = () => {
      const q = input.value.trim();
      shown = items.map((it) => ({ it, sc: fuzzyScore(q, it.title) ?? (fuzzyScore(q, it.where + ' ' + it.title) ?? null) }))
        .filter((x) => x.sc !== null)
        .sort((a, b) => a.sc - b.sc || (a.it.book === S.book ? -1 : 1))
        .slice(0, 30).map((x) => x.it);
      sel = Math.min(sel, Math.max(0, shown.length - 1));
      list.replaceChildren(...shown.map((it, i) => h('button', { class: 'qo-item' + (i === sel ? ' on' : ''), role: 'option', onclick: () => go(it) },
        h('span', { class: 'qo-title' }, it.title), h('span', { class: 'qo-where' }, it.where))));
      if (!shown.length) list.append(h('div', { class: 'qo-empty' }, 'No section matches'));
      list.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
    };
    input.addEventListener('input', () => { sel = 0; render(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, shown.length - 1); render(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); render(); }
      else if (e.key === 'Enter') { e.preventDefault(); go(shown[sel]); }
      else if (e.key === 'Escape') close();
    });
    box.classList.add('qo');
    box.append(input, list);
    render();
    setTimeout(() => input.focus());
  });
}

// ------------------------------------------------------------------ find in book (⇧⌘F)

async function bookTexts(b) {
  const out = [];
  const add = async (rel, title, where) => {
    const text = S.current?.rel === rel ? editor.text() : (await call('section_read', { rel }).catch(() => null))?.text;
    if (text != null) out.push({ rel, title, where, text });
  };
  for (const c of b.chapters) for (const s of c.sections) await add(relOf(b.name, c.name, s.file), s.title, c.name);
  for (const s of b.notes) await add(`${b.name}/${REFERENCE}/${s.file}`, s.title, 'Reference');
  return out;
}

export function findAll(text, q, matchCase) {
  if (!q) return [];
  const hay = matchCase ? text : text.toLowerCase(), needle = matchCase ? q : q.toLowerCase();
  const out = [];
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) out.push(i);
  return out;
}

function findInBook() {
  const b = book();
  if (!b) return;
  dialog((box, close) => {
    const find = h('input', { type: 'text', id: 'fb-find', placeholder: 'Find in this book', autocomplete: 'off' });
    const repl = h('input', { type: 'text', id: 'fb-replace', placeholder: 'Replace with', autocomplete: 'off' });
    const caseBox = h('input', { type: 'checkbox', id: 'fb-case' });
    const summary = h('p', { class: 'fb-summary' });
    const results = h('div', { class: 'fb-results' });
    const replBtn = h('button', { class: 'btn', id: 'fb-replace-all', disabled: true }, 'Replace all');
    let texts = null, hits = [], timer = null;
    const run = async () => {
      const q = find.value;
      texts = texts || await bookTexts(b);
      hits = q ? texts.map((t) => ({ ...t, at: findAll(t.text, q, caseBox.checked) })).filter((t) => t.at.length) : [];
      const total = hits.reduce((n, t) => n + t.at.length, 0);
      summary.textContent = !q ? 'Searches every section and reference note in this book.' : total ? `${formatCount(total)} match${total === 1 ? '' : 'es'} in ${hits.length} section${hits.length === 1 ? '' : 's'}` : 'No matches';
      replBtn.disabled = !total;
      results.replaceChildren(...hits.flatMap((t) => [
        h('div', { class: 'fb-sec' }, h('b', {}, t.title), h('span', {}, ` ${t.where} · ${t.at.length}`)),
        ...t.at.slice(0, 5).map((i) => {
          const a = Math.max(0, i - 40), z = Math.min(t.text.length, i + q.length + 60);
          const plain = (x) => x.replace(/<!--|-->|\*\*|__|~~|`|^\s*(#{1,6}|>|[-*+]( \[[ xX]\])?|\d+\.)\s/gm, '').replace(/\s+/g, ' ');
          const line = h('button', { class: 'fb-hit', onclick: async () => { close(); await openSection(t.rel); editor.select(i, i + q.length); } },
            (a > 0 ? '…' : '') + plain(t.text.slice(a, i)), h('mark', {}, t.text.slice(i, i + q.length)), plain(t.text.slice(i + q.length, z)) + (z < t.text.length ? '…' : ''));
          return line;
        }),
      ]));
    };
    const later = () => { clearTimeout(timer); timer = setTimeout(run, 150); };
    find.addEventListener('input', later);
    caseBox.addEventListener('change', run);
    find.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    replBtn.addEventListener('click', async () => {
      const q = find.value, r = repl.value;
      const total = hits.reduce((n, t) => n + t.at.length, 0);
      if (!q || !total) return;
      replBtn.disabled = true;
      await flushSave();
      try { await takeSnapshot(b.name); } catch { /* still safe: each file keeps Drive history */ }
      let done = 0;
      for (const t of hits) {
        const fresh = await call('section_read', { rel: t.rel });
        const at = findAll(fresh.text, q, caseBox.checked);
        if (!at.length) continue;
        let out = '', last = 0;
        for (const i of at) { out += fresh.text.slice(last, i) + r; last = i + q.length; }
        out += fresh.text.slice(last);
        const res = await call('section_save', { rel: t.rel, text: out, baseHash: fresh.hash });
        if (res.status !== 'saved') continue;
        done += at.length;
        S.savedHashes = [res.hash, ...S.savedHashes].slice(0, 20);
        if (S.current?.rel === t.rel) { S.current.hash = res.hash; S.current.words = wordCount(out); editor.load(out, editor.cursor()); S.dirty = false; }
      }
      texts = null;
      toast(`Replaced ${formatCount(done)} match${done === 1 ? '' : 'es'}. A backup snapshot was taken first.`);
      await refresh();
      run();
    });
    box.classList.add('fb');
    box.append(
      h('h2', {}, `Find in “${b.title}”`),
      h('div', { class: 'fb-row' }, find, h('label', { class: 'check' }, caseBox, 'Match case')),
      h('div', { class: 'fb-row' }, repl, replBtn),
      summary, results,
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: close }, 'Done')));
    const sel = editor.view.state.selection.main;
    if (!sel.empty && sel.to - sel.from < 80) find.value = editor.view.state.sliceDoc(sel.from, sel.to);
    run();
    setTimeout(() => { find.focus(); find.select(); });
  }, { wide: false });
}

// ------------------------------------------------------------------ export to Word and PDF

async function exportWord() {
  const b = book();
  if (!b) return;
  await flushSave();
  const path = await saveDialog({ defaultPath: `${b.title} - Manuscript ${stamp().slice(0, 10)}.docx`, filters: [{ name: 'Word document', extensions: ['docx'] }] });
  if (!path) return;
  try { await call('book_export_docx', { book: b.name, path }); toast('Exported to Word'); } catch (e) { toast(String(e), 6000); }
}

async function exportPdf() {
  const b = book();
  if (!b) return;
  await flushSave();
  let html;
  try { html = await call('book_export_html', { book: b.name }); } catch (e) { toast(String(e), 6000); return; }
  let root = $('#print-root');
  if (!root) { root = h('div', { id: 'print-root' }); document.body.append(root); }
  root.innerHTML = html;
  document.title = `${b.title} - Manuscript`;
  toast('In the print window, choose PDF › Save as PDF', 6000);
  await sleep(60);
  try { await invoke('print_window'); } catch { window.print(); }
  setTimeout(() => { root.innerHTML = ''; document.title = 'Writing Studio'; }, 1500);
}

// ------------------------------------------------------------------ goals

let progress = {}; // { device: { 'YYYY-MM-DD': words } }
const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

async function loadProgress() {
  try { progress = await call('progress_read'); } catch { progress = {}; }
  renderFoot();
}
let progressTimer = null;
function addProgress(delta) {
  if (!delta) return;
  const key = dayKey();
  const mine = progress[S.device] || (progress[S.device] = {});
  mine[key] = (mine[key] || 0) + delta;
  clearTimeout(progressTimer);
  progressTimer = setTimeout(() => call('progress_write', { device: S.device, days: mine }).catch(() => {}), 1500);
}
function wordsOn(key) {
  return Object.values(progress).reduce((n, days) => n + (days[key] || 0), 0);
}
function todayWords() {
  const live = S.current && !S.current.inbox && !S.current.note ? wordCount(editor.text()) - (S.current.words ?? 0) : 0;
  return wordsOn(dayKey()) + live;
}
function streakDays() {
  const goal = S.settings.dailyGoal;
  if (!goal) return 0;
  let n = 0;
  const d = new Date();
  if (todayWords() < goal) d.setDate(d.getDate() - 1); // today still counts once it's reached
  else n = 1, d.setDate(d.getDate() - 1);
  while (wordsOn(dayKey(d)) >= goal) { n++; d.setDate(d.getDate() - 1); }
  return n;
}

function goalChip(value, goal, title, onclick, label) {
  const pct = Math.max(0, Math.min(1, value / goal));
  const r = 6.5, c = 2 * Math.PI * r;
  const ring = `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="${r}" fill="none" stroke="var(--rule)" stroke-width="2.4"/><circle cx="8" cy="8" r="${r}" fill="none" stroke="${pct >= 1 ? 'var(--ok)' : 'var(--hl)'}" stroke-width="2.4" stroke-linecap="round" stroke-dasharray="${(c * pct).toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 8 8)"/></svg>`;
  const b = h('button', { class: 'goal-chip' + (pct >= 1 ? ' met' : ''), title, onclick });
  b.innerHTML = ring;
  b.append(h('span', {}, label || `${formatCount(value)} / ${formatCount(goal)}`));
  return b;
}

function remapTargets(oldRel, newRel) {
  const t = S.settings.targets || {};
  let changed = false;
  for (const k of Object.keys(t)) {
    if (k === oldRel || k.startsWith(oldRel + '/')) { t[newRel + k.slice(oldRel.length)] = t[k]; delete t[k]; changed = true; }
  }
  if (changed) saveSettings();
}

async function targetDialog(rel, title) {
  const cur = S.settings.targets?.[rel];
  const v = await ask(`Word target for “${title}”`, { label: 'Words', value: cur ? String(cur) : '', okText: 'Save target', note: 'A ring at the bottom of the window fills as you write. Leave empty to remove it.' });
  if (v === null && !cur) return;
  const n = parseInt(String(v || '').replace(/[^\d]/g, ''), 10);
  S.settings.targets = { ...(S.settings.targets || {}) };
  if (n) S.settings.targets[rel] = n; else delete S.settings.targets[rel];
  saveSettings();
  renderFoot();
}

function goalsDialog() {
  dialog((box, close) => {
    const b = book();
    const daily = h('input', { type: 'text', id: 'goal-daily', inputmode: 'numeric', value: S.settings.dailyGoal ? String(S.settings.dailyGoal) : '', placeholder: 'e.g. 500' });
    const bookGoal = h('input', { type: 'text', id: 'goal-book', inputmode: 'numeric', value: b?.goal ? String(b.goal) : '', placeholder: 'e.g. 60000' });
    const canTarget = S.current && !S.current.inbox && !S.current.note;
    const sec = h('input', { type: 'text', id: 'goal-section', inputmode: 'numeric', value: canTarget && S.settings.targets?.[S.current.rel] ? String(S.settings.targets[S.current.rel]) : '', placeholder: 'e.g. 1500', disabled: !canTarget });
    const num = (el) => parseInt(el.value.replace(/[^\d]/g, ''), 10) || null;
    const today = Math.max(0, todayWords()), streak = streakDays();
    box.append(
      h('h2', {}, 'Writing goals'),
      h('p', {}, `Today you’ve written ${formatCount(today)} words${streak > 1 ? `, and you’re on a ${streak}-day streak` : ''}. Words count across both Macs.`),
      h('label', { class: 'field' }, h('span', {}, 'Daily goal (words a day)'), daily),
      h('label', { class: 'field' }, h('span', {}, canTarget ? `Target for “${S.current.title}”` : 'Section target (open a section first)'), sec),
      b ? h('label', { class: 'field' }, h('span', {}, `Goal for “${b.title}”`), bookGoal) : null,
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: close }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: async () => {
          S.settings.dailyGoal = num(daily);
          if (canTarget) {
            S.settings.targets = { ...(S.settings.targets || {}) };
            if (num(sec)) S.settings.targets[S.current.rel] = num(sec); else delete S.settings.targets[S.current.rel];
          }
          saveSettings();
          if (b && num(bookGoal) !== (b.goal || null)) {
            try { await call('book_meta_set', num(bookGoal) ? { book: b.name, goal: num(bookGoal) } : { book: b.name, clearGoal: true }); } catch (e) { toast(String(e)); }
            await refresh();
          }
          close();
          renderFoot();
        } }, 'Save goals')),
    );
  });
}

// ------------------------------------------------------------------ help

function shortcutsDialog() {
  const rows = [
    ['Bold / Italic / Strikethrough', '⌘B  ⌘I  ⇧⌘X'],
    ['Heading 1, 2, 3 / Body text', '⌥⌘1  ⌥⌘2  ⌥⌘3  ⌥⌘0'],
    ['Bulleted / Numbered list', '⇧⌘8  ⇧⌘7'],
    ['Checklist', '⇧⌘L'],
    ['Quote', '⇧⌘\''],
    ['Indent or outdent a list item', 'Tab  ⇧Tab'],
    ['Link', '⌘K'],
    ['Note to self (not counted or exported)', '⇧⌘K'],
    ['Clear formatting', '⌘\\'],
    ['Quick Open: jump to any section', '⌘O'],
    ['Find / Find in Book', '⌘F  ⇧⌘F'],
    ['Focus mode / Sidebar / Reference panel', '⌘.  ⌘1  ⌘2'],
    ['New section / New chapter', '⌘N  ⇧⌘N'],
    ['Export to PDF', '⌘P'],
  ];
  dialog((box, close) => {
    box.append(
      h('h2', {}, 'Formatting and shortcuts'),
      h('p', {}, 'Everything is also in the Format menu, and in the small bar that appears when you select text. You can still type Markdown: **bold**, *italic*, # heading, - list, 1. list, - [ ] checkbox, > quote.'),
      h('div', { class: 'keys' }, ...rows.flatMap(([a, k]) => [h('span', {}, a), h('kbd', {}, k)])),
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: close }, 'Done')));
  });
}

// ------------------------------------------------------------------ menu bar commands

const FORMAT = new Set(['bold', 'italic', 'strike', 'h1', 'h2', 'h3', 'body', 'bullets', 'numbers', 'checklist', 'quote', 'note', 'clear', 'find']);
const ACTIONS = {
  settings: () => settingsDialog(),
  updates: () => checkForUpdates(true),
  'new-section': () => newSection(),
  'new-chapter': () => newChapter(),
  'new-note': () => newNote(),
  'new-book': () => newBook(),
  'quick-open': () => quickOpen(),
  'export-word': () => exportWord(),
  'export-pdf': () => exportPdf(),
  'export-md': () => exportBook(),
  save: () => flushSave(),
  'find-book': () => findInBook(),
  'smart-typing': () => { S.settings.smart = S.settings.smart === false; saveSettings(); toast(S.settings.smart ? 'Smart quotes and dashes on' : 'Smart quotes and dashes off'); },
  link: () => linkDialog(),
  focus: () => setFocusMode(!document.body.classList.contains('focus-mode')),
  typewriter: () => { S.settings.typewriter = !S.settings.typewriter; saveSettings(); toast(S.settings.typewriter ? 'Typewriter scrolling on' : 'Typewriter scrolling off'); },
  sidebar: () => document.body.classList.toggle('no-sidebar'),
  panel: () => togglePanel(),
  goals: () => goalsDialog(),
  shortcuts: () => shortcutsDialog(),
};
function runAction(id) {
  if (S.dialogOpen && id !== 'save') return;
  if (FORMAT.has(id)) { if (S.current) editor.run(id); return; }
  ACTIONS[id]?.();
}
listen('menu', (e) => runAction(e.payload)).catch(() => {});

// ------------------------------------------------------------------ keys, focus mode, lifecycle

function setFocusMode(on) {
  document.body.classList.toggle('focus-mode', on);
  editor?.setFocusMode(on);
}

document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (e.key === 'Escape') {
    if (document.querySelector('.menu')) return closeMenus();
    if (document.body.classList.contains('focus-mode')) return setFocusMode(false);
  }
  // On the Mac these keys arrive through the menu bar; this covers the browser preview.
  if (!mod || S.dialogOpen || e.defaultPrevented) return;
  const k = e.key.toLowerCase();
  const id = e.key === '.' ? 'focus' : e.key === '1' && !e.altKey ? 'sidebar' : e.key === '2' && !e.altKey ? 'panel'
    : k === 'n' ? (e.shiftKey ? 'new-chapter' : 'new-section') : e.key === ',' ? 'settings'
    : k === 'o' ? 'quick-open' : k === 'f' && e.shiftKey ? 'find-book' : k === 'p' ? 'export-pdf' : e.key === '/' ? 'shortcuts' : null;
  if (id) { e.preventDefault(); runAction(id); }
});

window.addEventListener('blur', () => { flushSave(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) flushSave(); });

listen('library-changed', (e) => onLibraryChanged(e.payload)).catch(() => {});
getCurrentWindow().onCloseRequested(async () => { await flushSave(); await pingActivity(); }).catch(() => {});

setInterval(() => { if (document.hasFocus() && S.current) pingActivity(); }, 30_000);
setInterval(() => { if (S.current) checkOtherDevice(); }, 60_000);
setInterval(snapshotTick, 5 * 60_000);
setTimeout(() => checkForUpdates(false), 5000);
setInterval(() => checkForUpdates(false), 6 * 60 * 60_000);

boot();
