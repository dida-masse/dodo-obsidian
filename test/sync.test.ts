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

// a second computer with the same vault (Obsidian Sync, iCloud, git): its own plugin data is empty, the notes are already there
const second = (r: Rig) => {
  const log: any[] = [], data = emptyData();
  Object.assign(data, { url: srv.url, session: ses.boss, name: 'Boss', autoAdd: false });
  return { log, data, dodo: new Dodo(data, { http: fetchHttp(log), host: r.vault, save: () => {}, openSettings: () => {} }) };
};

test('a second computer takes the note that is already in the vault, never makes a "2", and dodo wins', async () => {
  const r = await mk('Handla'); await seed(r); await r.dodo.enable(r.list);
  await r.todo(r.id('tttt4'), 'ost', { h: r.id('hhhh1'), pos: 4 }); // changed in dodo since the vault was synced
  const b = second(r);
  await b.dodo.enable(r.list);
  assert.deepEqual([...r.vault.files.keys()], [`dodo/Handla ${n}.md`]);
  assert.equal(body(r), '## Inköp\n- [ ] mjölk #mat\n- [ ] bröd !hög\n- [ ] smör\n- [ ] ost');
  assert.deepEqual(writes(b.log), []);
  assert.equal(r.vault.notices.length, 0);
});

test('an edit synced in from the other computer, already sent from there, is not sent again (no duplicates)', async () => {
  const r = await mk(); await seed(r); await r.dodo.enable(r.list);
  const b = second(r); await b.dodo.enable(r.list);
  r.vault.edit(r.list, t => t + '\n- [ ] ägg');
  await r.dodo.flush(r.list); // the first computer sends it; the second sees the same file change
  await b.dodo.flush(r.list);
  assert.deepEqual(writes(b.log), []);
  assert.equal((await state(r)).todos.filter((t: any) => t.text === 'ägg').length, 1);
});

