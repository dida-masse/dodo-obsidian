import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { nodeStream } from '../src/events.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const SILENT = 70e3, SERIES = 400, STEPS = 150;

// mulberry32: a fixed seed repeats a failure exactly
const random = (seed: number) => () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

// A clock and a transport the test controls: every timer and every connection can be counted after every step.
function world(rnd: () => number) {
  const real = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, now: Date.now };
  const timers = new Map<number, { at: number; ms: number; fn: () => void }>();
  const conns: any[] = [];
  let now = 1e6, ids = 0;
  (globalThis as any).setTimeout = (fn: () => void, ms: number) => { timers.set(++ids, { at: now + ms, ms, fn }); return ids; };
  (globalThis as any).clearTimeout = (id: number) => { timers.delete(id); };
  Date.now = () => now;
  const http = { request(_u: any, _o: any, cb: (res: any) => void) {
    const req: any = new EventEmitter(), c = { id: conns.length, req, cb, res: null as any, destroyed: false };
    req.end = () => {};
    req.destroy = () => { c.destroyed = true; if (rnd() < 0.5) req.emit('error', new Error('socket hang up')); }; // some sockets report their own destruction at once
    conns.push(c);
    return req;
  } };
  return {
    conns, timers, load: () => http,
    open: () => conns.filter(c => !c.destroyed).length,
    retries: () => [...timers.values()].filter(t => t.ms !== SILENT).length,
    dogs: () => [...timers.values()].filter(t => t.ms === SILENT).length,
    advance(ms: number, each: () => void = () => {}) {
      const end = now + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]); now = Math.max(now, next[1].at); next[1].fn(); each();
      }
      now = end;
    },
    restore() { Object.assign(globalThis, { setTimeout: real.setTimeout, clearTimeout: real.clearTimeout }); Date.now = real.now; },
  };
}

function respond(c: any, status: number) {
  if (c.res) return;
  c.res = new EventEmitter();
  c.res.statusCode = status; c.res.setEncoding = () => {}; c.res.resume = () => {};
  c.cb(c.res);
}
const emit = (e: EventEmitter, name: string) => { if (name !== 'error' || e.listenerCount('error')) e.emit(name, new Error('aborted')); }; // like Node: an unheard 'error' on a response is dropped

// One thing the network might do, to the newest connection or to an old one that should long be forgotten.
function act(w: ReturnType<typeof world>, rnd: () => number, each: () => void) {
  const pick = rnd() < 0.7 ? w.conns.at(-1) : w.conns[Math.floor(rnd() * w.conns.length)];
  const roll = rnd();
  if (roll < 0.3) return w.advance([0, 500, 1000, 5000, 31000, SILENT + 1][Math.floor(rnd() * 6)], each);
  if (roll < 0.5) return respond(pick, rnd() < 0.7 ? 200 : rnd() < 0.5 ? 502 : 504);
  if (roll < 0.65) return pick.res?.emit('data', `event: rev\ndata: {"c":${pick.id}}\n\nevent: rev\ndata: {"c":${pick.id}}\n\n`);
  if (roll < 0.85) return pick.res && emit(pick.res, ['end', 'error', 'close', 'aborted'][Math.floor(rnd() * 4)]);
  emit(pick.req, rnd() < 0.7 ? 'error' : 'close');
}

function series(seed: number) {
  const rnd = random(seed), w = world(rnd), where = () => `seed ${seed}`;
  const events: number[] = [], states: boolean[] = [];
  let closed = false, s: { close(): void };
  const closesItself = rnd() < 0.1;
  const check = () => {
    assert.ok(w.open() <= 1, `${where()}: ${w.open()} open connections`);
    assert.ok(w.retries() <= 1, `${where()}: ${w.retries()} waiting reconnects`);
    assert.ok(w.dogs() <= 1, `${where()}: ${w.dogs()} watchdogs`);
    assert.ok(w.open() + w.retries() <= 1, `${where()}: a waiting reconnect beside an open connection`);
  };
  try {
    s = nodeStream(w.load, SILENT)({ url: 'http://dodo.test', session: 'x', version: '0',
      onState: up => { assert.ok(!closed || !up, `${where()}: came up after close()`); states.push(up); },
      onEvent: (_n, d) => {
        assert.ok(!closed, `${where()}: event after close()`);
        assert.equal(d.c, w.conns.length - 1, `${where()}: event from an old connection`);
        events.push(d.c);
        if (closesItself && rnd() < 0.05) { closed = true; s.close(); }
      } });
    check();
    for (let i = 0; i < STEPS && !closed; i++) { act(w, rnd, check); check(); }
    if (!closed) { closed = true; s.close(); }
    assert.equal(w.open(), 0, `${where()}: open connection after close()`);
    assert.equal(w.timers.size, 0, `${where()}: timer after close()`);
    assert.equal(states.at(-1) ?? false, false, `${where()}: still up after close()`);
    const seen = [w.conns.length, events.length, states.length];
    for (let i = 0; i < 30; i++) act(w, rnd, check);
    w.advance(10 * SILENT);
    assert.deepEqual([w.conns.length, events.length, states.length], seen, `${where()}: something happened after close()`);
    assert.equal(w.timers.size, 0, `${where()}: timer after close()`);
  } finally { w.restore(); }
}

test(`${SERIES} random series of network events: at most one connection, one reconnect, and nothing after close()`, () => {
  for (let seed = 1; seed <= SERIES; seed++) series(seed);
});

test('a server that answers 200 and cuts at once is met with growing waits; a stream that lasted starts over at 1 s', () => {
  const w = world(() => 1);
  try {
    const s = nodeStream(w.load, SILENT)({ url: 'http://dodo.test', session: 'x', version: '0', onState: () => {}, onEvent: () => {} });
    const waits: number[] = [];
    const cut = () => { const c = w.conns.at(-1); respond(c, 200); c.res.emit('end'); waits.push(w.timers.values().next().value!.ms); w.advance(waits.at(-1)!); };
    for (let i = 0; i < 7; i++) cut();
    assert.deepEqual(waits, [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    const c = w.conns.at(-1);
    respond(c, 200);
    w.advance(60e3);
    c.res.emit('end');
    assert.equal(w.timers.values().next().value!.ms, 1000);
    s.close();
  } finally { w.restore(); }
});
