// A stand-in for the Tauri backend so the interface can be tried in an ordinary
try { if (!localStorage.getItem("ws-root")) localStorage.setItem("ws-root", JSON.stringify("/Users/writer/Google Drive/My Drive/Writing Studio")); } catch {}
// browser (npm run dev, then open /dev/mock.html). Keeps a small sample book in memory.
const files = new Map(Object.entries({
  'The Bench/_book.txt': 'Title: The Bench\nGoal: 60000\n',
  'The Bench/_order.txt': 'Why succession fails\nReading the room\n',
  'The Bench/Why succession fails/_order.txt': 'The empty chair.md\nHeirs and spares.md\n',
  'The Bench/Why succession fails/The empty chair.md': '# The empty chair\n\nThe meeting began, as these meetings often do, with a question nobody wanted to answer: *who is ready now?* The chief executive had two years left on her contract.\n\nMost organizations treat succession as an event. It is closer to a **habit**, practised quietly for years before it is ever needed.\n\n> We had plenty of candidates. What we lacked was evidence.\n\n## Three ways it goes wrong\n\nThe first is the heir apparent, chosen early and protected from real tests.',
  'The Bench/Why succession fails/Heirs and spares.md': 'Heirs are named too early.',
  'The Bench/Reading the room/What boards ask.md': 'Boards ask about readiness.',
  'The Bench/_Reference Notes/Story prompts.md': '# Story prompts\n\n## Broken roles today\n\n- Which role in your organization is quietly impossible?\n- Who is doing two jobs with one title?\n\n## Brain-dump list\n\n- The chess clock image\n',
  'Writing Studio - Inbox/2026.11.23 0930 Idea.md': 'Use the chess clock image in chapter two.',
}));
const hash = (s) => { let x = 0; for (const c of s) x = (x * 31 + c.codePointAt(0)) >>> 0; return 'h' + x; };
const words = (t) => (t.match(/\S+/g) || []).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
const dirs = () => { const d = new Set(); for (const k of files.keys()) { const p = k.split('/'); for (let i = 1; i < p.length; i++) d.add(p.slice(0, i).join('/')); } return d; };
const kids = (dir, kind) => {
  const pre = dir ? dir + '/' : '';
  const out = new Set();
  for (const k of [...files.keys(), ...dirs()]) {
    if (!k.startsWith(pre)) continue;
    const rest = k.slice(pre.length);
    if (!rest || rest.includes('/')) { if (kind === 'dir' && rest.includes('/')) out.add(rest.split('/')[0]); continue; }
    if (kind === 'md' && rest.endsWith('.md')) out.add(rest);
  }
  return [...out].filter((n) => !n.startsWith('_') && !n.startsWith('Writing Studio - '));
};
const order = (dir, found) => {
  const o = (files.get((dir ? dir + '/' : '') + '_order.txt') || '').split('\n').filter((n) => found.includes(n));
  return [...o, ...found.filter((n) => !o.includes(n)).sort()];
};
const setOrder = (dir, names) => files.set(dir + '/_order.txt', names.join('\n') + '\n');
const sec = (dir, f) => ({ file: f, title: f.replace(/\.md$/, ''), words: words(files.get(dir + '/' + f) || ''), modified: 0, conflict: / \(\d+\)\.md$/.test(f) });
const uniq = (dir, stem, ext) => { let n = 1, name; do { name = n === 1 ? stem + ext : `${stem} ${n}${ext}`; n++; } while (files.has(dir + '/' + name) || dirs().has(dir + '/' + name)); return name; };
const moveTree = (from, to) => { for (const k of [...files.keys()]) if (k === from || k.startsWith(from + '/')) { files.set(to + k.slice(from.length), files.get(k)); files.delete(k); } };

