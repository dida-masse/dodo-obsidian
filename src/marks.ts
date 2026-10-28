// A small "💬 n" at the end of each todo line that has comments: a CodeMirror decoration, never text in the file.
// The line -> todo map comes from the sync core (docPlan against the last server version). While typing, the markers
// follow their lines through the changes and are recomputed 300 ms after the last keystroke.
import { StateEffect, StateField, RangeSetBuilder, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { editorInfoField, type TFile } from 'obsidian';

export interface MarkHost {
  marks(file: TFile, text: string): { line: number; id: string; n: number; fresh: boolean }[];
  open(file: TFile, todo: string): void;
  moved(file: TFile, text: string, line: number): void;
}

class Mark extends WidgetType {
  constructor(private n: number, private fresh: boolean, private id: string, private open: (id: string) => void) { super(); }
  eq(o: Mark) { return o.n === this.n && o.fresh === this.fresh && o.id === this.id; }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'dodo-mark' + (this.fresh ? ' dodo-mark-new' : '');
    el.textContent = `💬 ${this.n}`;
    el.setAttribute('aria-label', 'Visa kommentarer');
    el.onmousedown = e => e.preventDefault(); // keeps the caret where it was
    el.onclick = () => this.open(this.id);
    return el;
  }
  ignoreEvent() { return true; }
}

const set = StateEffect.define<DecorationSet>();
const field = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(v, tr) { v = v.map(tr.changes); for (const e of tr.effects) if (e.is(set)) v = e.value; return v; },
  provide: f => EditorView.decorations.from(f),
});

interface Live { later(ms: number): void }
const live = new Set<Live>();
export const refreshMarks = () => live.forEach(p => p.later(0));

export function marksExtension(h: MarkHost): Extension {
  const plugin = ViewPlugin.fromClass(class implements Live {
    private t?: number;
    private c?: number;
    constructor(private view: EditorView) { live.add(this); this.later(0); }
    update(u: ViewUpdate) {
      if (u.docChanged) this.later(300);
      if (u.docChanged || u.selectionSet) { window.clearTimeout(this.c); this.c = window.setTimeout(() => this.cursor(), 200); }
    }
    later(ms: number) { window.clearTimeout(this.t); this.t = window.setTimeout(() => this.compute(), ms); }
    private file() { return this.view.state.field(editorInfoField, false)?.file ?? null; }
    private compute() {
      const file = this.file();
      if (!file || !this.view.dom.isConnected) return;
      const doc = this.view.state.doc, b = new RangeSetBuilder<Decoration>();
      for (const m of h.marks(file, doc.toString())) {
        if (m.line >= doc.lines) continue;
        b.add(doc.line(m.line + 1).to, doc.line(m.line + 1).to, Decoration.widget({ widget: new Mark(m.n, m.fresh, m.id, id => h.open(file, id)), side: 1 }));
      }
      this.view.dispatch({ effects: set.of(b.finish()) });
    }
    private cursor() {
      const file = this.file();
      if (file) h.moved(file, this.view.state.doc.toString(), this.view.state.doc.lineAt(this.view.state.selection.main.head).number - 1);
    }
    destroy() { live.delete(this); window.clearTimeout(this.t); window.clearTimeout(this.c); }
  });
  return [field, plugin];
}
