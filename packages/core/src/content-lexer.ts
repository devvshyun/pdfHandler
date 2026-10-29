/**
 * Minimal lexer/parser for PDF content streams (and CMap programs, which share the syntax).
 * It yields one entry per operator with its operands and the exact byte range they occupy,
 * so callers can splice replacements into the original bytes without re-serialising the rest.
 */

export class Name {
  constructor(readonly value: string) {}
}

export class Str {
  constructor(readonly bytes: Uint8Array) {}
}

export class Dict {
  constructor(readonly entries: Map<string, Operand>) {}
}

export type Operand = number | boolean | null | Name | Str | Dict | Operand[];

export interface ContentOp {
  op: string;
  args: Operand[];
  /** Byte offset of the first operand (or of the operator when it has none). */
  start: number;
  /** Byte offset just past the operator (for inline images: past `EI`). */
  end: number;
}

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);
const isRegular = (b: number) => !WS.has(b) && !DELIM.has(b);

type Container = { kind: 'array'; items: Operand[]; start: number } | { kind: 'dict'; items: Operand[]; start: number };

export function* parseContent(data: Uint8Array): Generator<ContentOp> {
  let pos = 0;
  const len = data.length;
  let operands: Operand[] = [];
  let firstStart = -1;
  const stack: Container[] = [];

  const push = (value: Operand, start: number) => {
    if (stack.length) stack[stack.length - 1].items.push(value);
    else {
      if (firstStart < 0) firstStart = start;
      operands.push(value);
    }
  };

  while (pos < len) {
    const b = data[pos];
    if (WS.has(b)) {
      pos++;
      continue;
    }
    if (b === 0x25) {
      // comment
      while (pos < len && data[pos] !== 0x0a && data[pos] !== 0x0d) pos++;
      continue;
    }
    const start = pos;
    if (b === 0x2f) {
      pos++;
      let name = '';
      while (pos < len && isRegular(data[pos])) {
        if (data[pos] === 0x23 && pos + 2 < len) {
          name += String.fromCharCode(parseInt(String.fromCharCode(data[pos + 1], data[pos + 2]), 16));
          pos += 3;
        } else name += String.fromCharCode(data[pos++]);
      }
      push(new Name(name), start);
      continue;
    }
    if (b === 0x28) {
      const [bytes, next] = readLiteralString(data, pos);
      pos = next;
      push(new Str(bytes), start);
      continue;
    }
    if (b === 0x3c) {
      if (data[pos + 1] === 0x3c) {
        pos += 2;
        stack.push({ kind: 'dict', items: [], start });
        continue;
      }
      const [bytes, next] = readHexString(data, pos);
      pos = next;
      push(new Str(bytes), start);
      continue;
    }
    if (b === 0x3e && data[pos + 1] === 0x3e) {
      pos += 2;
      const c = stack.pop();
      if (!c || c.kind !== 'dict') continue; // malformed; ignore
      const map = new Map<string, Operand>();
      for (let i = 0; i + 1 < c.items.length; i += 2) {
        const k = c.items[i];
        if (k instanceof Name) map.set(k.value, c.items[i + 1]);
      }
      push(new Dict(map), c.start);
      continue;
    }
    if (b === 0x5b || b === 0x7b) {
      pos++;
      stack.push({ kind: 'array', items: [], start });
      continue;
    }
    if (b === 0x5d || b === 0x7d) {
      pos++;
      const c = stack.pop();
      if (c) push(c.items, c.start);
      continue;
    }
    if (DELIM.has(b)) {
      pos++; // stray delimiter
      continue;
    }
    // number or keyword
    while (pos < len && isRegular(data[pos])) pos++;
    const word = latin1(data, start, pos);
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) {
      push(Number(word), start);
      continue;
    }
    if (word === 'true' || word === 'false') {
      push(word === 'true', start);
      continue;
    }
    if (word === 'null') {
      push(null, start);
      continue;
    }
    if (stack.length) {
      // keywords inside procedures/arrays (CMap programs); keep as names so nothing is lost
      stack[stack.length - 1].items.push(new Name(word));
      continue;
    }
    if (word === 'BI') {
      // Inline image: key/value pairs up to ID, then raw bytes up to EI.
      const imageStart = start;
      const idAt = indexOfKeyword(data, pos, 'ID');
      if (idAt < 0) return;
      let p = idAt + 3; // "ID" + one whitespace byte
      let endAt = -1;
      for (; p + 1 < len; p++) {
        if (
          WS.has(data[p - 1]) &&
          data[p] === 0x45 &&
          data[p + 1] === 0x49 &&
          (p + 2 >= len || WS.has(data[p + 2]) || DELIM.has(data[p + 2]))
        ) {
          endAt = p + 2;
          break;
        }
      }
      if (endAt < 0) return;
      yield { op: 'BI', args: [], start: firstStart >= 0 ? firstStart : imageStart, end: endAt };
      pos = endAt;
      operands = [];
      firstStart = -1;
      continue;
    }
    yield { op: word, args: operands, start: firstStart >= 0 ? firstStart : start, end: pos };
    operands = [];
    firstStart = -1;
  }
}

function readLiteralString(data: Uint8Array, pos: number): [Uint8Array, number] {
  const out: number[] = [];
  let depth = 1;
  pos++;
  while (pos < data.length) {
    const c = data[pos++];
    if (c === 0x5c) {
      const n = data[pos++];
      switch (n) {
        case 0x6e: out.push(0x0a); break; // n
        case 0x72: out.push(0x0d); break; // r
        case 0x74: out.push(0x09); break; // t
        case 0x62: out.push(0x08); break; // b
        case 0x66: out.push(0x0c); break; // f
        case 0x0d:
          if (data[pos] === 0x0a) pos++;
          break; // line continuation
        case 0x0a:
          break;
        default:
          if (n >= 0x30 && n <= 0x37) {
            let v = n - 0x30;
            for (let k = 0; k < 2 && data[pos] >= 0x30 && data[pos] <= 0x37; k++) v = v * 8 + (data[pos++] - 0x30);
            out.push(v & 0xff);
          } else out.push(n); // \( \) \\ and unknown escapes
      }
      continue;
    }
    if (c === 0x28) depth++;
    if (c === 0x29 && --depth === 0) break;
    out.push(c);
  }
  return [Uint8Array.from(out), pos];
}

function readHexString(data: Uint8Array, pos: number): [Uint8Array, number] {
  pos++;
  let hex = '';
  while (pos < data.length && data[pos] !== 0x3e) {
    const ch = String.fromCharCode(data[pos++]);
    if (/[0-9a-fA-F]/.test(ch)) hex += ch;
  }
  pos++; // '>'
  if (hex.length % 2) hex += '0';
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return [out, pos];
}

function indexOfKeyword(data: Uint8Array, from: number, kw: string): number {
  const a = kw.charCodeAt(0);
  const b = kw.charCodeAt(1);
  for (let i = from; i + 1 < data.length; i++) {
    if (
      data[i] === a &&
      data[i + 1] === b &&
      (i === 0 || WS.has(data[i - 1]) || DELIM.has(data[i - 1])) &&
      (i + 2 >= data.length || WS.has(data[i + 2]))
    ) {
      return i;
    }
  }
  return -1;
}

function latin1(data: Uint8Array, start: number, end: number): string {
  let s = '';
  for (let i = start; i < end; i++) s += String.fromCharCode(data[i]);
  return s;
}

export function formatNumber(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(4).replace(/\.?0+$/, '');
}

export function hexString(bytes: Uint8Array): string {
  let s = '<';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return `${s}>`;
}
