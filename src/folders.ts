// Mapparna (#19): dodos mappträd (GET/PUT /api/folders) som sökvägar i valvet, och sammanslagningen av dodos träd, trädet från förra synken och disken.
// Ren kod utan Obsidian. Sökvägarna är relativa till dodo-mappen, med / emellan och utan / först och sist; '' är dodo-mappen själv.
export interface Folder { id: string; name: string; parent: string | null }
export interface Tree { folders: Folder[]; lists: Record<string, string> } // lists: list id -> folder id
// dirs: alla mappar i valvet; lists: mappen för varje anteckning; absent: listor som är på men saknar anteckning (valvet är då kanske inte färdigsynkat);
// strict: hela valvet är dodo-mappen, så en mapp utan dodo-anteckning är inte dodos och skickas aldrig
export interface Disk { dirs: string[]; lists: Record<string, string>; absent?: string[]; strict?: boolean }

export const MAX_DEPTH = 5; // dodos gräns
// tecken som inte går i filnamn blir mellanrum; högst 60 tecken, som dodo tillåter
export const dirName = (s: string) => { const n = s.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60).trim(); return /^\.*$/.test(n) ? 'mapp' : n; };
const lc = (s: string) => s.toLowerCase();

// mapp-id -> sökväg. Två syskon med samma namn (dodo tillåter det) får ` (2)`, ` (3)` i den ordning de ligger i trädet.
export function pathsOf(t: Tree): Map<string, string> {
  const out = new Map<string, string>(), ids = new Set(t.folders.map(f => f.id));
  const walk = (parent: string | null, dir: string, depth: number) => {
    const used = new Set<string>();
    for (const f of t.folders.filter(f => (f.parent && ids.has(f.parent) ? f.parent : null) === parent)) {
      const n = dirName(f.name); let name = n, k = 1;
      while (used.has(lc(name))) name = `${n} (${++k})`;
      used.add(lc(name));
      out.set(f.id, dir ? dir + '/' + name : name);
      if (depth < MAX_DEPTH) walk(f.id, out.get(f.id)!, depth + 1);
    }
  };
  walk(null, '', 1);
  return out;
}