const cmds = {
  device_name: () => 'iMac',
  local_backup_folder: () => '/Users/writer/Library/Application Support/Writing Studio/Backups',
  folder_exists: () => true,
  watch_start: () => null,
  settings_read: () => files.get('Writing Studio - App Data/settings.json') || '{}',
  settings_write: ({ json }) => { files.set('Writing Studio - App Data/settings.json', json); },
  activity_write: () => null,
  activity_read: () => [{ device: 'MacBook Pro', section: 'The Bench/Why succession fails/Heirs and spares.md', at: Date.now() - 120000 }],
  library_list: () => ({
    books: order('', kids('', 'dir')).map((b) => {
      const meta = Object.fromEntries((files.get(b + '/_book.txt') || '').split('\n').filter(Boolean).map((l) => l.split(': ')));
      const chapters = order(b, kids(b, 'dir')).map((c) => {
        const sections = order(`${b}/${c}`, kids(`${b}/${c}`, 'md')).map((f) => sec(`${b}/${c}`, f));
        return { name: c, sections, words: sections.reduce((n, s) => n + s.words, 0) };
      });
      const notes = order(`${b}/_Reference Notes`, kids(`${b}/_Reference Notes`, 'md')).map((f) => sec(`${b}/_Reference Notes`, f));
      return { name: b, title: meta.Title || b, goal: +meta.Goal || null, chapters, notes, words: chapters.reduce((n, c) => n + c.words, 0) };
    }),
    inbox: kids('Writing Studio - Inbox', 'md').map((f) => sec('Writing Studio - Inbox', f)),
  }),
  section_read: ({ rel }) => { if (!files.has(rel)) throw 'Could not open this section'; const t = files.get(rel); return { text: t, hash: hash(t) }; },
  section_save: ({ rel, text, baseHash }) => {
    const disk = files.get(rel);
    if (baseHash && disk != null && hash(disk) !== baseHash && hash(disk) !== hash(text)) return { status: 'conflict', hash: hash(disk), disk_text: disk };
    files.set(rel, text); return { status: 'saved', hash: hash(text), disk_text: null };
  },
  book_create: ({ title }) => { const n = uniq('', title, '').replace(/^\//, ''); files.set(n + '/_book.txt', `Title: ${title}\n`); files.set(n + '/Chapter One/Opening.md', ''); return n; },
  chapter_create: ({ book, title, after }) => { const n = uniq(book, title, ''); files.set(`${book}/${n}/_order.txt`, ''); const o = order(book, kids(book, 'dir')).filter((x) => x !== n); const i = after ? o.indexOf(after) + 1 : o.length; o.splice(i || o.length, 0, n); setOrder(book, o); return n; },
  section_create: ({ chapter, title, after }) => { const n = uniq(chapter, title, '.md'); files.set(`${chapter}/${n}`, ''); const o = order(chapter, kids(chapter, 'md')).filter((x) => x !== n); const i = after ? o.indexOf(after) + 1 : o.length; o.splice(i || o.length, 0, n); setOrder(chapter, o); return n; },
  order_set: ({ dir, names }) => setOrder(dir, names),
  item_rename: ({ rel, title }) => { const p = rel.split('/'); const isFile = rel.endsWith('.md'); const parent = p.slice(0, -1).join('/'); const n = title + (isFile ? '.md' : ''); const to = (parent ? parent + '/' : '') + n; moveTree(rel, to); if (parent) setOrder(parent, order(parent, kids(parent, isFile ? 'md' : 'dir')).map((x) => (x === p.at(-1) ? n : x))); return to; },
  item_move: ({ from, toDir, index }) => { const name = from.split('/').at(-1); const fromDir = from.split('/').slice(0, -1).join('/'); const isFile = name.endsWith('.md'); let n = name; if (fromDir !== toDir) { n = uniq(toDir, name.replace(/\.md$/, ''), isFile ? '.md' : ''); moveTree(from, `${toDir}/${n}`); } const o = order(toDir, kids(toDir, isFile ? 'md' : 'dir')).filter((x) => x !== n); o.splice(Math.min(index, o.length), 0, n); setOrder(toDir, o); return `${toDir}/${n}`; },
  item_trash: ({ rel }) => { moveTree(rel, 'Writing Studio - Trash/' + rel.replaceAll('/', ' - ')); return 'x'; },
  book_meta_set: ({ book, goal }) => { files.set(book + '/_book.txt', `Title: ${book}\nGoal: ${goal || ''}\n`); },
  book_export: () => '# Book',
  book_export_docx: () => null,
  image_save: ({ section, name }) => { const b = section.split('/')[0]; files.set(`${b}/_Images/${name}`, 'PIC'); return '../_Images/' + name; },
  image_read: ({ src }) => 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400"><rect width="800" height="400" fill="#8a4f2a"/><text x="40" y="220" font-size="48" fill="#fff">' + decodeURIComponent(src.split('/').pop()) + '</text></svg>'),
  'plugin:opener|open_url': ({ url }) => { (window.__opened ||= []).push(url); return null; },
  book_export_pdf: () => { window.__pdf = (window.__pdf || 0) + 1; return null; },
  progress_read: () => window.__progress || { 'MacBook Pro': { [new Date().toISOString().slice(0, 10)]: 120 } },
  progress_write: ({ device, days }) => { window.__progressWritten = { device, days }; },
  export_write: () => null,
  snapshot_take: () => '2026.11.23 1400 - iMac.zip',
  snapshot_list: () => [{ file: '2026.11.23 1400 - iMac.zip', when: 'Mon Nov 23, 2026 at 2:00 PM', device: 'iMac', bytes: 2048 }],
  snapshot_restore: () => 'The Bench',
  'plugin:event|listen': ({ event, handler }) => { (window.__listeners ||= {})[event] = handler; return 1; },
  'plugin:updater|check': () => (window.__mockUpdate ? { rid: 1, currentVersion: '0.1.1', version: '0.2.0', date: null, body: '', rawJson: {} } : null),
  'plugin:app|version': () => '0.1.1',
  'plugin:event|unlisten': () => null,
  'plugin:dialog|save': ({ options }) => window.__savePath ?? '/Users/writer/Desktop/' + (options?.defaultPath || 'export'),
};
window.__mockFiles = files;
window.__menu = (id) => window['_' + window.__listeners.menu]({ event: 'menu', id: 1, payload: id });
window.__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
  transformCallback: (cb) => { const id = Math.random() * 1e9 | 0; window['_' + id] = cb; return id; },
  convertFileSrc: (s) => s,
  invoke: async (cmd, args) => {
    const f = cmds[cmd];
    if (!f) { if (cmd.startsWith('plugin:')) return null; throw new Error('mock: no command ' + cmd); }
    await new Promise((r) => setTimeout(r, 5));
    return f(args || {});
  },
};
