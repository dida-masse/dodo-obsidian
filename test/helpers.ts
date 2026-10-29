// A real dodo server (from ../dodo, in a temp data dir), a fake vault and an http function that logs what was sent.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Dodo, emptyData, freeName, listIdOf, type Data, type Host, type Http, type Note } from '../src/sync.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dodo/server.js');
export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const freePort = () => new Promise<number>(res => { const s = createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => res(p)); }); });

export class Server {
  proc?: ChildProcess;
  constructor(public port: number, public dir: string) {}
  get url() { return `http://127.0.0.1:${this.port}`; }
  get env() { return { ...process.env, DATA_DIR: this.dir, PORT: String(this.port), BASE_URL: this.url, BACKUP_DAYS: '0', HOST: '127.0.0.1', NTFY_URL: 'http://127.0.0.1:9', IDENTITY_HEADER: '' }; }
  static async create() { return new Server(await freePort(), mkdtempSync(path.join(tmpdir(), 'dodo-obs-'))); }
  // server CLI against the same data dir; returns parsed --json output
  cli(...args: string[]) {
    const r = spawnSync('node', [SERVER, ...args, '--json'], { env: this.env, encoding: 'utf8' });
    if (r.status) throw new Error(r.stderr);
    return JSON.parse(r.stdout);
  }
  async start() {
    this.proc = spawn('node', [SERVER], { env: this.env, stdio: 'ignore' });
    for (let i = 0; i < 100; i++) { try { await fetch(this.url + '/api/lists'); return; } catch { await sleep(50); } }
    throw new Error('server did not start');
  }
  async stop() { const p = this.proc; if (!p) return; p.kill(); await new Promise(r => p.once('exit', r)); this.proc = undefined; }
  clean() { rmSync(this.dir, { recursive: true, force: true }); }
}

export type Log = { method: string; path: string }[];
export function fetchHttp(log: Log = []): Http {
  return async r => {
    const res = await fetch(r.url, { method: r.method, headers: r.headers, body: r.body });
    log.push({ method: r.method, path: new URL(r.url).pathname });
    const text = await res.text();
    let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json };
  };
}
export const writes = (log: Log) => log.filter(l => l.method !== 'GET');

// a vault of files in a map; notes are found by their `dodo:` frontmatter, like main.ts does
export class FakeVault implements Host {
  files = new Map<string, string>();
  notices: { text: string; action?: any }[] = [];
  answer = true;
  asked: string[] = [];
  private path(id: string) { return [...this.files].find(([, t]) => listIdOf(t.match(/^---\n[\s\S]*?^dodo:\s*(\S+)/m)?.[1]) === id)?.[0]; }
  note(id: string): Note | null {
    const p = this.path(id);
    return p ? { read: async () => this.files.get(p)!, replace: async (from, to) => { if (this.files.get(p) !== from) return false; this.files.set(p, to); return true; } } : null;
  }
  file(id: string) { return this.files.get(this.path(id)!)!; }
  edit(id: string, f: (t: string) => string) { this.files.set(this.path(id)!, f(this.file(id))); }
  async move(id: string, dir: string) {
    const from = this.path(id)!, stem = from.split('/').pop()!.replace(/\.md$/, '');
    const to = freeName(dir, stem, p => this.exists(p)).path;
    this.files.set(to, this.files.get(from)!); this.files.delete(from);
  }
  async rename(id: string, stem: string) {
    const from = this.path(id)!, dir = from.split('/').slice(0, -1).join('/');
    const to = freeName(dir, stem, p => p !== from && this.exists(p)).path;
    const t = this.files.get(from)!; this.files.delete(from); this.files.set(to, t);
  }
  base(id: string) { const p = this.path(id); return p ? p.split('/').pop()!.replace(/\.md$/, '') : null; }
  exists(p: string) { return this.files.has(p); }
  async create(p: string, text: string) { this.files.set(p, text); return this.note(listIdOf(text.match(/dodo:\s*(\S+)/)![1])!)!; }
  notice(text: string, action?: any) { this.notices.push({ text, action }); }
  async confirm(text: string) { this.asked.push(text); return this.answer; }
}

export interface Rig { id: (s: string) => string; srv: Server; log: Log; vault: FakeVault; dodo: Dodo; data: Data; list: string; anna: (m: string, p: string, b?: any) => Promise<any>; todo: (id: string, text: string, extra?: any) => Promise<any> }
export async function login(srv: Server, email: string) {
  const r = await fetch(srv.cli('link', email).url, { method: 'POST', headers: { accept: 'application/json' } });
  return (await r.json()).session as string;
}
// a new list owned by boss, with anna in it, and a Dodo logged in as boss with its own vault
export async function rig(srv: Server, name: string, sessions: { boss: string; anna: string }): Promise<Rig> {
  const list = srv.cli('list', 'create', name, '--owner', 'boss@example.com').id;
  srv.cli('member', 'add', list, 'anna@example.com');
  const log: Log = [], vault = new FakeVault(), data = emptyData();
  Object.assign(data, { url: srv.url, session: sessions.boss, name: 'Boss', autoAdd: false });
  const dodo = new Dodo(data, { http: fetchHttp(log), host: vault, save: () => {}, openSettings: () => {} });
  const anna = async (m: string, p: string, b?: any) => {
    const r = await fetch(`${srv.url}/api/l/${list}${p}`, { method: m, headers: { authorization: 'Bearer ' + sessions.anna, ...(m !== 'GET' && { 'content-type': 'application/json' }) }, body: b === undefined ? undefined : JSON.stringify(b) });
    return r.status === 204 ? null : r.json();
  };
  const todo = (id: string, text: string, extra: any = {}) => anna('PUT', '/todos/' + id, { id, text, tags: [], who: [], due: null, prio: 0, done: false, notes: '', subs: [], h: null, ...extra });
  return { id: s => s + list, srv, log, vault, dodo, data, list, anna, todo };
}
export const state = async (r: Rig) => (await r.anna('GET', '/state')) as any;
