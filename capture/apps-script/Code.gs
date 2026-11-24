/**
 * Writing Studio capture: saves notes from the iPhone page into "Writing Studio - Inbox".
 *
 * Setup (once, on the Mac):
 *   1. script.google.com > New project. Name it "Writing Studio Capture". Paste this file in.
 *   2. Choose `setup` in the toolbar and press Run. Approve the permissions (Google warns
 *      that the app is unverified because it is your own script: Advanced > Go to ...).
 *   3. Deploy > New deployment > Web app. Execute as: Me. Who has access: Anyone. Deploy.
 *   4. Copy the Web app URL and paste it into the capture page on the iPhone within 30 minutes.
 *
 * The private key is created by `setup` and kept in Script Properties, never in this code.
 * To connect another device later, run `setup` again (it keeps the same key).
 */
const INBOX_NAME = 'Writing Studio - Inbox';
const LIBRARY_NAME = 'Writing Studio';
const PAIR_MINUTES = 30;
const REMEMBER = 400; // note ids kept to ignore repeat uploads

function setup() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('KEY')) props.setProperty('KEY', Utilities.getUuid() + Utilities.getUuid().slice(0, 8));
  props.setProperty('PAIR_UNTIL', String(Date.now() + PAIR_MINUTES * 60 * 1000));
  const inbox = inbox_();
  Logger.log('Ready. Notes will be saved in "%s" (inside "%s").', inbox.getName(), parentName_(inbox));
  Logger.log('Now deploy as a web app, then paste its URL into the iPhone page within %s minutes.', PAIR_MINUTES);
}

/** GET: the pairing handshake, or a plain status page. */
function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.action === 'pair') {
    const props = PropertiesService.getScriptProperties();
    const until = Number(props.getProperty('PAIR_UNTIL') || 0);
    if (!props.getProperty('KEY') || Date.now() > until) {
      return json_({ ok: false, error: 'Pairing is closed. On the Mac, open the script, run setup again, then paste the link within ' + PAIR_MINUTES + ' minutes.' });
    }
    props.setProperty('PAIR_UNTIL', '0'); // one device per setup run
    return json_({ ok: true, key: props.getProperty('KEY') });
  }
  return ContentService.createTextOutput('Writing Studio capture is running.');
}

/** POST: { key, action: 'ping' | 'save', note: { id, text, stamp } } */
function doPost(e) {
  let req = {};
  try { req = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'Bad request' }); }
  const key = PropertiesService.getScriptProperties().getProperty('KEY');
  if (!key || req.key !== key) return json_({ ok: false, error: 'Wrong key', reconnect: true });
  try {
    if (req.action === 'ping') return json_({ ok: true, inbox: inbox_().getName() });
    if (req.action === 'save') return json_(save_(req.note || {}));
    return json_({ ok: false, error: 'Unknown action' });
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  }
}

function save_(note) {
  const text = String(note.text || '').replace(/\r\n?/g, '\n').trim();
  const id = String(note.id || '');
  if (!text) return { ok: false, error: 'The note is empty' };
  if (!/^[\w-]{8,64}$/.test(id)) return { ok: false, error: 'Bad note id' };
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const props = PropertiesService.getScriptProperties();
    const seen = JSON.parse(props.getProperty('SEEN') || '{}');
    if (seen[id]) return { ok: true, name: seen[id], repeat: true }; // a retry after a lost reply
    const folder = inbox_();
    const name = uniqueName_(folder, fileName_(note.stamp, text));
    folder.createFile(name, text + '\n', 'text/markdown');
    seen[id] = name;
    const ids = Object.keys(seen);
    if (ids.length > REMEMBER) ids.slice(0, ids.length - REMEMBER).forEach(k => delete seen[k]);
    props.setProperty('SEEN', JSON.stringify(seen));
    return { ok: true, name: name };
  } finally {
    lock.releaseLock();
  }
}

/** "2026.11.24 0930 First few words.md", following the Drive naming rules (dates as YYYY.MM.DD). */
function fileName_(stamp, text) {
  stamp = /^\d{4}\.\d{2}\.\d{2} \d{4}$/.test(stamp || '') ? stamp : Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy.MM.dd HHmm');
  const first = text.split('\n').map(l => l.replace(/^[#>*+\-\s]+|\[[ xX]\]\s*/g, '').replace(/[*_~`]/g, '').trim()).find(l => l) || '';
  let title = first.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').replace(/^\.+/, '').trim();
  const words = title.split(' ');
  title = words.slice(0, 7).join(' ');
  if (title.length > 48) title = title.slice(0, 48).replace(/\s+\S*$/, '');
  title = title.replace(/[.,;:!?\-–—]+$/, '');
  return stamp + ' ' + (title || 'Note') + '.md';
}

function uniqueName_(folder, name) {
  const stem = name.replace(/\.md$/, '');
  let n = 1, candidate = name;
  while (folder.getFilesByName(candidate).hasNext()) candidate = stem + ' ' + (++n) + '.md';
  return candidate;
}

/** The Inbox inside the Writing Studio folder, found by name once and then remembered. */
function inbox_() {
  const props = PropertiesService.getScriptProperties();
  const known = props.getProperty('INBOX_ID');
  if (known) {
    try { const f = DriveApp.getFolderById(known); if (!f.isTrashed()) return f; } catch (err) {}
  }
  const found = [];
  const it = DriveApp.getFoldersByName(INBOX_NAME);
  while (it.hasNext()) { const f = it.next(); if (!f.isTrashed()) found.push(f); }
  const inLibrary = found.filter(f => parentName_(f) === LIBRARY_NAME);
  const pick = inLibrary[0] || found[0];
  if (!pick) throw new Error('Could not find the "' + INBOX_NAME + '" folder in your Drive.');
  props.setProperty('INBOX_ID', pick.getId());
  return pick;
}

function parentName_(folder) {
  const ps = folder.getParents();
  return ps.hasNext() ? ps.next().getName() : '';
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
