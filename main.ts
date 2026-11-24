// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// Implements SPEC.md in full: the command line, output and exit codes, safe paths,
// format detection, three-tier line matching (section 5), unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits (section 9),
// and the all-or-nothing write with move output (sections 2 and 10).
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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
  readonly moves: [string, string][] = [];
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

// ---------------------------------------------------------------------------
// Section 3: a file's lines, its line break, and whether it ends with one.
// ---------------------------------------------------------------------------

function fileParts(text: string): { lines: string[]; br: string; final: boolean } {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinParts(lines: string[], br: string, fin: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (fin ? br : '');
}

const lead = (s: string): string => (/^[ \t]*/.exec(s) ?? [''])[0]!;

// ---------------------------------------------------------------------------
// Section 5: three-tier line matching.
// ---------------------------------------------------------------------------

function norm(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function occs(file: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + o.length <= file.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (norm(file[i + j]!, tier) !== norm(o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function tiers(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

/** First tier at which O occurs at least once, with its occurrences. */
function findTier(file: string[], o: string[], strict: boolean): { tier: number; occ: number[] } | null {
  for (const t of tiers(strict)) {
    const oc = occs(file, o, t);
    if (oc.length > 0) return { tier: t, occ: oc };
  }
  return null;
}

/**
 * Build the replacement lines for a match at `pos`. Context lines of N are
 * written as the file's own matched lines; at tier 2 every other line of N
 * is re-indented (F = leading whitespace of the file's first matched line,
 * P = leading whitespace of O's first line).
 */
function buildNew(
  file: string[],
  pos: number,
  o: string[],
  n: string[],
  ctxO: boolean[],
  ctxN: boolean[],
  tier: number,
): string[] {
  const ctxOIdx: number[] = [];
  o.forEach((_, i) => {
    if (ctxO[i]) ctxOIdx.push(i);
  });
  const f = o.length > 0 ? lead(file[pos] ?? '') : '';
  const p = o.length > 0 ? lead(o[0]!) : '';
  let k = 0;
  const out: string[] = [];
  for (let j = 0; j < n.length; j++) {
    if (ctxN[j]) {
      out.push(file[pos + ctxOIdx[k]!]!);
      k++;
    } else if (tier === 2) {
      const line = n[j]!;
      if (line !== '' && line.trim() !== '' && line.startsWith(p)) out.push(f + line.slice(p.length));
      else out.push(line);
    } else {
      out.push(n[j]!);
    }
  }
  return out;
}

/** Split a hunk/chunk body into old lines O and new lines N with context flags. */
function bodyON(body: string[]): { o: string[]; n: string[]; ctxO: boolean[]; ctxN: boolean[] } {
  const o: string[] = [];
  const n: string[] = [];
  const ctxO: boolean[] = [];
  const ctxN: boolean[] = [];
  for (const b of body) {
    if (b.startsWith('\\')) continue;
    if (b === '') {
      o.push('');
      n.push('');
      ctxO.push(true);
      ctxN.push(true);
    } else if (b[0] === ' ') {
      o.push(b.slice(1));
      n.push(b.slice(1));
      ctxO.push(true);
      ctxN.push(true);
    } else if (b[0] === '-') {
      o.push(b.slice(1));
      ctxO.push(false);
    } else if (b[0] === '+') {
      n.push(b.slice(1));
      ctxN.push(false);
    }
  }
  return { o, n, ctxO, ctxN };
}

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

// ---------------------------------------------------------------------------
// Section 6: unified diffs.
// ---------------------------------------------------------------------------

interface Hunk {
  a: number;
  body: string[];
  noEol: boolean;
}

interface Section {
  gitOld: string | null | undefined;
  gitNew: string | null | undefined;
  headerOld: string | null | undefined;
  headerNew: string | null | undefined;
  renameOld: string | null | undefined;
  renameNew: string | null | undefined;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

function parseHunkHeader(l: string, lineNo: number): number {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(l);
  if (!m) throw new Exit2(`error: parse ${lineNo}`);
  return parseInt(m[1]!, 10);
}

/** Parse a `diff --git a/<X> b/<Y>` line; throws a parse error at its line. */
function parseGitLine(l: string, lineNo: number): { x: string; y: string } {
  const rest = l.slice('diff --git '.length);
  if (!rest.startsWith('a/')) throw new Exit2(`error: parse ${lineNo}`);
  const sep = rest.indexOf(' b/');
  if (sep <= 2) throw new Exit2(`error: parse ${lineNo}`);
  const yPart = rest.slice(sep + 1);
  if (!yPart.startsWith('b/') || yPart.length <= 2) throw new Exit2(`error: parse ${lineNo}`);
  return { x: rest.slice(2, sep), y: yPart.slice(2) };
}

/** A `--- `/`+++ ` path: text after the four characters, up to the first tab, trimmed, a/ or b/ removed. */
function parseHeaderPath(l: string): string | null {
  const p = l.slice(4).split('\t')[0]!.trim().replace(/^[ab]\//, '');
  return p === '/dev/null' ? null : p;
}

function newSection(): Section {
  return { gitOld: undefined, gitNew: undefined, headerOld: undefined, headerNew: undefined, renameOld: undefined, renameNew: undefined, create: false, del: false, hunks: [] };
}

function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const { x, y } = parseGitLine(l, i + 1);
      cur = newSection();
      cur.gitOld = x;
      cur.gitNew = y;
      sections.push(cur);
      inHeader = true;
      i++;
      continue;
    }
    if (cur === null) {
      if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        cur = newSection();
        cur.headerOld = parseHeaderPath(l);
        cur.headerNew = parseHeaderPath(lines[i + 1]!);
        sections.push(cur);
        inHeader = true;
        i += 2;
        continue;
      }
      if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i++;
      continue;
    }
    if (inHeader) {
      if (l.startsWith('@@')) {
        const a = parseHunkHeader(l, i + 1);
        const h = readHunk(lines, i, a);
        cur.hunks.push(h.hunk);
        inHeader = false;
        i = h.next;
        continue;
      }
      if (l.startsWith('--- ')) {
        if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        cur.headerOld = parseHeaderPath(l);
        cur.headerNew = parseHeaderPath(lines[i + 1]!);
        i += 2;
        continue;
      }
      if (l.startsWith('rename from ')) {
        cur.renameOld = l.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        cur.renameNew = l.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (l.startsWith('new file mode')) {
        cur.create = true;
        i++;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        cur.del = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    // After hunks: a new hunk, a new section, or ignored prose.
    if (l.startsWith('@@')) {
      const a = parseHunkHeader(l, i + 1);
      const h = readHunk(lines, i, a);
      cur.hunks.push(h.hunk);
      i = h.next;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      cur = newSection();
      cur.headerOld = parseHeaderPath(l);
      cur.headerNew = parseHeaderPath(lines[i + 1]!);
      sections.push(cur);
      inHeader = true;
      i += 2;
      continue;
    }
    i++;
  }
  return sections;
}

/** Read a hunk body starting just after the header at `headerIdx` (0-based). */
function readHunk(lines: string[], headerIdx: number, a: number): { hunk: Hunk; next: number } {
  const body: string[] = [];
  let j = headerIdx + 1;
  while (j < lines.length) {
    const b = lines[j]!;
    if (b.startsWith('diff --git ')) break;
    if (b.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\') {
      body.push(b);
      j++;
      continue;
    }
    break;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  let noEol = false;
  for (let k = body.length - 1; k >= 0; k--) {
    const b = body[k]!;
    if (b === '' || b.startsWith(' ') || b.startsWith('+')) {
      noEol = k + 1 < body.length && body[k + 1]!.startsWith('\\');
      break;
    }
  }
  return { hunk: { a, body, noEol }, next: j };
}

/** Whether a `\` line follows the last `+` line of a hunk. */
function hunkPlusNoEol(h: Hunk): boolean {
  for (let k = h.body.length - 1; k >= 0; k--) {
    if (h.body[k]!.startsWith('+')) return k + 1 < h.body.length && h.body[k + 1]!.startsWith('\\');
  }
  return false;
}

function applyHunks(before: string, hunks: Hunk[], strict: boolean, path: string): string {
  const parts = fileParts(before);
  const fl = parts.lines;
  let final = parts.final;
  const br = parts.br;
  let d = 0;
  for (const h of hunks) {
    const { o, n, ctxO, ctxN } = bodyON(h.body);
    if (o.length === 0) {
      let pos = h.a + d;
      if (pos < 0) pos = 0;
      if (pos > fl.length) pos = fl.length;
      const atEnd = pos === fl.length;
      fl.splice(pos, 0, ...n);
      if (atEnd) final = !h.noEol;
      d += n.length;
      continue;
    }
    const found = findTier(fl, o, strict);
    if (!found) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.occ[0]!;
    let bd = Math.abs(best - target);
    for (const oc of found.occ) {
      const dd = Math.abs(oc - target);
      if (dd < bd) {
        bd = dd;
        best = oc;
      }
    }
    const runsToEnd = best + o.length === fl.length;
    const n2 = buildNew(fl, best, o, n, ctxO, ctxN, found.tier);
    fl.splice(best, o.length, ...n2);
    if (runsToEnd) final = !h.noEol;
    d += n.length - o.length;
  }
  return joinParts(fl, br, final);
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseUnified(lines);
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => {
    const oldP = sec.headerOld !== undefined ? sec.headerOld : sec.renameOld !== undefined ? sec.renameOld : sec.gitOld;
    const newP = sec.headerNew !== undefined ? sec.headerNew : sec.renameNew !== undefined ? sec.renameNew : sec.gitNew;
    return (tree: Tree): void => {
      if (oldP !== null && oldP !== undefined && !safe(oldP)) throw new Fail('unsafe', oldP);
      if (newP !== null && newP !== undefined && !safe(newP)) throw new Fail('unsafe', newP);
      const isCreate = oldP === null || oldP === undefined || sec.create;
      const isDelete = newP === null || newP === undefined || sec.del;
      if (isCreate) {
        const np = newP as string;
        if (tree.get(np) !== null) throw new Fail('exists', np);
        const plus: string[] = [];
        let noEol = false;
        for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
          const h = sec.hunks[hi]!;
          let hasPlus = false;
          for (const b of h.body) if (b.startsWith('+')) hasPlus = true;
          if (hasPlus) {
            noEol = hunkPlusNoEol(h);
            break;
          }
        }
        for (const h of sec.hunks) for (const b of h.body) if (b.startsWith('+')) plus.push(b.slice(1));
        tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
        return;
      }
      if (isDelete) {
        const op = oldP as string;
        if (tree.get(op) === null) throw new Fail('missing', op);
        tree.now.set(op, null);
        return;
      }
      const op = oldP as string;
      const np = newP as string;
      const before = tree.get(op);
      if (before === null) throw new Fail('missing', op);
      if (op !== np && tree.get(np) !== null) throw new Fail('exists', np);
      const result = applyHunks(before, sec.hunks, strict, op);
      if (op !== np) {
        tree.now.set(np, result);
        tree.now.set(op, null);
        tree.moves.push([op, np]);
      } else {
        tree.now.set(op, result);
      }
    };
  });
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks.
// ---------------------------------------------------------------------------

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const s = i;
    let path: string | null = null;
    for (let j = s - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${s + 1}`);
    let eq = -1;
    for (let j = s + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '>>>>>>> REPLACE') throw new Exit2(`error: parse ${s + 1}`);
      if (t === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let gt = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '<<<<<<< SEARCH') throw new Exit2(`error: parse ${s + 1}`);
      if (t === '>>>>>>> REPLACE') {
        gt = j;
        break;
      }
    }
    if (gt < 0) throw new Exit2(`error: parse ${s + 1}`);
    const oldLines = lines.slice(s + 1, eq);
    const newLines = lines.slice(eq + 1, gt);
    const p = path;
    edits.push((tree: Tree): void => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const parts = fileParts(before);
      const fl = parts.lines;
      const found = findTier(fl, oldLines, strict);
      if (!found) throw new Fail('no-match', p);
      if (found.occ.length > 1) throw new Fail('ambiguous', p);
      const n2 = buildNew(
        fl,
        found.occ[0]!,
        oldLines,
        newLines,
        oldLines.map(() => false),
        newLines.map(() => false),
        found.tier,
      );
      const out = [...fl];
      out.splice(found.occ[0]!, oldLines.length, ...n2);
      tree.now.set(p, joinParts(out, parts.br, parts.final));
    });
    prevPath = p;
    prevEnd = gt;
    i = gt + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches.
// ---------------------------------------------------------------------------

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  body: string[];
}

type V4aSection =
  | { kind: 'add'; path: string; fileLines: string[]; lineNo: number }
  | { kind: 'delete'; path: string; lineNo: number }
  | { kind: 'update'; path: string; moveTo: string | null; chunks: V4aChunk[]; lineNo: number };

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (!isSectionStart(l)) throw new Exit2(`error: parse ${i + 1}`);
    const lineNo = i + 1;
    const kind = l.startsWith('*** Add') ? 'add' : l.startsWith('*** Delete') ? 'delete' : 'update';
    const path = l.slice(l.indexOf(': ') + 2).trim();
    const bodyStart = i + 1;
    let j = bodyStart;
    while (j < last && !isSectionStart(lines[j]!)) j++;
    let body = lines.slice(bodyStart, j);
    while (body.length > 0 && blank(body[body.length - 1]!)) body.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (let k = 0; k < body.length; k++) {
        const b = body[k]!;
        if (b === '') fileLines.push('');
        else if (b.startsWith('+')) fileLines.push(b.slice(1));
        else throw new Exit2(`error: parse ${bodyStart + k + 1}`);
      }
      sections.push({ kind: 'add', path, fileLines, lineNo });
    } else if (kind === 'delete') {
      for (let k = 0; k < body.length; k++) {
        if (!blank(body[k]!)) throw new Exit2(`error: parse ${bodyStart + k + 1}`);
      }
      sections.push({ kind: 'delete', path, lineNo });
    } else {
      let moveTo: string | null = null;
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      let started = false;
      for (let k = 0; k < body.length; k++) {
        const b = body[k]!;
        const ln = bodyStart + k + 1;
        if (blank(b)) {
          if (cur !== null) cur.body.push('');
          else if (chunks.length === 0) {
            cur = { anchor: null, eof: false, body: [] };
            started = true;
            cur.body.push('');
          }
          continue;
        }
        if (b.startsWith('*** Move to: ')) {
          if (moveTo !== null || started) throw new Exit2(`error: parse ${ln}`);
          moveTo = b.slice('*** Move to: '.length).trim();
          started = true;
          continue;
        }
        if (b === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${ln}`);
          cur.eof = true;
          chunks.push(cur);
          cur = null;
          started = true;
          continue;
        }
        if (b.startsWith('@@')) {
          if (cur !== null) chunks.push(cur);
          const anchor = b.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
          started = true;
          continue;
        }
        if (b[0] === ' ' || b[0] === '-' || b[0] === '+') {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${ln}`);
            cur = { anchor: null, eof: false, body: [] };
          }
          cur.body.push(b);
          started = true;
          continue;
        }
        throw new Exit2(`error: parse ${ln}`);
      }
      if (cur !== null) chunks.push(cur);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${lineNo}`);
      sections.push({ kind: 'update', path, moveTo, chunks, lineNo });
    }
    i = j;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => {
    if (sec.kind === 'add') {
      const p = sec.path;
      const fileLines = sec.fileLines;
      return (tree: Tree): void => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      };
    }
    if (sec.kind === 'delete') {
      const p = sec.path;
      return (tree: Tree): void => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      };
    }
    const p = sec.path;
    const moveTo = sec.moveTo;
    const chunks = sec.chunks;
    return (tree: Tree): void => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
      const parts = fileParts(before);
      const fl = parts.lines;
      let cursor = 0;
      for (const ch of chunks) {
        if (ch.anchor !== null) {
          let foundIdx = -1;
          for (const t of tiers(strict)) {
            for (let k = cursor; k < fl.length; k++) {
              if (norm(fl[k]!, t) === norm(ch.anchor, t)) {
                foundIdx = k;
                break;
              }
            }
            if (foundIdx >= 0) break;
          }
          if (foundIdx < 0) throw new Fail('no-match', p);
          cursor = foundIdx + 1;
        }
        const { o, n, ctxO, ctxN } = bodyON(ch.body);
        if (o.length === 0) {
          const pos = ch.eof ? fl.length : cursor;
          fl.splice(pos, 0, ...n);
          cursor = pos + n.length;
          continue;
        }
        let chosen: { tier: number; pos: number } | null = null;
        for (const t of tiers(strict)) {
          const oc = occs(fl, o, t).filter((x) => x >= cursor);
          if (oc.length === 0) continue;
          if (ch.eof) {
            const eofPos = fl.length - o.length;
            if (eofPos >= cursor && oc.includes(eofPos)) chosen = { tier: t, pos: eofPos };
            else continue;
          } else {
            chosen = { tier: t, pos: oc[0]! };
          }
          if (chosen !== null) break;
        }
        if (chosen === null) throw new Fail('no-match', p);
        const n2 = buildNew(fl, chosen.pos, o, n, ctxO, ctxN, chosen.tier);
        fl.splice(chosen.pos, o.length, ...n2);
        cursor = chosen.pos + n2.length;
      }
      const result = joinParts(fl, parts.br, parts.final);
      if (moveTo !== null) {
        tree.now.set(moveTo, result);
        tree.now.set(p, null);
        tree.moves.push([p, moveTo]);
      } else {
        tree.now.set(p, result);
      }
    };
  });
}

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
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Output rows: A/D/M per changed path, with R lines replacing a move's D+A
  // pair and sorting by the new path; every row sorts in UTF-8 byte order.
  const moveByNew = new Map<string, string>();
  const moveOlds = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.now.get(oldP) === null && tree.original(newP) === null && tree.now.get(newP) !== null) {
      moveByNew.set(newP, oldP);
      moveOlds.add(oldP);
    }
  }
  const rows: { key: string; line: string }[] = [];
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (moveOlds.has(p)) continue;
    if (moveByNew.has(p)) rows.push({ key: p, line: `R ${moveByNew.get(p)} -> ${p}` });
    else rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of tree.now.keys()) {
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
  const outLines = rows.map((r) => r.line);
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
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
