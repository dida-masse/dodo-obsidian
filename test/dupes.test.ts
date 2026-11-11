import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tieOf } from '../src/sync.js';
import { Server, login, rig, writes, type Rig } from './helpers.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
let srv: Server, ses: { boss: string; anna: string }, n = 0;
before(async () => {
  srv = await Server.create();
  srv.cli('user', 'add', 'boss@example.com', 'Boss', '--admin');
  srv.cli('user', 'add', 'anna@example.com', 'Anna');
  await srv.start();
  ses = { boss: await login(srv, 'boss@example.com'), anna: await login(srv, 'anna@example.com') };
});
after(async () => { await srv.stop(); srv.clean(); });

// a list that is on and synced, with one todo; its note is dodo/Lista N.md
const mk = async (): Promise<Rig> => {
  const r = await rig(srv, `Lista ${++n}`, ses);
  await r.todo(r.id('t'), 'mjölk');
  await r.dodo.enable(r.list);
  return r;
};
const tied = (r: Rig) => [...r.vault.files].filter(([, t]) => tieOf(t) === r.list).map(([p]) => p).sort();
const mem = (r: Rig) => r.dodo.data.lists[r.list].text;

test('a note that exists but is not in the cache yet is found by enable: no second note is made', async () => {
  const r = await rig(srv, `Lista ${++n}`, ses);
  await r.todo(r.id('t'), 'mjölk');
  r.vault.files.set('dodo/Annan.md', `---\ndodo: ${srv.url}/l/${r.list}\n---\n- [ ] gammal\n`);
  r.vault.hidden.add('dodo/Annan.md');
  await r.dodo.enable(r.list);
  assert.deepEqual([...r.vault.files.keys()], ['dodo/Annan.md']);
  assert.match(r.vault.files.get('dodo/Annan.md')!, /mjölk/); // dodo's text wins, as before
});

test('a second identical note appears later: it is trashed, one note remains, nothing is sent', async () => {
  const r = await mk(), kept = tied(r)[0], before = writes(r.log).length;
  r.vault.files.set(`dodo/Lista ${n} 2.md`, r.vault.files.get(kept)!);
  await r.dodo.dedupe(r.list);
  assert.deepEqual(tied(r), [kept]);
  assert.deepEqual(r.vault.trashed, [`dodo/Lista ${n} 2.md`]);
  await r.dodo.flush(r.list);
  assert.equal(writes(r.log).length, before);
  assert.equal(r.vault.notices.length, 0);
});

test('a copy that equals the last synced text is trashed even when the kept note has an unsent edit, and the edit is sent as usual', async () => {
  const r = await mk(), kept = tied(r)[0], old = r.vault.files.get(kept)!;
  r.vault.files.set(kept, old + '- [ ] ägg\n'); r.vault.typedIn.add(kept); // typed in this session: its edits are real and being made now
  r.vault.files.set(`dodo/Lista ${n} 2.md`, old);
  await r.dodo.dedupe(r.list);
  assert.deepEqual(tied(r), [kept]);
  await r.dodo.flush(r.list);
  assert.ok((await r.anna('GET', '/state')).todos.some((t: any) => t.text === 'ägg'));
});

test('a second note with other text: both texts stay on disk, one is the list\'s note, the other is set aside with a notice, and it is not adopted later', async () => {
  const r = await mk(), kept = tied(r)[0];
  const mine = `---\ndodo: ${srv.url}/l/${r.list}\n---\n- [ ] mjölk\n- [ ] något jag skrev på telefonen\n`;
  r.vault.files.set(`dodo/Lista ${n} 2.md`, mine);
  await r.dodo.dedupe(r.list);
  assert.deepEqual(tied(r), [kept]);
  const aside = [...r.vault.files].find(([p]) => p.startsWith('dodo/Borttagna/'))!;
  assert.ok(aside, 'set aside in Borttagna');
  assert.match(aside[1], /något jag skrev på telefonen/);
  assert.match(aside[1], /andra kopia/);
  assert.ok(!aside[1].includes(`dodo: ${srv.url}`));
  assert.equal(r.vault.notices.length, 1);
  assert.ok(r.vault.notices[0].text.includes(kept) && r.vault.notices[0].text.includes(`Lista ${n} 2.md`));
  await r.dodo.tick(); await r.dodo.dedupeAll(); // a later start and sync: still one, and the aside one is not picked up
  assert.deepEqual(tied(r), [kept]);
  assert.equal(r.vault.notices.length, 1);
  assert.ok(!(await r.anna('GET', '/state')).todos.some((t: any) => /telefonen/.test(t.text)));
});

