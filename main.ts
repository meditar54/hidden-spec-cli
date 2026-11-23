// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// It does all of SPEC.md: the command line, the output and exit codes, safe paths, format detection
// (section 4), line matching at three tiers (section 5), unified diffs (section 6), SEARCH/REPLACE
// blocks (section 7), V4A patches (section 8), JSON edits (section 9) and the all-or-nothing write
// (section 10).
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands
// over to runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and
// write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/* ------------------------------------------------------------------ */
/* Files as lines (SPEC.md section 3)                                  */
/* ------------------------------------------------------------------ */

interface FileModel {
  lines: string[];
  br: '\r\n' | '\n';
  final: boolean;
}

function splitFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

/* ------------------------------------------------------------------ */
/* Matching lines (SPEC.md section 5)                                  */
/* ------------------------------------------------------------------ */

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => (/^[ \t]*/.exec(s) ?? [''])[0]!;

function lineEq(tier: number, a: string, b: string): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimWs(a) === trimWs(b);
}

/** All 0-based positions at or after `from` where `pat` occurs at `tier`. */
function findOccs(lines: string[], pat: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (pat.length === 0) return out;
  for (let i = from; i + pat.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < pat.length; j++) {
      if (!lineEq(tier, lines[i + j]!, pat[j]!)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, 1, 2; 0 only with --strict) at which `pat` occurs, with its positions. */
function findTier(lines: string[], pat: string[], strict: boolean, from = 0): { tier: number; occs: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const occs = findOccs(lines, pat, t, from);
    if (occs.length > 0) return { tier: t, occs };
  }
  return null;
}

/** One line of N: `text`, and for a context line the index of its line in O (`ctx`). */
interface NItem {
  text: string;
  ctx: number | null;
}

function reindent(text: string, f: string, p: string): string {
  if (text === '' || text.trim() === '') return text;
  return text.startsWith(p) ? f + text.slice(p.length) : text;
}

/** The lines that replace a matched span: context lines are the file's own, tier 2 re-indents the rest. */
function buildReplacement(items: NItem[], fileLines: string[], pos: number, tier: number, oLines: string[]): string[] {
  const f = leadWs(fileLines[pos] ?? '');
  const p = oLines.length > 0 ? leadWs(oLines[0]!) : '';
  return items.map((it) => {
    if (it.ctx !== null) return fileLines[pos + it.ctx]!;
    return tier === 2 ? reindent(it.text, f, p) : it.text;
  });
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ------------------------------------------------------------------ */
/* JSON edits (SPEC.md section 9) — as the kit shipped them            */
/* ------------------------------------------------------------------ */

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                   */
/* ------------------------------------------------------------------ */

interface UBodyLine {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
  raw: string;
}
interface UHunk {
  a: number;
  body: UBodyLine[];
}
interface USection {
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  gitOld: string | undefined;
  gitNew: string | undefined;
  isCreate: boolean;
  isDelete: boolean;
  hunks: UHunk[];
}

function hdrPath(l: string): string | null {
  let t = l.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/')) t = t.slice(2);
  else if (t.startsWith('b/')) t = t.slice(2);
  return t;
}

const DIFFGIT = /^diff --git a\/(\S+) b\/(\S+)$/;
const HUNKHEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@( .*)?$/;

function parseDiffGit(l: string, lineNo: number): { old: string; nw: string } {
  const m = DIFFGIT.exec(l);
  if (m === null) throw new Exit2(`error: parse ${lineNo}`);
  return { old: m[1]!, nw: m[2]! };
}

function parseHunkHead(l: string, lineNo: number): number {
  const m = HUNKHEAD.exec(l);
  if (m === null) throw new Exit2(`error: parse ${lineNo}`);
  return parseInt(m[1]!, 10);
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  const newSection = (): USection => {
    const s: USection = {
      pairOld: undefined,
      pairNew: undefined,
      renameFrom: undefined,
      renameTo: undefined,
      gitOld: undefined,
      gitNew: undefined,
      isCreate: false,
      isDelete: false,
      hunks: [],
    };
    sections.push(s);
    return s;
  };
  let cur: USection | null = null;
  let state: 'out' | 'hdr' | 'between' = 'out';
  let i = 0;
  const n = lines.length;

  /** A hunk body starting at lines[i] (the first body line); advances i past it. */
  const readBody = (): UBodyLine[] => {
    const body: UBodyLine[] = [];
    while (i < n) {
      const l = lines[i]!;
      if (l.startsWith('diff --git ')) break;
      if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
      if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
        body.push({
          kind: l === '' ? 'ctx' : l[0] === ' ' ? 'ctx' : l[0] === '-' ? 'old' : l[0] === '+' ? 'new' : 'bs',
          text: l === '' ? '' : l.slice(1),
          raw: l,
        });
        i++;
        continue;
      }
      break;
    }
    while (body.length > 0 && body[body.length - 1]!.raw === '') body.pop();
    return body;
  };

  while (i < n) {
    const l = lines[i]!;
    if (state === 'out') {
      if (l.startsWith('diff --git ')) {
        const g = parseDiffGit(l, i + 1);
        cur = newSection();
        cur.gitOld = g.old;
        cur.gitNew = g.nw;
        state = 'hdr';
        i++;
        continue;
      }
      if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        cur = newSection();
        cur.pairOld = hdrPath(l);
        cur.pairNew = hdrPath(lines[i + 1]!);
        state = 'hdr';
        i += 2;
        continue;
      }
      if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i++;
      continue;
    }
    if (state === 'hdr') {
      if (l.startsWith('diff --git ')) {
        const g = parseDiffGit(l, i + 1);
        cur = newSection();
        cur.gitOld = g.old;
        cur.gitNew = g.nw;
        state = 'hdr';
        i++;
        continue;
      }
      if (l.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          cur!.pairOld = hdrPath(l);
          cur!.pairNew = hdrPath(lines[i + 1]!);
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (l.startsWith('+++ ')) {
        cur!.pairNew = hdrPath(l);
        i++;
        continue;
      }
      if (l.startsWith('rename from ')) {
        if (cur!.renameFrom === undefined) cur!.renameFrom = l.slice(12).trim();
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        if (cur!.renameTo === undefined) cur!.renameTo = l.slice(10).trim();
        i++;
        continue;
      }
      if (l === 'new file mode' || l.startsWith('new file mode ')) {
        cur!.isCreate = true;
        i++;
        continue;
      }
      if (l === 'deleted file mode' || l.startsWith('deleted file mode ')) {
        cur!.isDelete = true;
        i++;
        continue;
      }
      if (l.startsWith('@@')) {
        const a = parseHunkHead(l, i + 1);
        i++;
        cur!.hunks.push({ a, body: readBody() });
        state = 'between';
        continue;
      }
      i++;
      continue;
    }
    // between hunks of a section
    if (l.startsWith('diff --git ')) {
      const g = parseDiffGit(l, i + 1);
      cur = newSection();
      cur.gitOld = g.old;
      cur.gitNew = g.nw;
      state = 'hdr';
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      cur = newSection();
      cur.pairOld = hdrPath(l);
      cur.pairNew = hdrPath(lines[i + 1]!);
      state = 'hdr';
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      const a = parseHunkHead(l, i + 1);
      i++;
      cur!.hunks.push({ a, body: readBody() });
      continue;
    }
    i++;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedEdit(s, strict));
}

function resolveUPaths(s: USection): { old: string | null; nw: string | null } {
  let old: string | null | undefined;
  let nw: string | null | undefined;
  if (s.pairOld !== undefined || s.pairNew !== undefined) {
    old = s.pairOld;
    nw = s.pairNew;
  } else {
    old = s.renameFrom !== undefined ? s.renameFrom : s.gitOld;
    nw = s.renameTo !== undefined ? s.renameTo : s.gitNew;
  }
  return { old: old ?? null, nw: nw ?? null };
}

/** O, N and whether a `\` line follows the hunk's last context or `+` line. */
function hunkON(h: UHunk): { o: string[]; nItems: NItem[]; lastBs: boolean } {
  const o: string[] = [];
  const nItems: NItem[] = [];
  for (const b of h.body) {
    if (b.kind === 'ctx') {
      o.push(b.text);
      nItems.push({ text: b.text, ctx: o.length - 1 });
    } else if (b.kind === 'old') {
      o.push(b.text);
    } else if (b.kind === 'new') {
      nItems.push({ text: b.text, ctx: null });
    }
  }
  let lastBs = false;
  for (let k = h.body.length - 1; k >= 0; k--) {
    if (h.body[k]!.kind === 'ctx' || h.body[k]!.kind === 'new') {
      lastBs = h.body[k + 1] !== undefined && h.body[k + 1]!.kind === 'bs';
      break;
    }
  }
  return { o, nItems, lastBs };
}

function applyHunks(model: FileModel, hunks: UHunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    const { o, nItems, lastBs } = hunkON(h);
    if (o.length === 0) {
      const at = Math.min(h.a + d, model.lines.length);
      const atEnd = at === model.lines.length;
      const ins = nItems.map((it) => it.text);
      model.lines.splice(at, 0, ...ins);
      if (atEnd) model.final = !lastBs;
      d += nItems.length;
      continue;
    }
    const found = findTier(model.lines, o, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let pos = found.occs[0]!;
    let best = Math.abs(pos - target);
    for (const oc of found.occs) {
      const dist = Math.abs(oc - target);
      if (dist < best) {
        best = dist;
        pos = oc;
      }
    }
    const rep = buildReplacement(nItems, model.lines, pos, found.tier, o);
    const runsToEnd = pos + o.length === model.lines.length;
    model.lines.splice(pos, o.length, ...rep);
    if (runsToEnd) model.final = !lastBs;
    d += nItems.length - o.length;
  }
}

function unifiedEdit(sec: USection, strict: boolean): Edit {
  return (tree) => {
    const { old, nw } = resolveUPaths(sec);
    const named: string[] = [];
    if (old !== null) named.push(old);
    if (nw !== null && nw !== old) named.push(nw);
    for (const p of named) if (!safe(p)) throw new Fail('unsafe', p);
    const isCreate = old === null || sec.isCreate;
    const isDelete = nw === null || sec.isDelete;
    if (isCreate) {
      if (nw === null) return;
      if (tree.get(nw) !== null) throw new Fail('exists', nw);
      const plus: string[] = [];
      let lastBs = false;
      for (const h of sec.hunks) {
        for (let k = 0; k < h.body.length; k++) {
          const b = h.body[k]!;
          if (b.kind === 'new') {
            plus.push(b.text);
            lastBs = h.body[k + 1] !== undefined && h.body[k + 1]!.kind === 'bs';
          }
        }
      }
      tree.now.set(nw, plus.length === 0 ? '' : plus.join('\n') + (lastBs ? '' : '\n'));
      return;
    }
    if (isDelete) {
      if (old === null) return;
      if (tree.get(old) === null) throw new Fail('missing', old);
      tree.now.set(old, null);
      return;
    }
    if (old === null || nw === null) return;
    if (old !== nw) {
      if (tree.get(old) === null) throw new Fail('missing', old);
      if (tree.get(nw) !== null) throw new Fail('exists', nw);
      const model = splitFile(tree.get(old)!);
      applyHunks(model, sec.hunks, strict, old);
      tree.now.set(old, null);
      tree.now.set(nw, joinFile(model));
      tree.moves.push([old, nw]);
      return;
    }
    if (tree.get(old) === null) throw new Fail('missing', old);
    const model = splitFile(tree.get(old)!);
    applyHunks(model, sec.hunks, strict, old);
    tree.now.set(old, joinFile(model));
  };
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                           */
/* ------------------------------------------------------------------ */

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSR(lines: string[], strict: boolean): Edit[] {
  const blocks: SRBlock[] = [];
  let i = 0;
  let prevEnd = 0;
  let prevPath: string | null = null;
  const n = lines.length;
  while (i < n) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const searchIdx = i;
      let path: string | null = null;
      for (let j = searchIdx - 1; j >= prevEnd; j--) {
        const t = lines[j]!.trim();
        if (t === '') continue;
        if (t.startsWith('```')) continue;
        path = t;
        break;
      }
      if (path === null) {
        if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
        path = prevPath;
      }
      let k = searchIdx + 1;
      const oldLines: string[] = [];
      let foundEq = false;
      while (k < n) {
        if (lines[k]!.trimEnd() === '=======') {
          foundEq = true;
          break;
        }
        if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') break;
        oldLines.push(lines[k]!);
        k++;
      }
      if (!foundEq) throw new Exit2(`error: parse ${searchIdx + 1}`);
      k++;
      const newLines: string[] = [];
      let foundRep = false;
      while (k < n) {
        if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
          foundRep = true;
          break;
        }
        newLines.push(lines[k]!);
        k++;
      }
      if (!foundRep) throw new Exit2(`error: parse ${searchIdx + 1}`);
      blocks.push({ path, oldLines, newLines });
      prevPath = path;
      prevEnd = k + 1;
      i = k + 1;
      continue;
    }
    i++;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => srEdit(b, strict));
}