test('a list renamed in dodo renames its note; a note given its own name in Obsidian keeps it', async () => {
  const r = await mk('Gammal'); await seed(r); await r.dodo.enable(r.list);
  const put = (name: string) => fetch(`${srv.url}/api/l/${r.list}`, { method: 'PUT', headers: { authorization: 'Bearer ' + ses.boss, 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
  r.dodo.listCheckEvery = 0;
  await put('Ny: lista');
  await r.dodo.tick();
  assert.deepEqual([...r.vault.files.keys()], ['dodo/Ny lista.md']);
  assert.equal(body(r), '## Inköp\n- [ ] mjölk #mat\n- [ ] bröd !hög\n- [ ] smör');
  assert.deepEqual(writes(r.log).filter(l => l.method !== 'PUT' || !l.path.endsWith(r.list)), []);
  await r.vault.rename(r.list, 'Mitt eget namn');
  await put('Tredje');
  await r.dodo.tick();
  assert.deepEqual([...r.vault.files.keys()], ['dodo/Mitt eget namn.md']);
  assert.equal(r.data.lists[r.list].name, 'Tredje');
});

test('a note changed by someone else is marked until it is opened; my own edits, hiding done todos and an open note are not', async () => {
  const r = await mk(); await seed(r); await r.dodo.enable(r.list);
  await (r.dodo as any).call('POST', `/api/l/${r.list}/seen`, {}); await sleep(5); // a start where everything is seen
  let told = 0; r.dodo.onFresh = () => told++;
  r.vault.edit(r.list, t => t + '\n- [ ] mitt');
  await r.dodo.flush(r.list); await r.dodo.tick();
  assert.deepEqual(r.dodo.updated(), [], 'my own edit');
  await r.todo(r.id('tttt4'), 'ost', { h: r.id('hhhh1'), pos: 4 });
  await r.dodo.tick();
  assert.deepEqual(r.dodo.updated(), [r.list]);
  assert.equal(told, 1);
  r.dodo.opened(r.list);
  assert.deepEqual(r.dodo.updated(), []);
  await r.todo(r.id('tttt1'), 'mjölk', { h: r.id('hhhh1'), tags: ['mat'], pos: 1, done: true, doneBy: 'x', doneAt: Date.now() });
  await r.dodo.tick(); r.dodo.opened(r.list);
  r.dodo.data.hideDone = true;
  await r.dodo.tick();
  assert.deepEqual(r.dodo.updated(), [], 'only hiding done todos');
  r.vault.looking.add(r.list);
  await r.todo(r.id('tttt5'), 'smör igen', { h: r.id('hhhh1'), pos: 5 });
  await r.dodo.tick();
  assert.deepEqual(r.dodo.updated(), [], 'the note was open');
});

test('opening a marked note shows what others did since I last looked, marks those lines, can bring back a deleted todo, and counts as seen everywhere', async () => {
  const r = await mk(); await seed(r); await r.dodo.enable(r.list);
  await r.dodo.left(r.list); await (r.dodo as any).call('POST', `/api/l/${r.list}/seen`, {}); // a start where everything is seen
  await sleep(5);
  await r.todo(r.id('tttt4'), 'ost', { h: r.id('hhhh1'), pos: 4 });
  await r.todo(r.id('tttt2'), 'bröd fullkorn', { h: r.id('hhhh1'), prio: 1, pos: 2 });
  await r.anna('DELETE', '/todos/' + r.id('tttt3'));
  await r.dodo.tick();
  assert.deepEqual(r.dodo.updated(), [r.list]);
  let told = 0; r.dodo.onNews = () => told++;
  await r.dodo.opened(r.list);
  assert.deepEqual(r.dodo.updated(), []);
  const news = r.dodo.whatsNew(r.list);
  assert.deepEqual(news.map(x => [x.kind, x.text]).sort(), [['add', 'ost'], ['change', 'bröd fullkorn'], ['delete', 'smör']]);
  assert.equal(told, 1);
  const lines = r.vault.file(r.list).split('\n');
  assert.deepEqual(r.dodo.newsLines(r.list, r.vault.file(r.list)).map(i => lines[i]).sort(), ['- [ ] bröd fullkorn !hög', '- [ ] ost']);
  await r.dodo.restore(r.list, news.find(x => x.kind === 'delete')!);
  assert.match(body(r), /- \[ \] smör/);
  await r.dodo.left(r.list);
  assert.deepEqual(r.dodo.whatsNew(r.list), []);
  assert.equal((await r.dodo.lists()).find(l => l.id === r.list)!.changed, false, 'seen on the server too');
});

test('a list seen somewhere else (the web, another computer) loses its dot here', async () => {
  const r = await mk(); await seed(r); await r.dodo.enable(r.list);
  await r.todo(r.id('tttt4'), 'ost', { h: r.id('hhhh1'), pos: 4 });
  await r.dodo.tick();
  assert.deepEqual(r.dodo.updated(), [r.list]);
  await fetch(`${srv.url}/api/l/${r.list}/seen`, { method: 'POST', headers: { authorization: 'Bearer ' + ses.boss, 'content-type': 'application/json' }, body: '{}' });
  r.dodo.listCheckEvery = 0;
  await r.dodo.tick();
  assert.deepEqual(r.dodo.updated(), []);
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

test('a comment changes only the snapshot, never the note; one notice for a batch; seen marks them', async () => {
  const r = await mk(); await seed(r); await r.dodo.enable(r.list);
  const before = r.vault.file(r.list), t1 = r.id('tttt1'), rev = r.data.lists[r.list].rev;
  await r.anna('POST', `/todos/${t1}/comments`, { text: 'Ekologisk?' });
  const root = (await state(r)).comments[0];
  await r.anna('POST', `/todos/${t1}/comments`, { text: 'Ja', parent: root.id });
  r.log.length = 0;
  await r.dodo.tick();
  assert.equal(r.vault.file(r.list), before);
  assert.deepEqual(writes(r.log), []);
  assert.ok(r.data.lists[r.list].rev > rev);
  assert.equal(r.vault.notices.filter(n => /kommenterade/.test(n.text)).length, 1);
  assert.equal(r.vault.notices.at(-1)!.text, 'dodo: Anna kommenterade »mjölk« (och 1 till)');
  const th = r.dodo.threads(r.list, t1)!;
  assert.equal(th.threads.length, 1);
  assert.equal(th.threads[0].replies[0].text, 'Ja');
  const line = r.vault.file(r.list).split('\n').findIndex(l => l.includes('mjölk'));
  const [m] = r.dodo.commentLines(r.list, r.vault.file(r.list));
  assert.deepEqual(m, { line, id: t1, n: 2, fresh: true }, 'someone else, after the plugin was set up');
  r.dodo.markSeen(r.list, t1);
  assert.equal(r.dodo.commentLines(r.list, r.vault.file(r.list))[0].fresh, false);
  assert.equal(r.dodo.name(th.S, th.threads[0].root.user), 'Anna');
});

test('comments from before an old snapshot are fetched once; posting and resolving go to the server', async () => {
  const r = await mk(); await seed(r); await r.dodo.enable(r.list);
  const t2 = r.id('tttt2');
  delete r.data.lists[r.list].snap.comments; // a 0.2 snapshot
  await r.anna('POST', `/todos/${t2}/comments`, { text: 'gammal' });
  await r.dodo.tick();
  assert.equal(r.dodo.threads(r.list, t2)!.threads.length, 1);
  await r.dodo.comment(r.list, t2, 'från Obsidian');
  const root = r.dodo.threads(r.list, t2)!.threads[0].root;
  await r.dodo.comment(r.list, t2, 'svar', root.id);
  await r.dodo.resolve(r.list, root.id, true);
  const s = await state(r);
  assert.equal(s.comments.length, 3);
  assert.ok(s.comments.find((c: any) => c.id === root.id).resolved);
  assert.equal(r.dodo.threads(r.list, t2)!.threads[0].root.resolved != null, true);
  assert.equal(r.vault.notices.filter(n => /kommenterade/.test(n.text)).length, 0, 'own comments and the first full fetch are no news');
});

test('which todo a line belongs to: todo, its note and subtask, heading, text block, unsent line', async () => {
  const r = await mk();
  await r.anna('PUT', '/headings', [{ id: r.id('hhhh1'), level: 2, title: 'Del', who: [], notes: 'rubrikens anteckning' }]);
  await r.todo(r.id('tttt1'), 'första', { h: r.id('hhhh1'), pos: 1, notes: 'en anteckning', subs: [{ id: r.id('ssss1'), text: 'del', tags: [], who: [], due: null, prio: 0, done: false }] });
  await r.todo(r.id('tttt2'), 'andra', { h: r.id('hhhh1'), pos: 2 });
  await r.todo(r.id('tttt3'), '', { h: r.id('hhhh1'), pos: 3, md: true, notes: 'ett fritt stycke' });
  await r.dodo.enable(r.list);
  const f = r.vault.file(r.list), L = f.split('\n');
  const at = (needle: string, f2 = f) => r.dodo.todoAt(r.list, f2, f2.split('\n').findIndex(l => l.includes(needle)));
  assert.equal(at('rubrikens')!.kind, 'heading');
  assert.equal(at('## Del')!.kind, 'heading');
  assert.deepEqual(at('första'), { kind: 'todo', id: r.id('tttt1') });
  assert.deepEqual(at('en anteckning'), { kind: 'todo', id: r.id('tttt1') });
  assert.deepEqual(at('- [ ] del'), { kind: 'todo', id: r.id('tttt1') });
  assert.deepEqual(at('andra'), { kind: 'todo', id: r.id('tttt2') });
  assert.deepEqual(at('ett fritt'), { kind: 'block', id: r.id('tttt3') });
  assert.equal(r.dodo.todoAt(r.list, f, 0), null, 'frontmatter');
  assert.ok(L.length > 8);
  // typed, not sent: maps to nothing; an edited line still maps to its todo
  const typed = f + '\n- [ ] helt ny rad\n';
  assert.deepEqual(at('helt ny', typed), { kind: 'todo', id: null });
  assert.deepEqual(at('andra', typed), { kind: 'todo', id: r.id('tttt2') });
  assert.deepEqual(at('andra', f.replace('andra', 'andra och mer')) , { kind: 'todo', id: r.id('tttt2') });
  // a comment puts a marker on the todo's first line, not on its note
  await r.anna('POST', `/todos/${r.id('tttt1')}/comments`, { text: 'hej' });
  await r.dodo.tick();
  assert.deepEqual(r.dodo.commentLines(r.list, f).map(m => m.line), [L.findIndex(l => l.includes('första'))]);
  r.dodo.markSeen(r.list, r.id('tttt1'));
  assert.equal(r.data.seen[r.id('tttt1')] > '', true);
});
