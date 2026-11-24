// The writing surface: CodeMirror holding plain Markdown that looks like formatted text.
// The Markdown symbols (** _ # > - [ ]) are hidden; bullets, numbers and checkboxes are
// drawn in their place. The file on disk is always ordinary Markdown.
import { EditorState, EditorSelection, Compartment, RangeSetBuilder, StateField, StateEffect, Prec, findClusterBreak } from '@codemirror/state';
import { EditorView, keymap, placeholder, ViewPlugin, Decoration, WidgetType, drawSelection, showTooltip } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { search, searchKeymap, openSearchPanel } from '@codemirror/search';
import { tags as t } from '@lezer/highlight';
import { paragraphRange } from './logic.js';
import { linePrefix, listDepth, applyBlock, clearInline, smartChar } from './markup.js';

const style = HighlightStyle.define([
  { tag: t.heading1, fontSize: '1.55em', fontWeight: '600', lineHeight: '1.3' },
  { tag: t.heading2, fontSize: '1.28em', fontWeight: '600' },
  { tag: t.heading3, fontSize: '1.12em', fontWeight: '600' },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: '600' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strong, fontWeight: '650' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: [t.processingInstruction, t.contentSeparator], color: 'var(--mark)', fontWeight: '400' },
  { tag: t.quote, color: 'var(--quote)' },
  { tag: [t.link, t.url], color: 'var(--hl)' },
  { tag: t.monospace, fontFamily: 'var(--mono)', fontSize: '0.88em' },
]);

// ---------------------------------------------------------------- focus and typewriter

const dimLine = Decoration.line({ class: 'cm-dim' });
const focusPlugin = ViewPlugin.fromClass(
  class {
    constructor(view) { this.decorations = this.build(view); }
    update(u) { if (u.docChanged || u.selectionSet || u.viewportChanged) this.decorations = this.build(u.view); }
    build(view) {
      const doc = view.state.doc;
      const cur = doc.lineAt(view.state.selection.main.head).number;
      const [from, to] = paragraphRange((n) => doc.line(n).text, doc.lines, cur);
      const b = new RangeSetBuilder();
      for (const { from: vf, to: vt } of view.visibleRanges) {
        for (let n = doc.lineAt(vf).number; n <= doc.lineAt(vt).number; n++) {
          if (n < from || n > to) b.add(doc.line(n).from, doc.line(n).from, dimLine);
        }
      }
      return b.finish();
    }
  },
  { decorations: (v) => v.decorations }
);

function typewriter() {
  let pending = false;
  return EditorView.updateListener.of((u) => {
    if (!(u.docChanged || u.selectionSet) || pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      u.view.dispatch({ effects: EditorView.scrollIntoView(u.view.state.selection.main.head, { y: 'center' }) });
    });
  });
}

// ---------------------------------------------------------------- how Markdown is drawn

class BulletWidget extends WidgetType {
  constructor(depth) { super(); this.depth = depth; }
  eq(o) { return o.depth === this.depth; }
  toDOM() { const s = document.createElement('span'); s.className = 'cm-bullet'; s.textContent = ['•', '◦', '▪'][this.depth % 3]; return s; }
}
class NumberWidget extends WidgetType {
  constructor(text, width) { super(); this.text = text; this.width = width; }
  eq(o) { return o.text === this.text && o.width === this.width; }
  toDOM() { const s = document.createElement('span'); s.className = 'cm-number'; s.style.width = this.width + 'em'; s.textContent = this.text; return s; }
}
class CheckWidget extends WidgetType {
  constructor(on) { super(); this.on = on; }
  eq(o) { return o.on === this.on; }
  toDOM(view) {
    const box = document.createElement('span');
    box.className = 'cm-check' + (this.on ? ' on' : '');
    box.setAttribute('role', 'checkbox');
    box.setAttribute('aria-checked', String(this.on));
    box.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const line = view.state.doc.lineAt(view.posAtDOM(box));
      const p = linePrefix(line.text);
      if (p.kind !== 'task') return;
      const at = line.from + line.text.indexOf('[', p.indent) + 1;
      view.dispatch({ changes: { from: at, to: at + 1, insert: p.done ? ' ' : 'x' }, userEvent: 'input' });
    });
    return box;
  }
  ignoreEvent() { return true; }
}
class NoteWidget extends WidgetType {
  eq() { return true; }
  toDOM() { const s = document.createElement('span'); s.className = 'cm-note-tag'; s.textContent = 'Note'; return s; }
}

// ---------------------------------------------------------------- pictures and links

let imageSource = null; // (src) => Promise<data URL>, set by createEditor
let openLink = null;    // (url) => void

