// The sync core: no `obsidian` import. Network, notes and dialogs come in through small interfaces, so the tests run it with Node's fetch and a fake vault.
// The text rules (md.js) and the way a changed document becomes API calls are the web page's (public/index.html, openDoc) and tui.js's editAll.
import { loadMd, type Md } from './md.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type HttpReq = { method: string; url: string; headers: Record<string, string>; body?: string };
export type HttpRes = { status: number; json: any };
export type Http = (r: HttpReq) => Promise<HttpRes>; // rejects when the server cannot be reached

export interface Note {
  read(): Promise<string>; // the whole file, frontmatter included
  replace(from: string, to: string): Promise<boolean>; // only if the file still is `from`
  quiet?(): Promise<void>; // resolves when the user has stopped typing in it
}
export interface Host {
  note(listId: string): Note | null;
  exists(path: string): boolean;
  move(listId: string, dir: string): Promise<void>; // the note goes into `dir` under a free name; links follow
  create(path: string, text: string): Promise<Note>;
  notice(text: string, action?: { label: string; run: () => void }): void;
  confirm(text: string): Promise<boolean>;
}
export interface Snap { me: string; users: any[]; headings: any[]; todos: any[] }
export interface ListData { name: string; rev: number; text: string; snap: Snap; hide: boolean; off?: boolean; lost?: boolean }
export interface Data { url: string; session: string; name: string; folder: string; hideDone: boolean; autoAdd: boolean; lists: Record<string, ListData> }
export const emptyData = (): Data => ({ url: '', session: '', name: '', folder: 'dodo', hideDone: false, autoAdd: true, lists: {} });

