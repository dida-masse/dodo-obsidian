import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { nodeStream } from '../src/events.js';
import { Server, login, rig, sleep, type Rig } from './helpers.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
let srv: Server, ses: { boss: string; anna: string };
before(async () => {
  srv = await Server.create();
  srv.cli('user', 'add', 'boss@example.com', 'Boss', '--admin');
  srv.cli('user', 'add', 'anna@example.com', 'Anna');
  await srv.start();
  ses = { boss: await login(srv, 'boss@example.com'), anna: await login(srv, 'anna@example.com') };
});
after(async () => { await srv.stop(); srv.clean(); });

const load = createRequire(import.meta.url);
const until = async (f: () => boolean, ms: number) => { const t = Date.now(); while (!f() && Date.now() - t < ms) await sleep(20); return f(); };

test('the stream tells within a second that a list changed, and the note follows', async () => {
  const r: Rig = await rig(srv, 'Ström', ses);
  await r.dodo.enable(r.list);
  const got: any[] = [];
  const s = nodeStream(load)({ url: srv.url, session: ses.boss, onState: () => {}, onEvent: (n, d) => { got.push([n, d]); r.dodo.event(n, d); } });
  await sleep(200);
  const t0 = Date.now();
  await r.todo(r.id('stream1'), 'kom fort');
  assert.ok(await until(() => got.some(([n, d]) => n === 'rev' && d.list === r.list), 1000), 'rev event');
  assert.ok(await until(() => r.vault.file(r.list).includes('kom fort'), 1000), 'note updated');
  assert.ok(Date.now() - t0 < 1500);
  s.close();
});

test('the stream reconnects with backoff after the server was away, and stops when closed', async () => {
  const states: boolean[] = [];
  const s = nodeStream(load)({ url: srv.url, session: ses.boss, onState: u => states.push(u), onEvent: () => {} });
  assert.ok(await until(() => states.at(-1) === true, 2000));
  await srv.stop();
  assert.ok(await until(() => states.at(-1) === false, 2000));
  await srv.start();
  assert.ok(await until(() => states.at(-1) === true, 6000));
  s.close();
  assert.equal(states.at(-1), false);
  const n = states.length;
  await sleep(1500);
  assert.equal(states.length, n, 'closed: no more attempts');
});

test('a stream that goes silent is dropped (a computer that slept)', async () => {
  const states: boolean[] = [];
  const s = nodeStream(load, 300)({ url: srv.url, session: ses.boss, onState: u => states.push(u), onEvent: () => {} });
  assert.ok(await until(() => states.at(-1) === true, 2000));
  assert.ok(await until(() => states.includes(false), 1000), 'dropped after silence');
  s.close();
});