test('the same note is kept whichever of two a device saw first', async () => {
  const r = await mk(), a = `dodo/Lista ${n}.md`, b = `dodo/Lista ${n} 2.md`, c = `dodo/Annat/Lista ${n}.md`;
  for (const order of [[a, b], [b, a]]) assert.deepEqual(r.dodo.keepOrder(r.list, order), [a, b]);
  assert.deepEqual(r.dodo.keepOrder(r.list, ['dodo/Z.md', 'dodo/A.md']), ['dodo/A.md', 'dodo/Z.md']);
  assert.deepEqual(r.dodo.keepOrder(r.list, [c, b]), [b, c]); // no folder in the tree: the folder `dodo` is where it belongs
  // and the files themselves: two vaults that got the files in different orders end with the same one
  const text = r.vault.files.get(a)!, end = async (names: string[]) => { const v = await mk(); v.vault.files.clear(); for (const p of names) v.vault.files.set(p.replace(/Lista \d+/, `Lista ${v.list}`), text.replace(r.list, v.list)); await v.dodo.dedupe(v.list); return tied(v).map(p => p.replace(v.list, 'X')); };
  assert.deepEqual(await end([a, b]), await end([b, a]));
});

test('a duplicate in another folder than the folder tree says (a note another device moved) is the one that goes', async () => {
  const r = await mk(), tree = { folders: [{ id: 'k1', name: 'Kurser', parent: null }], lists: { [r.list]: 'k1' } };
  r.dodo.data.tree = tree as any;
  const right = `dodo/Kurser/Lista ${n}.md`, old = `dodo/Lista ${n}.md`;
  r.vault.files.set(right, r.vault.files.get(old)!); // delivered by the sync, where the tree says
  await r.dodo.dedupe(r.list);
  assert.deepEqual(tied(r), [right]);
  assert.deepEqual(r.vault.trashed, [old]);
});

test('running the check twice changes nothing more', async () => {
  const r = await mk(), kept = tied(r)[0];
  r.vault.files.set(`dodo/Lista ${n} 2.md`, r.vault.files.get(kept)!);
  r.vault.files.set(`dodo/Lista ${n} 3.md`, r.vault.files.get(kept)! + '- [ ] egen\n');
  await r.dodo.dedupe(r.list);
  const snap = JSON.stringify([...r.vault.files]), notes = r.vault.notices.length, trashed = r.vault.trashed.length;
  await r.dodo.dedupe(r.list); await r.dodo.dedupeAll();
  assert.equal(JSON.stringify([...r.vault.files]), snap);
  assert.equal(r.vault.notices.length, notes);
  assert.equal(r.vault.trashed.length, trashed);
});

// a note synced here, renamed to "Stale 2" by a move; the file sync then brings an OLD copy at the plain name, which wins the rule
const stale = async () => {
  const r = await rig(srv, `Lista ${++n}`, ses);
  for (const t of ['ett', 'tre']) await r.todo(r.id(t), t);
  await r.dodo.enable(r.list);
  const from = tied(r)[0], old = r.vault.files.get(from)!;
  for (const t of ['fyra', 'fem']) await r.todo(r.id(t), t);
  await r.dodo.flush(r.list);
  const cur = r.vault.files.get(from)!, plain = from, moved = from.replace('.md', ' 2.md');
  r.vault.files.delete(from); r.vault.files.set(moved, cur); r.vault.pins.set(r.list, moved);
  await r.dodo.flush(r.list);
  r.vault.files.set(plain, old);
  const todos = async () => (await r.anna('GET', '/state')).todos.map((t: any) => t.text).sort();
  return { r, old, cur, plain, moved, todos };
};

test('a stale copy that wins the rule does not become the note: the note this device syncs gives its text, dodo keeps every todo, nothing is sent', async () => {
  const { r, cur, plain, todos } = await stale(), was = await todos(), sent = writes(r.log).length;
  assert.equal(was.length, 4);
  await r.dodo.dedupe(r.list); await r.dodo.flush(r.list);
  assert.deepEqual(tied(r), [plain]);
  assert.equal(r.vault.files.get(plain), cur);
  assert.deepEqual(await todos(), was);
  assert.equal(writes(r.log).length, sent);
  assert.equal(r.vault.notices.length, 0);
  const files = JSON.stringify([...r.vault.files]); // and again: nothing more
  await r.dodo.dedupe(r.list); await r.dodo.dedupeAll(); await r.dodo.flush(r.list);
  assert.equal(JSON.stringify([...r.vault.files]), files);
  assert.deepEqual(await todos(), was);
});

