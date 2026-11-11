import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_DEPTH, pathsOf } from '../src/folders.js';
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

// boss's own tree, the way the web page reads and saves it
const api = async (m: string, p: string, b?: any) => (await fetch(srv.url + p, { method: m, headers: { authorization: 'Bearer ' + ses.boss, ...(b && { 'content-type': 'application/json' }) }, body: b && JSON.stringify(b) })).json() as Promise<any>;
const tree = () => api('GET', '/api/folders');
const put = (folders: any[], lists: Record<string, string> = {}) => api('PUT', '/api/folders', { folders, lists });
const F = (id: string, name: string, parent: string | null = null) => ({ id, name, parent });
const idOf = async (name: string) => (await tree()).folders.find((f: any) => f.name === name)?.id;
// a list that is on and synced once, in an empty tree; its note is dodo/<name>.md until the folders are
const mk = async (name = 'Lista'): Promise<Rig & { file: () => string }> => {
  await put([]);
  const r = await rig(srv, `${name} ${++n}`, ses);
  await r.dodo.enable(r.list); await r.dodo.folders();
  return Object.assign(r, { file: () => [...r.vault.files.keys()].find(k => r.vault.files.get(k)!.includes(r.list))! });
};
const folderWrites = (r: Rig) => writes(r.log).filter(l => l.path === '/api/folders');

test('a list in a folder in dodo lies in that folder as a file, and moves when it is moved in dodo; nothing is sent back', async () => {
  const r = await mk();
  await put([F('k1', 'Kurser'), F('k2', 'HT26', 'k1')], { [r.list]: 'k2' });
  await r.dodo.folders();
  assert.equal(r.file(), `dodo/Kurser/HT26/Lista ${n}.md`);
  await put([F('k1', 'Kurser'), F('k2', 'HT26', 'k1')], { [r.list]: 'k1' }); // moved one level up on the web
  await r.dodo.folders();
  assert.equal(r.file(), `dodo/Kurser/Lista ${n}.md`);
  await put([F('k1', 'Kurser'), F('k2', 'HT26', 'k1')], {});
  await r.dodo.folders();
  assert.equal(r.file(), `dodo/Lista ${n}.md`);
  assert.deepEqual(folderWrites(r), []); // our own moves are not a user's moves
  assert.deepEqual(r.vault.notices, []);
});

test('a note moved to another folder in Obsidian moves the list in dodo, in a new folder too, and a second sync sends nothing', async () => {
  const r = await mk();
  await r.vault.move(r.list, 'dodo/Skola/Termin 1');
  await r.dodo.folders();
  const t = await tree(), a = t.folders.find((f: any) => f.name === 'Skola'), b = t.folders.find((f: any) => f.name === 'Termin 1');
  assert.equal(b.parent, a.id);
  assert.equal(a.parent, null);
  assert.equal(t.lists[r.list], b.id);
  assert.equal(r.file(), `dodo/Skola/Termin 1/Lista ${n}.md`);
  assert.equal(folderWrites(r).length, 1);
  await r.dodo.folders();
  assert.equal(folderWrites(r).length, 1);
  await r.vault.move(r.list, 'dodo'); // and back to the top; Obsidian leaves the emptied folders
  r.vault.folders.add('dodo/Skola'); r.vault.folders.add('dodo/Skola/Termin 1');
  await r.dodo.folders();
  assert.equal((await tree()).lists[r.list], undefined);
  assert.equal((await tree()).folders.length, 2); // the folders stay, empty, until someone removes them
});

test('a folder made in Obsidian, empty, is made in dodo; one made in dodo is made in the vault', async () => {
  const r = await mk();
  r.vault.folders.add('dodo/Tom');
  await r.dodo.folders();
  assert.deepEqual((await tree()).folders.map((f: any) => f.name), ['Tom']);
  await put([F('x1', 'Tom'), F('x2', 'Från webben', 'x1')]);
  await r.dodo.folders();
  assert.ok(r.vault.dirs('dodo').includes('dodo/Tom/Från webben'));
});

