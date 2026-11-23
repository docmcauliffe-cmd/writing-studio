// The writing surface: CodeMirror with Markdown that looks like formatted text.
import { EditorState, Compartment, RangeSetBuilder } from '@codemirror/state';
import { EditorView, keymap, placeholder, ViewPlugin, Decoration, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
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
        markdown(),
        syntaxHighlighting(style),
        placeholder('Start writing…'),
        keymap.of([...extraKeys, ...defaultKeymap, ...historyKeymap, indentWithTab]),
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
