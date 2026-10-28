import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Dodo, emptyData, LOST_TITLE, split } from '../src/sync.js';
import { Server, login, rig, sleep, writes, fetchHttp, FakeVault, state, type Rig } from './helpers.js';

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

const mk = (name = 'Lista') => rig(srv, `${name} ${++n}`, ses);
const body = (r: Rig) => split(r.vault.file(r.list)).text;
const seed = async (r: Rig) => {
  await r.anna('PUT', '/headings', [{ id: r.id('hhhh1'), level: 2, title: 'Inköp', who: [], notes: '' }]);
  await r.todo(r.id('tttt1'), 'mjölk', { h: r.id('hhhh1'), tags: ['mat'], pos: 1 });
  await r.todo(r.id('tttt2'), 'bröd', { h: r.id('hhhh1'), prio: 1, pos: 2 });
  await r.todo(r.id('tttt3'), 'smör', { h: r.id('hhhh1'), pos: 3 });
};

test('login with the link gives a session that works as a bearer token; the link works once', async () => {
  const d = new Dodo(emptyData(), { http: fetchHttp(), host: new FakeVault(), save: () => {} });
  srv.cli('list', 'create', 'Inloggning', '--owner', 'boss@example.com');
  const link = srv.cli('link', 'boss@example.com').url;
  await assert.rejects(d.login('inte en länk'), /ser inte ut som en länk/);
  await d.login(link);
  assert.equal(d.data.name, 'Boss');
  assert.equal(d.data.url, srv.url);
  assert.ok((await d.lists()).length >= 1);
  await assert.rejects(new Dodo(emptyData(), { http: fetchHttp(), host: new FakeVault(), save: () => {} }).login(link), /gäller inte längre/);
  await d.logout();
  assert.equal(d.data.session, '');
  await assert.rejects(d.lists(), /Inte inloggad/);
});

test('first sync writes the note with frontmatter; a name already taken is never overwritten', async () => {
  const r = await mk('Handla'); await seed(r);
  r.vault.files.set(`dodo/Handla ${n}.md`, 'min egen fil');
  await r.dodo.enable(r.list);
  assert.equal(r.vault.files.get(`dodo/Handla ${n}.md`), 'min egen fil');
  const f = r.vault.files.get(`dodo/Handla ${n} 2.md`)!;
  assert.match(f, new RegExp(`^---\\ndodo: ${srv.url}/l/${r.list}\\n---\\n`));
  assert.equal(body(r), '## Inköp\n- [ ] mjölk #mat\n- [ ] bröd !hög\n- [ ] smör');
  assert.match(r.vault.notices[0].text, /fanns redan/);
});

test('an unchanged note sends nothing, also after blank lines and repeated polling', async () => {
  const r = await mk(); await seed(r); await r.dodo.enable(r.list);
  r.log.length = 0;
  await r.dodo.tick(); await r.dodo.flush(r.list);
  r.vault.edit(r.list, t => t + '\n\n');
  await r.dodo.flush(r.list);
  assert.deepEqual(writes(r.log), []);
  assert.equal(r.dodo.status, 'ok');
});

test('an edited line keeps its todo id and is one PUT; typing is left alone until the debounce flushes', async () => {
  const r = await mk(); await seed(r); await r.dodo.enable(r.list);
  r.vault.edit(r.list, t => t.replace('- [ ] bröd !hög', '- [ ] bröd och pålägg !hög'));
  r.dodo.touched(r.list); r.log.length = 0;
  await r.dodo.tick(); // just typed: the tick leaves it to the debounce
  assert.deepEqual(writes(r.log), []);
  await r.dodo.flush(r.list);
  assert.deepEqual(writes(r.log), [{ method: 'PUT', path: `/api/l/${r.list}/todos/${r.id('tttt2')}` }]);
  const s = await state(r);
  assert.equal(s.todos.length, 3);
  assert.equal(s.todos.find((t: any) => t.id === r.id('tttt2')).text, 'bröd och pålägg');
  assert.equal(body(r), '## Inköp\n- [ ] mjölk #mat\n- [ ] bröd och pålägg !hög\n- [ ] smör');
});

