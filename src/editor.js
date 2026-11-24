// The writing surface: CodeMirror with Markdown that looks like formatted text.
import { EditorState, EditorSelection, Compartment, RangeSetBuilder } from '@codemirror/state';
import { EditorView, keymap, placeholder, ViewPlugin, Decoration, WidgetType, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { paragraphRange } from './logic.js';

const style = HighlightStyle.define([
  { tag: t.heading1, fontSize: '1.55em', fontWeight: '600', lineHeight: '1.3' },
  { tag: t.heading2, fontSize: '1.28em', fontWeight: '600' },
  { tag: t.heading3, fontSize: '1.12em', fontWeight: '600' },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: '600' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strong, fontWeight: '650' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  // The # * > - symbols fade back so the text reads as formatted.
  { tag: [t.processingInstruction, t.contentSeparator], color: 'var(--mark)', fontWeight: '400' },
  { tag: t.quote, color: 'var(--dim)', fontStyle: 'italic' },
  { tag: [t.link, t.url], color: 'var(--hl)' },
  { tag: t.monospace, fontFamily: 'var(--mono)', fontSize: '0.9em' },
]);

// Focus mode: dim every paragraph except the one being written.
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

// ---- Formatting keys: ⌘B bold, ⌘I italic, ⇧⌘L checkbox ----

const stars = (state, pos, dir) => { let n = 0; while (state.sliceDoc(dir < 0 ? pos - n - 1 : pos + n, dir < 0 ? pos - n : pos + n + 1) === '*') n++; return n; };

/** Wrap the selection (or the word at the caret) in `mark`, or unwrap it if it is already wrapped. */
export function toggleWrap(mark) {
  const n = mark.length;
  const wrapped = (state, from, to) => {
    const b = stars(state, from, -1), a = stars(state, to, 1);
    return n === 2 ? b >= 2 && a >= 2 : b % 2 === 1 && a % 2 === 1;
  };
  return (view) => {
    const { state } = view;
    const tr = state.changeByRange((r) => {
      let { from, to } = r;
      // A caret inside a word formats the whole word; a caret elsewhere inserts a pair to type into.
      if (from === to) {
        const w = state.wordAt(from);
        if (w && w.from < from && w.to > from) ({ from, to } = w);
      }
      const inner = state.sliceDoc(from, to);
      if (inner.length >= 2 * n && inner.startsWith(mark) && inner.endsWith(mark) && wrapped(state, from + n, to - n)) {
        return { changes: [{ from, to: from + n }, { from: to - n, to }], range: EditorSelection.range(from, to - 2 * n) };
      }
      if (wrapped(state, from, to)) {
        return { changes: [{ from: from - n, to: from }, { from: to, to: to + n }], range: r.empty ? EditorSelection.cursor(r.head - n) : EditorSelection.range(from - n, to - n) };
      }
      const range = r.empty ? EditorSelection.cursor(r.head + n) : EditorSelection.range(from + n, to + n);
      return { changes: [{ from, insert: mark }, { from: to, insert: mark }], range };
    });
    view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: 'input' }));
    return true;
  };
}

/** Turn the selected lines into checklist items, or back into plain lines. */
export function toggleChecklist(view) {
  const { state } = view;
  const lines = new Set();
  for (const r of state.selection.ranges) for (let l = state.doc.lineAt(r.from).number; l <= state.doc.lineAt(r.to).number; l++) lines.add(l);
  const all = [...lines].map((l) => state.doc.line(l));
  const allTasks = all.every((l) => /^\s*[-*+] \[[ xX]\] /.test(l.text));
  const changes = [];
  for (const l of all) {
    if (allTasks) { const m = l.text.match(/^(\s*)[-*+] \[[ xX]\] /); changes.push({ from: l.from + m[1].length, to: l.from + m[0].length }); continue; }
    if (/^\s*[-*+] \[[ xX]\] /.test(l.text)) continue;
    const m = l.text.match(/^(\s*)([-*+]|\d+[.)]) /);
    if (m) changes.push({ from: l.from + m[0].length, insert: '[ ] ' });
    else { const ind = l.text.match(/^\s*/)[0].length; changes.push({ from: l.from + ind, insert: '- [ ] ' }); }
  }
  view.dispatch({ changes, userEvent: 'input' });
  return true;
}

