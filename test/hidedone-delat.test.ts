import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
// Two computers on one vault with different "hide done" settings (and a note deleted meanwhile) must neither create nor delete done todos.
import { Server, login, rig, state, fetchHttp, writes } from './helpers.js';
import { Dodo, emptyData } from '../src/sync.js';
let srv: Server, ses: any;
before(async () => { srv = await Server.create(); srv.cli('user', 'add', 'boss@example.com', 'Boss', '--admin'); srv.cli('user', 'add', 'anna@example.com', 'Anna'); await srv.start(); ses = { boss: await login(srv, 'boss@example.com'), anna: await login(srv, 'anna@example.com') }; });
after(async () => { await srv.stop(); srv.clean(); });
const setup = async (ha: boolean, hb: boolean, tag: string) => {
  const r = await rig(srv, tag + ha + hb, ses); r.data.hideDone = ha;
  const key = (await (await fetch(`${srv.url}/api/l/${r.list}/apikeys`, { method: 'POST', headers: { authorization: 'Bearer ' + ses.boss, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'K', write: true }) })).json()).key;
  const items = ['DV1', 'DV2', 'DV3', 'DV4', 'DV5', 'DV6'].map((c, i) => ({ key: 'capi:' + c, text: c + ' · Platser –', done: i % 2 === 0 ? true : undefined, tags: ['termin/ht26'], facts: [{ id: 'total', title: 'Totalt', values: { P: 25, R: i } }] }));
  await fetch(`${srv.url}/api/l/${r.list}/sync`, { method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, body: JSON.stringify({ items, remove: true }) });
  await r.dodo.enable(r.list);
  const blog: any[] = []; const data = emptyData(); Object.assign(data, { url: srv.url, session: ses.boss, name: 'Boss', autoAdd: false, hideDone: hb });
  const b = new Dodo(data, { http: fetchHttp(blog), host: r.vault, save: () => {}, openSettings: () => {} });
  await b.enable(r.list);
  const cnt = async () => { const t = (await state(r)).todos as any[]; return [t.length, t.filter(x => x.done).length]; };
  return { r, a: r.dodo as Dodo, b, cnt, hist: [await cnt()] };
};
const loop = async (w: Awaited<ReturnType<typeof setup>>, n = 20) => {
  for (let i = 0; i < n; i++) { await (i % 2 ? w.b : w.a).flush(w.r.list); await (i % 2 ? w.a : w.b).tick(); w.hist.push(await w.cnt()); }
  console.log(w.hist.map(h => h.join('/')).join(' '));
  for (const [t, d] of w.hist) { assert.ok(t <= 7 && d === 3 && t >= 6, 'todos/done: ' + w.hist.join(' ')); } // 7 = the one line typed below
};
for (const [ha, hb] of [[true, false], [false, true], [true, true], [false, false]]) {
  test(`A hide=${ha} B hide=${hb}: no growth, no loss`, async () => {
    const w = await setup(ha, hb, 'S');
    w.r.vault.edit(w.r.list, t => t + '\n- [ ] min egen\n');
    await loop(w);
  });
  for (const who of ['a', 'b'] as const) test(`note deleted on A, recreated by ${who}, A hide=${ha} B hide=${hb}`, async () => {
    const w = await setup(ha, hb, 'D');
    w.r.vault.files.delete(w.r.vault.where(w.r.list)!);
    await w.a.tick(); await w.b.tick();
    await w[who].enable(w.r.list);
    await loop(w);
  });
}
test('a new done line is still a new todo when done todos are hidden', async () => {
  const w = await setup(true, true, 'N');
  w.r.vault.edit(w.r.list, t => t + '\n- [x] helt ny\n');
  await w.a.flush(w.r.list);
  assert.deepEqual(await w.cnt(), [7, 4]);
});
test('more than 50 new todos in one push are held', async () => {
  const w = await setup(false, false, 'M');
  w.r.vault.edit(w.r.list, t => t + '\n' + Array.from({ length: 60 }, (_, i) => `- [ ] ny ${i}`).join('\n') + '\n');
  await w.a.flush(w.r.list);
  assert.deepEqual(await w.cnt(), [6, 3]);
  assert.ok(w.r.vault.notices.length > 0);
});
