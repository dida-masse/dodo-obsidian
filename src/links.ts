// [[Text|dodo:t/id]] links (dodo #225): t todo, h heading, l list. The file keeps dodo's text exactly; everything here only reads it or draws over it.
export const LINK = /\[\[([^\]\n|]+)\|dodo:([thl])\/([A-Za-z0-9_-]{4,64})\]\]/g;
export const KIND: Record<string, string> = { t: 'Uppgift', h: 'Rubrik', l: 'Lista' };
export type Info = { list: string; gone?: boolean };

export interface Found { from: number; to: number; text: string; ref: string }
export function parseLinks(text: string): Found[] {
  return [...text.matchAll(LINK)].map(m => ({ from: m.index!, to: m.index! + m[0].length, text: m[1], ref: m[2] + '/' + m[3] }));
}
// what Obsidian shows for [[Text|dodo:t/id]] in reading mode: an internal link to "Text" whose own text is the alias `dodo:t/id`
export const refOfAlias = (s: string) => /^dodo:([thl])\/([A-Za-z0-9_-]{4,64})$/.exec(s.trim())?.slice(1).join('/') ?? null;
// a line inside a fenced code block (or the fence itself): links there are text
export function fenced(lines: string[], n: number): boolean {
  let open = false;
  for (let i = 0; i <= n; i++) if (/^\s*(```|~~~)/.test(lines[i])) { if (i === n) return true; open = !open; }
  return open;
}
// the query typed after [[ : `Lista/ord` keeps to a list
export const splitQuery = (q: string) => { const i = q.indexOf('/'); return i < 0 ? { list: '', word: q } : { list: q.slice(0, i), word: q.slice(i + 1) }; };
