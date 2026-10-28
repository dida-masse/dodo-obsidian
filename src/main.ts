// The Obsidian side: vault, editor, settings and timers around the sync core (sync.ts).
import { FuzzySuggestModal, MarkdownView, Modal, Notice, Platform, Plugin, PluginSettingTab, Setting, TFile, normalizePath, requestUrl, type Editor, type MarkdownFileInfo } from 'obsidian';
import { Dodo, emptyData, listIdOf, minimalChange, type Data, type Host, type Http, type Note } from './sync.js';

const POLL_MS = 4000, SEND_MS = 1500, QUIET_MS = 2000;
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

  async onload() {
    this.data = Object.assign(emptyData(), await this.loadData());
    this.dodo = new Dodo(this.data, { http, host: this, save: () => this.saveData(this.data), openSettings: () => this.openSettings() });
    this.dodo.onStatus = () => this.paint();
    this.addSettingTab(new Settings(this));
    this.addCommand({ id: 'add-list', name: 'Lägg till lista', callback: () => this.addList() });
    if (Platform.isDesktop) { this.bar = this.addStatusBarItem(); this.bar.addClass('mod-clickable'); this.bar.onClickEvent(() => new Notice(this.dodo.lastError || 'dodo: allt är skickat.')); this.paint(); }

    this.registerEvent(this.app.workspace.on('editor-change', (_e: Editor, info: MarkdownFileInfo) => { if (info.file) { this.typed.set(info.file.path, Date.now()); this.changed(info.file); } }));
    this.registerEvent(this.app.vault.on('modify', f => { if (f instanceof TFile) this.changed(f); }));
    this.registerEvent(this.app.vault.on('delete', f => { for (const [id, t] of this.pinned) if (t === f) this.pinned.delete(id); }));
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => { // leaving a note sends it at once
      const prev = this.last, now = this.app.workspace.getActiveFile();
      if (prev && prev !== now) { const id = this.idOf(prev); if (id) void this.dodo.flush(id); }
      this.last = now;
    }));
    this.registerInterval(window.setInterval(() => void this.tick(), POLL_MS));
    this.registerDomEvent(window, 'focus', () => void this.tick());
    this.registerDomEvent(document, 'visibilitychange', () => { if (!document.hidden) void this.tick(); });
    this.app.workspace.onLayoutReady(() => { this.last = this.app.workspace.getActiveFile(); void this.tick(); });
  }
  onunload() { for (const t of this.timers.values()) window.clearTimeout(t); }

  private async tick() {
    if (this.ticking || !this.data.session) return;
    this.ticking = true;
    try { await this.dodo.tick(); } finally { this.ticking = false; }
  }
  private paint() {
    if (!this.bar) return;
    this.bar.setText(!this.data.session || !Object.keys(this.data.lists).length ? '' : this.dodo.status === 'busy' ? 'dodo …' : this.dodo.status === 'err' ? 'dodo !' : 'dodo ✓');
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
          try { await dodo.login(link); await this.p.saveData(data); void this.p.dodo.tick(); this.display(); } catch (e) { new Notice((e as Error).message, 10000); }
        }));
      return;
    }
    new Setting(el).setName(`Inloggad som ${data.name} på ${new URL(data.url).host}`)
      .addButton(b => b.setButtonText('Logga ut').onClick(async () => { await dodo.logout(); this.display(); }));
    new Setting(el).setName('Mapp').setDesc('Här ligger anteckningarna, en för varje lista.')
      .addText(t => t.setValue(data.folder).onChange(async v => { data.folder = v.trim(); await this.p.saveData(data); }));
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