test('the same, when the note this device syncs has an unsent edit: the edit is sent and nothing else changes', async () => {
  const { r, plain, moved, todos } = await stale();
  r.vault.files.set(moved, r.vault.files.get(moved)! + '- [ ] sex\n');
  await r.dodo.dedupe(r.list); await r.dodo.flush(r.list);
  assert.deepEqual(tied(r), [plain]);
  assert.deepEqual(await todos(), ['ett', 'fem', 'fyra', 'sex', 'tre']);
});

test('the same, when the stale copy has a line of its own: it goes to Borttagna with the notice and does not reach dodo', async () => {
  const { r, old, plain, cur, todos } = await stale(), was = await todos();
  r.vault.files.set(plain, old + 'en rad som bara finns här\n');
  await r.dodo.dedupe(r.list); await r.dodo.flush(r.list);
  assert.deepEqual(tied(r), [plain]);
  assert.equal(r.vault.files.get(plain), cur);
  const aside = [...r.vault.files].filter(([p]) => p.startsWith('dodo/Borttagna/'));
  assert.equal(aside.length, 1);
  assert.match(aside[0][1], /en rad som bara finns här/);
  assert.equal(r.vault.notices.length, 1);
  assert.deepEqual(await todos(), was);
  await r.dodo.dedupe(r.list); await r.dodo.flush(r.list);
  assert.equal(r.vault.notices.length, 1);
  assert.equal([...r.vault.files].filter(([p]) => p.startsWith('dodo/Borttagna/')).length, 1);
});

// a fresh start (nothing pinned, nothing typed) with two files delivered while Obsidian was closed: `old` and the current text
const start = async (order: 'old first' | 'cur first', extra = '') => {
  const r = await rig(srv, `Lista ${++n}`, ses);
  for (const t of ['ett', 'tva', 'tre']) await r.todo(r.id(t), t);
  await r.dodo.enable(r.list);
  const old = r.vault.files.get(tied(r)[0])!;
  for (const t of ['fyra', 'fem']) await r.todo(r.id(t), t);
  await r.dodo.flush(r.list);
  const cur = r.vault.files.get(tied(r)[0])!, a = `dodo/Lista ${n}.md`, b = `dodo/Lista ${n} 2.md`;
  r.vault.files.clear(); r.vault.pins.clear(); r.vault.typedIn.clear();
  const put = { old: () => r.vault.files.set(a, old), cur: () => r.vault.files.set(b, cur + extra) };
  if (order === 'old first') { put.old(); put.cur(); } else { put.cur(); put.old(); }
  const todos = async () => (await r.anna('GET', '/state')).todos.map((t: any) => t.text).sort();
  return { r, old, cur, a, b, todos };
};

for (const order of ['old first', 'cur first'] as const) test(`at start, a stale copy that wins the rule does not reach dodo (${order}), and a second run changes nothing`, async () => {
  const { r, cur, a, todos } = await start(order), was = await todos(), sent = writes(r.log).length;
  assert.equal(was.length, 5);
  await r.dodo.dedupeAll(); await r.dodo.flush(r.list);
  assert.deepEqual(tied(r), [a]);
  assert.equal(r.vault.files.get(a), cur);
  assert.deepEqual(await todos(), was);
  assert.equal(writes(r.log).length, sent);
  const files = JSON.stringify([...r.vault.files]), notes = r.vault.notices.length;
  await r.dodo.dedupeAll(); await r.dodo.dedupe(r.list); await r.dodo.flush(r.list);
  assert.equal(JSON.stringify([...r.vault.files]), files);
  assert.equal(r.vault.notices.length, notes);
  assert.deepEqual(await todos(), was);
});

for (const order of ['old first', 'cur first'] as const) test(`at start, a note with an unsent line next to a copy equal to the last synced text: dodo is unchanged, the line is set aside with a notice (${order})`, async () => {
  const { r, a, b, cur, todos } = await start(order), was = await todos();
  r.vault.files.set(a, cur + '- [ ] sex\n'); // the unsent line, in the file that wins the rule; b is the copy equal to the synced text
  await r.dodo.dedupeAll(); await r.dodo.flush(r.list);
  assert.deepEqual(tied(r), [a]);
  assert.equal(r.vault.files.get(a), cur);
  const aside = [...r.vault.files].filter(([p]) => p.startsWith('dodo/Borttagna/'));
  assert.equal(aside.length, 1);
  assert.match(aside[0][1], /sex/);
  assert.equal(r.vault.notices.length, 1);
  assert.deepEqual(await todos(), was);
  const files = JSON.stringify([...r.vault.files]);
  await r.dodo.dedupeAll(); await r.dodo.flush(r.list);
  assert.equal(JSON.stringify([...r.vault.files]), files);
});