function srEdit(b: SRBlock, strict: boolean): Edit {
  return (tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const model = splitFile(before);
    const found = findTier(model.lines, b.oldLines, strict);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.occs.length > 1) throw new Fail('ambiguous', b.path);
    const pos = found.occs[0]!;
    const nItems: NItem[] = b.newLines.map((t) => ({ text: t, ctx: null }));
    const rep = buildReplacement(nItems, model.lines, pos, found.tier, b.oldLines);
    model.lines.splice(pos, b.oldLines.length, ...rep);
    tree.now.set(b.path, joinFile(model));
  };
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                     */
/* ------------------------------------------------------------------ */

interface VChunk {
  anchor: string | null;
  body: string[];
  eof: boolean;
}
interface VSection {
  kind: 'add' | 'del' | 'upd';
  path: string;
  headerLine: number;
  moveTo: string | null;
  lines: string[];
  chunks: VChunk[];
}

function chunkON(body: string[]): { o: string[]; nItems: NItem[] } {
  const o: string[] = [];
  const nItems: NItem[] = [];
  for (const l of body) {
    if (l === '' || l[0] === ' ') {
      const t = l === '' ? '' : l.slice(1);
      o.push(t);
      nItems.push({ text: t, ctx: o.length - 1 });
    } else if (l[0] === '-') {
      o.push(l.slice(1));
    } else if (l[0] === '+') {
      nItems.push({ text: l.slice(1), ctx: null });
    }
  }
  return { o, nItems };
}