test('a folder renamed in Obsidian (its notes move along) is renamed in dodo, same folder; renamed in dodo the notes move and the old folder goes', async () => {
  const r = await mk();
  await put([F('k1', 'Kurser')], { [r.list]: 'k1' });
  await r.dodo.folders();
  assert.equal(r.file(), `dodo/Kurser/Lista ${n}.md`);
  await r.vault.move(r.list, 'dodo/Skola'); r.vault.folders.delete('dodo/Kurser'); // Obsidian renames the folder: the note's path changes with it, the old folder is gone
  await r.dodo.folders();
  let t = await tree();
  assert.deepEqual(t.folders.map((f: any) => [f.id, f.name]), [['k1', 'Skola']]);
  assert.equal(t.lists[r.list], 'k1');
  await put([F('k1', 'Utbildning')], { [r.list]: 'k1' }); // and in dodo
  await r.dodo.folders();
  assert.equal(r.file(), `dodo/Utbildning/Lista ${n}.md`);
  assert.deepEqual(r.vault.dirs('dodo'), ['dodo/Utbildning']); // Skola is gone, emptied and removed
  t = await tree();
  assert.equal(t.folders[0].name, 'Utbildning');
});

test('a folder renamed in Obsidian with a folder inside it: both follow, ids kept', async () => {
  const r = await mk();
  await put([F('k1', 'Kurser'), F('k2', 'HT26', 'k1')], { [r.list]: 'k2' });
  await r.dodo.folders();
  await r.vault.move(r.list, 'dodo/Skola/HT26'); ['dodo/Kurser', 'dodo/Kurser/HT26'].forEach(d => r.vault.folders.delete(d));
  await r.dodo.folders();
  assert.deepEqual((await tree()).folders.map((f: any) => [f.id, f.name, f.parent]), [['k1', 'Skola', null], ['k2', 'HT26', 'k1']]);
});

test('a folder removed in Obsidian takes nothing with it: the list moves one level up in dodo; removed in dodo the note moves one level up', async () => {
  const r = await mk();
  await put([F('k1', 'Kurser'), F('k2', 'HT26', 'k1')], { [r.list]: 'k2' });
  await r.dodo.folders();
  await r.vault.move(r.list, 'dodo/Kurser'); // the note is taken out, the empty folder removed
  await r.vault.prune('dodo/Kurser/HT26');
  await r.dodo.folders();
  let t = await tree();
  assert.deepEqual(t.folders.map((f: any) => f.id), ['k1']);
  assert.equal(t.lists[r.list], 'k1');
  await put([F('k1', 'Kurser'), F('k2', 'HT26', 'k1')], { [r.list]: 'k2' }); // back, then removed on the web: the server drops the list from it
  await r.dodo.folders();
  assert.equal(r.file(), `dodo/Kurser/HT26/Lista ${n}.md`);
  await put([F('k1', 'Kurser')], { [r.list]: 'k1' });
  await r.dodo.folders();
  assert.equal(r.file(), `dodo/Kurser/Lista ${n}.md`);
  assert.deepEqual(r.vault.dirs('dodo'), ['dodo/Kurser']);
  await put([], {}); // the last folder too
  await r.dodo.folders();
  assert.equal(r.file(), `dodo/Lista ${n}.md`);
  assert.deepEqual(r.vault.dirs('dodo'), []);
  assert.equal(r.vault.files.size, 1);
});

test('a folder emptied and removed in Obsidian, with a sibling that has a list: the list stays; a list in a removed folder is moved up, not lost', async () => {
  const r = await mk();
  await put([F('k1', 'A'), F('k2', 'B', 'k1')], { [r.list]: 'k2' });
  await r.dodo.folders();
  await r.vault.move(r.list, 'dodo'); // both folders gone from the vault, the note at the top
  await r.vault.prune('dodo/A/B'); await r.vault.prune('dodo/A');
  await r.dodo.folders(); // both of two folders at once: asked first
  assert.equal((await tree()).folders.length, 2);
  await r.dodo.releaseFolders(true);
  const t = await tree();
  assert.deepEqual([t.folders, t.lists], [[], {}]);
});