const nodeUrl = (state, node) => {
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.name === 'URL') return state.sliceDoc(c.from, c.to).replace(/^<|>$/g, '');
  }
  return null;
};

class ImageWidget extends WidgetType {
  constructor(src) { super(); this.src = src; }
  eq(o) { return o.src === this.src; }
  toDOM(view) {
    const box = document.createElement('span');
    box.className = 'cm-pic';
    const img = document.createElement('img');
    img.alt = '';
    img.draggable = false;
    box.append(img);
    Promise.resolve(imageSource?.(this.src))
      .then((url) => { if (!url) throw new Error(); img.onload = () => view.requestMeasure(); img.src = url; })
      .catch(() => { box.classList.add('missing'); box.textContent = 'Picture not found: ' + decodeURIComponent(this.src.split('/').pop()); });
    return box;
  }
  ignoreEvent() { return false; }
}

const hide = Decoration.replace({});
const noteTag = Decoration.replace({ widget: new NoteWidget() });
const noteMark = Decoration.mark({ class: 'cm-note' });
const doneMark = Decoration.mark({ class: 'cm-done' });
const BULLET_W = 1.3; // em, the room a bullet or checkbox takes

const inCode = (state, pos) => {
  for (let n = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent) {
    if (n.name === 'FencedCode' || n.name === 'CodeBlock' || n.name === 'HTMLBlock') return true;
  }
  return false;
};

const start0 = (line) => line.from;

/** Where the list item holding `pos` starts, if `pos` is on a later line of that item. */
function listItemStart(state, pos) {
  for (let n = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent) {
    if (n.name === 'FencedCode' || n.name === 'CodeBlock') return null;
    if (n.name === 'ListItem') return state.doc.lineAt(n.from).number < state.doc.lineAt(pos).number ? n.from : null;
  }
  return null;
}

function buildLive(view) {
  const { state } = view;
  const decos = [];
  const hidden = []; // [from, to] the caret skips over
  const sel = state.selection.main;
  const add = (d, from, to) => { decos.push(d.range(from, to)); if (to > from) hidden.push([from, to]); };

  for (const { from, to } of view.visibleRanges) {
    // Block markers at the start of each line.
    for (let pos = from; pos <= to;) {
      const line = state.doc.lineAt(pos);
      pos = line.to + 1;
      const p = linePrefix(line.text);
      if (!p.kind) {
        // A line that continues a list item (text typed on the next line without the marker)
        // hangs under the item's text instead of falling back to the margin.
        const item = line.text.trim() && listItemStart(state, line.from);
        if (item != null) {
          const head = state.doc.lineAt(item), hp = linePrefix(head.text);
          if (hp.kind === 'bullet' || hp.kind === 'task' || hp.kind === 'number') {
            const w = hp.kind === 'number' ? Math.max(1.6, hp.marker.length * 0.62 + 0.5) : BULLET_W;
            decos.push(Decoration.line({ class: 'cm-li-more', attributes: { style: `padding-left:${listDepth(head.text) * 1.5 + w}em` } }).range(start0(line)));
            const lead = line.text.match(/^[ \t]*/)[0].length;
            if (lead) add(hide, line.from, line.from + lead);
          }
        }
        continue;
      }
      if (inCode(state, line.from)) continue;
      const start = line.from, end = line.from + p.end;
      if (p.kind === 'heading') {
        decos.push(Decoration.line({ class: `cm-h cm-h${Math.min(p.level, 3)}` }).range(start));
        add(hide, start, end);
      } else if (p.kind === 'quote') {
        decos.push(Decoration.line({ class: 'cm-quote' }).range(start));
        add(hide, start, end);
      } else {
        const depth = listDepth(line.text);
        const w = p.kind === 'number' ? Math.max(1.6, p.marker.length * 0.62 + 0.5) : BULLET_W;
        decos.push(Decoration.line({ class: 'cm-li', attributes: { style: `padding-left:${depth * 1.5 + w}em;text-indent:-${w}em` } }).range(start));
        const widget = p.kind === 'task' ? new CheckWidget(p.done) : p.kind === 'number' ? new NumberWidget(p.marker, w) : new BulletWidget(depth);
        add(Decoration.replace({ widget }), start, end);
        if (p.kind === 'task' && p.done && line.to > end) decos.push(doneMark.range(end, line.to));
      }
    }

    // Notes to self: <!-- like this -->
    const text = state.doc.sliceString(from, to);
    const notes = [];
    for (const m of text.matchAll(/<!--( ?)([\s\S]*?)( ?)-->/g)) {
      const a = from + m.index, b = a + m[0].length;
      const open = 4 + m[1].length, close = 3 + m[3].length;
      add(noteTag, a, a + open);
      if (b - close > a + open) decos.push(noteMark.range(a + open, b - close));
      add(hide, b - close, b);
      notes.push([a, b]);
    }
    const inNote = (pos) => notes.some(([a, b]) => pos >= a && pos < b);

    // Inline marks: ** _ ~~ ` and links.
    syntaxTree(state).iterate({
      from, to,
      enter(node) {
        if (inNote(node.from)) return;
        const name = node.name;
        if (name === 'EmphasisMark' || name === 'StrikethroughMark') add(hide, node.from, node.to);
        else if (name === 'CodeMark' && node.node.parent?.name === 'InlineCode') add(hide, node.from, node.to);
        else if (name === 'Image') {
          // Show the picture itself, unless the caret is inside its Markdown to edit it.
          if (sel.from > node.from && sel.to < node.to) return false;
          const src = nodeUrl(state, node.node);
          if (src) add(Decoration.replace({ widget: new ImageWidget(src) }), node.from, node.to);
          return false;
        }
        else if (name === 'Link') {
          // Show only the link text, unless the caret is inside the link to edit it.
          if (sel.from <= node.to && sel.to >= node.from) return false;
          const marks = [];
          for (let c = node.node.firstChild; c; c = c.nextSibling) if (c.name === 'LinkMark') marks.push(c);
          if (marks.length >= 2 && marks[0].to <= marks[1].from) {
            add(hide, marks[0].from, marks[0].to);
            add(hide, marks[1].from, node.to);
            const url = nodeUrl(state, node.node) || '';
            decos.push(Decoration.mark({ class: 'cm-link', attributes: { title: `${url}\n⌘-click to open` } }).range(marks[0].to, marks[1].from));
          }
          return false;
        }
      },
    });
  }
  return { decorations: Decoration.set(decos, true), hidden };
}