// Det som ändrats på disken sedan förra synken (`base`) läggs på dodos senaste träd (`srv`), så att en ändring på webben inte skrivs över.
// Ändrade dodo och disken samma sak åt olika håll vinner dodo (och disken följer efter, se Dodo.folders). Utan `base` (första gången) räknas inget som lokalt ändrat.
export function mergeFolders(base: Tree | null, srv: Tree, disk: Disk, newId: () => string): { tree: Tree; notes: string[]; wanted: number } {
  const T: Tree = { folders: srv.folders.map(f => ({ ...f })), lists: { ...srv.lists } }, notes: string[] = [];
  let wanted = 0; // hur många mappar disken vill ta bort ur dodo (även de som skyddas nedan)
  if (!base) return { tree: T, notes, wanted };
  const bp = pathsOf(base), cut = (p: string) => p.split('/').slice(0, MAX_DEPTH).join('/');
  // djupare än fem nivåer skapas aldrig i dodo: det som ligger djupare räknas som ligger på femte nivån
  if (Object.values(disk.lists).some(d => d.split('/').length > MAX_DEPTH)) notes.push(`dodo: mappar får ligga högst ${MAX_DEPTH} nivåer djupt, så anteckningar djupare än så läggs på nivån ovanför.`);
  const dirs = new Map<string, string>(); // gemener -> sökvägen som den heter
  for (const d of disk.dirs.map(cut)) for (let p = d, i = 0; p; p = i < 0 ? '' : p.slice(0, i)) { dirs.set(lc(p), p); i = p.lastIndexOf('/'); }
  const listAt = (l: string) => cut(disk.lists[l]);

  // var ligger varje mapp från förra synken nu? Finns sökvägen kvar är det samma mapp; annars en omdöpt/flyttad om dess anteckningar ligger i en ny mapp tillsammans
  const local = new Map<string, string>(), taken = new Set<string>(), old = new Set([...bp.values()].map(lc));
  for (const [f, p] of bp) if (dirs.has(lc(p))) local.set(f, dirs.get(lc(p))!);
  for (const [f, p] of bp) {
    if (local.has(f)) continue;
    const votes = new Map<string, number>();
    for (const [l, fo] of Object.entries(base.lists)) {
      const bd = bp.get(fo);
      if (bd === undefined || disk.lists[l] === undefined || !(lc(bd) === lc(p) || lc(bd).startsWith(lc(p) + '/'))) continue;
      const rest = bd.slice(p.length), d = listAt(l);
      if (!lc(d).endsWith(lc(rest))) continue;
      const q = d.slice(0, d.length - rest.length);
      if (q && dirs.has(lc(q)) && !old.has(lc(q)) && !taken.has(lc(q))) votes.set(q, (votes.get(q) || 0) + 1);
    }
    const q = [...votes].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (q) { local.set(f, q); taken.add(lc(q)); }
  }

  const sf = new Map(srv.folders.map(f => [f.id, f])), bf = new Map(base.folders.map(f => [f.id, f])), tf = new Map(T.folders.map(f => [f.id, f]));
  const same = (id: string) => { const a = sf.get(id), b = bf.get(id); return !!a && !!b && a.name === b.name && a.parent === b.parent; }; // dodo har inte ändrat den
  const idAt = new Map([...local].map(([f, p]) => [lc(p), f]));
  const parentOf = (p: string) => { const i = p.lastIndexOf('/'), id = i < 0 ? null : idAt.get(lc(p.slice(0, i))) ?? null; return id && tf.has(id) ? id : null; };

  // borttagen mapp: innehållet flyttas en nivå upp, aldrig bort
  for (const f of bp.keys()) {
    if (local.has(f) || !same(f)) continue;
    wanted++;
    // en lista i mappen (eller under den) som är på men saknar anteckning: valvet är ofullständigt, mappen är inte borttagen
    if ((disk.absent || []).some(l => { for (let x = base.lists[l] as string | undefined; x !== undefined; x = bf.get(x)?.parent ?? undefined) if (x === f) return true; return false; })) continue;
    const up = tf.get(f)!.parent;
    for (const x of T.folders) if (x.parent === f) x.parent = up;
    for (const [l, d] of Object.entries(T.lists)) if (d === f) { if (up) T.lists[l] = up; else delete T.lists[l]; }
    tf.delete(f); T.folders = T.folders.filter(x => x.id !== f);
  }
  // omdöpt eller flyttad mapp
  for (const [f, p] of local) {
    if (lc(p) === lc(bp.get(f)!) || !same(f)) continue;
    Object.assign(tf.get(f)!, { name: p.split('/').pop()!.slice(0, 60), parent: parentOf(p) });
  }
  // ny mapp, de grunda först så att föräldern finns
  for (const [k, p] of [...dirs].filter(([k]) => !idAt.has(k) && (!disk.strict || Object.keys(disk.lists).some(l => lc(listAt(l)) === k || lc(listAt(l)).startsWith(k + '/')))).sort((a, b) => a[1].split('/').length - b[1].split('/').length)) {
    const x = { id: newId(), name: p.split('/').pop()!.slice(0, 60), parent: parentOf(p) };
    T.folders.push(x); tf.set(x.id, x); idAt.set(k, x.id);
  }
  // en anteckning som flyttats: bara om dodo inte flyttat samma lista, och jämfört med där dess mapp ligger nu (en omdöpt mapp flyttar inte sina listor)
  const upFrom = (id: string | undefined) => { while (id !== undefined && !local.has(id)) id = bf.get(id)?.parent ?? undefined; return id === undefined ? '' : local.get(id)!; };
  for (const l of Object.keys(disk.lists)) {
    const d = listAt(l);
    if ((srv.lists[l] ?? null) !== (base.lists[l] ?? null) || lc(d) === lc(upFrom(base.lists[l]))) continue;
    const to = d ? idAt.get(lc(d)) : null;
    if (to === undefined || (to && !tf.has(to))) continue;
    if (to) T.lists[l] = to; else delete T.lists[l];
  }
  return { tree: T, notes, wanted };
}
