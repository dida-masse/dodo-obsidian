// Writing a link: the suggestion list on [[ (in dodo notes) and the "Länka till …" dialog (anywhere). Both search dodo while you type and write
// [[Text|dodo:x/id]] at the caret.
import { EditorSuggest, SuggestModal, type App, type Editor, type EditorPosition, type EditorSuggestContext, type EditorSuggestTriggerInfo, type TFile } from 'obsidian';
import { KIND } from './links.js';
import type { Dodo } from './sync.js';

export type Item = { kind: 't' | 'h' | 'l'; id: string; text: string; list: string; listName: string };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const show = (it: Item, el: HTMLElement) => { el.createSpan({ cls: 'dodo-kind', text: KIND[it.kind] }); el.createSpan({ text: ' ' + it.text.slice(0, 80) }); if (it.listName) el.createSpan({ cls: 'dodo-in', text: ' · ' + it.listName }); };

export interface SuggestHost { dodo: Dodo; listOf(file: TFile): string | null }

export class LinkSuggest extends EditorSuggest<Item> {
  private seq = 0;
  constructor(app: App, private h: SuggestHost) { super(app); this.limit = 12; }
  // only in a dodo note whose list is synced here; elsewhere Obsidian's own [[ list is left alone
  onTrigger(cursor: EditorPosition, editor: Editor, file: TFile | null): EditorSuggestTriggerInfo | null {
    const id = file && this.h.listOf(file);
    if (!id || !this.h.dodo.data.lists[id] || !this.h.dodo.data.session) return null;
    const before = editor.getLine(cursor.line).slice(0, cursor.ch), m = /\[\[([^\]\n|]*)$/.exec(before);
    return m ? { start: { line: cursor.line, ch: m.index }, end: cursor, query: m[1] } : null;
  }
  async getSuggestions(c: EditorSuggestContext): Promise<Item[]> {
    const me = ++this.seq, id = this.h.listOf(c.file);
    await sleep(150); // while the typing goes on, only the last word is asked
    if (me !== this.seq || !id) return [];
    try { return await this.h.dodo.linkSearch(id, c.query); } catch { return []; } // offline or not allowed: no list, no message
  }
  renderSuggestion(it: Item, el: HTMLElement) { show(it, el); }
  selectSuggestion(it: Item) {
    const c = this.context;
    if (!c) return;
    const link = this.h.dodo.dodoLink(it.kind, it.id, it.text), line = c.editor.getLine(c.end.line);
    const to = { line: c.end.line, ch: c.end.ch + (line.startsWith(']]', c.end.ch) ? 2 : 0) }; // Obsidian may have closed the brackets already
    c.editor.replaceRange(link, c.start, to);
    c.editor.setCursor({ line: c.start.line, ch: c.start.ch + link.length });
  }
}

// "dodo: Länka till lista, rubrik eller uppgift…": an empty box shows the lists, typing searches
export class LinkModal extends SuggestModal<Item> {
  private seq = 0;
  constructor(app: App, private dodo: Dodo, private listId: string, private put: (link: string) => void) { super(app); this.setPlaceholder('Skriv för att söka, eller välj en lista. Lista/ord söker bara i den listan.'); }
  async getSuggestions(q: string): Promise<Item[]> {
    const me = ++this.seq;
    await sleep(150);
    if (me !== this.seq) return [];
    try {
      if (q.trim()) return await this.dodo.linkSearch(this.listId, q.trim());
      return (await this.dodo.lists()).map(l => ({ kind: 'l' as const, id: l.id, text: l.name, list: l.id, listName: '' }));
    } catch { return []; }
  }
  renderSuggestion(it: Item, el: HTMLElement) { show(it, el); }
  onChooseSuggestion(it: Item) { this.put(this.dodo.dodoLink(it.kind, it.id, it.text)); }
}
