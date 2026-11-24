// [[Text|dodo:t/id]] links (dodo #225): the pure parts, and that a note full of links goes to dodo and back without one change.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fenced, parseLinks, refOfAlias, splitQuery } from '../src/links.js';
import { Server, login, rig, state, sleep, type Rig } from './helpers.js';
import { split } from '../src/sync.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
test('parseLinks finds the three kinds with their text and ref, and nothing else', () => {
  const t = 'a [[Mjölk|dodo:t/abcd1234]] b [[Inköp|dodo:h/h_h-1234]] c [[Hem|dodo:l/LLLL9999]] [[vanlig]] [[x|y]] [[Kort|dodo:t/ab]] [[ [[A|dodo:x/abcd]]';
  const f = parseLinks(t);
  assert.deepEqual(f.map(x => [x.text, x.ref]), [['Mjölk', 't/abcd1234'], ['Inköp', 'h/h_h-1234'], ['Hem', 'l/LLLL9999']]);
  assert.equal(t.slice(f[0].from, f[0].to), '[[Mjölk|dodo:t/abcd1234]]');
});
test('refOfAlias reads the text Obsidian shows in reading mode; fenced and splitQuery', () => {
  assert.equal(refOfAlias('dodo:t/abcd1234'), 't/abcd1234');
  assert.equal(refOfAlias(' dodo:l/abcd '), 'l/abcd');
  assert.equal(refOfAlias('annat'), null);
  assert.equal(refOfAlias('dodo:t/ab'), null);
  const lines = ['a', '```', '[[x|dodo:t/abcd]]', '```', 'b'];
  assert.deepEqual(lines.map((_, i) => fenced(lines, i)), [false, true, true, true, false]);
  assert.deepEqual(splitQuery('Hem/mjö'), { list: 'Hem', word: 'mjö' });
  assert.deepEqual(splitQuery('mjö'), { list: '', word: 'mjö' });
});

let srv: Server, ses: { boss: string; anna: string; out: string }, n = 0;
before(async () => {
  srv = await Server.create();
  srv.cli('user', 'add', 'boss@example.com', 'Boss', '--admin');
  srv.cli('user', 'add', 'anna@example.com', 'Anna');
  srv.cli('user', 'add', 'out@example.com', 'Out');
  await srv.start();
  ses = { boss: await login(srv, 'boss@example.com'), anna: await login(srv, 'anna@example.com'), out: await login(srv, 'out@example.com') };
});
after(async () => { await srv.stop(); srv.clean(); });

// two lists boss is in (A with a note, B), and a list boss is not in
const mk = async () => {
  const a = await rig(srv, `Hem ${++n}`, ses), b = await rig(srv, `Jobb ${n}`, ses);
  const out = srv.cli('list', 'create', `Annans ${n}`, '--owner', 'anna@example.com').id;
  await b.anna('PUT', '/headings', [{ id: b.id('hhhh1'), level: 2, title: 'Veckan', who: [], notes: '' }]);
  await b.todo(b.id('tttt1'), 'rapport' + n, { h: b.id('hhhh1'), pos: 1 });
  await b.todo(b.id('tttt2'), 'raderas', { pos: 2 });
  await fetch(`${srv.url}/api/l/${out}/todos/hemlig${n}`, { method: 'PUT', headers: { authorization: 'Bearer ' + ses.anna, 'content-type': 'application/json' }, body: JSON.stringify({ id: 'hemlig' + n, text: 'annansx' + 'n', tags: [], who: [], due: null, prio: 0, done: false, notes: '', subs: [], h: null }) });
  await b.anna('DELETE', '/todos/' + b.id('tttt2'));
  return { a, b, out };
};
const L = (kind: string, id: string, text: string) => `[[${text}|dodo:${kind}/${id}]]`;

test('a note whose todos and headings hold links goes to dodo and back unchanged: no PUT, no DELETE, same text', async () => {
  const { a, b, out } = await mk();
  const links = [L('t', b.id('tttt1'), 'rapport'), L('h', b.id('hhhh1'), 'Veckan'), L('l', b.list, 'Jobb'), L('t', 'hemlig' + n, 'annans'), L('t', b.id('tttt2'), 'raderas'), L('t', 'finnsinte1', 'saknas')];
  await a.anna('PUT', '/headings', [{ id: a.id('hhhh1'), level: 2, title: 'Se ' + L('l', b.list, 'Jobb'), who: [], notes: '' }]);
  await a.todo(a.id('tttt1'), 'läs ' + links[0] + ' och ' + links[3], { h: a.id('hhhh1'), pos: 1 });
  await a.todo(a.id('tttt2'), 'även ' + links[1] + ' ' + links[2] + ' ' + links[4] + ' ' + links[5], { h: a.id('hhhh1'), pos: 2 });
  await a.dodo.enable(a.list);
  const text = split(a.vault.file(a.list)).text;
  for (const l of links) assert.ok(text.includes(l), 'the note keeps ' + l);
  const before = a.vault.file(a.list), todos = (await state(a)).todos.map((t: any) => t.text);
  a.log.length = 0;
  // a quiet note, then an edit elsewhere in it: only that goes to dodo, the links are never part of a change
  for (let i = 0; i < 3; i++) { await a.dodo.tick(); await a.dodo.flush(a.list); await sleep(10); }
  assert.equal(a.vault.file(a.list), before);
  assert.deepEqual(a.log.filter(l => l.method !== 'GET'), []);
  a.vault.edit(a.list, t => t + '- [ ] ny rad\n');
  await a.dodo.flush(a.list);
  assert.ok(a.log.some(l => l.method === 'PUT'), 'the edit goes');
  const S = await state(a);
  assert.deepEqual(S.todos.map((t: any) => t.text).sort(), [...todos, 'ny rad'].sort());
  assert.equal(S.headings.find((h: any) => h.id === a.id('hhhh1')).title, 'Se ' + links[2]);
  for (const l of split(a.vault.file(a.list)).text.split('\n')) if (l.includes('dodo:')) assert.ok(links.some(k => l.includes(k)) || l.includes('Se '), l);
  void out;
});

