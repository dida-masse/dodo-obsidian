import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Dodo, emptyData, LOST_TITLE } from '../src/sync.js';
import { Server, login, rig, fetchHttp, FakeVault, type Rig } from './helpers.js';

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

const SHOW = { due: true, prio: true, tags: true, who: true, notes: true, done: true, comments: false };
const boss = async (r: Rig, m: string, p: string, b?: any) => {
  const res = await fetch(`${srv.url}/api/l/${r.list}${p}`, { method: m, headers: { authorization: 'Bearer ' + ses.boss, 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
  return res.status === 204 ? null : res.json() as Promise<any>;
};
// a list with two todos, a link for one of them and one for the whole list, the boss's note kept in step
const mk = async () => {
  const r = await rig(srv, `Delad ${++n}`, ses);
  await r.todo(r.id('tttt1'), 'mjölk', { pos: 1 });
  await r.todo(r.id('tttt2'), 'bröd', { pos: 2 });
  const one = await boss(r, 'POST', '/shares', { todo: r.id('tttt1'), minutes: 60, show: SHOW, check: true });
  const all = await boss(r, 'POST', '/shares', { minutes: 60, show: { ...SHOW, comments: true }, comment: true });
  await r.dodo.enable(r.list);
  await r.dodo.tick();
  return { r, one, all };
};
// anna's plugin: her own session and vault
const asAnna = (r: Rig) => {
  const vault = new FakeVault(), data = emptyData();
  Object.assign(data, { url: srv.url, session: ses.anna, name: 'Anna', autoAdd: false });
  return { vault, data, dodo: new Dodo(data, { http: fetchHttp(), host: vault, save: () => {}, openSettings: () => {} }) };
};
const links = async (r: Rig) => (await boss(r, 'GET', '/shares')) as any[];
const line = (r: Rig, text: string) => r.vault.file(r.list).split('\n').findIndex(l => l.includes(text));
const leaks = (x: unknown) => /\/s\/[A-Za-z0-9_-]{8,}/.test(JSON.stringify(x));

test('the todo with a public link gets a marker line with what the link allows; the list-wide link and the other todo do not', async () => {
  const { r } = await mk();
  const m = r.dodo.shareLines(r.list, r.vault.file(r.list));
  assert.equal(m.length, 1);
  assert.equal(m[0].line, line(r, 'mjölk'));
  assert.equal(m[0].n, 1);
  assert.equal(m[0].id, r.id('tttt1'));
  assert.match(m[0].says, /visar datum, prioritet, taggar, vem, anteckning, klara; får bocka av/);
  assert.ok(!leaks([m, r.vault.files, r.vault.notices, r.data.lists]));
});

test('the marker follows a link being made, changed and stopped on the web', async () => {
  const { r, one } = await mk();
  const two = await boss(r, 'POST', '/shares', { todo: r.id('tttt1'), minutes: 30, show: SHOW });
  await r.dodo.tick();
  assert.equal(r.dodo.shareLines(r.list, r.vault.file(r.list))[0].n, 2);
  await boss(r, 'DELETE', '/shares/' + two.id);
  await boss(r, 'DELETE', '/shares/' + one.id);
  await r.dodo.tick();
  assert.deepEqual(r.dodo.shareLines(r.list, r.vault.file(r.list)), []);
});

test('Delningar: the boss sees the people and the links of the list, and no address', async () => {
  const { r, one, all } = await mk();
  const d = await r.dodo.shared(), mine = d.mine.find((l: any) => l.id === r.list)!;
  assert.deepEqual(mine.people.map(p => [p.name, p.role]), [['Anna', 'member']]);
  assert.deepEqual(mine.links.map(l => l.id).sort(), [one.id, all.id].sort());
  const link = mine.links.find(l => l.id === one.id)!;
  assert.equal(link.text, 'mjölk');
  assert.match(link.says, /får bocka av/);
  assert.ok(mine.links.find(l => l.id === all.id)!.todo === null);
  const member = d.member.find(l => l.id === r.list)!;
  assert.deepEqual([member.role, member.canLeave], ['admin', false]); // the only admin
  assert.ok(!leaks(d));
});

test('a link can be changed: what it shows and allows, and the marker follows', async () => {
  const { r, one } = await mk();
  await r.dodo.changeLink(r.list, one.id, { check: false, show: { notes: false, who: false }, comment: true });
  const o = (await links(r)).find(l => l.id === one.id).opts;
  assert.equal(o.check, false);
  assert.equal(o.show.notes, false);
  assert.equal(o.show.who, false);
  assert.equal(o.show.due, true); // the rest is as it was
  assert.equal(o.comment, false); // commenting needs the comments shown: the server drops it
  await r.dodo.changeLink(r.list, one.id, { show: { comments: true }, comment: true });
  const o2 = (await links(r)).find(l => l.id === one.id).opts;
  assert.deepEqual([o2.show.comments, o2.comment], [true, true]);
  assert.match(r.dodo.shareLines(r.list, r.vault.file(r.list))[0].says, /kommentarer.*kommentera/);
  assert.ok(!leaks([r.vault.files, r.vault.notices]));
});

test('a link can be stopped: it is gone for the server and the marker goes', async () => {
  const { r, one, all } = await mk();
  await r.dodo.stopLink(r.list, one.id);
  assert.deepEqual((await links(r)).map(l => l.id), [all.id]);
  assert.deepEqual(r.dodo.shareLines(r.list, r.vault.file(r.list)), []);
  await assert.rejects(r.dodo.stopLink(r.list, one.id), (e: any) => e.status === 404); // stopped twice
});

test('a person can be taken out of a list by its admin', async () => {
  const { r } = await mk();
  await r.dodo.removePerson(r.list, (await r.dodo.shared()).mine.find(l => l.id === r.list)!.people[0].id);
  assert.deepEqual((await r.dodo.shared()).mine.find(l => l.id === r.list)!.people, []);
  assert.equal((await r.anna('GET', '/state')).error, 'Hittades inte');
});

test('a member who is not the owner sees no owner actions, and the server refuses them', async () => {
  const { r, one } = await mk(), a = asAnna(r);
  const d = await a.dodo.shared();
  assert.ok(!d.mine.some((l: any) => l.id === r.list)); // nothing to stop or change, nobody to take out
  const l = d.member.find(l => l.id === r.list)!;
  assert.deepEqual([l.role, l.canLeave, l.by], ['member', true, ['Boss']]);
  await assert.rejects(a.dodo.stopLink(r.list, one.id), (e: any) => e.status === 403);
  await assert.rejects(a.dodo.changeLink(r.list, one.id, { check: false }), (e: any) => e.status === 403);
  await assert.rejects(a.dodo.removePerson(r.list, 'boss'), (e: any) => e.status === 403);
  assert.equal((await links(r)).find(x => x.id === one.id).opts.check, true); // untouched
});

test('the only admin cannot leave; with a second admin the list can be left', async () => {
  const { r } = await mk();
  await assert.rejects(r.dodo.leave(r.list), (e: any) => e.status === 400);
  assert.equal(r.data.lists[r.list].lost, undefined); // the note is not touched
  assert.ok([...r.vault.files.keys()].every(k => !k.includes('Borttagna')));
  const anna = (await r.dodo.shared()).mine[0].people[0].id;
  await boss(r, 'PUT', '/members/' + anna, { role: 'admin' });
  assert.equal((await r.dodo.shared()).member.find(l => l.id === r.list)!.canLeave, true);
});

test('leaving a list sends what is unsent, moves the note to Borttagna with a line about it, and says so', async () => {
  const { r } = await mk(), a = asAnna(r);
  await a.dodo.enable(r.list);
  a.vault.edit(r.list, t => t.trimEnd() + '\n- [ ] skriven före\n');
  await a.dodo.leave(r.list);
  assert.ok((await boss(r, 'GET', '/state')).todos.some((t: any) => t.text === 'skriven före')); // sent first
  const [path] = [...a.vault.files.keys()];
  assert.match(path, /^dodo\/Borttagna\//);
  assert.ok(a.vault.file(r.list).includes(LOST_TITLE));
  assert.ok(a.vault.file(r.list).includes('skriven före')); // the text stays
  assert.match(a.vault.notices.at(-1)!.text, /lämnat »Delad \d+«.*dodo\/Borttagna/);
  assert.ok(a.data.lists[r.list].lost);
  assert.ok(!(await a.dodo.lists()).some(l => l.id === r.list)); // no longer in her lists
  assert.equal((await boss(r, 'GET', '/members')).members.some((m: any) => m.name === 'Anna'), false);
  assert.ok(!leaks([a.vault.files, a.vault.notices]));
});

test('leaving a list that has no note here just leaves it', async () => {
  const { r } = await mk(), a = asAnna(r);
  assert.equal(a.dodo.noted(r.list), false);
  await a.dodo.leave(r.list);
  assert.ok(!(await a.dodo.lists()).some(l => l.id === r.list));
  assert.equal(a.vault.files.size, 0);
});