test('adding and removing todos and text paragraphs', async () => {
  const r = await mk(); await seed(r); await r.dodo.enable(r.list);
  r.vault.edit(r.list, t => t.replace('- [ ] mjölk #mat\n', '') + '\n- [ ] nytt @anna ^2030-01-02\n\nEtt stycke med **text**.\n');
  await r.dodo.flush(r.list);
  const s = await state(r);
  assert.deepEqual(s.todos.map((t: any) => t.id).filter((i: string) => i.includes('tttt')).sort(), [r.id('tttt2'), r.id('tttt3')].sort());
  const nytt = s.todos.find((t: any) => t.text === 'nytt');
  assert.equal(nytt.due, '2030-01-02');
  assert.deepEqual(nytt.who, [s.users.find((u: any) => u.handle === 'anna').id]);
  const block = s.todos.find((t: any) => t.md);
  assert.equal(block.notes, 'Ett stycke med **text**.');
  // the note is what the server renders: order kept
  const before = body(r);
  await r.dodo.tick();
  assert.equal(body(r), before);
  assert.match(before, /- \[ \] nytt @anna \^2030-01-02\n\nEtt stycke med \*\*text\*\*\.$/);
  // removing a text paragraph removes the block
  r.vault.edit(r.list, t => t.replace('\n\nEtt stycke med **text**.', ''));
  await r.dodo.flush(r.list);
  assert.ok(!(await state(r)).todos.some((t: any) => t.md));
});

