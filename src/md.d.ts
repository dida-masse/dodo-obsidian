/* eslint-disable @typescript-eslint/no-explicit-any */
export interface Md {
  parseBlock(lines: string[]): any;
  parseHeading(s: string): { title: string; who: string[] };
  serialize(t: any): string;
  docPlan(items: any[], text: string): any[];
  docText(items: any[]): string;
  blockText(t: any): string;
  splitDoc(text: string): any[];
  headingText(h: any): string;
  headingItem(h: any): string;
  ordKey(t: any): number;
}
// users: the array md.js reads people from; change its content in place
export function loadMd(users: any[], uid: () => string, lang: string): Md;
