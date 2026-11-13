import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
// "Slå ihop med en annan lista" in dodo (with and without merging of identical content) while both lists are notes in the vault, on one and two computers:
// A's note shows the merged content, B's note goes to Borttagna with the text the user had in it, nothing is created from it again, nothing in A is deleted.
import { Server, login, rig, state, fetchHttp, writes, sleep, type Rig } from './helpers.js';
import { Dodo, emptyData, tieOf } from '../src/sync.js';

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

const call = async (m: string, p: string, b?: any) => {
  const r = await fetch(srv.url + p, { method: m, headers: { authorization: 'Bearer ' + ses.boss, ...(b && { 'content-type': 'application/json' }) }, body: b && JSON.stringify(b) });
  return { status: r.status, json: await r.json().catch(() => null) as any };
};
const mk = async (same: boolean) => {
  const a = await rig(srv, `Hemma ${++n}`, ses), b = await rig(srv, `Jobbet ${n}`, ses);
  const head = (r: Rig) => r.anna('PUT', '/headings', [{ id: r.id('hhhh1'), level: 2, title: 'Mat', who: [], notes: '' }]);
  await head(a); await head(b);
  await a.todo(a.id('tttt1'), 'mjölk', { h: a.id('hhhh1'), pos: 1 }); await a.todo(a.id('tttt2'), 'bröd', { h: a.id('hhhh1'), pos: 2 });
  await b.todo(b.id('tttt1'), 'mjölk', { h: b.id('hhhh1'), pos: 1, notes: 'ekologisk' }); await b.todo(b.id('tttt2'), 'ägg', { h: b.id('hhhh1'), pos: 2 });
  await b.todo(b.id('tttt3'), 'lös', { pos: 3 });
  // both lists are notes in the one vault, on two computers (a second Dodo with its own data and the same files)
  await a.dodo.enable(a.list); await a.dodo.enable(b.list);
  const data = emptyData(); Object.assign(data, { url: srv.url, session: ses.boss, name: 'Boss', autoAdd: false });
  const second = new Dodo(data, { http: fetchHttp([]), host: a.vault, save: () => {}, openSettings: () => {} });
  await second.enable(a.list); await second.enable(b.list);
  return { a, b, second, same };
};
const files = (v: Map<string, string>, id: string) => [...v].filter(([, t]) => tieOf(t) === id).map(([p]) => p);

for (const same of [true, false]) {
  test(`merging B into A (identical content ${same ? 'merged' : 'kept'}): A's note is the merge, B's goes to Borttagna with its unsent text, nothing is recreated or lost, on two computers`, async () => {
    const { a, b, second } = await mk(same);
    const before = (await state(a)).todos.map((t: any) => t.id).sort();
    // text the user has in B's note that is not sent yet (typed in this session)
    const bp = a.vault.where(b.list)!;
    a.vault.edit(b.list, t => t + '\n- [ ] skrivet i B\n'); a.vault.typedIn.add(bp);
    const r = await call('POST', `/api/l/${a.list}/merge`, { from: b.list, name: a.data.lists[a.list].name, members: [], same });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.merged, same ? { headings: 1, todos: 1 } : { headings: 0, todos: 0 });
    a.log.length = 0;
    await a.dodo.flush(b.list).catch(() => {}); // the unsent line is pushed to B at once: dodo answers 404, nothing is created anywhere
    for (let i = 0; i < 4; i++) { await a.dodo.tick(); await second.tick(); await a.dodo.flush(a.list); await second.flush(a.list); await sleep(20); }
    const S = await state(a), texts = S.todos.map((t: any) => t.text).sort();
    // A on the server: everything it had, B's todos (merged or moved), and not one from B's unsent line
    for (const id of before) assert.ok(S.todos.some((t: any) => t.id === id), 'A kept ' + id);
    assert.deepEqual(texts, same ? ['bröd', 'lös', 'mjölk', 'ägg'].sort() : ['bröd', 'lös', 'mjölk', 'mjölk', 'ägg'].sort());
    assert.ok(!texts.includes('skrivet i B'), 'not created from B\'s old note');
    // A's note shows it
    const note = a.vault.file(a.list);
    assert.equal(note.split('mjölk').length - 1, same ? 1 : 2);
    assert.match(note, /ägg/); assert.match(note, /lös/);
    if (same) assert.match(S.todos.find((t: any) => t.id === a.id('tttt1')).notes, /Från listan «Jobbet \d+»:\*\nekologisk/);
    // B's note: no tied file outside Borttagna, and its text is there
    assert.deepEqual(files(a.vault.files, b.list).filter(p => !p.startsWith('dodo/Borttagna/')), []);
    const aside = files(a.vault.files, b.list);
    assert.equal(aside.length, 1, 'one file for B, set aside: ' + aside);
    assert.match(a.vault.files.get(aside[0])!, /skrivet i B/);
    assert.deepEqual(files(a.vault.files, a.list).length, 1); // one note for A, also with two computers
    // nothing was written to A that creates todos, and nothing is deleted there
    assert.deepEqual(writes(a.log).filter(l => l.method === 'DELETE' || l.path.includes(a.list)), []);
    assert.deepEqual((await call('GET', `/api/l/${a.list}/trash`)).json.todos.map((t: any) => t.id).sort(), same ? [b.id('tttt1')] : []);
    assert.equal(S.todos.filter((t: any) => t.text === 'skrivet i B').length, 0);
  });
}