// ---- Lists that look like lists: bullets, clickable checkboxes, hanging indents ----

class BulletWidget extends WidgetType {
  eq() { return true; }
  toDOM() { const s = document.createElement('span'); s.className = 'cm-bullet'; s.textContent = '•'; return s; }
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
      const pos = view.posAtDOM(box);
      const cur = view.state.sliceDoc(pos + 1, pos + 2);
      view.dispatch({ changes: { from: pos + 1, to: pos + 2, insert: cur === ' ' ? 'x' : ' ' }, userEvent: 'input' });
    });
    return box;
  }
  ignoreEvent() { return true; }
}
const bullet = Decoration.replace({ widget: new BulletWidget() });
const listLine = Decoration.line({ class: 'cm-li' });
const doneMark = Decoration.mark({ class: 'cm-done' });

function buildLists(view) {
  const decos = [];
  const { state } = view;
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from, to,
      enter(node) {
        if (node.name === 'ListItem') {
          const line = state.doc.lineAt(node.from);
          if (line.from <= node.from) decos.push(listLine.range(line.from));
        } else if (node.name === 'ListMark' && node.node.parent?.parent?.name === 'BulletList') {
          const task = node.node.nextSibling;
          if (task?.name === 'Task') {
            decos.push(Decoration.replace({}).range(node.from, task.from));
          } else {
            const end = state.sliceDoc(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to;
            decos.push(bullet.range(node.from, end));
          }
        } else if (node.name === 'TaskMarker') {
          const on = /x/i.test(state.sliceDoc(node.from, node.to));
          const end = state.sliceDoc(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to;
          decos.push(Decoration.replace({ widget: new CheckWidget(on) }).range(node.from, end));
          const task = node.node.parent;
          if (on && task && task.to > node.to + 1) decos.push(doneMark.range(node.to + 1, task.to));
        }
      },
    });
  }
  return Decoration.set(decos, true);
}

const listPlugin = ViewPlugin.fromClass(
  class {
    constructor(view) { this.decorations = buildLists(view); }
    update(u) { if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) this.decorations = buildLists(u.view); }
  },
  {
    decorations: (v) => v.decorations,
    provide: (p) => EditorView.atomicRanges.of((view) => {
      const d = view.plugin(p)?.decorations;
      if (!d) return Decoration.none;
      const b = new RangeSetBuilder();
      const iter = d.iter();
      for (; iter.value; iter.next()) if (iter.from < iter.to) b.add(iter.from, iter.to, iter.value);
      return b.finish();
    }),
  }
);

// Typewriter scrolling: keep the line being written near the middle of the window.
function typewriter() {
  let pending = false;
  return EditorView.updateListener.of((u) => {
    if (!(u.docChanged || u.selectionSet) || pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      const head = u.view.state.selection.main.head;
      u.view.dispatch({ effects: EditorView.scrollIntoView(head, { y: 'center' }) });
    });
  });
}

export function createEditor(parent, { onChange, extraKeys = [] }) {
  const focus = new Compartment();
  const tw = new Compartment();
  let focusOn = false, twOn = false;

  const extensions = () => [
        history(),
        drawSelection(),
        EditorView.lineWrapping,
        markdown({ base: markdownLanguage }),
        syntaxHighlighting(style),
        listPlugin,
        placeholder('Start writing…'),
        keymap.of([
          { key: 'Mod-b', run: toggleWrap('**') },
          { key: 'Mod-i', run: toggleWrap('*') },
          { key: 'Mod-Shift-l', run: toggleChecklist },
          ...extraKeys, ...defaultKeymap, ...historyKeymap, indentWithTab]),
        focus.of(focusOn ? focusPlugin : []),
        tw.of(twOn ? typewriter() : []),
        EditorView.contentAttributes.of({ spellcheck: 'true', autocorrect: 'on', autocapitalize: 'sentences' }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChange(u.state.doc.toString());
        }),
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
    setFocusMode(on) { focusOn = on; view.dispatch({ effects: focus.reconfigure(on ? focusPlugin : []) }); },
    setTypewriter(on) { twOn = on; view.dispatch({ effects: tw.reconfigure(on ? typewriter() : []) }); },
    focus() { view.focus(); },
  };
}
