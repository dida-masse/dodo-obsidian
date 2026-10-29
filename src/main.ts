// The Obsidian side: vault, editor, settings and timers around the sync core (sync.ts).
import { FuzzySuggestModal, MarkdownView, Modal, Notice, Platform, Plugin, PluginSettingTab, Setting, TFile, normalizePath, requestUrl, type Editor, type MarkdownFileInfo } from 'obsidian';
import { CommentsView, VIEW } from './panel.js';
import { marksExtension, refreshMarks } from './marks.js';
import { nodeStream, type Stream } from './events.js';
import { Dodo, emptyData, freeName, listIdOf, minimalChange, SEND_MS, type Data, type Host, type Http, type Note } from './sync.js';

const POLL_MS = 2000, SAFETY_MS = 30000, QUIET_MS = 2000; // polling every 2 s, or every 30 s while the event stream is up
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// requestUrl works on mobile and is not stopped by CORS; throw: false gives the status instead of an exception
const http: Http = async r => {
  const res = await requestUrl({ url: r.url, method: r.method, headers: r.headers, body: r.body, throw: false });
  let json: unknown = null;
  try { json = res.json; } catch { /* no body or not json */ }
  return { status: res.status, json };
};

export function patch(editor: Editor, from: string, to: string) {
  const c = minimalChange(from, to);
  editor.replaceRange(c.text, editor.offsetToPos(c.from), editor.offsetToPos(c.to));
}

class Confirm extends Modal {
  private done = false;
  constructor(app: Plugin['app'], private text: string, private resolve: (ok: boolean) => void) { super(app); }
  onOpen() {
    this.titleEl.setText('dodo');
    this.contentEl.createEl('p', { text: this.text });
    new Setting(this.contentEl)
      .addButton(b => b.setButtonText('Ta bort').setWarning().onClick(() => this.finish(true)))
      .addButton(b => b.setButtonText('Behåll').setCta().onClick(() => this.finish(false)));
  }
  onClose() { this.finish(false); }
  private finish(ok: boolean) { if (this.done) return; this.done = true; this.resolve(ok); this.close(); }
}

class Pick extends FuzzySuggestModal<{ id: string; name: string }> {
  constructor(app: Plugin['app'], private all: { id: string; name: string }[], private pick: (l: { id: string; name: string }) => void) { super(app); this.setPlaceholder('Välj en dodo-lista'); }
  getItems() { return this.all; }
  getItemText(l: { id: string; name: string }) { return l.name; }
  onChooseItem(l: { id: string; name: string }) { this.pick(l); }
}

export default class DodoPlugin extends Plugin implements Host {
  data: Data = emptyData();
  dodo!: Dodo;
  private pinned = new Map<string, TFile>(); // list id -> its note, found by the `dodo:` frontmatter and kept while the file lives
  private typed = new Map<string, number>(); // path -> last keystroke
  private timers = new Map<string, number>();
  private bar?: HTMLElement;
  private ticking = false;
  private last: TFile | null = null;
  private stream?: { close(): void };
  private indexed = false;
  private up = false;
  private poll?: number;
  private dots?: HTMLStyleElement;