test('two sibling folders with the same name in dodo get (2); characters that cannot be in file names are replaced', async () => {
  const r = await mk();
  const two = await rig(srv, `Andra ${++n}`, ses);
  await r.dodo.enable(two.list); // same Dodo: the second list is on in the first one's vault
  const other = srv.cli('list', 'create', `Tredje ${++n}`, '--owner', 'boss@example.com').id;
  await r.dodo.enable(other);
  await put([F('a', 'Samma'), F('b', 'Samma'), F('c', 'A/B: "C"? <D>|*\\')], { [r.list]: 'a', [other]: 'b' });
  await r.dodo.folders();
  assert.deepEqual([...r.vault.dirs('dodo')].sort(), ['dodo/A B C D', 'dodo/Samma', 'dodo/Samma (2)']);
  assert.ok(r.file().startsWith('dodo/Samma/'));
  assert.ok([...r.vault.files.keys()].some(k => k.startsWith('dodo/Samma (2)/') && r.vault.files.get(k)!.includes(other)));
  assert.deepEqual(folderWrites(r), []);
  await r.vault.move(r.list, 'dodo/Samma (2)'); // moving into the second one is moving into the second one, not a new folder
  await r.dodo.folders();
  assert.equal((await tree()).lists[r.list], 'b');
  assert.equal((await tree()).folders.length, 3);
  assert.deepEqual(pathsOf({ folders: [F('a', 'x'), F('b', 'X'), F('c', 'x')], lists: {} }), new Map([['a', 'x'], ['b', 'X (2)'], ['c', 'x (3)']]));
});

test('never deeper than five levels from the plugin: a notice, and the note lies on the fifth level; five from dodo is fine', async () => {
  const r = await mk();
  const deep = ['a', 'b', 'c', 'd', 'e'];
  await put(deep.map((x, i) => F(x, x.toUpperCase(), i ? deep[i - 1] : null)), { [r.list]: 'e' });
  await r.dodo.folders();
  assert.equal(r.file(), `dodo/A/B/C/D/E/Lista ${n}.md`);
  assert.equal(MAX_DEPTH, 5);
  await r.vault.move(r.list, 'dodo/A/B/C/D/E/F/G');
  await r.dodo.folders();
  const t = await tree();
  assert.equal(t.folders.length, 5);
  assert.equal(t.lists[r.list], 'e');
  assert.equal(r.file(), `dodo/A/B/C/D/E/Lista ${n}.md`);
  assert.match(r.vault.notices[0].text, /högst 5 nivåer/);
});

test('a change on the web between two syncs is kept when the plugin writes: the tree is fetched first and only the local change is laid on it', async () => {
  const r = await mk();
  await put([F('k1', 'Kurser')], { [r.list]: 'k1' });
  await r.dodo.folders();
  await r.vault.move(r.list, 'dodo/Lokal'); // here: the folder is made and the list moved
  await put([F('k1', 'Kurser'), F('w1', 'Webben'), F('w2', 'Under webben', 'w1')], { [r.list]: 'k1' }); // meanwhile on the web: two new folders
  r.vault.folders.add('dodo/Kurser'); // (the vault still has the old folder)
  await r.dodo.folders();
  const t = await tree();
  assert.deepEqual(t.folders.map((f: any) => f.name).sort(), ['Kurser', 'Lokal', 'Under webben', 'Webben']);
  assert.equal(t.lists[r.list], t.folders.find((f: any) => f.name === 'Lokal').id);
  assert.equal(t.folders.find((f: any) => f.name === 'Under webben').parent, 'w1');
});

test('the same list moved differently on both sides between two syncs: dodo wins and the file is moved', async () => {
  const r = await mk();
  await put([F('k1', 'X'), F('k2', 'Y')]);
  await r.dodo.folders();
  await put([F('k1', 'X'), F('k2', 'Y')], { [r.list]: 'k1' }); // on the web: into X
  await r.vault.move(r.list, 'dodo/Y'); // here: into Y
  await r.dodo.folders();
  assert.equal(r.file(), `dodo/X/Lista ${n}.md`);
  assert.equal((await tree()).lists[r.list], 'k1');
});

test('a note that is off or lost is left alone, and the first sync only follows dodo', async () => {
  await put([F('k1', 'Kurser')]);
  const r = await rig(srv, `Första ${++n}`, ses);
  await put([F('k1', 'Kurser')], { [r.list]: 'k1' });
  await r.dodo.enable(r.list); // the note starts at the top of dodo/, there is no earlier sync: the web's place wins
  await r.dodo.folders();
  assert.equal([...r.vault.files.keys()][0], `dodo/Kurser/Första ${n}.md`);
  assert.deepEqual(folderWrites(r), []);
  await r.dodo.disable(r.list);
  await r.vault.move(r.list, 'dodo/Egen');
  await r.dodo.folders();
  assert.deepEqual((await tree()).folders.map((f: any) => f.name), ['Kurser', 'Egen']); // the folder is a folder, the off list is not moved
  assert.equal((await tree()).lists[r.list], 'k1');
});