test('linkInfo answers for what is mine, leaves out the rest alike, marks deleted, and forgets at logout', async () => {
  const { a, b } = await mk();
  a.data.session = await login(srv, 'boss@example.com'); // its own session: logging out ends it on the server
  const refs = ['t/' + b.id('tttt1'), 'h/' + b.id('hhhh1'), 'l/' + b.list, 't/hemlig' + n, 't/finnsinte1', 't/' + b.id('tttt2'), 'x/y'];
  const info = await a.dodo.linkInfo(refs);
  assert.deepEqual(info, [{ list: b.list }, { list: b.list }, { list: b.list }, null, null, { list: b.list, gone: true }, null]);
  assert.deepEqual(a.dodo.linkKnown(refs[0]), { list: b.list });
  assert.equal(a.dodo.linkKnown('t/aldrigfrågad'), undefined);
  // the same cache serves the second ask: no new request for it
  const asked = a.log.length; await a.dodo.linkInfo([refs[0]]);
  assert.equal(a.log.length, asked);
  await a.dodo.logout();
  assert.equal((a.dodo as any).links.size, 0);
  assert.equal(a.dodo.linkKnown(refs[0]), undefined);
  assert.deepEqual(await a.dodo.linkInfo(refs), refs.map(() => undefined)); // logged out: no answer, no request
});

test('itemLine: where a todo or heading is in the note; linkAt: the link to copy, or why there is none', async () => {
  const { a, b } = await mk();
  await a.anna('PUT', '/headings', [{ id: a.id('hhhh1'), level: 2, title: 'Mat', who: [], notes: '' }]);
  await a.todo(a.id('tttt1'), 'mjölk', { h: a.id('hhhh1'), pos: 1 });
  await a.dodo.enable(a.list);
  const file = a.vault.file(a.list), lines = file.split('\n');
  const at = (s: string) => lines.findIndex(l => l.includes(s));
  assert.equal(a.dodo.itemLine(a.list, file, a.id('tttt1')), at('mjölk'));
  assert.equal(a.dodo.itemLine(a.list, file, a.id('hhhh1')), at('## Mat'));
  assert.equal(a.dodo.itemLine(a.list, file, 'finnsinte'), -1);
  assert.deepEqual(a.dodo.linkAt(a.list, file, at('mjölk')), { link: L('t', a.id('tttt1'), 'mjölk') });
  assert.deepEqual(a.dodo.linkAt(a.list, file, at('## Mat')), { link: L('h', a.id('hhhh1'), 'Mat') });
  assert.equal(a.dodo.listLink(a.list), L('l', a.list, a.data.lists[a.list].name));
  assert.match((a.dodo.linkAt(a.list, file, 0) as any).why, /markören/); // the frontmatter
  const typed = file + '- [ ] helt ny\n';
  assert.match((a.dodo.linkAt(a.list, typed, typed.split('\n').findIndex(l => l.includes('helt ny'))) as any).why, /inte skickad/);
  assert.equal(a.dodo.dodoLink('t', 'abcd', 'a [b] | c\nd'), '[[a b c d|dodo:t/abcd]]');
  void b;
});

test('linkSearch: this list first, then the other lists, then what is in them; Lista/ keeps to one list; nothing from lists that are not mine', async () => {
  const { a, b } = await mk();
  await a.todo(a.id('tttt1'), `rapport${n} hemma`, { pos: 1 });
  await a.dodo.enable(a.list);
  const kinds = async (q: string) => (await a.dodo.linkSearch(a.list, q)).map(x => `${x.kind}:${x.text}:${x.list === a.list ? 'A' : x.list === b.list ? 'B' : '?'}:${x.listName}`);
  const bn = a.data.lists[a.list] ? (await a.dodo.lists()).find(l => l.id === b.list)!.name : '';
  const w = 'rapport' + n;
  assert.deepEqual(await kinds(w), [`t:${w} hemma:A:` + (await a.dodo.lists()).find(l => l.id === a.list)!.name, `t:${w}:B:${bn}`]);
  assert.deepEqual((await kinds(bn))[0], `l:${bn}:B:`);
  assert.deepEqual(await kinds(bn + '/rapp'), [`t:${w}:B:${bn}`]);
  assert.deepEqual(await kinds('annansxn'), []);
  assert.deepEqual(await kinds('finnsinte/x'), []);
  assert.ok((await a.dodo.linkSearch('', w)).length === 2); // from a note that is no dodo note: no "this list"
});
