// The side panel: the comment threads of the todo at the cursor, shown like the web does (replies indented, resolved threads folded).
import { ItemView, MarkdownRenderer, Notice, type WorkspaceLeaf } from 'obsidian';
import type { Dodo } from './sync.js';

export const VIEW = 'dodo-comments';
/* eslint-disable @typescript-eslint/no-explicit-any */
const when = (at: string) => new Date(at).toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' });

export class CommentsView extends ItemView {
  private list: string | null = null;
  private todo: string | null = null;
  private sig = '';
  private reply: string | null = null;
  private unfolded = new Set<string>();
  private drafts = new Map<string, string>(); // "new" or a comment id -> unsent text

  constructor(leaf: WorkspaceLeaf, private dodo: Dodo) { super(leaf); }
  getViewType() { return VIEW; }
  getDisplayText() { return 'Kommentarer'; }
  getIcon() { return 'message-square'; }
  async onOpen() { this.contentEl.addClass('dodo-panel'); this.render(true); }

  show(list: string | null, todo: string | null) {
    if (list === this.list && todo === this.todo) return this.render(false);
    this.list = list; this.todo = todo; this.reply = null;
    this.render(true);
  }
  refresh() { this.render(false); }

  private render(force: boolean) {
    const el = this.contentEl, data = this.list && this.todo ? this.dodo.threads(this.list, this.todo) : null;
    const sig = JSON.stringify([this.list, this.todo, data?.todo.text, data?.threads, this.reply, [...this.unfolded]]);
    if (!force && sig === this.sig) return;
    this.sig = sig;
    // what is being typed survives a redraw
    const typing = el.querySelector('textarea');
    if (typing instanceof HTMLTextAreaElement) this.drafts.set(typing.dataset.key!, typing.value);
    const focused = typing && document.activeElement === typing ? typing.dataset.key : null;
    el.empty();
    if (!data) { el.createEl('p', { cls: 'dodo-hint', text: 'Flytta markören till en uppgift i en dodo-anteckning, så syns dess kommentarer här.' }); return; }
    const { todo, S, threads } = data, list = this.list!;
    el.createEl('h4', { cls: 'dodo-title', text: todo.md ? 'Textstycke' : todo.text });
    const box = el.createDiv({ cls: 'dodo-threads' });
    if (!threads.length) box.createEl('p', { cls: 'dodo-hint', text: 'Inga kommentarer än.' });
    for (const { root, replies } of threads) {
      if (root.resolved && !this.unfolded.has(root.id)) {
        const row = box.createDiv({ cls: 'dodo-thread dodo-resolved', text: `✓ Löst · ${this.dodo.name(S, root.user)}: ${root.text.split('\n')[0]}` });
        row.onclick = () => { this.unfolded.add(root.id); this.render(true); };
        continue;
      }
      const t = box.createDiv({ cls: 'dodo-thread' });
      // a reply sits under the comment it answers; one whose comment was deleted moves up under the first
      const ids = new Set([root.id, ...replies.map((r: any) => r.id)]);
      const kids = (id: string) => replies.filter((r: any) => (ids.has(r.replyTo) ? r.replyTo : root.id) === id);
      const one = (c: any, d: number) => {
        const row = t.createDiv({ cls: 'dodo-c' + (d ? ' dodo-reply' : '') });
        row.style.marginLeft = Math.min(d, 3) * 14 + 'px';
        const head = row.createDiv({ cls: 'dodo-chead' });
        head.createEl('b', { text: this.dodo.name(S, c.user) });
        head.createSpan({ cls: 'dodo-when', text: when(c.at) + (c.edited ? ' · redigerad' : '') });
        void MarkdownRenderer.render(this.app, c.text, row.createDiv({ cls: 'dodo-body' }), '', this);
        const acts = row.createDiv({ cls: 'dodo-acts' });
        acts.createEl('button', { text: 'Svara' }).onclick = () => { this.reply = c.id; this.render(true); };
        if (c === root) acts.createEl('button', { text: root.resolved ? 'Öppna igen' : 'Lös' }).onclick = () => this.run(this.dodo.resolve(list, root.id, !root.resolved));
        if (this.reply === c.id) this.form(t, c.id, 'Svara…', text => this.dodo.comment(list, todo.id, text, c.id), d + 1);
        kids(c.id).forEach((k: any) => one(k, d + 1));
      };
      one(root, 0);
    }
    this.form(el.createDiv({ cls: 'dodo-new' }), 'new', 'Skriv en kommentar…', text => this.dodo.comment(list, todo.id, text));
    if (focused) el.querySelector<HTMLTextAreaElement>(`textarea[data-key="${focused}"]`)?.focus();
    this.dodo.markSeen(list, todo.id);
  }

  private form(parent: HTMLElement, key: string, placeholder: string, send: (text: string) => Promise<void>, indent = 0) {
    const f = parent.createDiv({ cls: 'dodo-form' });
    f.style.marginLeft = Math.min(indent, 3) * 14 + 'px';
    const ta = f.createEl('textarea', { attr: { rows: '2', placeholder, 'data-key': key } });
    ta.value = this.drafts.get(key) ?? '';
    const go = async () => {
      const text = ta.value.trim();
      if (!text) return;
      this.drafts.delete(key); ta.value = '';
      try { await send(text); this.reply = null; this.render(true); } catch (e) { this.drafts.set(key, text); new Notice('dodo: kunde inte skicka kommentaren: ' + (e as Error).message); this.render(true); }
    };
    ta.onkeydown = e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void go(); } };
    const row = f.createDiv({ cls: 'dodo-row' });
    if (key !== 'new') row.createEl('button', { text: 'Avbryt' }).onclick = () => { this.reply = null; this.drafts.delete(key); this.render(true); };
    row.createEl('button', { text: 'Skicka', cls: 'mod-cta' }).onclick = () => void go();
  }
  private async run(p: Promise<void>) { try { await p; } catch (e) { new Notice('dodo: ' + (e as Error).message); } }
}
