// A course's table (dodo #38): the source's, and the server puts it back whatever is written. Nothing here is text in the file, only decorations
// and a filter on what is typed.
import { EditorState, StateField, RangeSetBuilder, type Extension, type Text } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';

// ---- a course's table: between two markers, and the source's (the server puts it back whatever is written) ----
// The two marker lines are replaced by a short label, the lines between get a muted background, and a typed change inside the block is
// refused (a change that takes the whole block away, a deleted course, is allowed; so is whatever the plugin itself writes, which has no user event).
const OPEN = '<!-- dodo:källa -->', CLOSE = '<!-- /dodo:källa -->';
// [from, to] of each complete block in the document: the start of the opening marker's line to the end of the closing marker's line
export function sourceBlocks(doc: Text): [number, number][] {
  const out: [number, number][] = [];
  let from = -1;
  for (let n = 1; n <= doc.lines; n++) {
    const l = doc.line(n), t = l.text.trim();
    if (t === OPEN) from = l.from;
    else if (t === CLOSE && from >= 0) { out.push([from, l.to]); from = -1; }
  }
  return out;
}
class Label extends WidgetType {
  constructor(private text: string) { super(); }
  eq(o: Label) { return o.text === this.text; }
  toDOM() { const el = document.createElement('span'); el.className = 'dodo-src-label'; el.textContent = this.text; return el; }
}
const SRC_LABEL = 'Från Kursredan, kan inte ändras här';
function sourceDecos(doc: Text): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  for (const [from, to] of sourceBlocks(doc)) {
    for (let n = doc.lineAt(from).number; n <= doc.lineAt(to).number; n++) {
      const l = doc.line(n);
      b.add(l.from, l.from, Decoration.line({ class: 'dodo-src' }));
      if (l.from === from) b.add(l.text.search(/\S/) + l.from, l.to, Decoration.replace({ widget: new Label(SRC_LABEL) }));
      else if (l.to === to) b.add(l.text.search(/\S/) + l.from, l.to, Decoration.replace({ widget: new Label('') }));
    }
  }
  return b.finish();
}
const sourceField = StateField.define<DecorationSet>({
  create: s => sourceDecos(s.doc),
  update: (v, tr) => (tr.docChanged ? sourceDecos(tr.state.doc) : v),
  provide: f => EditorView.decorations.from(f),
});
const TYPED = ['input', 'delete', 'move'];
export function sourceExtension(refused: () => void): Extension {
  const filter = EditorState.changeFilter.of(tr => {
    if (!tr.docChanged || !TYPED.some(e => tr.isUserEvent(e))) return true;
    const blocks = sourceBlocks(tr.startState.doc);
    if (!blocks.length) return true;
    let bad = false;
    tr.changes.iterChangedRanges((a, b) => {
      for (const [from, to] of blocks) {
        const covers = a <= from && b >= to, inside = a === b ? a > from && a < to : a < to && b > from;
        if (inside && !covers) bad = true;
      }
    });
    if (bad) refused();
    return !bad;
  });
  return [sourceField, filter];
}
