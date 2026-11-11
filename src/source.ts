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
// A block as data for the widget. Parsed by hand, and shown with textContent only: nothing in the block is ever HTML.
export type Cell = { text: string; bold: boolean; old?: string };
export type Table = { change?: string; head: Cell[]; rows: Cell[][] };
// the server escapes \\ | and < (cell() in server.js); \\ and | by a backslash, < as &lt;
const unescape = (s: string) => s.replace(/\\([|\\])/g, '$1').replace(/&lt;/g, '<');
function splitRow(row: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 1; i < row.length; i++) { // from 1: past the leading pipe
    if (row[i] === '\\' && i + 1 < row.length) cur += row[i] + row[++i];
    else if (row[i] === '|') { out.push(cur); cur = ''; }
    else cur += row[i];
  }
  return out.map(c => c.trim()); // a text after the last pipe is not a cell
}
const cellOf = (raw: string): Cell => {
  const m = /^\*\*(.*)\*\*(?: ← (.*))?$/.exec(raw); // **new** ← old
  return m ? { text: unescape(m[1]), bold: true, ...(m[2] != null ? { old: unescape(m[2]) } : {}) } : { text: unescape(raw), bold: false };
};
// the lines of one block (markers included) -> its table, or null when it is not the block the server writes (then it stays raw text)
export function parseBlock(lines: string[]): Table | null {
  const l = lines.map(x => x.trim());
  if (l.length < 4 || l[0] !== OPEN || l[l.length - 1] !== CLOSE) return null;
  const t = l.slice(1, -1).filter(x => x), rows = t.filter(x => x.startsWith('|'));
  if (rows.length < 3 || !/^\|[-| ]+\|$/.test(rows[1])) return null; // a header, the dashes, and at least one row
  const first = t.findIndex(x => x.startsWith('|')), change = t.slice(0, first).join(' ');
  return { ...(change ? { change: unescape(change.replace(/^\*(.*?:)\* /, '$1 ')) } : {}), head: splitRow(rows[0]).map(cellOf), rows: [rows[0], ...rows.slice(2)].slice(1).map(r => splitRow(r).map(cellOf)) };
}
class TableWidget extends WidgetType {
  constructor(private t: Table) { super(); }
  eq(o: TableWidget) { return JSON.stringify(o.t) === JSON.stringify(this.t); }
  toDOM() {
    const el = (tag: string, cls = '', text = '') => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };
    const box = el('div', 'dodo-src-block');
    box.append(el('div', 'dodo-src-label', SRC_LABEL));
    if (this.t.change) box.append(el('div', 'dodo-src-change', this.t.change));
    const table = el('table'), fill = (tr: HTMLElement, cells: Cell[], tag: string) => {
      for (const c of cells) {
        const td = el(tag);
        td.append(c.bold ? el('strong', '', c.text) : document.createTextNode(c.text));
        if (c.old != null) td.append(document.createTextNode(' ← ' + c.old));
        tr.append(td);
      }
    };
    const thead = el('thead'), hr = el('tr');
    fill(hr, this.t.head, 'th'); thead.append(hr); table.append(thead);
    const tbody = el('tbody');
    for (const r of this.t.rows) { const tr = el('tr'); fill(tr, r, 'td'); tbody.append(tr); }
    table.append(tbody);
    const scroll = el('div', 'dodo-src-scroll'); scroll.append(table); box.append(scroll);
    return box;
  }
  ignoreEvent() { return false; }
}
class Label extends WidgetType {
  constructor(private text: string) { super(); }
  eq(o: Label) { return o.text === this.text; }
  toDOM() { const el = document.createElement('span'); el.className = 'dodo-src-label'; el.textContent = this.text; return el; }
}
const SRC_LABEL = 'Från Kursredan, kan inte ändras här';
// live: Live Preview, where a whole block is one table widget; otherwise (Source mode) raw lines with a muted background
export function sourceDecos(doc: Text, live = false): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  for (const [from, to] of sourceBlocks(doc)) {
    const t = live ? parseBlock(doc.sliceString(from, to).split('\n')) : null;
    if (t) { b.add(from, to, Decoration.replace({ widget: new TableWidget(t), block: true })); continue; }
    for (let n = doc.lineAt(from).number; n <= doc.lineAt(to).number; n++) {
      const l = doc.line(n);
      b.add(l.from, l.from, Decoration.line({ class: 'dodo-src' }));
      if (l.from === from) b.add(l.text.search(/\S/) + l.from, l.to, Decoration.replace({ widget: new Label(SRC_LABEL) }));
      else if (l.to === to) b.add(l.text.search(/\S/) + l.from, l.to, Decoration.replace({ widget: new Label('') }));
    }
  }
  return b.finish();
}
const sourceField = (live: (s: EditorState) => boolean) => StateField.define<DecorationSet>({
  create: s => sourceDecos(s.doc, live(s)),
  update: (v, tr) => (tr.docChanged || live(tr.state) !== live(tr.startState) ? sourceDecos(tr.state.doc, live(tr.state)) : v),
  provide: f => [EditorView.decorations.from(f),
    // the cursor steps over a table widget (nothing in it can be typed); the line decorations of Source mode are not atomic
    EditorView.atomicRanges.of(v => v.state.field(f).update({ filter: (_a, _b, d) => d.spec.widget instanceof TableWidget }))],
});
const TYPED = ['input', 'delete', 'move'];
// live: tells whether a state is in Live Preview (main.ts passes Obsidian's editorLivePreviewField); without it every block is raw text
export function sourceExtension(refused: () => void, live: (s: EditorState) => boolean = () => false): Extension {
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
  return [sourceField(live), filter];
}