// a callout at the top of a note whose list is gone (the server says 404 both when it was deleted and when you were taken out of it)
export const LOST_TITLE = '> [!warning] Listan finns inte längre i dodo';
export const lostNote = (name: string, day: string) => `${LOST_TITLE}\n> »${name}« är borttagen i dodo, eller så är du inte med i den längre (${day}). Anteckningen hålls inte i takt längre, men texten finns kvar här.`;
export const ASIDE = 'Borttagna';
export const SEND_MS = 1000; // quiet after typing before it is sent
// the first free `dir/stem.md`, `dir/stem 2.md` …; n > 1 means the first was taken
export function freeName(dir: string, stem: string, exists: (p: string) => boolean) {
  let n = 1, path = '';
  do path = `${dir ? dir + '/' : ''}${stem}${n > 1 ? ' ' + n : ''}.md`; while (exists(path) && ++n);
  return { path, n };
}
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const FM = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;
// a file -> its frontmatter and the document text (no trailing newline, \n only)
export function split(file: string) {
  const head = file.match(FM)?.[0] ?? '';
  return { head, text: file.slice(head.length).replace(/\r\n/g, '\n').replace(/\n$/, '') };
}
const toFile = (head: string, text: string) => head + (text ? text + '\n' : '');
// the same document apart from blank lines and trailing spaces: a user's Enter at the end must not be rewritten away
const squash = (s: string) => s.split('\n').map(l => l.trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
// the list a note belongs to, from its `dodo:` frontmatter value (https://host/l/<id>)
export const listIdOf = (v: unknown) => (typeof v === 'string' ? v.match(/\/l\/([A-Za-z0-9_-]+)\/?\s*$/)?.[1] ?? null : null);
const fileName = (s: string) => s.replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim() || 'lista';

// the smallest edit from `from` to `to` (offsets into `from`): the text before and after it is not touched, so the cursor and the scroll stay
export function minimalChange(from: string, to: string) {
  const max = Math.min(from.length, to.length), hi = (s: string, i: number) => { const c = s.charCodeAt(i); return c >= 0xd800 && c < 0xdc00; };
  let a = 0, b = 0;
  while (a < max && from[a] === to[a]) a++;
  while (b < max - a && from[from.length - 1 - b] === to[to.length - 1 - b]) b++;
  if (a && hi(from, a - 1)) a--; // never in the middle of an emoji
  if (b && hi(to, to.length - b - 1)) b--;
  return { from: a, to: from.length - b, text: to.slice(a, to.length - b) };
}

export class Fail extends Error { status?: number; offline?: boolean; data?: any; lost?: boolean }

export class Dodo {
  status: 'ok' | 'busy' | 'err' = 'ok';
  lastError = '';
  authLost = false;
  onStatus: () => void = () => {};
  onLists: () => void = () => {}; // a list was turned on or lost: the settings tab shows it
  private md: Md;
  private users: any[] = [];
  private busy = 0;
  private errs = new Map<string, string>();
  private locks = new Map<string, Promise<unknown>>();
  private edited = new Map<string, number>();

  constructor(public data: Data, private d: { http: Http; host: Host; save: () => unknown; openSettings?: () => void }) {
    this.md = loadMd(this.users, uid, 'sv');
  }

  // ---- network ----
  private async call(method: string, path: string, body?: unknown) {
    let r: HttpRes;
    try {
      r = await this.d.http({ method, url: this.data.url + path, body: body === undefined ? undefined : JSON.stringify(body),
        headers: { ...(this.data.session && { authorization: 'Bearer ' + this.data.session }), ...(method !== 'GET' && { 'content-type': 'application/json' }) } });
    } catch { throw Object.assign(new Fail(`Får ingen kontakt med ${this.data.url}`), { offline: true }); }
    if (r.status === 204) return null;
    if (r.status >= 400) throw Object.assign(new Fail(r.json?.error || `HTTP ${r.status}`), { status: r.status, data: r.json });
    return r.json;
  }

  async login(link: string) {
    let u: URL;
    try { u = new URL(link.trim()); } catch { throw new Error('Det där ser inte ut som en länk. Kopiera hela länken från ⋯ → Logga in på annan enhet.'); }
    if (!/^\/in\/[A-Za-z0-9_-]{20,100}$/.test(u.pathname)) throw new Error('Det där är inte en inloggningslänk. Den ska se ut som https://…/in/… och finns under ⋯ → Logga in på annan enhet.');
    let r: HttpRes;
    try { r = await this.d.http({ method: 'POST', url: u.href, headers: { accept: 'application/json' } }); } catch { throw new Error(`Får ingen kontakt med ${u.host}`); }
    if (r.status !== 200 || !r.json?.session) throw new Error(r.status === 410 || r.status === 429
      ? 'Länken gäller inte längre: den gäller i 10 minuter och kan bara användas en gång. Hämta en ny i ⋯ → Logga in på annan enhet.'
      : `Inloggningen gick inte (HTTP ${r.status}).`);
    Object.assign(this.data, { url: u.origin, session: r.json.session, name: r.json.name });
    this.authLost = false;
    await this.d.save();
  }
  async logout() {
    if (this.data.session) await this.call('POST', '/api/logout', {}).catch(() => {});
    Object.assign(this.data, { session: '', name: '' });
    await this.d.save();
  }
  async lists(): Promise<{ id: string; name: string }[]> { return (await this.call('GET', '/api/lists')).lists; }

  // ---- the state of a list, and its text ----
  // null = nothing changed since `rev`
  private async state(id: string, rev?: number): Promise<(Snap & { rev: number; list: any }) | null> {
    let d: any;
    try { d = await this.call('GET', `/api/l/${id}/state` + (rev == null ? '' : `?rev=${rev}`)); } catch (e: any) { if (e.status === 403 || e.status === 404) e.lost = true; throw e; }
    if (!d) return null;
    const canon = (w: string) => (w[0] === '@' ? (d.users.find((u: any) => u.handle === w.slice(1)) || { id: w }).id : w);
    for (const x of [...d.headings, ...d.todos, ...d.todos.flatMap((t: any) => t.subs)]) x.who = [...new Set((x.who || []).map(canon))];
    d.todos.sort((a: any, b: any) => this.md.ordKey(a) - this.md.ordKey(b));
    return { rev: d.rev, me: d.me, users: d.users, headings: d.headings, todos: d.todos, list: d.list };
  }
  private snap = (S: Snap): Snap => ({ me: S.me, users: S.users, headings: S.headings, todos: S.todos });
  // the list as the document items docPlan compares with (done todos left out when they are hidden: they are not "removed" either)
  private items(S: Snap, hide: boolean): any[] {
    this.users.length = 0; this.users.push(...S.users);
    const md = this.md, known = new Set(S.headings.map(h => h.id)), vis = (t: any) => !(hide && t.done);
    const todo = (t: any) => t.md ? { id: t.id, at: t.updatedAt, block: true, text: md.blockText(t) } : { id: t.id, at: t.updatedAt, text: md.serialize(t) };
    return [...S.todos.filter(t => !known.has(t.h) && vis(t)).map(todo),
      ...S.headings.flatMap(h => [{ id: h.id, heading: true, text: md.headingItem(h) }, ...S.todos.filter(t => t.h === h.id && vis(t)).map(todo)])];
  }
  private render = (S: Snap, hide: boolean) => this.md.docText(this.items(S, hide));

  // ---- lists on or off ----
  async enable(id: string) {
    const h = this.d.host, old = this.data.lists[id];
    if (old && h.note(id)) { old.off = false; old.lost = false; await this.d.save(); return this.flush(id); }
    const S = (await this.state(id))!, hide = this.data.hideDone, text = this.render(S, hide);
    const stem = fileName(S.list.name), dir = this.data.folder.replace(/^\/+|\/+$/g, '');
    const { path, n } = freeName(dir, stem, h.exists.bind(h));
    await h.create(path, toFile(`---\ndodo: ${this.data.url}/l/${id}\n---\n`, text));
    if (n > 1) h.notice(`Det fanns redan en fil med det namnet, så anteckningen heter ${path.split('/').pop()}.`);
    this.data.lists[id] = { name: S.list.name, rev: S.rev, text, snap: this.snap(S), hide };
    await this.d.save();
  }
  async disable(id: string) { if (this.data.lists[id]) { this.data.lists[id].off = true; await this.d.save(); } }

  // ---- when to sync ----
  touched(id: string) { this.edited.set(id, Date.now()); }
  listCheckEvery = 30000;
  private listCheck = 0;
  private adding = new Set<string>();
  async tick() {
    await Promise.all([this.addNew(false), ...Object.keys(this.data.lists).map(id => this.cycle(id, false))]);
  }
  // a message from the event stream: a list changed, or lists were added or taken away
  event(name: string, d: any) {
    if (name === 'rev' && d?.list && this.data.lists[d.list]) void this.cycle(d.list, false);
    else if (name === 'lists') { void this.addNew(true); for (const id of Object.keys(this.data.lists)) void this.cycle(id, false); } // a deleted list is noticed at once
  }
  // lists the server has that the vault has never seen are turned on; a list switched off stays off
  private async addNew(force: boolean) {
    if (!this.data.autoAdd || !this.data.session || this.authLost || (!force && Date.now() - this.listCheck < this.listCheckEvery)) return;
    this.listCheck = Date.now();
    try {
      for (const l of await this.lists()) {
        if (this.data.lists[l.id] || this.adding.has(l.id)) continue;
        this.adding.add(l.id);
        try { await this.enable(l.id); this.onLists(); } finally { this.adding.delete(l.id); }
      }
      this.errs.delete('lists');
    } catch (e: any) {
      if (e.status === 401) await this.fail('lists', null, null, e); else if (!e.offline) this.errs.set('lists', e.message || String(e));
      this.update();
    }
  }
  flush(id: string) { return this.cycle(id, true); }

  private cycle(id: string, now: boolean): Promise<void> {
    const p = (this.locks.get(id) ?? Promise.resolve()).then(() => this.run(id, now));
    this.locks.set(id, p);
    return p;
  }
  private async run(id: string, now: boolean) {
    const ld = this.data.lists[id], note = ld && this.d.host.note(id);
    if (!ld || ld.off || ld.lost || this.authLost || !note) return;
    this.busy++; this.update();
    try {
      const { text } = split(await note.read());
      if (text === ld.text) await this.pull(id, ld, note);
      else if (now || Date.now() - (this.edited.get(id) || 0) >= SEND_MS) await this.push(id, ld, note); // still typing: the debounce sends it
      this.errs.delete(id);
    } catch (e: any) { await this.fail(id, ld, note, e); }
    finally { this.busy--; this.update(); }
  }

  // server -> note, only when the note has no unsent edits
  private async pull(id: string, ld: ListData, note: Note) {
    const hide = this.data.hideDone, S = await this.state(id, ld.hide === hide ? ld.rev : undefined);
    if (!S) return;
    await note.quiet?.();
    const file = await note.read(), { head, text } = split(file);
    if (text !== ld.text) return; // typed meanwhile: it is sent first, next time
    const c = this.render(S, hide);
    if (squash(text) === squash(c)) ld.text = text;
    else if (await note.replace(file, toFile(head, c))) ld.text = c;
    else return;
    Object.assign(ld, { rev: S.rev, snap: this.snap(S), hide });
    await this.d.save();
  }

  // note -> server: what changed against the last server version, like the web page's Markdown mode does when it saves
  private async push(id: string, ld: ListData, note: Note) {
    const md = this.md, file = await note.read(), { head, text } = split(file);
    const items = this.items(ld.snap, ld.hide);
    const S = (await this.state(id))!; // the newest state first, so only what I changed is written over others' work
    this.users.length = 0; this.users.push(...S.users);
    const plan = md.docPlan(items, text), at = new Map(items.map(x => [x.id, x.at])), inDoc = new Set(items.map(x => x.id));

    const kept = new Set(plan.filter(p => p.id).map(p => p.id)), todos = items.filter(i => !i.heading && !i.block);
    const gone = todos.filter(i => !kept.has(i.id)).length;
    if (gone >= 2 && gone * 2 > todos.length && !await this.d.host.confirm(`Ta bort ${gone} av ${todos.length} uppgifter i dodo? De går att ångra där.`)) {
      await note.replace(file, toFile(head, ld.text)); // "keep": the note goes back to what dodo has
      return;
    }

    const byId = (i: string) => S.todos.find(t => t.id === i);
    const baseJ = new Map(S.todos.map(t => [t.id, JSON.stringify(t)])), baseH = JSON.stringify(S.headings);
    const setDone = (t: any, v: boolean) => { t.done = v; t.doneBy = v ? S.me : null; t.doneAt = v ? Date.now() : null; };
    const fresh = (p: any) => {
      if (p.subs && p.subs.length && p.subs.every((s: any) => s.done)) p.done = true;
      return { id: uid(), notes: '', subs: [], due: null, prio: 0, ...p, doneBy: p.done ? S.me : null, doneAt: p.done ? Date.now() : null };
    };
    const applyBlock = (t: any, p: any, h: string | null, base: string) => {
      Object.assign(t, { text: p.text, tags: p.tags, who: p.who, due: p.due, prio: p.prio, notes: p.notes, subs: p.subs, h, base });
      if (p.done) t.subs.forEach((s: any) => s.done = true);
      const done = p.done || (t.subs.length > 0 && t.subs.every((s: any) => s.done));
      if (done !== t.done) setDone(t, done);
    };
    const H: any[] = [], add: any[] = [], keep = new Set<string>();
    let cur: string | null = null;
    for (const p of plan) {
      if (p.level) {
        const h = S.headings.find(x => x.id === p.id) || { id: uid() };
        H.push(Object.assign(h, { level: p.level, ...md.parseHeading(p.title), notes: p.notes })); p.id = cur = h.id;
        continue;
      }
      const x = p.id && byId(p.id);
      if (p.same) { if (x) { keep.add(x.id); x.h = cur; p.h = cur; } else p.id = null; continue; } // untouched, or deleted by someone else meanwhile
      p.h = cur;
      if (p.block) { // a text block: its notes are the text
        if (x) { keep.add(x.id); Object.assign(x, { notes: p.notes, h: cur, base: at.get(x.id) }); }
        else { const nt = fresh({ md: true, text: '', notes: p.notes, tags: [], who: [], h: cur }); add.push(nt); p.id = nt.id; }
        continue;
      }
      const b = md.parseBlock(p.lines);
      if (!b.text) { p.id = null; continue; }
      if (x) { keep.add(x.id); applyBlock(x, b, cur, at.get(x.id) as string); } else { const nt = fresh({ ...b, h: cur }); add.push(nt); p.id = nt.id; }
    }
    S.headings = [...H, ...S.headings.filter(h => !inDoc.has(h.id) && !H.includes(h))];
    S.todos = [...add, ...S.todos.filter(x => keep.has(x.id) || !inDoc.has(x.id))];
    const hs = new Set(S.headings.map(h => h.id));
    S.todos.forEach(x => { if (x.h && !hs.has(x.h)) x.h = null; });
    // the text is the order: where a section's order differs from it, the same positions are handed out again in text order
    const secs = new Map<string | null, any[]>();
    for (const p of plan) if (p.id && !p.level) secs.set(p.h, [...(secs.get(p.h) || []), byId(p.id)]);
    for (const g of secs.values()) {
      const keys = g.map(md.ordKey).sort((a, b) => a - b).map((k, i, a) => a[i] = i && k <= a[i - 1] ? a[i - 1] + 1 : k);
      if (g.every((x, i) => md.ordKey(x) === keys[i])) continue;
      g.forEach((x, i) => x.pos = keys[i]);
    }
    S.todos.sort((a, b) => md.ordKey(a) - md.ordKey(b));

    // the calls: only what differs from the server's version
    const L = `/api/l/${id}`, sendJ = (t: any) => JSON.stringify({ ...t, base: undefined });
    if (baseH !== JSON.stringify(S.headings)) await this.call('PUT', L + '/headings', S.headings);
    for (const t of [...S.todos].reverse()) { // newest first on the server, so the last one goes first
      if (baseJ.get(t.id) === sendJ(t) || (!t.md && !t.text.trim())) continue;
      t.updatedBy = S.me;
      try { await this.call('PUT', `${L}/todos/${t.id}`, { ...t }); } catch (e: any) {
        if (e.status !== 409) throw e;
        // someone else saved this todo meanwhile: theirs stays, mine goes in as a comment, so no text is lost
        const mine = t.md ? md.blockText(t) : md.serialize(t);
        await this.call('POST', `${L}/todos/${t.id}/comments`, { text: 'Ändrades här i Obsidian samtidigt, så den här versionen togs inte med:\n\n' + mine });
        this.d.host.notice(`Krock: »${e.data?.current?.text || t.text || 'textstycke'}« ändrades i dodo samtidigt. Din version ligger som kommentar på uppgiften.`);
      }
    }
    const ids = new Set(S.todos.map(t => t.id));
    for (const i of baseJ.keys()) if (!ids.has(i)) await this.call('DELETE', `${L}/todos/${i}`);

    // what dodo has now; the note is only rewritten if it differs in more than blank lines, and not if it was typed in meanwhile
    const S2 = (await this.state(id))!, c = this.render(S2, ld.hide), f2 = await note.read(), cur2 = split(f2);
    if (cur2.text !== text || squash(text) === squash(c)) ld.text = text;
    else ld.text = (await note.replace(f2, toFile(cur2.head, c))) ? c : text;
    Object.assign(ld, { rev: S2.rev, snap: this.snap(S2) });
    await this.d.save();
  }

  // ---- errors and status ----
  private async fail(id: string, ld: ListData | null, note: Note | null, e: Fail) {
    if (e.status === 401) {
      this.authLost = true;
      this.errs.set(id, 'Sessionen har stängts av. Logga in igen.');
      this.d.host.notice('dodo: du är utloggad. Det du skriver sparas i anteckningen och skickas efter inloggningen.', this.d.openSettings && { label: 'Logga in igen', run: this.d.openSettings });
    } else if (e.lost && ld && note) {
      ld.lost = true; this.errs.delete(id);
      const file = await note.read().catch(() => '');
      if (file && !file.includes(LOST_TITLE)) { const { head } = split(file); await note.replace(file, head + lostNote(ld.name, new Date().toISOString().slice(0, 10)) + '\n\n' + file.slice(head.length)); }
      const dir = this.data.folder.replace(/^\/+|\/+$/g, '');
      await this.d.host.move(id, `${dir ? dir + '/' : ''}${ASIDE}`).catch(() => {});
      this.d.host.notice(`dodo: »${ld.name}« finns inte längre i dodo. Anteckningen ligger nu i ${ASIDE}, med en rad överst om det.`);
      this.onLists();
      await this.d.save();
    } else this.errs.set(id, e.message || String(e));
  }
  private update() {
    this.lastError = [...this.errs.values()][0] ?? '';
    this.status = this.busy ? 'busy' : this.errs.size ? 'err' : 'ok';
    this.onStatus();
  }
}
