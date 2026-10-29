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
  rename(listId: string, stem: string): Promise<void>; // the note gets a new free name in its folder; links follow
  base(listId: string): string | null; // the note's file name without .md
  viewing?(listId: string): boolean; // the note is in front of the user right now
  create(path: string, text: string): Promise<Note>;
  notice(text: string, action?: { label: string; run: () => void }): void;
  confirm(text: string): Promise<boolean>;
}
// one line of "new since last time" from the server (GET /news): a todo added, changed, done or deleted, or someone who came or went
export interface News { kind: string; by: string; at: string; todo?: string; text?: string; md?: boolean; who?: string; data?: any }
export interface Snap { me: string; users: any[]; headings: any[]; todos: any[]; comments?: any[] }
export interface ListData { name: string; rev: number; text: string; snap: Snap; hide: boolean; off?: boolean; lost?: boolean }
export interface Data { url: string; session: string; name: string; folder: string; hideDone: boolean; autoAdd: boolean; seen: Record<string, string>; since: string; lists: Record<string, ListData>; fresh: Record<string, number> }
export const emptyData = (): Data => ({ url: '', session: '', name: '', folder: 'dodo', hideDone: false, autoAdd: true, seen: {}, since: '', lists: {}, fresh: {} });

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
// where each item of a docPlan starts (line index in the document text). A todo or block knows its lines; a heading goes on to the next item's first line.
const TODO_LINE = /^(?:[-*+]|\d+[.)])\s+\[[ xX]\]/, FENCE_LINE = /^\s*(```|~~~)/;
export function spans(plan: any[], lines: string[]): number[] {
  let pos = 0;
  while (pos < lines.length && !lines[pos].trim()) pos++;
  return plan.map((it, i) => {
    const start = pos;
    if (!it.level) pos += (it.lines || it.block).length;
    else {
      const nxt = plan[i + 1];
      let j = start + 1, fence = false;
      if (!nxt) j = lines.length;
      else for (; j < lines.length; j++) {
        if (FENCE_LINE.test(lines[j])) { fence = !fence; continue; }
        if (!fence && (nxt.level ? /^#{1,6}\s+\S/.test(lines[j]) : TODO_LINE.test(lines[j]))) break;
      }
      pos = j;
    }
    return start;
  });
}
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
  onFresh: () => void = () => {}; // which notes have news from others changed: the status bar and the file list show it
  onNews: (listId: string) => void = () => {}; // what is new in an opened note arrived, or was cleared
  private newsOf: Record<string, News[]> = {};
  private owed = new Set<string>(); // others changed it while it was in front of me: the server hears it was seen when I leave
  onLists: () => void = () => {}; // a list was turned on or lost: the settings tab shows it
  private md: Md;
  private users: any[] = [];
  private busy = 0;
  private errs = new Map<string, string>();
  private locks = new Map<string, Promise<unknown>>();
  private edited = new Map<string, number>();

  constructor(public data: Data, private d: { http: Http; host: Host; save: () => unknown; openSettings?: () => void }) {
    this.md = loadMd(this.users, uid, 'sv');
    if (!data.since) data.since = new Date().toISOString(); // saved with the next save
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
  async lists(): Promise<{ id: string; name: string; changed?: boolean }[]> { return (await this.call('GET', '/api/lists')).lists; }

  // ---- the state of a list, and its text ----
  // null = nothing changed since `rev`
  private async state(id: string, rev?: number): Promise<(Snap & { rev: number; list: any }) | null> {
    let d: any;
    try { d = await this.call('GET', `/api/l/${id}/state` + (rev == null ? '' : `?rev=${rev}`)); } catch (e: any) { if (e.status === 403 || e.status === 404) e.lost = true; throw e; }
    if (!d) return null;
    const canon = (w: string) => (w[0] === '@' ? (d.users.find((u: any) => u.handle === w.slice(1)) || { id: w }).id : w);
    for (const x of [...d.headings, ...d.todos, ...d.todos.flatMap((t: any) => t.subs)]) x.who = [...new Set((x.who || []).map(canon))];
    d.todos.sort((a: any, b: any) => this.md.ordKey(a) - this.md.ordKey(b));
    return { rev: d.rev, me: d.me, users: d.users, headings: d.headings, todos: d.todos, comments: d.comments || [], list: d.list };
  }
  private snap = (S: Snap): Snap => ({ me: S.me, users: S.users, headings: S.headings, todos: S.todos, comments: S.comments });
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
    const there = h.note(id);
    if (there) { // the vault already has it (synced from another computer, whose plugin made it): take that note, and dodo's version wins
      const file = await there.read(), { head } = split(file);
      if (split(file).text !== text) await there.replace(file, toFile(head, text));
      this.data.lists[id] = { name: S.list.name, rev: S.rev, text, snap: this.snap(S), hide };
      return this.d.save();
    }
    const stem = fileName(S.list.name), dir = this.data.folder.replace(/^\/+|\/+$/g, '');
    const { path, n } = freeName(dir, stem, h.exists.bind(h));
    await h.create(path, toFile(`---\ndodo: ${this.data.url}/l/${id}\n---\n`, text));
    if (n > 1) h.notice(`Det fanns redan en fil med det namnet, så anteckningen heter ${path.split('/').pop()}.`);
    this.data.lists[id] = { name: S.list.name, rev: S.rev, text, snap: this.snap(S), hide };
    await this.d.save();
  }
  // the list got a new name in dodo: the note follows, unless it was given a name of its own in Obsidian
  private async renamed(id: string, ld: ListData, name: string) {
    const base = this.d.host.base(id);
    const was = fileName(ld.name);
    ld.name = name; // before the rename, so the vault's rename event for it is seen as already known
    if (base === was || base?.replace(/ \d+$/, '') === was) await this.d.host.rename(id, fileName(name)); // or »Handla 2« when the name was taken
    await this.d.save();
  }
  // the user renamed the note in Obsidian: the list gets that name for everyone if they are its admin, otherwise the note keeps its own name
  async noteRenamed(id: string) {
    const ld = this.data.lists[id], base = this.d.host.base(id);
    if (!ld || ld.off || ld.lost || !base || !this.data.session) return;
    const now = fileName(ld.name);
    if (base === now || base.replace(/ \d+$/, '') === now) return; // our own rename, or »Namn 2« made because the name was taken
    try {
      await this.call('PUT', `/api/l/${id}`, { name: base });
      ld.name = base; await this.d.save();
    } catch (e: any) {
      if (e.status === 403) this.d.host.notice('Bara listans admin kan byta namn på listan; anteckningen behåller sitt eget namn.');
      else if (!e.offline) this.errs.set(id, e.message || String(e));
    }
  }
  // the note was opened: what others did since I last looked is fetched (like the web's "new since last time"), and it counts as seen everywhere
  async opened(id: string) {
    if (!this.data.fresh[id] || !this.data.lists[id]) return;
    delete this.data.fresh[id]; void this.d.save(); this.onFresh();
    try {
      const { previous } = await this.call('POST', `/api/l/${id}/seen`, {});
      if (!previous) return;
      const d = await this.call('GET', `/api/l/${id}/news?since=${encodeURIComponent(previous)}`);
      if (d?.items?.length) { this.newsOf[id] = d.items; this.onNews(id); }
    } catch { /* offline: the dot is gone, only the details are missed */ }
  }
  // the note was left: what was new in it is no longer marked, and changes that came while it was open count as seen
  async left(id: string) {
    if (this.newsOf[id]) { delete this.newsOf[id]; this.onNews(id); }
    if (this.owed.delete(id)) await this.call('POST', `/api/l/${id}/seen`, {}).catch(() => {});
  }
  whatsNew(id: string): News[] { return this.newsOf[id] || []; }
  // where a todo is in the note (0-based line in the whole file), or -1
  lineOf(id: string, file: string, todo: string) {
    const p = this.plan(id, file), i = p ? p.plan.findIndex(it => !it.level && it.id === todo) : -1;
    return p && i >= 0 ? p.starts[i] + p.off : -1;
  }
  // the lines of the note whose todos are in its news (added, changed or done; a deleted one has no line)
  newsLines(id: string, file: string): number[] {
    const p = this.plan(id, file), ids = new Set(this.whatsNew(id).filter(x => x.kind !== 'delete').map(x => x.todo));
    if (!p || !ids.size) return [];
    return p.plan.flatMap((it, i) => !it.level && it.id && ids.has(it.id) ? [p.starts[i] + p.off] : []);
  }
  // a todo someone deleted comes back as it was
  async restore(id: string, x: News) {
    await this.call('PUT', `/api/l/${id}/todos/${encodeURIComponent(x.todo!)}`, x.data);
    await this.flush(id);
  }
  updated() { return Object.keys(this.data.fresh).filter(id => this.data.lists[id] && !this.data.lists[id].lost).sort((a, b) => this.data.fresh[b] - this.data.fresh[a]); }
  async disable(id: string) { if (this.data.lists[id]) { this.data.lists[id].off = true; await this.d.save(); } }

  // ---- when to sync ----
  touched(id: string) { this.edited.set(id, Date.now()); }
  listCheckEvery = 30000;
  private listCheck = 0;
  private adding = new Set<string>();
  async tick() {
    await Promise.all([this.addNew(false), ...Object.keys(this.data.lists).map(id => this.cycle(id, false))]);
    this.flushNews();
  }
  // a message from the event stream: a list changed, or lists were added or taken away
  event(name: string, d: any) {
    if (name === 'rev' && d?.list && this.data.lists[d.list]) void this.cycle(d.list, false).then(() => this.flushNews());
    else if (name === 'lists') { void this.addNew(true); for (const id of Object.keys(this.data.lists)) void this.cycle(id, false); } // a deleted list is noticed at once
  }
  // lists the server has that the vault has never seen are turned on; a list switched off stays off; a renamed list renames its note
  private async addNew(force: boolean) {
    if (!this.data.session || this.authLost || (!force && Date.now() - this.listCheck < this.listCheckEvery)) return;
    this.listCheck = Date.now();
    try {
      for (const l of await this.lists()) {
        const ld = this.data.lists[l.id];
        if (ld) {
          if (l.name !== ld.name) await this.renamed(l.id, ld, l.name);
          // the server knows what I have seen anywhere (the web, another computer): its word wins, except for the note in front of me
          if ('changed' in l && !ld.off && !this.d.host.viewing?.(l.id) && !!l.changed !== !!this.data.fresh[l.id]) {
            if (l.changed) this.data.fresh[l.id] = Date.now(); else delete this.data.fresh[l.id];
            await this.d.save(); this.onFresh();
          }
          continue;
        }
        if (!this.data.autoAdd || this.adding.has(l.id)) continue;
        this.adding.add(l.id);
        try { await this.enable(l.id); this.onLists(); } finally { this.adding.delete(l.id); }
      }
      this.errs.delete('lists');
    } catch (e: any) {
      if (e.status === 401) await this.fail('lists', null, null, e); else if (!e.offline) this.errs.set('lists', e.message || String(e));
      this.update();
    }
  }
  flush(id: string) { return this.cycle(id, true).then(() => this.flushNews()); }

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
    const hide = this.data.hideDone, S = await this.state(id, ld.hide === hide && ld.snap.comments ? ld.rev : undefined); // an old snapshot without comments is fetched whole once
    if (!S) return;
    await note.quiet?.();
    const file = await note.read(), { head, text } = split(file);
    if (text !== ld.text) return; // typed meanwhile: it is sent first, next time
    const c = this.render(S, hide);
    let wrote = false;
    if (squash(text) === squash(c)) ld.text = text;
    else if (await note.replace(file, toFile(head, c))) { ld.text = c; wrote = ld.hide === hide; } // not when it was only done todos shown or hidden
    else return;
    if (wrote && this.d.host.viewing?.(id)) this.owed.add(id);
    else if (wrote) { this.data.fresh[id] = Date.now(); this.onFresh(); } // my own edits never come back this way: what I sent already matches
    this.news(ld.snap, S);
    Object.assign(ld, { rev: S.rev, snap: this.snap(S), hide });
    await this.d.save();
    this.onSnap(id);
  }

  // note -> server: what changed against the last server version, like the web page's Markdown mode does when it saves
  private async push(id: string, ld: ListData, note: Note) {
    const md = this.md, file = await note.read(), { head, text } = split(file);
    const items = this.items(ld.snap, ld.hide);
    const S = (await this.state(id))!; // the newest state first, so only what I changed is written over others' work
    this.users.length = 0; this.users.push(...S.users);
    if (squash(text) === squash(this.render(S, ld.hide))) { // the note already says what dodo says: the edit came with the vault from another computer, which sent it
      Object.assign(ld, { text, rev: S.rev, snap: this.snap(S) });
      return this.d.save();
    }
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
    this.news(ld.snap, S2);
    Object.assign(ld, { rev: S2.rev, snap: this.snap(S2) });
    await this.d.save();
    this.onSnap(id);
  }

  // ---- comments ----
  onSnap: (listId: string) => void = () => {};
  private told: string[] = [];
  name(S: Snap, user: string) { return user?.[0] === '@' ? user.slice(1) : S.users.find(u => u.id === user)?.name ?? 'okänd'; }
  // someone else's comment that was not in the last snapshot: one notice for a whole batch
  private news(old: Snap, S: Snap) {
    if (!old.comments) return;
    const had = new Set(old.comments.map(c => c.id));
    for (const c of S.comments || []) {
      const t = S.todos.find(t => t.id === c.todo);
      if (!had.has(c.id) && c.user !== S.me && t) this.told.push(`${this.name(S, c.user)} kommenterade »${t.md ? 'textstycket' : t.text}«`);
    }
  }
  private flushNews() {
    if (!this.told.length) return;
    const [first, ...more] = this.told; this.told = [];
    this.d.host.notice('dodo: ' + first + (more.length ? ` (och ${more.length} till)` : ''));
  }
  private fresh(S: Snap, todo: string) {
    return (S.comments || []).some(c => c.todo === todo && c.user !== S.me && c.at > this.data.since && // older than the plugin itself counts as seen; unseen ones stay new across restarts
       c.at > (this.data.seen[todo] || ''));
  }
  private plan(id: string, file: string) {
    const ld = this.data.lists[id];
    if (!ld) return null;
    const { head, text } = split(file), lines = text.split('\n');
    const plan = this.md.docPlan(this.items(ld.snap, ld.hide), text);
    return { ld, plan, starts: spans(plan, lines), off: head.split('\n').length - 1, n: lines.length };
  }
  // what is at a line of the note (0-based, in the whole file): null in the frontmatter; id null = a line not sent yet
  todoAt(id: string, file: string, line: number): { kind: 'todo' | 'heading' | 'block'; id: string | null } | null {
    const p = this.plan(id, file);
    if (!p || line < p.off) return null;
    const l = line - p.off;
    let i = -1;
    p.starts.forEach((s, k) => { if (s <= l) i = k; });
    if (i < 0) return null;
    const it = p.plan[i];
    return { kind: it.level ? 'heading' : it.block ? 'block' : 'todo', id: it.id || null };
  }
  // the todo lines that have comments: where a marker goes
  commentLines(id: string, file: string): { line: number; id: string; n: number; fresh: boolean }[] {
    const p = this.plan(id, file);
    if (!p) return [];
    const S = p.ld.snap, out: { line: number; id: string; n: number; fresh: boolean }[] = [];
    p.plan.forEach((it, i) => {
      if (it.level || it.block || !it.id) return;
      const n = (S.comments || []).filter(c => c.todo === it.id).length;
      if (n) out.push({ line: p.starts[i] + p.off, id: it.id, n, fresh: this.fresh(S, it.id) });
    });
    return out;
  }
  threads(id: string, todo: string) {
    const S = this.data.lists[id]?.snap, t = S?.todos.find(t => t.id === todo);
    if (!S || !t) return null;
    const cs = (S.comments || []).filter(c => c.todo === todo);
    return { todo: t, S, threads: cs.filter(c => !c.parent).map(root => ({ root, replies: cs.filter(c => c.parent === root.id) })) };
  }
  markSeen(id: string, todo: string) {
    const last = (this.data.lists[id]?.snap.comments || []).filter(c => c.todo === todo).reduce((m, c) => (c.at > m ? c.at : m), '');
    if (last && this.data.seen[todo] !== last) { this.data.seen[todo] = last; void this.d.save(); this.onSnap(id); }
  }
  // posted like the web does; a reply names the comment it answers
  async comment(id: string, todo: string, text: string, parent?: string) {
    await this.call('POST', `/api/l/${id}/todos/${todo}/comments`, parent ? { text, parent } : { text });
    await this.flush(id);
  }
  async resolve(id: string, comment: string, resolved: boolean) {
    await this.call('PUT', `/api/l/${id}/comments/${comment}`, { resolved });
    await this.flush(id);
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
