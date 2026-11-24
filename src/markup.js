// Pure text rules behind the formatting commands, kept apart from the editor so they
// can be tested with `npm test`. Everything here works on plain Markdown strings.

const PREFIX = /^([ \t]*)(?:(#{1,6})[ \t]+|(>)[ \t]?|([-*+])[ \t]+\[([ xX])\][ \t]+|([-*+])[ \t]+|(\d{1,9}[.)])[ \t]+)/;

/**
 * The block marker at the start of a line, if any.
 * kind: 'heading' | 'quote' | 'task' | 'bullet' | 'number' | null.
 * `end` is where the writer's own text begins.
 */
export function linePrefix(text) {
  const m = text.match(PREFIX);
  if (!m) return { kind: null, indent: (text.match(/^[ \t]*/) || [''])[0].length, end: 0, level: 0 };
  const indent = m[1].length;
  const base = { indent, end: m[0].length };
  if (m[2]) return { ...base, kind: 'heading', level: m[2].length };
  if (m[3]) return { ...base, kind: 'quote' };
  if (m[4]) return { ...base, kind: 'task', done: m[5] !== ' ', marker: m[4] };
  if (m[6]) return { ...base, kind: 'bullet', marker: m[6] };
  return { ...base, kind: 'number', marker: m[7] };
}

/** Nesting depth of a list line, from its indentation. */
export function listDepth(text) {
  const ind = (text.match(/^[ \t]*/) || [''])[0].replace(/\t/g, '    ').length;
  return Math.floor(ind / 2);
}

/**
 * Turn lines into `kind` (bullet, number, task, quote, h1..h3, body), or back to body
 * text when every line already is that kind. Returns the new lines.
 */
export function applyBlock(lines, kind) {
  const want = (p) => {
    if (kind === 'body') return false;
    if (/^h\d$/.test(kind)) return p.kind === 'heading' && p.level === +kind[1];
    return p.kind === kind;
  };
  const prefixes = lines.map(linePrefix);
  const meaningful = lines.map((l, i) => [l, prefixes[i]]).filter(([l]) => l.trim() !== '');
  const off = kind === 'body' || (meaningful.length > 0 && meaningful.every(([, p]) => want(p)));
  let n = 0;
  return lines.map((line, i) => {
    const p = prefixes[i];
    if (line.trim() === '' && lines.length > 1) return line;
    const isList = (k) => k === 'bullet' || k === 'number' || k === 'task';
    // Keep a list's nesting when switching between list kinds.
    const indent = isList(p.kind) && isList(kind) ? line.slice(0, p.indent) : '';
    const rest = line.slice(p.kind ? p.end : p.indent);
    if (off) return indent + rest;
    n++;
    switch (kind) {
      case 'bullet': return `${indent}- ${rest}`;
      case 'number': return `${indent}${n}. ${rest}`;
      case 'task': return `${indent}- [ ] ${rest}`;
      case 'quote': return `> ${rest}`;
      default: return `${'#'.repeat(+kind[1])} ${rest}`;
    }
  });
}

/** Remove inline formatting (bold, italic, strikethrough, code, notes stay) from text. */
export function clearInline(text) {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
    .replace(/(\*|_)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/`([^`]*)`/g, '$1');
}

/**
 * Smart typing: what to insert when `ch` is typed after `before` (the text on the line
 * up to the caret). Returns { insert, replaceBefore } or null to type normally.
 */
export function smartChar(before, ch) {
  const prev = before.slice(-1);
  const opens = before === '' || /[\s(\[{—–"“‘-]$/.test(before);
  if (ch === '"') return { insert: opens ? '“' : '”', replaceBefore: 0 };
  if (ch === "'") return { insert: before === '' || /[\s(\[{“"]$/.test(before) ? '‘' : '’', replaceBefore: 0 };
  // Two hyphens inside a sentence become an em dash; a line that starts with them is left
  // alone so lists and dividers ("---") still work.
  if (ch === '-' && prev === '-' && before.slice(-2, -1) !== '-' && /\S/.test(before.slice(0, -1))) return { insert: '—', replaceBefore: 1 };
  if (ch === '.' && before.endsWith('..') && !before.endsWith('...')) return { insert: '…', replaceBefore: 2 };
  return null;
}

/** Notes to self (`<!-- ... -->`) are kept in the file but never counted or exported. */
export function stripNotes(text) {
  return text.replace(/<!--[\s\S]*?(-->|$)/g, '');
}