// a stored tree: Kurser > HT26 (with the list), Jobb, Privat; synced once
const stored = async () => {
  const r = await mk();
  const t = [F('k1', 'Kurser'), F('k2', 'HT26', 'k1'), F('j', 'Jobb'), F('p', 'Privat')];
  await put(t, { [r.list]: 'k2' });
  await r.dodo.folders();
  return { r, t };
};

test('a vault whose files are not there yet leaves dodo\'s tree alone, is filled from dodo, and asks; "Ta bort ändå" then sends the removal', async () => {
  const { r, t } = await stored();
  r.vault.files.clear(); r.vault.folders.clear(); // another computer: data.json is there, the vault's files have not synced down
  await r.dodo.folders();
  assert.deepEqual((await tree()).folders, t);
  assert.deepEqual(folderWrites(r), []);
  assert.deepEqual([...r.vault.dirs('dodo')].sort(), ['dodo/Jobb', 'dodo/Kurser', 'dodo/Kurser/HT26', 'dodo/Privat']);
  assert.equal(r.vault.notices.length, 1);
  assert.match(r.vault.notices[0].text, /4 av 4 mappar skulle tas bort/);
  assert.deepEqual(r.vault.notices[0].actions.map((a: any) => a.label), ['Ta bort ändå', 'Hämta från dodo']);
  await r.dodo.folders(); // asked once, and a later sync still changes nothing
  assert.equal(r.vault.notices.length, 1);
  assert.deepEqual((await tree()).folders, t);
  await r.dodo.releaseFolders(true); // the folder with the list, whose note is missing, stays; the empty ones go
  assert.deepEqual((await tree()).folders.map((f: any) => f.name), ['Kurser', 'HT26']);
});

test('"Hämta från dodo" drops the held removal; one empty folder deleted on purpose still goes; a folder whose list has no note is never removed', async () => {
  const { r, t } = await stored();
  r.vault.files.clear(); r.vault.folders.clear();
  await r.dodo.folders();
  await r.dodo.releaseFolders(false);
  await r.dodo.releaseFolders(true);
  assert.deepEqual((await tree()).folders, t);
  const q = await stored();
  q.r.vault.folders.delete('dodo/Jobb'); // one real deletion in Obsidian
  await q.r.dodo.folders();
  assert.deepEqual((await tree()).folders.map((f: any) => f.name), ['Kurser', 'HT26', 'Privat']);
  assert.equal(q.r.vault.notices.length, 0);
  const w = await stored();
  w.r.vault.files.clear(); w.r.vault.folders.delete('dodo/Kurser'); w.r.vault.folders.delete('dodo/Kurser/HT26'); // the note is missing, the folder with it looks removed
  await w.r.dodo.folders();
  assert.deepEqual((await tree()).folders, w.t);
  assert.deepEqual(w.r.vault.notices, []); // only one folder asked for: no question, and nothing is removed
});

test('with the whole vault as the dodo folder, folders without a dodo note are never sent; one with a note is', async () => {
  await put([]);
  const r = await rig(srv, `Hela ${++n}`, ses);
  r.data.folder = '';
  await r.dodo.enable(r.list); await r.dodo.folders();
  r.vault.folders.add('Dagbok'); r.vault.folders.add('Dagbok/2026'); r.vault.folders.add('Projekt');
  await r.dodo.folders();
  assert.deepEqual(folderWrites(r), []);
  assert.deepEqual((await tree()).folders, []);
  await r.vault.move(r.list, 'Ny/Mapp');
  await r.dodo.folders();
  const t = await tree();
  assert.deepEqual(t.folders.map((f: any) => f.name), ['Ny', 'Mapp']);
  assert.equal(t.lists[r.list], t.folders[1].id);
  assert.deepEqual([...r.vault.files.keys()], [`Ny/Mapp/Hela ${n}.md`]);
});
