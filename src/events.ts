// The server's event stream (GET /api/events: "rev" {list, by} when a list changes, "lists" when membership changes, "ping" every 25 s).
// requestUrl cannot stream, so this uses Node's http/https; `load` hands them over (Obsidian desktop: window.require, tests: createRequire).
export interface StreamOpts { url: string; session: string; version: string; onEvent(name: string, data: any): void; onState(up: boolean): void }
export type Stream = (o: StreamOpts) => { close(): void };

const SILENT_MS = 70e3; // the server pings every 25 s; quiet for longer means a dead socket (a laptop that slept)

export const nodeStream = (load: (m: string) => any, silentMs = SILENT_MS): Stream => o => {
  let req: any, closed = false, up = false, delay = 1000, retry: any, dog: any;
  const state = (v: boolean) => { if (v !== up) { up = v; o.onState(v); } };
  const again = () => {
    clearTimeout(dog); try { req?.destroy(); } catch { /* already gone */ }
    state(false);
    if (closed) return;
    clearTimeout(retry); retry = setTimeout(connect, delay);
    delay = Math.min(delay * 2, 30000);
  };
  const connect = () => {
    const u = new URL(o.url + '/api/events');
    const mod = load(u.protocol === 'https:' ? 'https' : 'http');
    let buf = '', name = '', done = false;
    const drop = () => { if (!done) { done = true; again(); } }; // a socket can report its end several times ('end', 'error', the watchdog): reconnect once, or the streams multiply
    req = mod.request(u, { headers: { authorization: 'Bearer ' + o.session, accept: 'text/event-stream', 'user-agent': 'dodo-obsidian/' + o.version } }, (res: any) => {
      if (res.statusCode !== 200) { res.resume(); return drop(); }
      delay = 1000; state(true);
      const watch = () => { clearTimeout(dog); dog = setTimeout(drop, silentMs); };
      watch();
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        watch();
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1);
          if (line.startsWith('event:')) name = line.slice(6).trim();
          else if (line.startsWith('data:') && name) { let d: any = null; try { d = JSON.parse(line.slice(5)); } catch { /* not json */ } o.onEvent(name, d); name = ''; }
          else if (!line) name = '';
        }
      });
      res.on('end', drop); res.on('error', drop);
    });
    req.on('error', drop);
    req.end();
  };
  connect();
  return { close() { closed = true; clearTimeout(retry); clearTimeout(dog); try { req?.destroy(); } catch { /* already gone */ } state(false); } };
};