  async onload() {
    this.data = Object.assign(emptyData(), await this.loadData());
    this.dodo = new Dodo(this.data, { http, host: this, save: () => this.saveData(this.data), openSettings: () => this.openSettings() });
    this.dodo.onStatus = () => this.paint();
    this.dodo.onFresh = () => { this.paint(); this.paintDots(); };
    this.dodo.onSnap = () => { this.panels().forEach(p => p.refresh()); refreshMarks(); };
    this.registerView(VIEW, leaf => new CommentsView(leaf, this.dodo));
    this.addCommand({ id: 'show-comments', name: 'Visa kommentarer', callback: () => void this.showPanel() });
    this.addRibbonIcon('message-square', 'dodo: Visa kommentarer', () => void this.showPanel());
    this.registerEditorExtension(marksExtension({
      marks: (file, text) => { const id = this.idOf(file); return id && this.data.lists[id] ? this.dodo.commentLines(id, text) : []; },
      open: (file, todo) => { const id = this.idOf(file); if (id) void this.showPanel().then(() => this.panels().forEach(p => p.show(id, todo))); },
      moved: (file, text, line) => this.cursorAt(file, text, line),
    }));
    const tab = new Settings(this);
    this.dodo.onLists = () => { if (tab.containerEl.isConnected) tab.display(); }; // an open settings tab is not left showing old toggles
    this.addSettingTab(tab);
    this.addCommand({ id: 'add-list', name: 'Lägg till lista', callback: () => this.addList() });
    if (Platform.isDesktop) { this.bar = this.addStatusBarItem(); this.bar.addClass('mod-clickable'); this.bar.onClickEvent(() => { const f = this.dodo.updated().map(id => this.fileFor(id)).find(Boolean); if (f && !this.dodo.lastError) void this.app.workspace.getLeaf().openFile(f); else new Notice(this.dodo.lastError || 'dodo: allt är skickat.'); }); this.paint(); }

    this.registerEvent(this.app.workspace.on('editor-change', (_e: Editor, info: MarkdownFileInfo) => { if (info.file) { this.typed.set(info.file.path, Date.now()); this.changed(info.file); } }));
    this.registerEvent(this.app.vault.on('modify', f => { if (f instanceof TFile) this.changed(f); }));
    this.registerEvent(this.app.vault.on('rename', () => this.paintDots()));
    this.registerEvent(this.app.vault.on('delete', f => { for (const [id, t] of this.pinned) if (t === f) this.pinned.delete(id); }));
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => { // leaving a note sends it at once
      const prev = this.last, now = this.app.workspace.getActiveFile();
      if (prev && prev !== now) { const id = this.idOf(prev); if (id) void this.dodo.flush(id); }
      this.last = now;
      this.openedActive();
      this.syncPanel();
    }));
    // notes are found by their frontmatter: before the cache has read every file an existing note looks missing, and a second one would be made
    const mc = this.app.metadataCache as typeof this.app.metadataCache & { resolved?: boolean }; // not in the typings: unknown means go on as before
    if (mc.resolved !== false) this.indexed = true; else this.registerEvent(mc.on('resolved', () => { if (!this.indexed) { this.indexed = true; this.paintDots(); } }));
    const loop = () => { this.poll = window.setTimeout(() => { void this.tick().finally(loop); }, this.up ? SAFETY_MS : POLL_MS); };
    loop();
    this.registerDomEvent(window, 'focus', () => void this.tick());
    this.registerDomEvent(document, 'visibilitychange', () => { if (!document.hidden) { this.openedActive(); void this.tick(); } });
    this.app.workspace.onLayoutReady(() => { this.last = this.app.workspace.getActiveFile(); this.openStream(); this.paintDots(); void this.tick(); });
  }
  onunload() { this.dots?.remove(); window.clearTimeout(this.poll); this.stream?.close(); for (const t of this.timers.values()) window.clearTimeout(t); }

  // desktop only: the server says at once when something changes (requestUrl cannot stream, so Node's http is used)
  openStream() {
    this.stream?.close(); this.stream = undefined; this.up = false;
    const load = (window as unknown as { require?: (m: string) => unknown }).require;
    if (!Platform.isDesktopApp || !load || !this.data.session) return;
    const open: Stream = nodeStream(load);
    this.stream = open({ url: this.data.url, session: this.data.session,
      onState: up => { this.up = up; if (up) void this.tick(); }, // after a drop or a wake-up: catch up at once
      onEvent: (name, d) => this.dodo.event(name, d) });
  }

  private async tick() {
    if (this.ticking || !this.data.session || !this.indexed) return;
    this.ticking = true;
    try { await this.dodo.tick(); } finally { this.ticking = false; }
  }
  private paint() {
    if (!this.bar) return;
    const n = this.dodo.updated().length;
    this.bar.setText(!this.data.session || !Object.keys(this.data.lists).length ? '' : (this.dodo.status === 'busy' ? 'dodo …' : this.dodo.status === 'err' ? 'dodo !' : 'dodo ✓') + (n ? ` · ${n} uppdaterad${n > 1 ? 'e' : ''}` : ''));
  }
  private panels() { return this.app.workspace.getLeavesOfType(VIEW).map(l => l.view).filter((v): v is CommentsView => v instanceof CommentsView); }
  async showPanel() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW)[0];
    if (!leaf) { leaf = this.app.workspace.getRightLeaf(false)!; await leaf.setViewState({ type: VIEW, active: true }); }
    await this.app.workspace.revealLeaf(leaf);
    this.syncPanel();
  }
  // the todo under the cursor of the note being edited
  private cursorAt(file: TFile, text: string, line: number) {
    if (file !== this.app.workspace.getActiveFile()) return;
    const id = this.idOf(file), at = id && this.data.lists[id] ? this.dodo.todoAt(id, text, line) : null;
    this.panels().forEach(p => p.show(at && at.kind === 'todo' && at.id ? id : null, at && at.kind === 'todo' ? at.id : null));
  }
  private syncPanel() {
    const v = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (v?.file && this.panels().length) this.cursorAt(v.file, v.editor.getValue(), v.editor.getCursor().line);
  }
  openSettings() {
    const s = (this.app as unknown as { setting: { open(): void; openTabById(id: string): void } }).setting;
    s.open(); s.openTabById(this.manifest.id);
  }
  async addList() {
    if (!this.data.session) { new Notice('Logga in på dodo i inställningarna först.'); return this.openSettings(); }
    try {
      const open = (await this.dodo.lists()).filter(l => !this.data.lists[l.id] || this.data.lists[l.id].off);
      if (!open.length) return void new Notice('Alla dina listor finns redan som anteckningar.');
      new Pick(this.app, open, l => this.enable(l.id)).open();
    } catch (e) { new Notice('dodo: ' + (e as Error).message); }
  }
  async enable(id: string) {
    try { await this.dodo.enable(id); } catch (e) { new Notice('dodo: ' + (e as Error).message); }
  }

  // a change in a dodo note: sent when the typing has stopped
  private changed(file: TFile) {
    const id = this.idOf(file);
    if (!id || !this.data.lists[id]) return;
    this.dodo.touched(id);
    window.clearTimeout(this.timers.get(id));
    this.timers.set(id, window.setTimeout(() => { this.timers.delete(id); void this.dodo.flush(id); }, SEND_MS));
  }
  private idOf(file: TFile): string | null {
    for (const [id, f] of this.pinned) if (f === file) return id;
    return listIdOf(this.app.metadataCache.getFileCache(file)?.frontmatter?.dodo);
  }
  private fileFor(id: string): TFile | null {
    const p = this.pinned.get(id);
    if (p) return p;
    const f = this.app.vault.getMarkdownFiles().find(f => listIdOf(this.app.metadataCache.getFileCache(f)?.frontmatter?.dodo) === id);
    if (f) this.pinned.set(id, f);
    return f ?? null;
  }
  private editorOf(file: TFile): Editor | null {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const v = leaf.view;
      if (v instanceof MarkdownView && v.file === file && v.getMode() === 'source') return v.editor;
    }
    return null;
  }

  // the note in front of the user has been seen
  private openedActive() { const f = this.app.workspace.getActiveFile(), id = f && this.idOf(f); if (id) this.dodo.opened(id); }
  // a dot after the names of notes others have changed, in the file list. One style sheet by path: it survives the list being redrawn,
  // and if Obsidian renames its classes the dots just stop showing
  private paintDots() {
    this.dots ??= document.head.createEl('style');
    this.dots.textContent = this.dodo.updated().map(id => this.fileFor(id)?.path).filter(Boolean)
      .map(p => `.nav-file-title[data-path="${CSS.escape(p!)}"] .nav-file-title-content::after { content: " ●"; color: var(--interactive-accent); }`).join('\n');
  }

  // ---- Host ----
  note(id: string): Note | null {
    const file = this.fileFor(id), vault = this.app.vault;
    if (!file) return null;
    return {
      // the editor has the newest text: the disk lags a couple of seconds behind the typing
      read: async () => this.editorOf(file)?.getValue() ?? await vault.read(file),
      replace: async (from, to) => {
        const ed = this.editorOf(file);
        if (ed) { if (ed.getValue() !== from) return false; patch(ed, from, to); return true; }
        let ok = false;
        await vault.process(file, data => (ok = data === from) ? to : data);
        return ok;
      },
      quiet: async () => {
        const end = Date.now() + 30000;
        while (this.editorOf(file) && Date.now() - (this.typed.get(file.path) || 0) < QUIET_MS && Date.now() < end) await sleep(250);
      },
    };
  }
  async move(id: string, dir: string) {
    const file = this.fileFor(id);
    if (!file) return;
    if (!this.app.vault.getAbstractFileByPath(dir)) await this.app.vault.createFolder(dir).catch(() => {});
    await this.app.fileManager.renameFile(file, normalizePath(freeName(dir, file.basename, p => this.exists(p)).path)); // links follow
  }
  async rename(id: string, stem: string) {
    const file = this.fileFor(id);
    if (!file) return;
    const dir = file.parent && !file.parent.isRoot() ? file.parent.path : '', self = file.path.toLowerCase();
    await this.app.fileManager.renameFile(file, normalizePath(freeName(dir, stem, p => p.toLowerCase() !== self && this.exists(p)).path)); // links follow
  }
  base(id: string) { return this.fileFor(id)?.basename ?? null; }
  viewing(id: string) { const f = this.fileFor(id); return !!f && !document.hidden && this.app.workspace.getActiveFile() === f; }
  exists(path: string) { const l = path.toLowerCase(); return this.app.vault.getAllLoadedFiles().some(f => f.path.toLowerCase() === l); }
  async create(path: string, text: string) {
    path = normalizePath(path);
    const dir = path.slice(0, path.lastIndexOf('/'));
    if (dir && !this.app.vault.getAbstractFileByPath(dir)) await this.app.vault.createFolder(dir).catch(() => {});
    const file = await this.app.vault.create(path, text);
    this.pinned.set(listIdOf(text.match(/^dodo:\s*(\S+)/m)?.[1])!, file);
    return this.note(listIdOf(text.match(/^dodo:\s*(\S+)/m)?.[1])!)!;
  }
  notice(text: string, action?: { label: string; run: () => void }) {
    if (!action) return void new Notice(text, 8000);
    const n = new Notice(text, 15000);
    n.noticeEl.createEl('button', { text: action.label }).onclick = () => { action.run(); n.hide(); };
  }
  confirm(text: string) { return new Promise<boolean>(res => new Confirm(this.app, text, res).open()); }
}

