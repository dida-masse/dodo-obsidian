// How [[Text|dodo:t/id]] looks in Obsidian: Live Preview (a CodeMirror decoration over the link while the caret is elsewhere) and reading mode
// (the internal link Obsidian makes of it is replaced). Both draw only; the text in the file is never touched.
import { RangeSetBuilder, StateEffect, Prec, type EditorState, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { fenced, parseLinks, refOfAlias, type Info } from './links.js';

export interface LinkHost {
  known(ref: string): Info | null | undefined; // undefined: not asked, or no answer (offline)
  info(refs: string[]): Promise<unknown>; // asks the server about what is not known
  go(ref: string): void;
}

// r: undefined = no answer yet, null = not there or not mine (plain text, nothing said about why)
function paint(el: HTMLElement, ref: string, r: Info | null | undefined, h: LinkHost) {
  el.className = 'dodo-link' + (r ? (r.gone ? ' dodo-gone' : ' dodo-on') : '');
  if (!r) return;
  el.setAttribute('role', 'link'); el.tabIndex = 0;
  if (r.gone) el.title = 'Borttagen';
  el.onclick = e => { e.preventDefault(); e.stopPropagation(); h.go(ref); };
  el.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); h.go(ref); } };
}

class Widget extends WidgetType {
  constructor(private text: string, private ref: string, private r: Info | null | undefined, private h: LinkHost) { super(); }
  eq(o: Widget) { const k = (r: Info | null | undefined) => r === undefined ? '?' : r === null ? '-' : (r.gone ? 'g' : 'o') + r.list; return o.text === this.text && o.ref === this.ref && k(o.r) === k(this.r); }
  toDOM() {
    const el = document.createElement('span');
    el.textContent = this.text;
    paint(el, this.ref, this.r, this.h);
    el.onmousedown = e => e.preventDefault(); // the caret stays where it was
    return el;
  }
  ignoreEvent() { return true; }
}

const redraw = StateEffect.define<null>();
const touching = (s: EditorState, from: number, to: number) => s.selection.ranges.some(r => r.from <= to && r.to >= from);

export function linksExtension(h: LinkHost, live: (s: EditorState) => boolean): Extension {
  const plugin = ViewPlugin.fromClass(class {
    decorations: DecorationSet = Decoration.none;
    constructor(private view: EditorView) { this.build(); }
    update(u: ViewUpdate) { if (u.docChanged || u.selectionSet || u.viewportChanged || u.transactions.some(t => t.effects.some(e => e.is(redraw)))) this.build(); }
    build() {
      const { state } = this.view, b = new RangeSetBuilder<Decoration>(), ask = new Set<string>();
      if (live(state)) {
        const doc = state.doc;
        let lines: string[] | null = null; // shortcut: the whole document is split only when a link is met; fine for notes, upgrade if a vault has huge ones
        for (const r of this.view.visibleRanges) for (const m of parseLinks(doc.sliceString(r.from, r.to))) {
          const from = r.from + m.from, to = r.from + m.to, l = doc.lineAt(from);
          if (touching(state, from, to) || (doc.sliceString(l.from, from).split('`').length - 1) % 2) continue;
          if (fenced(lines ??= doc.toString().split('\n'), l.number - 1)) continue;
          const info = h.known(m.ref);
          if (info === undefined) ask.add(m.ref);
          b.add(from, to, Decoration.replace({ widget: new Widget(m.text, m.ref, info, h) }));
        }
      }
      this.decorations = b.finish();
      if (ask.size) void h.info([...ask]).then(() => { if (this.view.dom.isConnected && [...ask].some(r => h.known(r) !== undefined)) this.view.dispatch({ effects: redraw.of(null) }); });
    }
  }, { decorations: v => v.decorations });
  return Prec.high(plugin);
}

// Reading mode. Obsidian turns [[Text|dodo:t/id]] into an internal link to a note called "Text" with the text "dodo:t/id"; clicking it would make that note.
// So the link is replaced at once by plain text, and made a real link only when dodo says the target is there.
export function readingLinks(el: HTMLElement, h: LinkHost) {
  const found: [HTMLElement, string][] = [];
  el.querySelectorAll<HTMLAnchorElement>('a.internal-link').forEach(a => {
    const ref = refOfAlias(a.textContent ?? '');
    if (!ref) return;
    const span = document.createElement('span');
    span.textContent = a.getAttribute('data-href') ?? '';
    paint(span, ref, h.known(ref), h);
    a.replaceWith(span); found.push([span, ref]);
  });
  if (found.length) void h.info(found.map(f => f[1])).then(() => found.forEach(([s, ref]) => paint(s, ref, h.known(ref), h)));
}