test('a change in dodo reaches the note; done todos can be hidden', async () => {
  const r = await mk(); await seed(r); await r.dodo.enable(r.list);
  await r.todo(r.id('tttt4'), 'ost', { h: r.id('hhhh1'), pos: 4 });
  await r.dodo.tick();
  assert.match(body(r), /- \[ \] ost$/);
  await r.todo(r.id('tttt1'), 'mjölk', { h: r.id('hhhh1'), tags: ['mat'], pos: 1, done: true, doneBy: 'x', doneAt: Date.now() });
  await r.dodo.tick();
  assert.match(body(r), /- \[x\] mjölk #mat/);
  r.dodo.data.hideDone = true;
  r.log.length = 0;
  await r.dodo.tick();
  assert.ok(!body(r).includes('mjölk'));
  assert.deepEqual(writes(r.log), [], 'hidden is not deleted');
  r.vault.edit(r.list, t => t + '\n- [ ] sist');
  await r.dodo.flush(r.list);
  assert.ok((await state(r)).todos.some((t: any) => t.id === r.id('tttt1') && t.done), 'the hidden done todo is still there');
  r.dodo.data.hideDone = false;
  await r.dodo.tick();
  assert.match(body(r), /- \[x\] mjölk/);
});

test('both sides edit the same todo: the server wins, the local text becomes a comment, nothing is lost', async () => {
  const r = await mk(); await seed(r); await r.dodo.enable(r.list);
  await sleep(10);
  await r.todo(r.id('tttt3'), 'smör och ost', { h: r.id('hhhh1'), pos: 3 }); // anna, after the note was written
  r.vault.edit(r.list, t => t.replace('- [ ] smör', '- [ ] smör eller margarin'));
  await r.dodo.flush(r.list);
  const s = await state(r);
  assert.equal(s.todos.find((t: any) => t.id === r.id('tttt3')).text, 'smör och ost');
  const c = s.comments.filter((c: any) => c.todo === r.id('tttt3'));
  assert.equal(c.length, 1);
  assert.match(c[0].text, /- \[ \] smör eller margarin/);
  assert.match(body(r), /- \[ \] smör och ost/);
  assert.match(r.vault.notices.at(-1)!.text, /Krock/);
});

test('offline: the note keeps the edit and it is delivered when the server is back', async () => {
  const r = await mk(); await seed(r); await r.dodo.enable(r.list);
  await srv.stop();
  r.vault.edit(r.list, t => t + '\n- [ ] medan jag var offline');
  await r.dodo.flush(r.list);
  assert.equal(r.dodo.status, 'err');
  assert.match(r.dodo.lastError, /Får ingen kontakt/);
  assert.match(body(r), /medan jag var offline/);
  await srv.start();
  await r.dodo.tick();
  assert.equal(r.dodo.status, 'ok');
  assert.ok((await state(r)).todos.some((t: any) => t.text === 'medan jag var offline'));
});

test('deleting more than half the todos asks first; keeping puts the note back', async () => {
  const r = await mk(); await seed(r); await r.todo(r.id('tttt4'), 'ost', { h: r.id('hhhh1'), pos: 4 }); await r.dodo.enable(r.list);
  const full = body(r);
  r.vault.answer = false;
  r.vault.edit(r.list, () => r.vault.file(r.list).replace(/- \[ \] (mjölk|bröd|smör).*\n/g, ''));
  r.log.length = 0;
  await r.dodo.flush(r.list);
  assert.equal(r.vault.asked.length, 1);
  assert.deepEqual(writes(r.log), []);
  assert.equal(body(r), full);
  r.vault.answer = true;
  r.vault.edit(r.list, () => r.vault.file(r.list).replace(/- \[ \] (mjölk|bröd|smör).*\n/g, ''));
  await r.dodo.flush(r.list);
  assert.equal(r.vault.asked.length, 2);
  assert.deepEqual((await state(r)).todos.map((t: any) => t.text), ['ost']);
  // one todo less is no question
  r.vault.edit(r.list, t => t.replace('- [ ] ost', ''));
  await r.dodo.flush(r.list);
  assert.equal(r.vault.asked.length, 2);
});

test('logged out: a notice with a button, the text stays and is sent after logging in again', async () => {
  const r = await mk(); await seed(r); await r.dodo.enable(r.list);
  const mine = await login(srv, 'boss@example.com'); // a second session; "logout" ends all of them
  srv.cli('logout', 'boss@example.com'); void mine;
  r.vault.edit(r.list, t => t + '\n- [ ] skrivet utloggad');
  await r.dodo.flush(r.list);
  assert.equal(r.dodo.authLost, true);
  assert.equal(r.vault.notices.at(-1)!.action.label, 'Logga in igen');
  assert.match(body(r), /skrivet utloggad/);
  await r.dodo.login(srv.cli('link', 'boss@example.com').url);
  ses.boss = r.data.session;
  await r.dodo.flush(r.list);
  assert.ok((await state(r)).todos.some((t: any) => t.text === 'skrivet utloggad'));
});

test('lost access: syncing stops, a line is put at the top, the note moves to Borttagna and is never deleted', async () => {
  const r = await mk(); await seed(r); await r.dodo.enable(r.list);
  const path = [...r.vault.files.keys()][0], stem = path.split('/').pop()!.replace(/\.md$/, '');
  r.vault.files.set(`dodo/Borttagna/${stem}.md`, 'en gammal fil'); // the name is taken there
  srv.cli('member', 'add', r.list, 'anna@example.com', '--role', 'admin'); // so the list keeps an admin
  srv.cli('member', 'remove', r.list, 'boss@example.com');
  await r.dodo.tick();
  assert.ok(r.dodo.data.lists[r.list].lost);
  assert.ok(!r.vault.files.has(path));
  assert.equal(r.vault.files.get(`dodo/Borttagna/${stem}.md`), 'en gammal fil');
  assert.ok(r.vault.file(r.list).startsWith(`---\ndodo: ${srv.url}/l/${r.list}\n---\n${LOST_TITLE}\n> »`), r.vault.file(r.list));
  assert.match(r.vault.file(r.list), /längre \(\d{4}-\d\d-\d\d\)\. Anteckningen hålls inte i takt längre, men texten finns kvar här\.\n\n## Inköp/);
  assert.ok(r.vault.files.has(`dodo/Borttagna/${stem} 2.md`));
  r.log.length = 0;
  await r.dodo.tick();
  assert.deepEqual(r.log, []);
});

const count = (r: Rig, id: string) => [...r.vault.files.values()].filter(t => t.includes(`/l/${id}\n`)).length;
test('new lists are added by themselves; a list switched off stays off; the setting can be off', async () => {
  const r = await mk('Auto'); r.dodo.listCheckEvery = 0;
  const a = srv.cli('list', 'create', 'Ny ' + ++n, '--owner', 'boss@example.com').id;
  await r.dodo.tick();
  assert.equal(count(r, a), 0, 'setting off: nothing added');
  r.data.autoAdd = true;
  await r.dodo.tick();
  assert.equal(count(r, a), 1);
  assert.ok(r.vault.note(a));
  await r.dodo.disable(a);
  await r.dodo.tick(); await r.dodo.tick();
  assert.equal(count(r, a), 1, 'not added twice');
  assert.equal(r.data.lists[a].off, true);
  const b = srv.cli('list', 'create', 'Ny ' + ++n, '--owner', 'boss@example.com').id;
  r.data.autoAdd = false;
  await r.dodo.tick();
  assert.equal(count(r, b), 0);
  r.dodo.event('lists', {}); // the stream says so, but the setting is off
  await sleep(300);
  assert.equal(count(r, b), 0);
});
