import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
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

const line = (r: Rig, text: string) => r.vault.file(r.list).split('\n').findIndex(l => l.includes(text));
const stateOf = async (r: Rig) => (await r.anna('GET', '/state')) as any;
// a source list with a heading and a todo with a sub-task, on in the vault, and a target list with a heading of the same title
const mk = async () => {
  const a = await rig(srv, `Källa ${++n}`, ses), b = await rig(srv, `Mål ${n}`, ses);
  await a.anna('PUT', '/headings', [{ id: a.id('hhhh1'), level: 2, title: 'Inköp', who: [], notes: '' }]);
  await b.anna('PUT', '/headings', [{ id: b.id('hhhh2'), level: 2, title: 'Annat', who: [], notes: '' }, { id: b.id('hhhh3'), level: 2, title: 'Inköp', who: [], notes: '' }]);
  await a.todo(a.id('tttt1'), 'mjölk', { h: a.id('hhhh1'), pos: 1, subs: [{ id: a.id('ssss1'), text: 'havre', tags: [], who: [], due: null, prio: 0, done: false }] });
  await a.todo(a.id('tttt2'), 'bröd', { h: a.id('hhhh1'), pos: 2 });
  await a.dodo.enable(a.list);
  return [a, b] as const;
};

test('the todo under the cursor is copied to the other list under the heading of the same title; the original and the note are untouched', async () => {
  const [a, b] = await mk(), before = a.vault.file(a.list);
  const r = await a.dodo.copyTodo(a.list, line(a, 'mjölk'), b.list);
  assert.equal(r.list, b.list);
  assert.match(r.name, /^Mål \d+$/);
  const T = await stateOf(b), copy = T.todos.find((t: any) => t.id === r.id);
  assert.equal(copy.text, 'mjölk');
  assert.equal(copy.h, b.id('hhhh3')); // »Inköp«, not the first heading
  assert.equal(copy.subs.length, 1);
  assert.equal(copy.subs[0].text, 'havre');
  assert.notEqual(copy.subs[0].id, a.id('ssss1')); // new ids, a separate todo
  const S = await stateOf(a);
  assert.deepEqual(S.todos.map((t: any) => t.id).sort(), [a.id('tttt1'), a.id('tttt2')]); // no duplicate in the source
  assert.equal(S.todos.find((t: any) => t.id === a.id('tttt1')).subs[0].id, a.id('ssss1'));
  assert.equal(a.vault.file(a.list), before);
  assert.match(a.vault.notices.at(-1)!.text, new RegExp(`»${r.name}«`));
  assert.deepEqual(writes(a.log).filter(l => l.path.includes('/todos/') && !l.path.endsWith('/copy')), []);
});

test('without a heading of that title the copy has none', async () => {
  const [a, b] = await mk();
  await a.anna('PUT', '/headings', [{ id: a.id('hhhh1'), level: 2, title: 'Helt annat', who: [], notes: '' }]);
  await a.dodo.tick();
  const r = await a.dodo.copyTodo(a.list, line(a, 'bröd'), b.list);
  assert.equal((await stateOf(b)).todos.find((t: any) => t.id === r.id).h, null);
});

test('a copy to a note of the plugin fills it at once', async () => {
  const [a, b] = await mk();
  await a.dodo.enable(b.list); // the target is a note in the same vault
  await a.dodo.copyTodo(a.list, line(a, 'bröd'), b.list);
  await new Promise(r => setTimeout(r, 300));
  assert.match(a.vault.file(b.list), /bröd/);
});

test('an unsent edit is sent first, so the right todo is copied', async () => {
  const [a, b] = await mk();
  a.vault.edit(a.list, t => t.replace('mjölk', 'havremjölk').trimEnd() + '\n- [ ] ny rad\n');
  const r = await a.dodo.copyTodo(a.list, line(a, 'ny rad'), b.list);
  const T = await stateOf(b), S = await stateOf(a);
  assert.equal(T.todos.find((t: any) => t.id === r.id).text, 'ny rad');
  assert.equal(S.todos.filter((t: any) => t.text === 'ny rad').length, 1); // sent once, not twice
  assert.ok(S.todos.some((t: any) => t.text === 'havremjölk')); // the other edit went with it
});

test('a line that is not a todo is refused with a reason, and nothing is copied', async () => {
  const [a, b] = await mk();
  a.vault.edit(a.list, t => t.trimEnd() + '\n\nett stycke\n');
  await assert.rejects(a.dodo.copyTodo(a.list, line(a, 'Inköp'), b.list), /rubrik/);
  await assert.rejects(a.dodo.copyTodo(a.list, line(a, 'ett stycke'), b.list), /textstycke/);
  await assert.rejects(a.dodo.copyTodo(a.list, 0, b.list), /inte på en uppgift/); // the frontmatter
  await assert.rejects(a.dodo.copyTodo(a.list, line(a, 'mjölk'), a.list), /annan lista/);
  assert.equal((await stateOf(b)).todos.length, 0);
});

test('a todo that cannot be sent yet is not copied, and says why', async () => {
  const [a, b] = await mk();
  const was = a.dodo.data.session;
  a.dodo.data.session = 'x'; // the server refuses the session: the edit stays unsent
  a.vault.edit(a.list, t => t.trimEnd() + '\n- [ ] osänd\n');
  await assert.rejects(a.dodo.copyTodo(a.list, line(a, 'osänd'), b.list), /inte har kunnat skickas|inte skickad/);
  a.dodo.data.session = was;
  assert.equal((await stateOf(b)).todos.length, 0);
});

test('a list the user is not in cannot be copied to, and is not offered', async () => {
  const [a] = await mk();
  const other = srv.cli('list', 'create', `Annas ${n}`, '--owner', 'anna@example.com').id;
  await assert.rejects(a.dodo.copyTodo(a.list, line(a, 'mjölk'), other), /inte med i den listan/);
  const offered = (await a.dodo.copyTargets(a.list)).map(l => l.id);
  assert.ok(!offered.includes(other));
  assert.ok(!offered.includes(a.list));
  const s = await (await fetch(`${srv.url}/api/l/${other}/state`, { headers: { authorization: 'Bearer ' + ses.anna } })).json() as any;
  assert.equal(s.todos.length, 0);
});

test('a note that is not kept in step is refused', async () => {
  const [a, b] = await mk();
  a.dodo.data.lists[a.list].off = true;
  await assert.rejects(a.dodo.copyTodo(a.list, line(a, 'mjölk'), b.list), /hålls inte i takt/);
});
