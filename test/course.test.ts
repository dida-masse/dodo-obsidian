// A course list: todos owned by a source (the Kursredan script), each with a table in its note between two markers that the
// server puts back if someone writes in it. These run the plugin against a real dodo with a source key syncing like the script does.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Server, login, rig, state, writes, type Rig } from './helpers.js';

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

const course = (code: string, reg = 10, heading = 'HT26 LP1') => ({ key: `capi:${code}:HT26:1`, text: `${code} Kurs ${code}`, heading,
  tags: ['termin/ht26', 'läsperiod/lp1', 'fart/50'],
  facts: [{ id: '1', title: 'ABC12', values: { Typ: 'Program', Prg: 'PAAD25h', UF: 'C', P: 25, R: reg, 'S%': 50 } }, { id: 'total', title: 'Totalt', values: { P: 25, R: reg } }] });
// the course script: a sync with a key, as examples/capi-kurser/sync.mjs does
const keys = new Map<string, string>(); // one key per list: the source removes only what it made itself
async function script(r: Rig, items: any[]) {
  const key = keys.get(r.list) ?? (await (await fetch(`${srv.url}/api/l/${r.list}/apikeys`, { method: 'POST', headers: { authorization: 'Bearer ' + ses.boss, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Kurser' + ++n, write: true }) })).json()).key;
  keys.set(r.list, key);
  const res = await fetch(`${srv.url}/api/l/${r.list}/sync`, { method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, body: JSON.stringify({ items, remove: true }) });
  assert.equal(res.status, 200);
  return res.json();
}
const mk = async (items: any[]) => { const r = await rig(srv, `Kurser ${++n}`, ses); await script(r, items); await r.dodo.enable(r.list); return r; };
const noise = (r: Rig) => r.vault.notices.filter(x => /Krock|Ändrades/i.test(x.text));
const todos = async (r: Rig) => (await state(r)).todos as any[];

test('a course list is written as a note: tags category/value, headings, and the table between its markers', async () => {
  const r = await mk([course('DV1')]);
  const t = r.vault.file(r.list);
  assert.match(t, /^# HT26 LP1$/m);
  assert.match(t, /- \[ \] DV1 Kurs DV1 #termin\/ht26 #läsperiod\/lp1 #fart\/50/);
  assert.match(t, /<!-- dodo:källa -->[\s\S]*\| \*\*ABC12\*\* \|[\s\S]*<!-- \/dodo:källa -->/);
  assert.match(t, /\| Typ \| Prg \| UF \| P \| R \| S% \|/);
  r.log.length = 0; await r.dodo.tick();
  assert.deepEqual(writes(r.log), [], 'reading it back changes nothing');
});

test('writing in the table: the server puts the source table back, once, with no loop, no krock comment and no cursor-jumping rewrite loop', async () => {
  const r = await mk([course('DV1')]);
  r.vault.edit(r.list, t => t.replace('| 25 | 10 |', '| 99 | 10 |').replace('Kurs DV1', 'Kurs DV1 min'));
  await r.dodo.flush(r.list);
  assert.match(r.vault.file(r.list), /\| 25 \| 10 \|/, 'the table is the source\'s again');
  assert.match(r.vault.file(r.list), /Kurs DV1 min/, 'the own text change stays');
  assert.deepEqual(noise(r), []);
  assert.equal((await (await state(r)).comments).length, 0);
  r.log.length = 0;
  await r.dodo.tick(); await r.dodo.tick();
  assert.deepEqual(writes(r.log), [], 'it settles');
});

test('only the table edited: the server writes it back and the note is the same afterwards', async () => {
  const r = await mk([course('DV1')]);
  const before = r.vault.file(r.list);
  r.vault.edit(r.list, t => t.replace('| 25 | 10 |', '| 99 | 10 |'));
  await r.dodo.flush(r.list);
  assert.equal(r.vault.file(r.list), before);
  assert.deepEqual(noise(r), []);
});

test('damaged markers: the table comes back and the own note below it is kept', async () => {
  const r = await mk([course('DV1')]);
  await (async () => { const x = (await todos(r))[0]; await r.anna('PUT', '/todos/' + x.id, { ...x, notes: x.notes + '\n\nMin anteckning' }); })();
  await r.dodo.tick();
  assert.match(r.vault.file(r.list), /Min anteckning/);
  r.vault.edit(r.list, t => t.replace('<!-- /dodo:källa -->', ''));
  await r.dodo.flush(r.list); await r.dodo.tick();
  assert.match(r.vault.file(r.list), /<!-- \/dodo:källa -->/);
  assert.match(r.vault.file(r.list), /Min anteckning/, 'what was written under the table is not lost');
  r.vault.edit(r.list, t => t.replace('<!-- dodo:källa -->', '').replace('<!-- /dodo:källa -->', ''));
  await r.dodo.flush(r.list); await r.dodo.tick();
  assert.match(r.vault.file(r.list), /Min anteckning/);
  assert.equal((r.vault.file(r.list).match(/<!-- dodo:källa -->/g) || []).length, 1, 'one block of the source');
  assert.equal((r.vault.file(r.list).match(/\| \*\*ABC12\*\*/g) || []).length, 1, 'and its table once, not the stray copy as well');
});

test('a course deleted in Obsidian goes in dodo; the script makes it again and the note gets it back, with no conflict', async () => {
  const r = await mk([course('DV1'), course('DV2')]);
  r.vault.edit(r.list, t => { const i = t.indexOf('- [ ] DV2'); const j = t.indexOf('<!-- /dodo:källa -->', i) + '<!-- /dodo:källa -->'.length; return t.slice(0, i) + t.slice(j); });
  await r.dodo.flush(r.list);
  assert.ok(!(await todos(r)).some(t => t.text.startsWith('DV2')));
  assert.deepEqual(noise(r), []);
  assert.equal((await script(r, [course('DV1'), course('DV2')])).created, 1);
  await r.dodo.tick();
  assert.match(r.vault.file(r.list), /- \[ \] DV2 Kurs DV2/);
  assert.deepEqual(noise(r), []);
});

test('a big refetch: many courses change at once, the note follows without sending anything, and the news stays short', async () => {
  const items = (reg: number) => Array.from({ length: 60 }, (_, i) => course('K' + String(i).padStart(2, '0'), reg));
  const r = await mk(items(10));
  r.log.length = 0;
  await script(r, items(20));
  await r.dodo.tick();
  assert.deepEqual(writes(r.log), []);
  assert.equal((r.vault.file(r.list).match(/\*\*20\*\* ← 10/g) || []).length, 120, 'two rows with a changed R in each course');
  assert.equal(r.dodo.status, 'ok');
  assert.deepEqual(noise(r), []);
  // a refetch that takes courses away: 60 gone from the list, which is the source's doing and is not held back as a mass deletion of mine
  await script(r, [course('K00', 20)]);
  r.log.length = 0; await r.dodo.tick();
  assert.deepEqual(writes(r.log), []);
  assert.equal((await todos(r)).length, 1);
  assert.doesNotMatch(r.vault.file(r.list), /K59/);
  assert.ok(!r.vault.notices.some(x => /Inget av anteckningen/.test(x.text) || /skulle tas bort/.test(x.text)));
});

test('ticking a course is kept while the data stays, and goes when the data changes, with the line in the note following', async () => {
  const r = await mk([course('DV1')]);
  r.vault.edit(r.list, t => t.replace('- [ ] DV1', '- [x] DV1'));
  await r.dodo.flush(r.list);
  assert.equal((await todos(r))[0].done, true);
  await script(r, [course('DV1')]); await r.dodo.tick();
  assert.match(r.vault.file(r.list), /- \[x\] DV1/);
  await script(r, [course('DV1', 12)]); await r.dodo.tick();
  assert.match(r.vault.file(r.list), /- \[ \] DV1/, 'a change of data unticks it');
  assert.match(r.vault.file(r.list), /\*\*12\*\* ← 10/);
  assert.deepEqual(noise(r), []);
});

test('a course moved under another heading in Obsidian is put back by the next fetch, quietly', async () => {
  const r = await mk([course('DV1'), course('DV2', 10, 'HT26 LP2')]);
  const r2 = r; // cut DV2 and paste it under the first heading
  r2.vault.edit(r2.list, t => { const i = t.indexOf('- [ ] DV2'); const j = t.indexOf('<!-- /dodo:källa -->', i) + '<!-- /dodo:källa -->'.length; const blk = t.slice(i, j); const rest = t.slice(0, i) + t.slice(j); return rest.replace('## HT26 LP2', '').replace(/(## HT26 LP1\n)/, `$1${blk}\n`); });
  await r2.dodo.flush(r2.list);
  await script(r2, [course('DV1'), course('DV2', 10, 'HT26 LP2')]); await r2.dodo.tick();
  const t = r2.vault.file(r2.list);
  assert.ok(t.indexOf('## HT26 LP2') < t.indexOf('- [ ] DV2'), 'back under its own heading');
  assert.deepEqual(noise(r2), []);
  assert.equal(r2.dodo.status, 'ok');
});

test('the editor: the marker block is found, typing inside it is refused, deleting the whole course and writing outside it are not', async () => {
  const { EditorState, Text } = await import('@codemirror/state');
  const { sourceBlocks, sourceExtension } = await import('../src/source.js');
  const doc = '- [ ] DV1\n  <!-- dodo:källa -->\n  | a | b |\n  <!-- /dodo:källa -->\n  min text\n';
  assert.deepEqual(sourceBlocks(Text.of(doc.split('\n'))), [[10, 66]]);
  assert.deepEqual(sourceBlocks(Text.of('  <!-- dodo:källa -->\n| a |\n'.split('\n'))), [], 'a damaged block is none, and nothing is refused in it');
  let told = 0;
  const st = EditorState.create({ doc, extensions: sourceExtension(() => told++) });
  const at = (from: number, to: number, ins: string, ev: string) => st.update({ changes: { from, to, insert: ins }, userEvent: ev }).state.doc.toString();
  assert.equal(at(30, 30, 'x', 'input.type'), doc, 'typed in the table: refused');
  assert.equal(at(22, 30, '', 'delete.selection'), doc, 'deleted in the table: refused');
  assert.equal(told, 2);
  assert.notEqual(at(doc.length - 1, doc.length - 1, 'x', 'input.type'), doc, 'typed below the block: allowed');
  assert.notEqual(at(0, 66, '', 'delete.selection'), doc, 'the whole course away: allowed');
  assert.notEqual(at(30, 30, 'x', 'set'), doc, 'the plugin\'s own writes carry no user event and pass');
});
