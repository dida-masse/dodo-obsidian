// The server's event stream (GET /api/events: "rev" {list, by} when a list changes, "lists" when membership changes, "ping" every 25 s).
// requestUrl cannot stream, so this uses Node's http/https; `load` hands them over (Obsidian desktop: window.require, tests: createRequire).
export interface StreamOpts { url: string; session: string; version: string; onEvent(name: string, data: any): void; onState(up: boolean): void }
export type Stream = (o: StreamOpts) => { close(): void };

const SILENT_MS = 70e3; // the server pings every 25 s; quiet for longer means a dead socket (a laptop that slept)
const STABLE_MS = 60e3; // only a stream that lasted this long resets the wait: a proxy that answers 200 and cuts at once must not get a new connection every second

export const nodeStream = (load: (m: string) => any, silentMs = SILENT_MS): Stream => o => {
  let req: any, up = false, delay = 1000, retry: any, dog: any, live = 0;
  const state = (v: boolean) => { if (v !== up) { up = v; o.onState(v); } };
  // ends whatever exists: only the connection holding the number in `live` may act, so what an older one reports later is ignored
  const stop = () => { live++; clearTimeout(retry); clearTimeout(dog); try { req?.destroy(); } catch { /* already gone */ } };
  const again = () => {
    stop();
    retry = setTimeout(connect, delay);
    delay = Math.min(delay * 2, 30000);
    state(false);
  };
  const connect = () => {
    stop();
    const me = live, u = new URL(o.url + '/api/events');
    const mod = load(u.protocol === 'https:' ? 'https' : 'http');
    let buf = '', name = '', opened = Infinity;
    const drop = () => { // a socket can report its end several times ('end', 'error', the watchdog): reconnect once, or the streams multiply
      if (me !== live) return;
      if (Date.now() - opened >= STABLE_MS) delay = 1000;
      again();
    };
    req = mod.request(u, { headers: { authorization: 'Bearer ' + o.session, accept: 'text/event-stream', 'user-agent': 'dodo-obsidian/' + o.version } }, (res: any) => {
      if (me !== live || res.statusCode !== 200) { res.resume(); return drop(); }
      opened = Date.now();
      const watch = () => { clearTimeout(dog); dog = setTimeout(drop, silentMs); };
      watch();
      state(true);
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        if (me !== live) return;
        watch();
        buf += chunk;
        let i: number;
        while (me === live && (i = buf.indexOf('\n')) >= 0) {
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
  return { close() { stop(); state(false); } };
};
