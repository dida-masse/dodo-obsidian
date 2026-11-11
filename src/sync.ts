// The sync core: no `obsidian` import. Network, notes and dialogs come in through small interfaces, so the tests run it with Node's fetch and a fake vault.
// The text rules (md.js) and the way a changed document becomes API calls are the web page's (public/index.html, openDoc) and tui.js's editAll.
import { loadMd, type Md } from './md.js';
import { mergeFolders, pathsOf, type Disk, type Tree } from './folders.js';

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
  dir(listId: string): string | null; // the folder the note is in ('' = the vault's root)
  dirs(root: string): string[]; // every folder below `root` (not the hidden ones)
  mkdir(path: string): Promise<void>;
  prune(path: string): Promise<void>; // removes the folder if it is empty, otherwise leaves it
  viewing?(listId: string): boolean; // the note is in front of the user right now
  create(path: string, text: string): Promise<Note>;
  // every note whose frontmatter ties it to the list, wherever it lies: files the metadata cache has not read yet are read from disk (note() only sees what the cache knows)
  copies(listId: string): Promise<{ path: string; read(): Promise<string> }[]>;
  where(listId: string): string | null; // the path of the note this device is syncing for the list right now (what note() would use), asked before adopt
  isTyped(path: string): boolean; // the user has typed in this file in this session (its edits are being made now, not left from before a restart)
  adopt(listId: string, path: string): void; // this file is the list's note from now on (note(), base(), dir() answer for it)
  trash(path: string): Promise<void>; // through the user's trash setting, never a hard delete
  aside(path: string, from: string, to: string, dir: string): Promise<boolean>; // writes `to` if the file still is `from`, then moves it into `dir` under a free name
  notice(text: string, ...actions: { label: string; run: () => void }[]): void;
}
// one line of "new since last time" from the server (GET /news): a todo added, changed, done or deleted, or someone who came or went
export interface News { kind: string; by: string; at: string; todo?: string; text?: string; md?: boolean; who?: string; data?: any }
// A course's table sits between two markers and is the source's: the server puts it back whatever is sent. If the markers in the note were damaged
// (one gone, or both) the server would take the strays for the person's own text and the table would be there twice. So a note whose markers are not
// exactly one complete pair gets the source's block back first, the stray markers go, and so do the table lines that are the block's own.
const SRC_OPEN = '<!-- dodo:källa -->', SRC_CLOSE = '<!-- /dodo:källa -->';
export function mendSource(local: string, server: string | undefined): string {
  const i = server?.indexOf(SRC_OPEN) ?? -1, j = server?.indexOf(SRC_CLOSE) ?? -1;
  if (!server || i < 0 || j < i) return local;
  const count = (t: string, m: string) => t.split(m).length - 1;
  if (count(local, SRC_OPEN) === 1 && count(local, SRC_CLOSE) === 1 && local.indexOf(SRC_OPEN) < local.indexOf(SRC_CLOSE)) return local;
  const block = server.slice(i, j + SRC_CLOSE.length), own = new Set(block.split('\n').filter(l => l.trim().startsWith('|')).map(l => l.trim()));
  const rest = local.split('\n').filter(l => !l.includes(SRC_OPEN) && !l.includes(SRC_CLOSE) && !own.has(l.trim())).join('\n').trim();
  return block + (rest ? '\n\n' + rest : '');
}
export interface Snap { me: string; users: any[]; headings: any[]; todos: any[]; comments?: any[]; keys?: any[]; shares?: any[] } // shares: the active public links (id, todo, expires), never their addresses
export interface ListData { name: string; rev: number; text: string; snap: Snap; hide: boolean; off?: boolean; lost?: boolean }
export interface Data { url: string; session: string; name: string; folder: string; hideDone: boolean; tablesOpen?: boolean; autoAdd: boolean; seen: Record<string, string>; since: string; lists: Record<string, ListData>; fresh: Record<string, number>; tree?: Tree } // tree: dodo's folders as of the last sync
export interface SharedLink { id: string; todo: string | null; text: string | null; expires: string | null; opts: any; says: string; views: number; names: Record<string, string> }
export interface SharedMine { id: string; name: string; people: { id: string; name: string; role: string }[]; links: SharedLink[] }
export interface SharedIn { id: string; name: string; role: string; by: string[]; note: boolean; canLeave: boolean }
export const emptyData = (): Data => ({ url: '', session: '', name: '', folder: 'dodo', hideDone: false, autoAdd: true, seen: {}, since: '', lists: {}, fresh: {} });