const livePlugin = ViewPlugin.fromClass(
  class {
    constructor(view) { this.apply(buildLive(view)); }
    apply(r) { this.decorations = r.decorations; this.hidden = r.hidden; }
    update(u) {
      if (u.docChanged || u.viewportChanged || u.selectionSet || syntaxTree(u.startState) !== syntaxTree(u.state)) this.apply(buildLive(u.view));
    }
  },
  {
    decorations: (v) => v.decorations,
    provide: (p) => EditorView.atomicRanges.of((view) => {
      const hidden = view.plugin(p)?.hidden || [];
      const b = new RangeSetBuilder();
      for (const [f, t2] of [...hidden].sort((a, c) => a[0] - c[0] || a[1] - c[1])) b.add(f, t2, hide);
      return b.finish();
    }),
  }
);
const hiddenRanges = (view) => view.plugin(livePlugin)?.hidden || [];

// Keep the caret after a line's hidden marker, so typing never lands in front of it.
const caretGuard = EditorState.transactionFilter.of((tr) => {
  if (!tr.selection) return tr;
  const doc = tr.newDoc;
  let changed = false;
  const ranges = tr.newSelection.ranges.map((r) => {
    if (!r.empty) return r;
    const line = doc.lineAt(r.head);
    // A click or End that lands just before hidden closing marks at the end of a line
    // goes past them, so the next words aren't silently bold.
    if (!tr.docChanged && r.head < line.to && /^(\*\*|\*|__|_|~~|`| ?-->)+$/.test(doc.sliceString(r.head, line.to))) {
      changed = true;
      return EditorSelection.cursor(line.to);
    }
    const p = linePrefix(line.text);
    if (!p.kind || r.head >= line.from + p.end) return r;
    changed = true;
    // Moving left from the start of a line's text goes to the end of the line above.
    const old = tr.startState.selection.main.head;
    if (!tr.docChanged && old === line.from + p.end && line.number > 1) return EditorSelection.cursor(line.from - 1);
    return EditorSelection.cursor(line.from + p.end);
  });
  return changed ? [tr, { selection: EditorSelection.create(ranges, tr.newSelection.mainIndex), sequential: true }] : tr;
});

// ---------------------------------------------------------------- typing and deleting

/** Backspace just after a picture (or Delete just before it) removes the whole picture. */
function deletePicture(forward) {
  return (view) => {
    const r = view.state.selection.main;
    if (!r.empty) return false;
    let hit = null;
    syntaxTree(view.state).iterate({
      from: r.head - 1, to: r.head + 1,
      enter(n) { if (n.name === 'Image' && (forward ? n.from === r.head : n.to === r.head)) hit = { from: n.from, to: n.to }; },
    });
    if (!hit) return false;
    view.dispatch({ changes: hit, selection: { anchor: hit.from }, userEvent: 'delete' });
    return true;
  };
}

function linkAt(state, pos) {
  for (let n = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent) {
    if (n.name === 'Link' || n.name === 'URL' || n.name === 'Autolink') {
      const link = n.name === 'URL' ? n.parent : n;
      const url = link && (nodeUrl(state, link) || (n.name === 'URL' ? state.sliceDoc(n.from, n.to) : null));
      if (url) return url;
    }
  }
  return null;
}

const linkClicks = EditorView.domEventHandlers({
  mousedown(e, view) {
    if (!(e.metaKey || e.ctrlKey) || e.button !== 0) return false;
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
    const url = pos != null && linkAt(view.state, pos);
    if (!url) return false;
    e.preventDefault();
    openLink?.(url);
    return true;
  },
});

/** Put pictures on their own lines at `pos`. `save(file)` stores one and returns its path. */
async function insertPictures(view, files, pos, save) {
  for (const file of files) {
    let src;
    try { src = await save(file); } catch { return; }
    if (!src) return;
    const doc = view.state.doc;
    pos = Math.min(pos, doc.length);
    const line = doc.lineAt(pos);
    const before = pos > line.from ? (doc.sliceString(pos - 1, pos) === '\n' ? '' : '\n\n') : pos > 0 && doc.sliceString(pos - 2, pos) !== '\n\n' ? '\n' : '';
    const after = pos < line.to ? '\n\n' : '\n';
    const insert = `${before}![](<${src}>)${after}`;
    view.dispatch({ changes: { from: pos, insert }, selection: { anchor: pos + insert.length }, scrollIntoView: true, userEvent: 'input.paste' });
    pos += insert.length;
  }
  view.focus();
}

const pictureFiles = (list) => [...(list || [])].filter((f) => f.type.startsWith('image/'));

const PAIRS = [['**', '**'], ['__', '__'], ['~~', '~~'], ['*', '*'], ['_', '_'], ['`', '`'], ['<!-- ', ' -->'], ['<!--', '-->']];

/** After deleting at `pos`, drop formatting marks left with nothing between them. */
function emptyPairAt(doc, pos) {
  for (const [o, c] of PAIRS) {
    if (pos - o.length >= 0 && doc.sliceString(pos - o.length, pos) === o && doc.sliceString(pos, pos + c.length) === c) return { from: pos - o.length, to: pos + c.length };
  }
  return null;
}

function deleteBy(forward) {
  return (view) => {
    const { state } = view;
    if (!state.selection.ranges.every((r) => r.empty)) return false;
    const hidden = hiddenRanges(view);
    const changes = [];
    const ranges = state.selection.ranges.map((r) => {
      const line = state.doc.lineAt(r.head);
      const p = linePrefix(line.text);
      // Backspace at the start of a list item, heading or quote removes its marker first.
      if (!forward && p.kind && r.head === line.from + p.end) {
        const keep = (p.kind === 'bullet' || p.kind === 'task' || p.kind === 'number') && p.indent > 0 ? line.text.slice(0, Math.max(0, p.indent - 2)) : '';
        if (keep) {
          changes.push({ from: line.from, to: line.from + p.indent, insert: keep });
          return EditorSelection.cursor(line.from + p.end - (p.indent - keep.length));
        }
        changes.push({ from: line.from, to: line.from + p.end });
        return EditorSelection.cursor(line.from);
      }
      let pos = r.head;
      for (let moved = true; moved;) {
        moved = false;
        for (const [f, t2] of hidden) {
          if (!forward && t2 === pos && f < t2) { pos = f; moved = true; }
          if (forward && f === pos && f < t2) { pos = t2; moved = true; }
        }
      }
      if (pos === r.head) return null; // nothing hidden next to the caret: delete normally
      if (forward ? pos >= state.doc.length : pos <= 0) return r;
      let from, to;
      if (forward) {
        const str = state.doc.sliceString(pos, pos + 4);
        from = pos; to = pos + findClusterBreak(str, 0, true);
      } else {
        const s0 = Math.max(0, pos - 4), str = state.doc.sliceString(s0, pos);
        from = s0 + findClusterBreak(str, str.length, false); to = pos;
      }
      changes.push({ from, to });
      return EditorSelection.cursor(forward ? r.head : r.head - (to - from));
    });
    if (ranges.some((x) => x === null)) return false;
    view.dispatch({ changes, selection: EditorSelection.create(ranges), userEvent: forward ? 'delete.forward' : 'delete.backward', scrollIntoView: true });
    return true;
  };
}

// Remove "****" and friends that a deletion leaves behind.
const tidyPairs = EditorView.updateListener.of((u) => {
  if (!u.docChanged || !u.transactions.some((tr) => tr.isUserEvent('delete'))) return;
  const pos = u.state.selection.main.head;
  const pair = emptyPairAt(u.state.doc, pos);
  if (pair) queueMicrotask(() => u.view.dispatch({ changes: pair, selection: { anchor: pair.from }, userEvent: 'delete' }));
});

// Pages-style ⌘B with nothing selected: the next thing you type is bold.
const setPending = StateEffect.define();
const pendingField = StateField.define({
  create: () => null,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setPending)) return e.value;
    if (tr.selection && !tr.docChanged) return null;
    return v;
  },
});

const smartCompartment = new Compartment();
const smartTyping = EditorView.inputHandler.of((view, from, to, text) => {
  if (text.length !== 1 || !view.state.selection.main.empty || inCode(view.state, from)) return false;
  const line = view.state.doc.lineAt(from);
  if (syntaxTree(view.state).resolveInner(from, -1).name === 'InlineCode') return false;
  const s = smartChar(line.text.slice(0, from - line.from), text);
  if (!s) return false;
  view.dispatch({ changes: { from: from - s.replaceBefore, to, insert: s.insert }, selection: { anchor: from - s.replaceBefore + s.insert.length }, userEvent: 'input.type' });
  return true;
});

const pendingInput = EditorView.inputHandler.of((view, from, to, text) => {
  const marks = view.state.field(pendingField, false);
  if (!marks || !/\S/.test(text)) return false;
  const open = marks, close = [...marks].reverse().join('');
  view.dispatch({
    changes: { from, to, insert: open + text + close },
    selection: { anchor: from + open.length + text.length },
    effects: setPending.of(null),
    userEvent: 'input.type',
  });
  return true;
});

// ---------------------------------------------------------------- formatting commands

const NODE = { '**': 'StrongEmphasis', '*': 'Emphasis', '~~': 'Strikethrough' };

function enclosing(state, pos, name, side = 0) {
  for (let n = syntaxTree(state).resolveInner(pos, side); n; n = n.parent) if (n.name === name) return n;
  return null;
}
function markLen(node) {
  const c = node.firstChild;
  return c && /Mark$/.test(c.name) ? c.to - c.from : 0;
}

/** Bold, italic or strikethrough: on the selection, the word at the caret, or what you type next. */
export function toggleInline(mark) {
  const name = NODE[mark];
  return (view) => {
    const { state } = view;
    const r = state.selection.main;
    let node = enclosing(state, r.from, name, 1) || enclosing(state, r.from, name, -1);
    if (node && !(node.from <= r.from && node.to >= r.to)) node = null;
    if (node) {
      const n = markLen(node);
      // Caret at the end of bold text: step out, so what you type next is plain.
      if (r.empty && r.head === node.to - n) {
        view.dispatch({ selection: { anchor: node.to } });
        return true;
      }
      view.dispatch({
        changes: [{ from: node.from, to: node.from + n }, { from: node.to - n, to: node.to }],
        selection: r.empty ? { anchor: r.head - n } : { anchor: Math.max(node.from, r.from - n), head: Math.min(node.to - 2 * n, r.to - n) },
        userEvent: 'input.format',
      });
      return true;
    }
    let { from, to } = r;
    if (r.empty) {
      const w = state.wordAt(r.head);
      if (!w || w.from === r.head || w.to === r.head) {
        const cur = state.field(pendingField, false);
        view.dispatch({ effects: setPending.of(cur === mark ? null : (cur && !cur.includes(mark) ? cur + mark : mark)) });
        return true;
      }
      ({ from, to } = w);
    }
    // Don't wrap the spaces at either end of a selection: "** word**" isn't bold.
    const sel = state.sliceDoc(from, to);
    from += sel.length - sel.trimStart().length;
    to -= sel.length - sel.trimEnd().length;
    if (to <= from) return true;
    view.dispatch({
      changes: [{ from, insert: mark }, { from: to, insert: mark }],
      selection: r.empty ? { anchor: r.head + mark.length } : { anchor: from + mark.length, head: to + mark.length },
      userEvent: 'input.format',
    });
    return true;
  };
}

function selectedLines(state) {
  const r = state.selection.main;
  const first = state.doc.lineAt(r.from), last = state.doc.lineAt(r.to > r.from && state.doc.lineAt(r.to).from === r.to ? r.to - 1 : r.to);
  const lines = [];
  for (let n = first.number; n <= last.number; n++) lines.push(state.doc.line(n));
  return lines;
}

/** Bulleted list, numbered list, checklist, quote, heading or body text for the selected lines. */
export function setBlock(kind) {
  return (view) => {
    const lines = selectedLines(view.state);
    const next = applyBlock(lines.map((l) => l.text), kind);
    const from = lines[0].from, to = lines.at(-1).to;
    const text = next.join('\n');
    const caretLine = view.state.doc.lineAt(view.state.selection.main.head);
    const single = lines.length === 1;
    view.dispatch({
      changes: { from, to, insert: text },
      selection: single ? { anchor: from + text.length - (caretLine.to - view.state.selection.main.head) } : { anchor: from, head: from + text.length },
      userEvent: 'input.format',
    });
    return true;
  };
}

export function clearFormatting(view) {
  const { state } = view;
  const r = state.selection.main;
  const lines = selectedLines(state);
  const from = r.empty ? lines[0].from : r.from, to = r.empty ? lines.at(-1).to : r.to;
  let text = clearInline(state.sliceDoc(from, to));
  if (r.empty || from === lines[0].from) text = applyBlock(text.split('\n'), 'body').join('\n');
  view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from, head: from + text.length }, userEvent: 'input.format' });
  return true;
}

export function insertNote(view) {
  const r = view.state.selection.main;
  if (r.empty && noteAt(view.state, r.head)) return exitNote(false)(view);
  if (r.empty) {
    view.dispatch({ changes: { from: r.from, insert: '<!--  -->' }, selection: { anchor: r.from + 5 }, userEvent: 'input.format' });
  } else {
    const text = view.state.sliceDoc(r.from, r.to);
    view.dispatch({ changes: { from: r.from, to: r.to, insert: `<!-- ${text} -->` }, selection: { anchor: r.from + 5, head: r.from + 5 + text.length }, userEvent: 'input.format' });
  }
  return true;
}

export function insertLink(view, url) {
  const r = view.state.selection.main;
  const w = r.empty ? view.state.wordAt(r.head) : r;
  const from = w ? w.from : r.from, to = w ? w.to : r.to;
  const text = view.state.sliceDoc(from, to) || url;
  view.dispatch({ changes: { from, to, insert: `[${text}](${url})` }, selection: { anchor: from + text.length + url.length + 4 }, userEvent: 'input.format' });
  return true;
}

/** The note to self around `pos`, if any: { from, to, contentFrom, contentTo }. */
function noteAt(state, pos) {
  const lo = Math.max(0, pos - 20000);
  const before = state.sliceDoc(lo, pos);
  const open = before.lastIndexOf('<!--');
  if (open < 0 || before.indexOf('-->', open + 4) >= 0) return null;
  const after = state.sliceDoc(pos, Math.min(state.doc.length, pos + 20000));
  const close = after.indexOf('-->');
  if (close < 0) return null;
  const from = lo + open, to = pos + close + 3;
  const contentFrom = from + 4 + (state.sliceDoc(from + 4, from + 5) === ' ' ? 1 : 0);
  const contentTo = to - 3 - (state.sliceDoc(to - 4, to - 3) === ' ' ? 1 : 0);
  return { from, to, contentFrom, contentTo: Math.max(contentFrom, contentTo) };
}

/**
 * Step out of a note to self. Return at the end of a note ends it and starts a new
 * line; an empty note is removed. ⇧⌘K and Esc inside a note just step past it.
 */
function exitNote(newline) {
  return (view) => {
    const r = view.state.selection.main;
    if (!r.empty) return false;
    const n = noteAt(view.state, r.head);
    if (!n) return false;
    if (newline && r.head < n.contentTo) return false; // Return in the middle: a line break inside the note
    const empty = !view.state.sliceDoc(n.contentFrom, n.contentTo).trim();
    if (empty) {
      view.dispatch({ changes: { from: n.from, to: n.to, insert: newline ? '\n' : '' }, selection: { anchor: n.from + (newline ? 1 : 0) }, userEvent: 'input' });
    } else if (newline) {
      view.dispatch({ changes: { from: n.to, insert: '\n' }, selection: { anchor: n.to + 1 }, scrollIntoView: true, userEvent: 'input' });
    } else {
      view.dispatch({ selection: { anchor: n.to } });
    }
    return true;
  };
}

/** Return on an empty quote line ends the quote. */
function endEmptyQuote(view) {
  const r = view.state.selection.main;
  if (!r.empty) return false;
  const line = view.state.doc.lineAt(r.head);
  if (!/^\s*>\s*$/.test(line.text)) return false;
  view.dispatch({ changes: { from: line.from, to: line.to }, selection: { anchor: line.from }, userEvent: 'delete' });
  return true;
}

/** Tab and ⇧Tab nest list items; elsewhere Tab does nothing (a tab would turn a line into code). */
function indentList(dir) {
  return (view) => {
    const lines = selectedLines(view.state);
    const changes = [];
    for (const l of lines) {
      const p = linePrefix(l.text);
      if (!['bullet', 'number', 'task'].includes(p.kind)) continue;
      const step = p.kind === 'number' ? 3 : 2;
      if (dir > 0) changes.push({ from: l.from, insert: ' '.repeat(step) });
      else if (p.indent > 0) changes.push({ from: l.from, to: l.from + Math.min(p.indent, step) });
    }
    if (changes.length) view.dispatch({ changes, userEvent: 'input.indent' });
    return true;
  };
}

// ---------------------------------------------------------------- formatting bar on selection

const showBar = StateEffect.define();
let mouseDown = false;
const barField = StateField.define({
  create: () => false,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(showBar)) return e.value;
    if (tr.docChanged) return false;
    if (tr.selection) return !mouseDown && !tr.state.selection.main.empty;
    return v;
  },
  provide: (f) => showTooltip.compute([f, 'selection'], (state) => {
    if (!state.field(f) || state.selection.main.empty) return null;
    const r = state.selection.main;
    return { pos: r.from, end: r.to, above: true, strictSide: false, arrow: false, create: (view) => ({ dom: barDom(view) }) };
  }),
});
const barMouse = EditorView.domEventHandlers({
  blur(e, view) {
    if (view.state.field(barField, false)) setTimeout(() => view.dispatch({ effects: showBar.of(false) }), 0);
    return false;
  },
  mousedown(e, view) {
    if (e.target.closest?.('.cm-tooltip')) return false;
    mouseDown = true;
    const up = () => {
      mouseDown = false;
      document.removeEventListener('mouseup', up);
      setTimeout(() => view.dispatch({ effects: showBar.of(!view.state.selection.main.empty) }), 0);
    };
    document.addEventListener('mouseup', up);
    if (view.state.field(barField)) view.dispatch({ effects: showBar.of(false) });
    return false;
  },
});

let barActions = {};
function barDom(view) {
  const dom = document.createElement('div');
  dom.className = 'fmt-bar';
  const btn = (label, title, action, cls = '') => {
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = label;
    b.title = title;
    if (cls) b.className = cls;
    b.addEventListener('mousedown', (e) => { e.preventDefault(); barActions[action]?.(view); view.dispatch({ effects: showBar.of(!view.state.selection.main.empty) }); });
    dom.append(b);
  };
  const sep = () => { const s = document.createElement('span'); s.className = 'sep'; dom.append(s); };
  btn('<b>B</b>', 'Bold (⌘B)', 'bold');
  btn('<i>I</i>', 'Italic (⌘I)', 'italic');
  btn('<s>S</s>', 'Strikethrough (⇧⌘X)', 'strike');
  sep();
  btn('H1', 'Heading 1 (⌥⌘1)', 'h1', 'small');
  btn('H2', 'Heading 2 (⌥⌘2)', 'h2', 'small');
  sep();
  btn('•', 'Bulleted list (⇧⌘8)', 'bullets');
  btn('1.', 'Numbered list (⇧⌘7)', 'numbers', 'small');
  btn('☐', 'Checklist (⇧⌘L)', 'checklist');
  btn('❝', 'Quote', 'quote');
  sep();
  btn('Link', 'Link (⌘K)', 'link', 'small');
  btn('Note', 'Note to self (⇧⌘K)', 'note', 'small');
  return dom;
}

// ---------------------------------------------------------------- the editor

export const COMMANDS = {
  bold: toggleInline('**'),
  italic: toggleInline('*'),
  strike: toggleInline('~~'),
  h1: setBlock('h1'),
  h2: setBlock('h2'),
  h3: setBlock('h3'),
  body: setBlock('body'),
  bullets: setBlock('bullet'),
  numbers: setBlock('number'),
  checklist: setBlock('task'),
  quote: setBlock('quote'),
  note: insertNote,
  clear: clearFormatting,
  find: (view) => openSearchPanel(view),
};

export function createEditor(parent, { onChange, extraKeys = [], onLink, onAction, onImage, imageSrc, onOpenLink }) {
  imageSource = imageSrc || null;
  openLink = onOpenLink || null;
  const pictureDrops = EditorView.domEventHandlers({
    paste(e, view) {
      const files = pictureFiles(e.clipboardData?.files);
      if (!files.length || !onImage) return false;
      e.preventDefault();
      insertPictures(view, files, view.state.selection.main.head, onImage);
      return true;
    },
    dragover(e) {
      if (!onImage || ![...(e.dataTransfer?.types || [])].includes('Files')) return false;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      return true;
    },
    drop(e, view) {
      const files = pictureFiles(e.dataTransfer?.files);
      if (!files.length || !onImage) return false;
      e.preventDefault();
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? view.state.selection.main.head;
      insertPictures(view, files, pos, onImage);
      return true;
    },
  });
  const focus = new Compartment();
  const tw = new Compartment();
  let focusOn = false, twOn = false, smartOn = true;
  barActions = { ...COMMANDS, link: () => onLink?.() };

  const shifted = [
    { key: 'Mod-Shift-8', run: COMMANDS.bullets },
    { key: 'Mod-Shift-7', run: COMMANDS.numbers },
    { key: "Mod-Shift-'", run: COMMANDS.quote },
  ];
  // Shifted letters are matched by physical key, so ⌘K never answers for ⇧⌘K.
  const byCode = { KeyX: COMMANDS.strike, KeyL: COMMANDS.checklist, KeyK: COMMANDS.note, KeyF: () => { onAction?.('find-book'); return true; } };
  shifted.push({
    any(view, e) {
      const run = (e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && byCode[e.code];
      if (!run) return false;
      e.preventDefault();
      return run(view);
    },
  });
  const keys = [
    { key: 'Mod-b', run: COMMANDS.bold },
    { key: 'Mod-i', run: COMMANDS.italic },
    { key: 'Mod-Alt-1', run: COMMANDS.h1 },
    { key: 'Mod-Alt-2', run: COMMANDS.h2 },
    { key: 'Mod-Alt-3', run: COMMANDS.h3 },
    { key: 'Mod-Alt-0', run: COMMANDS.body },
    { key: 'Mod-\\', run: COMMANDS.clear },
    { key: 'Mod-k', run: () => { onLink?.(); return true; } },
    { key: 'Tab', run: indentList(1) },
    { key: 'Shift-Tab', run: indentList(-1) },
  ];

  const extensions = () => [
    history(),
    drawSelection(),
    EditorView.lineWrapping,
    markdown({ base: markdownLanguage }),
    syntaxHighlighting(style),
    livePlugin,
    caretGuard,
    pendingField,
    pendingInput,
    smartCompartment.of(smartOn ? smartTyping : []),
    tidyPairs,
    barField,
    barMouse,
    linkClicks,
    pictureDrops,
    search({ top: true }),
    placeholder('Start writing…'),
    Prec.highest(keymap.of([{ key: 'Backspace', run: deletePicture(false) }, { key: 'Delete', run: deletePicture(true) }, { key: 'Backspace', run: deleteBy(false) }, { key: 'Delete', run: deleteBy(true) }, { key: 'Enter', run: exitNote(true) }, { key: 'Enter', run: endEmptyQuote }, { key: 'Escape', run: exitNote(false) }, ...shifted])),
    keymap.of([...keys, ...extraKeys, ...searchKeymap, ...defaultKeymap, ...historyKeymap]),
    focus.of(focusOn ? focusPlugin : []),
    tw.of(twOn ? typewriter() : []),
    EditorView.contentAttributes.of({ spellcheck: 'true', autocorrect: 'on', autocapitalize: 'sentences' }),
    EditorView.updateListener.of((u) => { if (u.docChanged) onChange(u.state.doc.toString()); }),
  ];

  const view = new EditorView({ parent, state: EditorState.create({ doc: '', extensions: extensions() }) });

  return {
    view,
    /**
     * Show a section's text. Starts a fresh undo history, so Undo never reaches into
     * another section. `cursor` keeps the caret near where it was (reload from the other Mac).
     */
    load(text, cursor = 0) {
      const anchor = Math.max(0, Math.min(cursor, text.length));
      view.setState(EditorState.create({ doc: text, selection: { anchor }, extensions: extensions() }));
      if (anchor) view.dispatch({ effects: EditorView.scrollIntoView(anchor, { y: 'center' }) });
    },
    text: () => view.state.doc.toString(),
    cursor: () => view.state.selection.main.head,
    run(name) { const c = COMMANDS[name]; if (!c) return false; view.focus(); return c(view); },
    link(url) { view.focus(); return insertLink(view, url); },
    select(from, to) {
      view.focus();
      view.dispatch({ selection: { anchor: from, head: to }, effects: EditorView.scrollIntoView(from, { y: 'center' }) });
    },
    setFocusMode(on) { focusOn = on; view.dispatch({ effects: focus.reconfigure(on ? focusPlugin : []) }); },
    setTypewriter(on) { twOn = on; view.dispatch({ effects: tw.reconfigure(on ? typewriter() : []) }); },
    setSmartTyping(on) { smartOn = on; view.dispatch({ effects: smartCompartment.reconfigure(on ? smartTyping : []) }); },
    focus() { view.focus(); },
  };
}