class Settings extends PluginSettingTab {
  constructor(private p: DodoPlugin) { super(p.app, p); }
  display() {
    const el = this.containerEl, { data, dodo } = this.p;
    el.empty();
    if (!data.session) {
      let link = '';
      new Setting(el).setName('Logga in på dodo')
        .setDesc('Öppna dodo i webbläsaren, välj ⋯ → Logga in på annan enhet och klistra in länken här. Den gäller en gång i 10 minuter.')
        .addText(t => t.setPlaceholder('https://…/in/…').onChange(v => link = v))
        .addButton(b => b.setButtonText('Logga in').setCta().onClick(async () => {
          try { await dodo.login(link); await this.p.saveData(data); this.p.openStream(); void this.p.dodo.tick(); this.display(); } catch (e) { new Notice((e as Error).message, 10000); }
        }));
      return;
    }
    new Setting(el).setName(`Inloggad som ${data.name} på ${new URL(data.url).host}`)
      .addButton(b => b.setButtonText('Logga ut').onClick(async () => { await dodo.logout(); this.p.openStream(); this.display(); }));
    new Setting(el).setName('Mapp').setDesc('Här ligger anteckningarna, en för varje lista.')
      .addText(t => t.setValue(data.folder).onChange(async v => { data.folder = v.trim(); await this.p.saveData(data); }));
    new Setting(el).setName('Lägg till nya listor automatiskt').setDesc('Nya listor i dodo blir anteckningar av sig själva. En lista du har stängt av läggs inte till igen.')
      .addToggle(t => t.setValue(data.autoAdd).onChange(async v => { data.autoAdd = v; await this.p.saveData(data); }));
    new Setting(el).setName('Dölj klara uppgifter').setDesc('De finns kvar i dodo, bara inte i anteckningen.')
      .addToggle(t => t.setValue(data.hideDone).onChange(async v => { data.hideDone = v; await this.p.saveData(data); void this.p.dodo.tick(); }));
    new Setting(el).setName('Listor').setHeading();
    const box = el.createDiv();
    box.setText('Hämtar listor …');
    dodo.lists().then(lists => {
      box.empty();
      for (const l of lists) new Setting(box).setName(l.name).addToggle(t => t.setValue(!!data.lists[l.id] && !data.lists[l.id].off).onChange(async v => {
        if (v) await this.p.enable(l.id); else await dodo.disable(l.id);
        this.display();
      }));
      if (!lists.length) box.setText('Du är inte med i någon lista.');
    }, e => box.setText('Kunde inte hämta listorna: ' + (e as Error).message + (this.p.dodo.authLost ? ' Logga ut och in igen.' : '')));
  }
}
