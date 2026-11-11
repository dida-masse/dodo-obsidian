// The Obsidian side: vault, editor, settings and timers around the sync core (sync.ts).
import { FuzzySuggestModal, MarkdownView, Notice, Platform, Plugin, PluginSettingTab, Setting, TFile, TFolder, editorLivePreviewField, normalizePath, requestUrl, type Editor, type MarkdownFileInfo } from 'obsidian';
import { CommentsView, newsLine, VIEW } from './panel.js';
import { marksExtension, refreshMarks } from './marks.js';
import { refreshTables, sourceExtension } from './source.js';
import { SharedModal } from './shares.js';
import { nodeStream, type Stream } from './events.js';
import { Dodo, emptyData, freeName, listIdOf, minimalChange, SEND_MS, tieOf, type Data, type Host, type Http, type Note } from './sync.js';

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
  private folderTimer?: number;
  private dots?: HTMLStyleElement;

  async onload() {
    this.data = Object.assign(emptyData(), await this.loadData());
    this.dodo = new Dodo(this.data, { http, host: this, save: () => this.saveData(this.data), openSettings: () => this.openSettings() });
    this.dodo.onStatus = () => this.paint();
    this.dodo.onFresh = () => { this.paint(); this.paintDots(); };
    this.dodo.onSnap = () => { this.panels().forEach(p => p.refresh()); refreshMarks(); };
    this.registerView(VIEW, leaf => new CommentsView(leaf, this.dodo, { active: () => { const f = this.app.workspace.getActiveFile(), id = f && this.idOf(f); return id && this.data.lists[id] ? id : null; }, reveal: (l, t) => this.reveal(l, t) }));
    this.dodo.onNews = id => {
      refreshMarks(); this.panels().forEach(p => p.refresh());
      const news = this.dodo.whatsNew(id);
      if (!news.length || this.panels().length) return; // an open panel shows it
      const f = document.createDocumentFragment(), more = news.length > 3 ? ` · +${news.length - 3}` : '';
      f.createSpan({ text: 'Nytt sedan sist: ' + news.slice(-3).reverse().map(x => newsLine(this.dodo, id, x)).join(' · ') + more + ' ' });
      f.createEl('button', { text: 'Visa' }).onclick = () => void this.showPanel();
      new Notice(f, 10000);
    };
    this.addCommand({ id: 'show-comments', name: 'Visa kommentarer', callback: () => void this.showPanel() });
    this.addRibbonIcon('message-square', 'dodo: Visa kommentarer', () => void this.showPanel());
    this.registerEditorExtension(marksExtension({
      news: (file, text) => { const id = this.idOf(file); return id && this.data.lists[id] ? this.dodo.newsLines(id, text) : []; },
      shares: (file, text) => { const id = this.idOf(file); return id && this.data.lists[id] ? this.dodo.shareLines(id, text) : []; },
      share: () => this.openShared(),
      marks: (file, text) => { const id = this.idOf(file); return id && this.data.lists[id] ? this.dodo.commentLines(id, text) : []; },
      open: (file, todo) => { const id = this.idOf(file); if (id) void this.showPanel().then(() => this.panels().forEach(p => p.show(id, todo))); },
      moved: (file, text, line) => this.cursorAt(file, text, line),
    }));
    let told = false; // once a session is enough: the label in the note says it too
    this.registerEditorExtension(sourceExtension(() => { if (!told) { told = true; new Notice('dodo: tabellen kommer från Kursredan och kan inte ändras här. Din egen text skriver du under den.'); } }, s => s.field(editorLivePreviewField, false) ?? false, () => !!this.data.tablesOpen));
    for (const [id, name, open] of [['open-tables', 'Fäll ut alla kurstabeller', true], ['close-tables', 'Fäll ihop alla kurstabeller', false]] as const)
      this.addCommand({ id, name, callback: () => { this.data.tablesOpen = open; void this.saveData(this.data); refreshTables(); } });
    const tab = new Settings(this);
    this.dodo.onLists = () => { if (tab.containerEl.isConnected) tab.display(); }; // an open settings tab is not left showing old toggles
    this.addSettingTab(tab);
    this.addCommand({ id: 'copy-todo', name: 'Kopiera uppgiften till en annan lista…', editorCheckCallback: (check, editor, ctx) => {
      const id = ctx.file && this.idOf(ctx.file);
      if (!id || !this.data.lists[id] || !this.data.session) return false;
      if (!check) void this.copyTodo(id, editor.getCursor().line);
      return true;
    } });
    this.addCommand({ id: 'shared', name: 'Delningar…', callback: () => this.openShared() });
    this.addCommand({ id: 'add-list', name: 'Lägg till lista', callback: () => this.addList() });
    // a held mass deletion in the active note (sync.ts, massDelete): the commands only show while there is one
    const held = (send: boolean) => (check: boolean) => {
      const f = this.app.workspace.getActiveFile(), id = f && this.idOf(f);
      if (!id || !this.dodo.held.has(id)) return false;
      if (!check) void this.dodo.release(id, send);
      return true;
    };
    this.addCommand({ id: 'send-deletion', name: 'Spara borttagningen ändå', checkCallback: held(true) });
    this.addCommand({ id: 'drop-deletion', name: 'Hämta listan från dodo igen', checkCallback: held(false) });
    if (Platform.isDesktop) { this.bar = this.addStatusBarItem(); this.bar.addClass('mod-clickable'); this.bar.onClickEvent(() => { const f = this.dodo.updated().map(id => this.fileFor(id)).find(Boolean); if (f && !this.dodo.lastError) void this.app.workspace.getLeaf().openFile(f); else new Notice(this.dodo.lastError || 'dodo: allt är skickat.'); }); this.paint(); }

    this.registerEvent(this.app.workspace.on('editor-change', (_e: Editor, info: MarkdownFileInfo) => { if (info.file) { this.typed.set(info.file.path, Date.now()); this.changed(info.file); } }));
    this.registerEvent(this.app.vault.on('modify', f => { if (f instanceof TFile) this.changed(f); }));
    this.registerEvent(this.app.vault.on('rename', f => { this.paintDots(); const id = f instanceof TFile ? this.idOf(f) : null; if (id) void this.dodo.noteRenamed(id); if (id || f instanceof TFolder) this.foldersSoon(); }));
    this.registerEvent(this.app.vault.on('create', f => { if (f instanceof TFolder) this.foldersSoon(); else void this.seen(f); }));
    this.registerEvent(this.app.metadataCache.on('changed', f => void this.seen(f))); // a file the sync delivered, once its frontmatter is read
    this.registerEvent(this.app.vault.on('delete', f => { for (const [id, t] of this.pinned) if (t === f) this.pinned.delete(id); if (f instanceof TFolder) this.foldersSoon(); }));
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => { // leaving a note sends it at once
      const prev = this.last, now = this.app.workspace.getActiveFile();
      if (prev && prev !== now) { const id = this.idOf(prev); if (id) { void this.dodo.flush(id); void this.dodo.left(id); } }
      this.last = now;
      this.openedActive();
      this.syncPanel();
    }));
    // notes are found by their frontmatter: before the cache has read every file an existing note looks missing, and a second one would be made
    const mc = this.app.metadataCache as typeof this.app.metadataCache & { resolved?: boolean }; // not in the typings: unknown means go on as before
    if (mc.resolved !== false) this.indexed = true; else this.registerEvent(mc.on('resolved', () => { if (!this.indexed) { this.indexed = true; this.paintDots(); void this.dodo.dedupeAll(); } }));
    const loop = () => { this.poll = window.setTimeout(() => { void this.tick().finally(loop); }, this.up ? SAFETY_MS : POLL_MS); };
    loop();
    this.registerDomEvent(window, 'focus', () => void this.tick());
    this.registerDomEvent(document, 'visibilitychange', () => { if (!document.hidden) { this.openedActive(); void this.tick(); } });
    this.app.workspace.onLayoutReady(() => { this.last = this.app.workspace.getActiveFile(); this.openStream(); this.paintDots(); if (this.indexed) void this.dodo.dedupeAll(); void this.tick(); });
  }
  onunload() { this.dots?.remove(); window.clearTimeout(this.poll); window.clearTimeout(this.folderTimer); this.stream?.close(); for (const t of this.timers.values()) window.clearTimeout(t); }

  // desktop only: the server says at once when something changes (requestUrl cannot stream, so Node's http is used)
  openStream() {
    this.stream?.close(); this.stream = undefined; this.up = false;
    const load = (window as unknown as { require?: (m: string) => unknown }).require;
    if (!Platform.isDesktopApp || !load || !this.data.session) return;
    const open: Stream = nodeStream(load);
    this.stream = open({ url: this.data.url, session: this.data.session, version: this.manifest.version,
      onState: up => { this.up = up; if (up) void this.tick(); }, // after a drop or a wake-up: catch up at once
      onEvent: (name, d) => this.dodo.event(name, d) });
  }

  // a note or folder was moved, made or removed in the vault: dodo hears of it when the moving has stopped (the plugin's own moves come back here and change nothing)
  private foldersSoon() {
    window.clearTimeout(this.folderTimer);
    this.folderTimer = window.setTimeout(() => { if (this.indexed) void this.dodo.folders(); }, 1500);
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
  private openShared() {
    if (!this.data.session) { new Notice('Logga in på dodo i inställningarna först.'); return this.openSettings(); }
    new SharedModal(this.app, this.dodo).open();
  }
  async copyTodo(id: string, line: number) {
    try {
      const to = await this.dodo.copyTargets(id);
      if (!to.length) return void new Notice('Du är inte med i någon annan lista att kopiera till.');
      new Pick(this.app, to, l => void this.dodo.copyTodo(id, line, l.id).catch(e => new Notice('dodo: ' + (e as Error).message))).open();
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
  // a note that is new or changed and ties to a list whose note is another file: two notes for one list
  private async seen(f: unknown) {
    if (!this.indexed || !(f instanceof TFile) || f.extension !== 'md') return;
    const c = this.app.metadataCache.getFileCache(f), id = c ? listIdOf(c.frontmatter?.dodo) : tieOf(await this.app.vault.cachedRead(f).catch(() => ''));
    if (id && this.data.lists[id] && this.pinned.get(id) !== f) void this.dodo.dedupe(id);
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
  private openedActive() { const f = this.app.workspace.getActiveFile(), id = f && this.idOf(f); if (id) void this.dodo.opened(id); }
  // a todo from the news: the caret goes to its line in the note
  private reveal(list: string, todo: string) {
    const v = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!v?.file || this.idOf(v.file) !== list) return;
    const line = this.dodo.lineOf(list, v.editor.getValue(), todo);
    if (line < 0) return;
    v.editor.setCursor({ line, ch: 0 }); v.editor.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } }, true); v.editor.focus();
  }
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
    await this.mkdir(dir);
    await this.app.fileManager.renameFile(file, normalizePath(freeName(dir, file.basename, p => this.exists(p)).path)); // links follow
  }
  async rename(id: string, stem: string) {
    const file = this.fileFor(id);
    if (!file) return;
    const dir = file.parent && !file.parent.isRoot() ? file.parent.path : '', self = file.path.toLowerCase();
    await this.app.fileManager.renameFile(file, normalizePath(freeName(dir, stem, p => p.toLowerCase() !== self && this.exists(p)).path)); // links follow
  }
  dir(id: string) { const p = this.fileFor(id)?.parent; return p ? (p.isRoot() ? '' : p.path) : null; }
  dirs(root: string) {
    const under = root ? root + '/' : '';
    return this.app.vault.getAllLoadedFiles().filter((f): f is TFolder => f instanceof TFolder && !f.isRoot() && f.path.startsWith(under) && !f.path.split('/').some(s => s.startsWith('.'))).map(f => f.path);
  }
  async mkdir(path: string) { // one level at a time: the parents are made too
    let at = '';
    for (const s of path.split('/').filter(Boolean)) { at = at ? at + '/' + s : s; if (!this.app.vault.getAbstractFileByPath(at)) await this.app.vault.createFolder(at).catch(() => {}); }
  }
  async prune(path: string) { const f = this.app.vault.getAbstractFileByPath(path); if (f instanceof TFolder && !f.children.length) await this.app.fileManager.trashFile(f).catch(() => {}); }
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
  async copies(id: string) {
    const out: { path: string; read(): Promise<string> }[] = [], vault = this.app.vault;
    for (const f of vault.getMarkdownFiles()) {
      const c = this.app.metadataCache.getFileCache(f);
      if (c ? listIdOf(c.frontmatter?.dodo) !== id : tieOf(await vault.cachedRead(f).catch(() => '')) !== id) continue;
      out.push({ path: f.path, read: async () => this.editorOf(f)?.getValue() ?? await vault.read(f) }); // the editor has the newest text
    }
    return out;
  }
  isTyped(path: string) { return this.typed.has(path); }
  where(id: string) { return this.fileFor(id)?.path ?? null; }
  adopt(id: string, path: string) { const f = this.app.vault.getAbstractFileByPath(path); if (f instanceof TFile) this.pinned.set(id, f); }
  async trash(path: string) { const f = this.app.vault.getAbstractFileByPath(path); if (f instanceof TFile) await this.app.fileManager.trashFile(f); }
  async aside(path: string, from: string, to: string, dir: string) {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile)) return false;
    let ok = false;
    await this.app.vault.process(f, data => (ok = data === from) ? to : data);
    if (!ok) return false;
    for (const [id, p] of this.pinned) if (p === f) this.pinned.delete(id);
    await this.mkdir(dir);
    await this.app.fileManager.renameFile(f, normalizePath(freeName(dir, f.basename, p => this.exists(p)).path));
    return true;
  }
  notice(text: string, ...actions: { label: string; run: () => void }[]) {
    if (!actions.length) return void new Notice(text, 8000);
    const n = new Notice(text, 15000);
    for (const a of actions) n.noticeEl.createEl('button', { text: a.label }).onclick = () => { a.run(); n.hide(); };
  }
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
    new Setting(el).setName('Kurstabeller: utfällda som standard').setDesc('Av: tabellerna i kurslistor är ihopfällda tills du klickar på dem.')
      .addToggle(t => t.setValue(!!data.tablesOpen).onChange(async v => { data.tablesOpen = v; await this.p.saveData(data); refreshTables(); }));
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