function parseV4A(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    let kind: 'add' | 'del' | 'upd' | null = null;
    let path = '';
    if (l.startsWith('*** Add File:')) {
      kind = 'add';
      path = l.slice(14).trim();
    } else if (l.startsWith('*** Delete File:')) {
      kind = 'del';
      path = l.slice(17).trim();
    } else if (l.startsWith('*** Update File:')) {
      kind = 'upd';
      path = l.slice(17).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const headerLine = i + 1;
    i++;
    const raw: Array<{ t: string; no: number }> = [];
    while (i < last) {
      const l2 = lines[i]!;
      if (l2.startsWith('*** Add File:') || l2.startsWith('*** Delete File:') || l2.startsWith('*** Update File:')) break;
      raw.push({ t: l2, no: i + 1 });
      i++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.t)) raw.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const rl of raw) {
        if (rl.t.startsWith('+')) fileLines.push(rl.t.slice(1));
        else if (rl.t === '') fileLines.push('');
        else throw new Exit2(`error: parse ${rl.no}`);
      }
      sections.push({ kind, path, headerLine, moveTo: null, lines: fileLines, chunks: [] });
    } else if (kind === 'del') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.no}`);
      sections.push({ kind, path, headerLine, moveTo: null, lines: [], chunks: [] });
    } else {
      let moveTo: string | null = null;
      let j = 0;
      if (j < raw.length && raw[j]!.t.startsWith('*** Move to:')) {
        moveTo = raw[j]!.t.slice(12).trim();
        j++;
      }
      const chunks: VChunk[] = [];
      while (j < raw.length) {
        let anchor: string | null = null;
        let eof = false;
        if (raw[j]!.t.startsWith('@@')) {
          anchor = raw[j]!.t.slice(2).trim();
          if (anchor === '') anchor = null;
          j++;
        }
        const body: string[] = [];
        while (j < raw.length) {
          const rl = raw[j]!;
          if (rl.t.startsWith('@@')) break;
          if (rl.t === '*** End of File') {
            eof = true;
            j++;
            break;
          }
          if (rl.t === '' || rl.t[0] === ' ' || rl.t[0] === '-' || rl.t[0] === '+') {
            body.push(rl.t);
            j++;
            continue;
          }
          throw new Exit2(`error: parse ${rl.no}`);
        }
        chunks.push({ anchor, body, eof });
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
      sections.push({ kind, path, headerLine, moveTo, lines: [], chunks });
    }
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => v4aEdit(s, strict));
}

function v4aEdit(sec: VSection, strict: boolean): Edit {
  return (tree) => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    if (sec.kind === 'add') {
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, sec.lines.length === 0 ? '' : sec.lines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'del') {
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    const before = tree.get(sec.path);
    if (before === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const model = splitFile(before);
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.anchor !== null) {
        const found = findTier(model.lines, [ch.anchor], strict, cursor);
        if (found === null) throw new Fail('no-match', sec.path);
        cursor = found.occs[0]! + 1;
      }
      const { o, nItems } = chunkON(ch.body);
      if (o.length === 0) {
        const at = ch.eof ? model.lines.length : cursor;
        const ins = nItems.map((it) => it.text);
        model.lines.splice(at, 0, ...ins);
        cursor = at + ins.length;
        continue;
      }
      let found: { tier: number; occs: number[] } | null = null;
      if (ch.eof) {
        const max = strict ? 0 : 2;
        for (let t = 0; t <= max; t++) {
          const occs = findOccs(model.lines, o, t, cursor).filter((p) => p + o.length === model.lines.length);
          if (occs.length > 0) {
            found = { tier: t, occs };
            break;
          }
        }
      } else {
        found = findTier(model.lines, o, strict, cursor);
      }
      if (found === null) throw new Fail('no-match', sec.path);
      const pos = found.occs[0]!;
      const rep = buildReplacement(nItems, model.lines, pos, found.tier, o);
      model.lines.splice(pos, o.length, ...rep);
      cursor = pos + rep.length;
    }
    const out = joinFile(model);
    if (sec.moveTo !== null) {
      tree.now.set(sec.path, null);
      tree.now.set(sec.moveTo, out);
      tree.moves.push([sec.path, sec.moveTo]);
    } else {
      tree.now.set(sec.path, out);
    }
  };
}

/* ------------------------------------------------------------------ */
/* Run (SPEC.md sections 1, 2, 10)                                     */
/* ------------------------------------------------------------------ */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSR(lines, strict);
    else edits = parseV4A(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const finalState = (p: string): string | null => (tree.now.has(p) ? tree.now.get(p)! : tree.original(p));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const suppressed = new Set<string>();
  const rows: Array<{ key: string; line: string }> = [];
  for (const [o, n] of tree.moves) {
    if (tree.original(o) !== null && finalState(o) === null && tree.original(n) === null && finalState(n) !== null) {
      rows.push({ key: n, line: `R ${o} -> ${n}` });
      suppressed.add(o);
      suppressed.add(n);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (suppressed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = rows.map((r) => r.line);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
