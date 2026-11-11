// "dodo: Delningar…": the people and public links of the lists I run, and the lists I am in (the web's Delningar, GET /api/shared).
// Stopping a link, taking someone out and leaving a list each ask first, on a page of their own with Avbryt as the one focused. No address of a link is ever shown or kept here.
import { Modal, Notice, Setting, type App } from 'obsidian';
import { Dodo, type SharedLink } from './sync.js';

type Shared = Awaited<ReturnType<Dodo['shared']>>;
interface Ask { title: string; text: string; ok: string; run: () => Promise<void> }
const until = (at: string | null) => at ? 'gäller till ' + new Date(at).toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' }) : 'utan slutdatum';

export class SharedModal extends Modal {
  private d?: Shared;
  private ask: Ask | null = null;
  private edit: string | null = null; // the link whose settings are open
  constructor(app: App, private dodo: Dodo) { super(app); }
  onOpen() { this.titleEl.setText('Delningar'); this.contentEl.setText('Hämtar …'); void this.load(); }
  private async load() {
    try { this.d = await this.dodo.shared(); } catch (e) { this.contentEl.setText('Kunde inte hämta delningarna: ' + (e as Error).message); return; }
    this.render();
  }
  // runs one change and shows the list again; a refusal from the server is told as it is
  private async run(f: () => Promise<void>) {
    this.ask = null;
    try { await f(); } catch (e) { new Notice('dodo: ' + (e as Error).message); }
    await this.load();
  }
  private render() {
    const el = this.contentEl, d = this.d!;
    el.empty();
    if (this.ask) {
      const a = this.ask;
      this.titleEl.setText(a.title);
      el.createEl('p', { text: a.text });
      new Setting(el)
        .addButton(b => { b.setButtonText('Avbryt').setCta().onClick(() => { this.ask = null; this.render(); }); window.setTimeout(() => b.buttonEl.focus(), 0); })
        .addButton(b => b.setButtonText(a.ok).setWarning().onClick(() => void this.run(a.run)));
      return;
    }
    this.titleEl.setText('Delningar');
    new Setting(el).setName('Delat av mig').setHeading();
    for (const l of d.mine) {
      new Setting(el).setName(l.name).setHeading();
      for (const p of l.people) new Setting(el).setName(p.name).setDesc(p.role === 'admin' ? 'admin' : 'medlem')
        .addButton(b => b.setButtonText('Ta bort').setWarning().onClick(() => this.confirm({ title: `Ta bort ${p.name} ur »${l.name}«?`, text: 'Personen förlorar åtkomsten till listan. Det hen har skrivit står kvar.', ok: 'Ta bort', run: () => this.dodo.removePerson(l.id, p.id) })));
      for (const k of l.links) {
        const what = k.todo ? `uppgiften »${k.text ?? ''}«` : 'hela listan';
        new Setting(el).setName(k.todo ? k.text || 'Uppgift' : 'Hela listan').setDesc(`${until(k.expires)} · ${k.says}`)
          .addButton(b => b.setButtonText(this.edit === k.id ? 'Klar' : 'Ändra').onClick(() => { this.edit = this.edit === k.id ? null : k.id; this.render(); }))
          .addButton(b => b.setButtonText('Stoppa länken').setWarning().onClick(() => this.confirm({ title: `Stoppa länken till ${what}?`, text: `Länken till ${what} i »${l.name}« slutar fungera direkt: den som har den kommer inte längre in. Det går inte att ångra, en ny länk får en ny adress.`, ok: 'Stoppa länken', run: () => this.dodo.stopLink(l.id, k.id) })));
        if (this.edit === k.id) this.options(l.id, k);
      }
      if (!l.people.length && !l.links.length) el.createEl('p', { text: 'Inget delat.', cls: 'setting-item-description' });
    }
    if (!d.mine.length) el.createEl('p', { text: 'Du driver inga listor.', cls: 'setting-item-description' });
    new Setting(el).setName('Jag är med i').setHeading();
    for (const l of d.member) {
      const s = new Setting(el).setName(l.name).setDesc((l.role === 'admin' ? 'admin' : 'medlem') + (l.by.length ? ' · Admin: ' + l.by.join(', ') : '') + (l.canLeave ? '' : ' · enda admin: gör någon annan till admin i dodo först'));
      if (l.canLeave) s.addButton(b => b.setButtonText('Lämna listan').setWarning().onClick(() => this.confirm({
        title: `Lämna »${l.name}«?`,
        text: `Listan försvinner från dina listor i dodo, och du kommer bara tillbaka med en ny inbjudan. Det du har skrivit står kvar där.${l.note ? ` Anteckningen flyttas till ${this.dodo.asideFolder()}/ med en rad överst om att du har lämnat listan, och hålls inte längre i takt. Texten finns kvar i filen.` : ''}`,
        ok: 'Lämna listan', run: () => this.dodo.leave(l.id) })));
    }
    if (!d.member.length) el.createEl('p', { text: 'Du är inte med i några listor.', cls: 'setting-item-description' });
  }
  private confirm(a: Ask) { this.ask = a; this.render(); }
  // what a link shows and allows: toggles, each one a change at once (the server needs all of it, the core fills in the rest)
  private options(list: string, k: SharedLink) {
    const el = this.contentEl.createDiv({ cls: 'dodo-link-options' }), o = k.opts;
    const toggle = (name: string, on: boolean, change: (v: boolean) => Parameters<Dodo['changeLink']>[2]) => new Setting(el).setName(name).addToggle(t => t.setValue(on).onChange(v => void this.run(() => this.dodo.changeLink(list, k.id, change(v)))));
    for (const [key, label] of Dodo.SHOWS) toggle('Visar ' + label, !!o.show?.[key], v => ({ show: { [key]: v } }));
    toggle('Får bocka av', !!o.check, v => ({ check: v }));
    if (!k.todo) toggle('Får lägga till uppgifter', !!o.add, v => ({ add: v }));
    toggle('Får kommentera (kräver att kommentarer visas)', !!o.comment, v => ({ comment: v }));
    toggle('Får skriva i anteckningen (kräver att anteckningen visas)', !!o.notes, v => ({ notes: v }));
  }
}
