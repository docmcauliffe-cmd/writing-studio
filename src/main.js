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
const FONTS = {
  plex: { name: 'Plex Sans', css: '"IBM Plex Sans", -apple-system, system-ui, sans-serif' },
  literata: { name: 'Literata', css: '"Literata", Georgia, serif' },
  newsreader: { name: 'Newsreader', css: '"Newsreader", Georgia, serif' },
  source: { name: 'Source Serif', css: '"Source Serif 4", Georgia, serif' },
  mono: { name: 'Plex Mono', css: '"IBM Plex Mono", ui-monospace, Menlo, monospace' },
};
const LOOKS = { sepia: 'Sepia', paper: 'Paper', studio: 'Studio', night: 'Night' };
const DEFAULTS = { look: 'sepia', font: 'plex', size: 19, measure: 34, typewriter: false };

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
  );
  editor = createEditor($('#editor-host'), {
    onChange,
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
  return S.lib.books.find((x) => x.name === b)?.chapters.find((x) => x.name === c)?.sections.find((x) => x.file === f) || null;
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
  }
  side.replaceChildren(...kids);
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
  const target = S.lib.books.find((x) => x.name === bName)?.chapters.find((x) => x.name === cName);
  if (!target) return;
  const sameChapter = d.rel.startsWith(chapterRel + '/');
  const names = target.sections.map((s) => s.file);
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
    if (isCurrent) setCurrentRel(newRel);
  } catch (e) { toast(String(e)); }
  await refresh();
  if (isCurrent) updateChrome();
}

/** "Book/Chapter/Section.md" or "Writing Studio - Inbox/Note.md" → its parts. */
function parseRel(rel) {
  const parts = rel.split('/');
  const file = parts.at(-1);
  return { rel, book: parts[0], chapter: parts.length > 2 ? parts[1] : null, file, title: file.replace(/\.md$/i, ''), inbox: parts[0] === INBOX };
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
  if (!inbox) {
    const [b, c, f] = rel.split('/');
    items.push({ label: 'New section below', run: () => newSection(`${b}/${c}`, f) });
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
    { label: 'Export whole book as Markdown…', run: exportBook },
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
  S.current = { ...parseRel(rel), hash: loaded.hash };
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
  $('#crumb').textContent = !c ? '' : c.inbox ? `Inbox › ${c.title}` : `${book()?.title || c.book} › ${c.chapter} › ${c.title}`;
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
    const sel = h('select', { id: 'file-into', 'aria-label': 'Chapter' }, ...(b?.chapters || []).map((c) => h('option', { value: `${b.name}/${c.name}` }, c.name)));
    kids.push(h('div', { class: 'banner' },
      h('span', {}, 'Captured on your iPhone. File it into'), sel,
      h('button', { onclick: async () => {
        if (!sel.value) return;
        const ch = S.lib.books.find((x) => x.name === b.name).chapters.find((x) => `${b.name}/${x.name}` === sel.value);
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
  foot.replaceChildren(...parts.map((p) => h('span', {}, p)));
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
      S.savedHashes = [res.hash, ...S.savedHashes].slice(0, 20);
      if (editor.text() === text) {
        S.dirty = false;
        store.del('ws-draft:' + cur.rel);
        setStatus('', 'Saved');
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
      h('p', {}, 'Focus mode: ⌘. (hides everything but the paragraph you’re writing). Sidebar: ⌘1. New section: ⌘N. New chapter: ⇧⌘N.'),
      h('div', { class: 'field' }, h('span', {}, 'Writing folder'), h('div', { class: 'path' }, S.root),
        h('div', {}, h('button', { class: 'btn', onclick: () => { close(); chooseFolder(); } }, 'Change folder…'))),
      h('div', { class: 'field' }, h('span', {}, 'Updates'), h('div', { class: 'path', id: 'version-line' }, 'Writing Studio'),
        h('div', {}, h('button', { class: 'btn', onclick: () => checkForUpdates(true) }, 'Check for updates'))),
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: close }, 'Done')),
    );
    getVersion().then((v) => { const el = $('#version-line'); if (el) el.textContent = `Writing Studio ${v}`; }).catch(() => {});
  });
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
  if (!mod || S.dialogOpen) return;
  if (e.key === '.') { e.preventDefault(); setFocusMode(!document.body.classList.contains('focus-mode')); }
  else if (e.key === '1') { e.preventDefault(); document.body.classList.toggle('no-sidebar'); }
  else if (e.key.toLowerCase() === 'n' && e.shiftKey) { e.preventDefault(); newChapter(); }
  else if (e.key.toLowerCase() === 'n') { e.preventDefault(); newSection(); }
  else if (e.key === ',') { e.preventDefault(); settingsDialog(); }
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