// a callout at the top of a note whose list is gone (the server says 404 both when it was deleted and when you were taken out of it)
export const LOST_TITLE = '> [!warning] Listan finns inte längre i dodo';
export const lostNote = (name: string, day: string) => `${LOST_TITLE}\n> »${name}« är borttagen i dodo, eller så är du inte med i den längre (${day}). Anteckningen hålls inte i takt längre, men texten finns kvar här.`;
export const ASIDE = 'Borttagna';
// a second note for a list that holds text of its own: its tie (`dodo:`) is cut and it goes aside with a line at the top
export const COPY_TITLE = '> [!warning] Det här är en andra kopia av en dodo-lista';
export const copyNote = (kept: string) => `${COPY_TITLE}\n> Listan hålls i takt i ${kept}. Den här anteckningen hålls inte i takt längre, men texten finns kvar här.`;
export const SEND_MS = 1000; // quiet after typing before it is sent
// a note whose changes would delete this many of the list's todos is held back: more likely a misread note (a ~~~ in a mail signature once swallowed 62 todos) than a cleanup
export const massDelete = (gone: number, total: number) => gone >= 10 || (gone >= 3 && gone * 2 > total);
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
// the list a file belongs to by its frontmatter, read from the text itself (for files the metadata cache has not read)
export const tieOf = (file: string) => listIdOf(split(file).head.match(/^dodo:[ \t]*(\S+)/m)?.[1]);
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
  held = new Map<string, string>(); // list id -> why its note is not sent: a mass deletion waits for the user
  private allow = new Set<string>(); // the user said send it anyway: the next push may delete

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
  async lists(): Promise<{ id: string; name: string; changed?: boolean; role?: string }[]> { return (await this.call('GET', '/api/lists')).lists; }

  // ---- the state of a list, and its text ----
  // null = nothing changed since `rev`
  private async state(id: string, rev?: number): Promise<(Snap & { rev: number; list: any }) | null> {
    let d: any;
    try { d = await this.call('GET', `/api/l/${id}/state` + (rev == null ? '' : `?rev=${rev}`)); } catch (e: any) { if (e.status === 403 || e.status === 404) e.lost = true; throw e; }
    if (!d) return null;
    const canon = (w: string) => (w[0] === '@' ? (d.users.find((u: any) => u.handle === w.slice(1)) || { id: w }).id : w);
    for (const x of [...d.headings, ...d.todos, ...d.todos.flatMap((t: any) => t.subs)]) x.who = [...new Set((x.who || []).map(canon))];
    d.todos.sort((a: any, b: any) => this.md.ordKey(a) - this.md.ordKey(b));
    return { rev: d.rev, me: d.me, users: d.users, headings: d.headings, todos: d.todos, comments: d.comments || [], keys: d.keys || [], shares: d.shares || [], list: d.list };
  }
  private snap = (S: Snap): Snap => ({ me: S.me, users: S.users, headings: S.headings, todos: S.todos, comments: S.comments, keys: S.keys, shares: S.shares });
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
    await this.dedupe(id); // a note that exists but is not in the cache yet is found before anything is made
    if (old && h.note(id)) { old.off = false; old.lost = false; await this.d.save(); return this.flush(id); }
    const S = (await this.state(id))!, hide = this.data.hideDone, text = this.render(S, hide);
    const there = h.note(id);
    if (there) { // the vault already has it (synced from another computer, whose plugin made it): take that note, and dodo's version wins
      const file = await there.read(), { head } = split(file);
      if (split(file).text !== text) await there.replace(file, toFile(head, text));
      this.data.lists[id] = { name: S.list.name, rev: S.rev, text, snap: this.snap(S), hide };
      await this.loadSays(id, S);
      return this.d.save();
    }
    const stem = fileName(S.list.name), dir = this.data.folder.replace(/^\/+|\/+$/g, '');
    const { path, n } = freeName(dir, stem, h.exists.bind(h));
    await h.create(path, toFile(`---\ndodo: ${this.data.url}/l/${id}\n---\n`, text));
    if (n > 1) h.notice(`Det fanns redan en fil med det namnet, så anteckningen heter ${path.split('/').pop()}.`);
    this.data.lists[id] = { name: S.list.name, rev: S.rev, text, snap: this.snap(S), hide };
    await this.loadSays(id, S);
    await this.d.save();
  }
  // ---- two notes for one list ----
  // A file sync can deliver a second note for a list (made by another device, or moved there by it). Every device must keep the same one,
  // so the rule uses only what the shared vault and dodo's tree say: first the note lying where the tree says the list belongs, then the plain
  // name before »Name 2«, then the smallest path. A copy with nothing of its own (same text as the kept note, or as the last synced text) goes to the trash;
  // a copy with other text is never removed or overwritten: it loses its tie, gets a line at the top and goes to Borttagna.
  keepOrder(id: string, paths: string[]): string[] {
    const t = this.data.tree, f = t?.lists[id], root = this.data.folder.replace(/^\/+|\/+$/g, '');
    const want = [root, f && t ? pathsOf(t).get(f) ?? '' : ''].filter(Boolean).join('/').toLowerCase();
    const key = (p: string) => [p.slice(0, Math.max(0, p.lastIndexOf('/'))).toLowerCase() === want ? 0 : 1, / \d+\.md$/.test(p) ? 1 : 0] as const;
    return [...paths].sort((a, b) => key(a)[0] - key(b)[0] || key(a)[1] - key(b)[1] || (a.replace(/\.md$/, '') < b.replace(/\.md$/, '') ? -1 : a === b ? 0 : 1));
  }
  async dedupe(id: string) {
    return this.locked(id, async () => {
      const h = this.d.host, ld = this.data.lists[id], pin = h.where(id), all = await h.copies(id); // the pin is asked before adopt changes the answer
      if (!all.length) return;
      const order = this.keepOrder(id, all.map(c => c.path)), keep = all.find(c => c.path === order[0])!, pinned = all.find(c => c.path === pin);
      // Which copy's text lives on (`from`) is decided by content, the pin only where it means something: at start the pin is whatever file was met first.
      // 1) the pinned note with text the user is typing right now; 2) else a copy equal to the last synced text, which is what this device had in step with dodo
      // (the winner itself if it is one); 3) else the pinned note. Accepted: edits left unsent from before a restart, in a note that then meets a copy equal
      // to the last synced text, are set aside with a notice instead of being sent: nothing is lost, and nothing stale reaches dodo.
      const same = async (c: { read(): Promise<string> }) => squash(split(await c.read().catch(() => '')).text) === squash(ld?.text ?? '\0');
      let from = ld && pinned && h.isTyped(pinned.path) && !await same(pinned) ? pinned : undefined;
      if (ld && !from) for (const p of order) { const c = all.find(c => c.path === p)!; if (await same(c)) { from = c; break; } }
      from ??= pinned;
      if (ld?.lost) return h.adopt(id, keep.path);
      let kept = squash(split(await keep.read()).text);
      // The rule only says which PATH stays. If this device was syncing another file, that file's text is the one that goes on (its synced state and
      // unsent edits), never the stale text of the winner: it would be sent to dodo as edits and delete what others added since.
      // Order: the winner's own text is set aside or trashed first, then prev's text is written at the winner's path, then prev goes; at every step the text is in some file.
      if (ld && from && from !== keep) {
        const pf = await from.read().catch(() => null), kf = await keep.read().catch(() => null);
        if (pf != null && kf != null) {
          const pt = squash(split(pf).text), kt = squash(split(kf).text), known = new Set([...pt.split('\n'), ...(ld.text ? squash(ld.text).split('\n') : [])]);
          if (kt === pt) await h.trash(from.path).catch(() => {}); // the winner already has the text: nothing to move
          else {
            // a winner whose every line is in the note or in the last synced text is just stale (an older version); a line that is nowhere else is the user's own
            if (kt.split('\n').some(l => !known.has(l))) { if (!await this.setAside(keep.path, kf, keep.path, `dodo: »${keep.path}« hade text som varken finns i dodo eller i anteckningen du har arbetat i. Den är lagd i ${this.asideDir()} med en rad överst, och »${keep.path}« har nu din anteckning.`)) return; }
            else await h.trash(keep.path);
            await h.create(keep.path, pf);
            await h.trash(from.path).catch(() => {});
          }
          kept = squash(split(pf).text);
        }
      }
      h.adopt(id, keep.path);
      for (const c of all) {
        if (c.path === keep.path || (c === from && ld)) continue;
        const file = await c.read().catch(() => null);
        if (file == null) continue;
        const text = squash(split(file).text);
        if (text === kept || (ld && text === squash(ld.text))) await h.trash(c.path).catch(() => {});
        else await this.setAside(c.path, file, keep.path, `dodo: »${keep.path}« och »${c.path}« var två anteckningar för samma lista och hade olika text. »${keep.path}« är listans anteckning. »${c.path}« är lagd i ${this.asideDir()} med en rad överst. Texten finns kvar i båda.`);
      }
    });
  }
  // cuts the tie of a copy that holds text of its own, puts a line at the top and moves it aside
  private async setAside(path: string, file: string, keptPath: string, told: string) {
    const { head } = split(file);
    const ok = await this.d.host.aside(path, file, head.replace(/^dodo:/m, 'dodo-kopia:') + copyNote(keptPath) + '\n\n' + file.slice(head.length), this.asideDir()).catch(() => false);
    if (ok) this.d.host.notice(told);
    return ok;
  }
  // at start, once the vault is indexed
  async dedupeAll() { await Promise.all(Object.keys(this.data.lists).map(id => this.dedupe(id))); }
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
      // with a shared vault the other computer's rename (following dodo) arrives as a rename here too: the server already has that name
      const there = (await this.lists()).find(l => l.id === id)?.name;
      if (there != null && (fileName(there) === base || base.replace(/ \d+$/, '') === fileName(there))) { ld.name = there; await this.d.save(); return; }
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
    else if (name === 'folders') void this.folders();
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
      await this.folders();
    } catch (e: any) {
      if (e.status === 401) await this.fail('lists', null, null, e); else if (!e.offline) this.errs.set('lists', e.message || String(e));
      this.update();
    }
  }
  // ---- folders (#19) ----
  // dodo's tree and the vault's folders are made one: what changed in the vault since the last sync is laid on dodo's newest tree, then the vault follows the result
  // a removal of more than half of dodo's folders is more likely a vault that is not there yet (not synced down on this computer) than a cleanup: it waits for the user, like massDelete for notes
  heldFolders: Disk | null = null;
  async releaseFolders(send: boolean) {
    const disk = this.heldFolders; this.heldFolders = null;
    if (disk && send) await this.folders(disk); // the vault as it was then, and this time the removal is sent
  }
  async folders(held?: Disk) {
    if (!this.data.session || this.authLost) return;
    return this.locked('folders', async () => {
      const h = this.d.host, root = this.data.folder.replace(/^\/+|\/+$/g, ''), up = (p: string) => root ? p.slice(root.length + 1) : p, down = (p: string) => [root, p].filter(Boolean).join('/');
      const inside = (p: string) => !root || p === root || p.startsWith(root + '/'), aside = (p: string) => p === ASIDE || p.startsWith(ASIDE + '/');
      try {
        const srv = (await this.call('GET', '/api/folders')) as Tree, lists: Record<string, string> = {};
        for (const [id, l] of Object.entries(this.data.lists)) { const d = l.off || l.lost ? null : h.dir(id); if (d != null && inside(d) && !aside(up(d))) lists[id] = up(d); }
        const dirs = h.dirs(root).filter(inside).map(up).filter(d => d && !aside(d));
        const absent = Object.entries(this.data.lists).filter(([id, l]) => !l.off && !l.lost && h.dir(id) == null).map(([id]) => id);
        const disk = held ?? { dirs, lists, absent, strict: !root };
        let { tree, notes, wanted } = mergeFolders(this.data.tree ?? null, srv, disk, uid);
        notes.forEach(n => h.notice(n));
        if (!held && wanted >= 2 && wanted * 2 > (this.data.tree?.folders.length ?? 0)) { // nothing is removed in dodo: the vault follows dodo, and the user is asked
          tree = srv;
          if (!this.heldFolders) h.notice(`dodo: ${wanted} av ${this.data.tree!.folders.length} mappar skulle tas bort i dodo, så ingen mapp är borttagen. Mapparna läggs tillbaka i valvet. Är det meningen att de ska bort?`, { label: 'Ta bort ändå', run: () => void this.releaseFolders(true) }, { label: 'Hämta från dodo', run: () => void this.releaseFolders(false) });
          this.heldFolders = disk;
        }
        const T = JSON.stringify(tree) === JSON.stringify(srv) ? srv : (await this.call('PUT', '/api/folders', tree)) as Tree;
        const was = pathsOf(this.data.tree ?? T), now = pathsOf(T), have = new Set(dirs.map(d => d.toLowerCase())), want = (id: string) => (T.lists[id] ? now.get(T.lists[id]) ?? '' : '');
        for (const p of now.values()) if (!have.has(p.toLowerCase())) await h.mkdir(down(p));
        for (const id of Object.keys(lists)) if (lists[id].toLowerCase() !== want(id).toLowerCase()) await h.move(id, down(want(id)));
        const kept = new Set([...now.values()].map(p => p.toLowerCase()));
        for (const p of [...was.values()].filter(p => !kept.has(p.toLowerCase())).sort((a, b) => b.split('/').length - a.split('/').length)) await h.prune(down(p)); // a folder gone from dodo, once emptied
        this.data.tree = T; await this.d.save();
        this.errs.delete('folders');
      } catch (e: any) {
        if (e.status === 401) await this.fail('folders', null, null, e); else if (!e.offline && e.status !== 404) this.errs.set('folders', e.message || String(e)); // 404: a server without folders
      }
      this.update();
    });
  }
  flush(id: string) { return this.cycle(id, true).then(() => this.flushNews()); }

  private cycle(id: string, now: boolean) { return this.locked(id, () => this.run(id, now)); }
  private locked(id: string, f: () => Promise<void>): Promise<void> {
    const p = (this.locks.get(id) ?? Promise.resolve()).then(f).catch(() => {}); // a failure never blocks the next one in line
    this.locks.set(id, p);
    return p;
  }
  // the user's answer to a held mass deletion: send the note after all, or put back what dodo has (the edit is lost)
  async release(id: string, send: boolean) {
    if (!this.held.delete(id)) return;
    if (send) this.allow.add(id);
    else await this.locked(id, async () => {
      const ld = this.data.lists[id], note = this.d.host.note(id), file = await note?.read();
      if (ld && note && file != null) await note.replace(file, toFile(split(file).head, ld.text)); // the last synced text: the pull then brings dodo's newest
    });
    await this.flush(id);
  }
  private async run(id: string, now: boolean) {
    const ld = this.data.lists[id], note = ld && this.d.host.note(id);
    if (!ld || ld.off || ld.lost || this.authLost || !note) return;
    this.busy++; this.update();
    try {
      const { text } = split(await note.read());
      if (text === ld.text) { this.held.delete(id); await this.pull(id, ld, note); }
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
    await this.loadSays(id, S);
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
    const gone = todos.filter(i => !kept.has(i.id)).length, ok = this.allow.delete(id);
    // nothing of the note is sent, not even its other edits: they are part of the same reading (the swallowed todos became one todo's note)
    if (massDelete(gone, todos.length) && !ok) {
      const why = `»${ld.name}«: ${gone} av ${todos.length} uppgifter skulle tas bort i dodo, så inget av anteckningen är skickat. Kör »dodo: Spara borttagningen ändå« om det är meningen, eller »dodo: Hämta listan från dodo igen«.`;
      if (!this.held.has(id)) this.d.host.notice('dodo: ' + why, { label: 'Ta bort ändå', run: () => void this.release(id, true) }, { label: 'Hämta från dodo', run: () => void this.release(id, false) });
      this.held.set(id, why);
      throw new Fail(why); // the status bar shows it until it is answered; once told, the next polls say nothing
    }
    this.held.delete(id);

    const byId = (i: string) => S.todos.find(t => t.id === i);
    const baseJ = new Map(S.todos.map(t => [t.id, JSON.stringify(t)])), baseH = JSON.stringify(S.headings);
    const setDone = (t: any, v: boolean) => { t.done = v; t.doneBy = v ? S.me : null; t.doneAt = v ? Date.now() : null; };
    const fresh = (p: any) => {
      if (p.subs && p.subs.length && p.subs.every((s: any) => s.done)) p.done = true;
      return { id: uid(), notes: '', subs: [], due: null, prio: 0, ...p, doneBy: p.done ? S.me : null, doneAt: p.done ? Date.now() : null };
    };
    const applyBlock = (t: any, p: any, h: string | null, base: string) => {
      Object.assign(t, { text: p.text, tags: p.tags, who: p.who, due: p.due, prio: p.prio, notes: mendSource(p.notes, t.notes), subs: p.subs, h, base });
      // the time of day follows the date: a note without it clears it (the parser leaves the keys out)
      if (p.dueEnd) t.dueEnd = p.dueEnd; else delete t.dueEnd; // a period's last day follows the same way
      if (p.time) { t.time = p.time; if (p.until) t.until = p.until; else delete t.until; } else { delete t.time; delete t.until; }
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
    await this.loadSays(id, S2);
    await this.d.save();
    this.onSnap(id);
  }

  // ---- copy a todo to another list (#14) ----
  // the lists a todo can be copied to: the ones I am a member in (and so can write in), except the one it is in
  async copyTargets(id: string) { return (await this.lists()).filter(l => l.id !== id); }
  // the todo on `line` (0-based, in the whole file) of the note becomes a new, separate todo in list `to`, under a heading of the same title if it has one
  async copyTodo(id: string, line: number, to: string): Promise<{ list: string; id: string; name: string }> {
    const ld = this.data.lists[id], note = this.d.host.note(id);
    if (!ld || ld.off || ld.lost || !note) throw new Error('Anteckningen hålls inte i takt med någon dodo-lista.');
    if (to === id) throw new Error('Välj en annan lista än den uppgiften redan ligger i.');
    let file = await note.read();
    if (split(file).text !== ld.text) { // unsent edits go first, so the line is a todo dodo knows
      const was = file.split('\n')[line];
      await this.flush(id);
      file = await note.read();
      if (split(file).text !== ld.text) throw new Error('Anteckningen har ändringar som inte har kunnat skickas än. Vänta in synken och försök igen.');
      if (file.split('\n')[line] !== was) throw new Error('Anteckningen ändrades medan den skickades. Försök igen.');
    }
    const at = this.todoAt(id, file, line);
    if (!at) throw new Error('Markören står inte på en uppgift.');
    if (at.kind === 'heading') throw new Error('Det är en rubrik. Ställ markören på en uppgift.');
    if (at.kind === 'block') throw new Error('Det är ett textstycke, inte en uppgift. Ställ markören på en uppgift.');
    if (!at.id) throw new Error('Uppgiften är inte skickad till dodo än. Vänta in synken och försök igen.');
    const t = ld.snap.todos.find(x => x.id === at.id);
    if (!t) throw new Error('Uppgiften finns inte i dodo längre.');
    let T: any;
    try { T = await this.call('GET', `/api/l/${encodeURIComponent(to)}/state`); } catch (e: any) { throw e.status === 403 || e.status === 404 ? new Error('Du är inte med i den listan, så du kan inte skriva i den.') : e; }
    const src = ld.snap.headings.find(x => x.id === t.h), h = (src && T.headings.find((x: any) => String(x.title).trim() === String(src.title).trim())?.id) ?? null;
    const r = await this.call('POST', `/api/l/${id}/todos/${at.id}/copy`, h ? { to, h } : { to });
    const name = String(T.list?.name ?? to), text = t.text.length > 60 ? t.text.slice(0, 59) + '…' : t.text;
    this.d.host.notice(`dodo: kopierade »${text}« till »${name}«.`);
    if (this.data.lists[to] && !this.data.lists[to].off) void this.flush(to); // its note is filled in now, not at the next sync
    return { list: r.list, id: r.id, name };
  }

  // ---- comments ----
  onSnap: (listId: string) => void = () => {};
  private told: string[] = [];
  // an API key (a script, the course source) writes as key:<id>, named like the web page does
  name(S: Snap, user: string) {
    if (user?.startsWith('key:')) return `${S.keys?.find(k => 'key:' + k.id === user)?.name ?? '?'} (nyckel)`;
    if (user?.startsWith('guest:')) return `${user.slice(6)} (publik länk)`; // a visitor of a public link, who only gave a name
    if (user === 'mail') return 'Mejl';
    return user?.[0] === '@' ? user.slice(1) : S.users.find(u => u.id === user)?.name ?? 'okänd';
  }
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

  // ---- sharing (#15): public links, people and lists I am in ----
  // what a link allows, in words. SHOWS are the fields a visitor sees
  static SHOWS: [string, string][] = [['due', 'datum'], ['prio', 'prioritet'], ['tags', 'taggar'], ['who', 'vem'], ['notes', 'anteckning'], ['done', 'klara'], ['comments', 'kommentarer']];
  static says(o: any): string {
    const show = Dodo.SHOWS.filter(([k]) => o?.show?.[k]).map(([, l]) => l), may = [o?.check && 'bocka av', o?.add && 'lägga till', o?.comment && 'kommentera', o?.notes && 'skriva i anteckningen'].filter(Boolean);
    return `visar ${show.length ? show.join(', ') : 'bara texten'}${may.length ? '; får ' + may.join(', ') : '; kan inte ändra något'}`;
  }
  private says: Record<string, Record<string, string>> = {}; // list id -> link id -> what it allows (read off GET /shares, whose addresses are never kept)
  private sig: Record<string, string> = {};
  // the links change when the ids in the state change; what they allow is read again then
  private async loadSays(id: string, S: Snap, force = false) {
    const ids = (S.shares || []).map(s => s.id).sort().join();
    if (!force && this.sig[id] === ids) return;
    this.sig[id] = ids;
    if (!ids) { delete this.says[id]; return; }
    try { this.says[id] = Object.fromEntries((await this.call('GET', `/api/l/${id}/shares`)).map((s: any) => [s.id, Dodo.says(s.opts)])); } catch { delete this.sig[id]; } // tried again next time
  }
  // the todo lines with an active public link: where a marker goes
  shareLines(id: string, file: string): { line: number; id: string; n: number; says: string }[] {
    const p = this.plan(id, file), links = p?.ld.snap.shares || [];
    if (!p || !links.length) return [];
    const out: { line: number; id: string; n: number; says: string }[] = [];
    p.plan.forEach((it, i) => {
      if (it.level || it.block || !it.id) return;
      const mine = links.filter(s => s.todo === it.id);
      if (mine.length) out.push({ line: p.starts[i] + p.off, id: it.id, n: mine.length, says: mine.map(s => this.says[id]?.[s.id]).filter(Boolean).join(' · ') });
    });
    return out;
  }
  // everything I share and every list I am in. No address of a link is in it. `can*` says what the server will allow this user
  async shared(): Promise<{ mine: SharedMine[]; member: SharedIn[] }> {
    const d = await this.call('GET', '/api/shared');
    return {
      mine: d.mine.map((l: any) => ({ id: l.id, name: l.name, people: l.people as { id: string; name: string; role: string }[],
        links: l.links.map((x: any) => ({ id: x.id, todo: x.todo as string | null, text: x.text as string | null, expires: x.expires as string | null, opts: x.opts, says: Dodo.says(x.opts), views: x.views, names: x.names })) })),
      member: d.member.map((l: any) => ({ id: l.id, name: l.name, role: l.role as string, by: l.by as string[], note: this.noted(l.id),
        // a list keeps an admin: the only admin cannot leave (the server says so too)
        canLeave: l.role !== 'admin' || d.mine.find((m: any) => m.id === l.id)?.people.some((x: any) => x.role === 'admin') === true })),
    };
  }
  // the list has a note here that is kept in step, and so would go aside if the list were left
  noted(id: string) { const ld = this.data.lists[id]; return !!ld && !ld.off && !ld.lost && !!this.d.host.note(id); }
  asideFolder() { return this.asideDir(); }
  async removePerson(list: string, user: string) {
    await this.call('POST', `/api/l/${list}/members/${encodeURIComponent(user)}`, { action: 'remove' });
  }
  async stopLink(list: string, link: string) {
    await this.call('DELETE', `/api/l/${list}/shares/${encodeURIComponent(link)}`, {});
    delete this.sig[list]; // the next snapshot reads the links again
    if (this.data.lists[list]) await this.flush(list);
  }
  // `change` is laid over what the link allows now (the server wants all of it); what cannot go together (commenting without seeing comments) the server drops
  async changeLink(list: string, link: string, change: { show?: Record<string, boolean>; check?: boolean; add?: boolean; comment?: boolean; notes?: boolean; notesMode?: 'append' | 'replace' }) {
    const cur = (await this.call('GET', `/api/l/${list}/shares`)).find((s: any) => s.id === link)?.opts;
    if (!cur) throw new Error('Länken finns inte längre.');
    const o = { ...cur, ...change, show: { ...cur.show, ...change.show } };
    await this.call('PUT', `/api/l/${list}/shares/${encodeURIComponent(link)}`, { show: o.show, check: !!o.check, add: !!o.add, comment: !!o.comment, notes: !!o.notes, notesMode: o.notesMode === 'replace' ? 'replace' : 'append' });
    const S = this.data.lists[list]?.snap;
    if (S) { await this.loadSays(list, S, true); this.onSnap(list); }
  }
  // leaving a list: what is unsent is sent first, then the note goes aside like for any list that is gone
  async leave(list: string) {
    const ld = this.data.lists[list], kept = this.noted(list);
    if (kept) await this.flush(list);
    await this.call('POST', `/api/l/${list}/leave`, {});
    const note = ld && kept ? this.d.host.note(list) : null;
    if (ld && note) await this.locked(list, async () => { if (!ld.lost) await this.lose(list, ld, note, `dodo: du har lämnat »${ld.name}«. Anteckningen ligger nu i ${this.asideDir()}, med en rad överst om det. Texten finns kvar.`); });
  }

  // ---- errors and status ----
  private async fail(id: string, ld: ListData | null, note: Note | null, e: Fail) {
    if (e.status === 401) {
      this.authLost = true;
      this.errs.set(id, 'Sessionen har stängts av. Logga in igen.');
      this.d.host.notice('dodo: du är utloggad. Det du skriver sparas i anteckningen och skickas efter inloggningen.', ...this.d.openSettings ? [{ label: 'Logga in igen', run: this.d.openSettings }] : []);
    } else if (e.lost && ld && note) {
      this.errs.delete(id);
      await this.lose(id, ld, note, `dodo: »${ld.name}« finns inte längre i dodo. Anteckningen ligger nu i ${ASIDE}, med en rad överst om det.`);
    } else this.errs.set(id, e.message || String(e));
  }
  // the list is gone for this user (deleted, taken out of, or left): the note gets a line at the top and goes aside, never deleted
  private async lose(id: string, ld: ListData, note: Note, told: string) {
    ld.lost = true;
    const file = await note.read().catch(() => '');
    if (file && !file.includes(LOST_TITLE)) { const { head } = split(file); await note.replace(file, head + lostNote(ld.name, new Date().toISOString().slice(0, 10)) + '\n\n' + file.slice(head.length)); }
    await this.d.host.move(id, this.asideDir()).catch(() => {});
    this.d.host.notice(told);
    this.onLists();
    await this.d.save();
  }
  private asideDir() { const dir = this.data.folder.replace(/^\/+|\/+$/g, ''); return `${dir ? dir + '/' : ''}${ASIDE}`; }
  private update() {
    this.lastError = [...this.errs.values()][0] ?? '';
    this.status = this.busy ? 'busy' : this.errs.size ? 'err' : 'ok';
    this.onStatus();
  }
}
