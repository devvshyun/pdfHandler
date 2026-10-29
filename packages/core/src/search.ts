/**
 * Text search over the glyph map: literal strings, regular expressions and built-in patterns for
 * personal data (Korean context). Each match carries the exact boxes of its glyphs, ready to be
 * used as `redact` areas or a `replaceText` area.
 */
import { PDFDocument, PDFObject } from 'pdf-lib';
import { loadPdf } from './engine';
import type { PdfOperation, RgbColor } from './operations';
import { Box, buildTextMap, FontDecoder, PageTextMap, unionBox } from './text-map';

export interface TextPattern {
  id: string;
  /** Korean label for the UI. */
  label: string;
  regex: RegExp;
  /** Extra check on the matched text, for what a regular expression cannot express well. */
  validate?: (match: string) => boolean;
}

export interface TextMatch {
  page: number;
  /** The matched text as it reads on the page (virtual spaces/newlines included). */
  text: string;
  /** Offsets into `PageTextMap.text`. */
  start: number;
  end: number;
  /** Indexes into `PageTextMap.glyphs`. */
  glyphs: number[];
  /** Union of the matched glyphs per line, visual top-left coordinates. */
  boxes: Box[];
  /** Font size of the first matched glyph, in points. */
  fontSize: number;
  /**
   * Room for replacement text on the first line: from the first box's left edge to just before the
   * next glyph on that line, or to the right margin when nothing follows.
   */
  maxWidth: number;
  /** Up to 30 characters of context on each side (newlines as spaces). */
  before: string;
  after: string;
  /** Pattern id when found by a built-in pattern. */
  pattern?: string;
}

export interface FindOptions {
  /** 0-based pages to search; all pages when omitted. */
  pages?: number[];
  /** Literal queries only (RegExp queries use their own flags). Default false. */
  caseSensitive?: boolean;
  /** Stop after this many matches (default 10000). */
  limit?: number;
}

export type Query = string | RegExp | TextPattern;

const digits = (s: string) => s.replace(/\D/g, '');

function validDate(yymmdd: string): boolean {
  const m = Number(yymmdd.slice(2, 4));
  const d = Number(yymmdd.slice(4, 6));
  return m >= 1 && m <= 12 && d >= 1 && d <= [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

function luhn(num: string): boolean {
  let sum = 0;
  for (let i = 0; i < num.length; i++) {
    let d = Number(num[num.length - 1 - i]);
    if (i % 2) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

function rrnChecksum(d: string): boolean {
  const w = [2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4, 5];
  const sum = w.reduce((acc, k, i) => acc + k * Number(d[i]), 0);
  return (11 - (sum % 11)) % 10 === Number(d[12]);
}

/** A Korean product barcode (EAN-13, prefix 880) with a valid check digit. */
function isKoreanEan13(d: string): boolean {
  if (!d.startsWith('880')) return false;
  const sum = [...d.slice(0, 12)].reduce((acc, c, i) => acc + Number(c) * (i % 2 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === Number(d[12]);
}

const PHONE = /^(01[016789]|02|0[3-6][1-5]|070|050\d)/;

/** Built-in personal-data patterns. Digit runs never match inside a longer number. */
export const TEXT_PATTERNS: readonly TextPattern[] = [
  {
    id: 'rrn',
    label: '주민등록번호',
    // YYMMDD-GNNNNNN (G = 1-8, foreigners 5-8). Without the hyphen only a 13-digit run whose
    // first six digits form a valid date and whose check digit is right counts (numbers issued
    // since October 2020 have no check digit, so write those with the hyphen to be found).
    regex: /(?<![\d-])\d{6}(?:[ \t]?[-–][ \t]?|)[1-8]\d{6}(?![\d-])/g,
    validate: (s) => validDate(digits(s)) && (/\D/.test(s) || (rrnChecksum(digits(s)) && !isKoreanEan13(digits(s)))),
  },
  {
    id: 'phone',
    label: '전화번호',
    // Mobile (010-1234-5678, 01012345678) and landline (02-123-4567, 031-123-4567, (02) 123-4567).
    // Landlines need separators: an 9-10 digit run alone is too ambiguous.
    regex: /(?<![\d-])(?:01[016789]([-. ]?)\d{3,4}\1\d{4}|\(?0(?:2|[3-6][1-5]|70|50\d)(?:\)\s?|[-. ])\d{3,4}[-. ]\d{4})(?![\d-])/g,
    validate: (s) => {
      const d = digits(s);
      if (!PHONE.test(d)) return false;
      if (/^01/.test(d)) return d.length === 10 || d.length === 11;
      return d.length >= 9 && d.length <= 12;
    },
  },
  {
    id: 'card',
    label: '카드번호',
    // 4-4-4-4 with spaces or hyphens (same separator throughout), 4-6-5 (Amex), or 16 digits
    // in a row when the Luhn check digit is right.
    regex: /(?<![\d-]|\d[ -])(?:\d{4}([ -])\d{4}\1\d{4}\1\d{4}|\d{4}([ -])\d{6}\2\d{5}|\d{16})(?![\d-]|[ -]\d)/g,
    validate: (s) => {
      if (/^\d{16}$/.test(s)) return luhn(s);
      // Four years in a row ("2019 2020 2021 2022") is a table header, not a card.
      return !/^(?:(?:19|20)\d\d[ -]){3}(?:19|20)\d\d$/.test(s);
    },
  },
  {
    id: 'account',
    label: '계좌번호',
    // Bank account numbers: 3-4 hyphenated groups, 10-14 digits in total
    // (110-234-567890, 1002-123-456789, 123-456789-01-234, 3333-01-1234567, 301-0123-4567-01).
    regex: /(?<![\d-])\d{2,6}-\d{2,7}-\d{2,7}(?:-\d{1,3})?(?![\d-])/g,
    validate: (s) => {
      const d = digits(s);
      if (d.length < 10 || d.length > 14) return false;
      if (PHONE.test(d) && /^0/.test(d)) return false; // telephone numbers
      if (/^\d{3}-\d{2}-\d{5}$/.test(s)) return false; // business registration number
      if (/^(19|20)\d{2}-\d{2}-\d{2}/.test(s)) return false; // dates
      return true;
    },
  },
  {
    id: 'email',
    label: '이메일',
    regex: /(?<![\w.%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![\w-])/g,
  },
];

/** Literal query → regular expression; runs of whitespace match any whitespace (line breaks too). */
export function queryToRegExp(query: string, caseSensitive = false): RegExp | null {
  const parts = query
    .normalize('NFKC')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!parts.length) return null;
  return new RegExp(parts.join('\\s+'), caseSensitive ? 'gu' : 'giu');
}

/** Matches in one page's text map. */
export function findInTextMap(map: PageTextMap, query: Query, options: Pick<FindOptions, 'caseSensitive' | 'limit'> = {}): TextMatch[] {
  let regex: RegExp | null;
  let validate: ((s: string) => boolean) | undefined;
  let pattern: string | undefined;
  if (typeof query === 'string') regex = queryToRegExp(query, options.caseSensitive);
  else if (query instanceof RegExp) regex = new RegExp(query.source, query.flags.includes('g') ? query.flags : `${query.flags}g`);
  else {
    regex = new RegExp(query.regex.source, query.regex.flags.includes('g') ? query.regex.flags : `${query.regex.flags}g`);
    validate = query.validate;
    pattern = query.id;
  }
  if (!regex) return [];
  const limit = options.limit ?? 10000;
  const out: TextMatch[] = [];
  const { text } = map;
  for (let m = regex.exec(text); m && out.length < limit; m = regex.exec(text)) {
    if (m[0].length === 0) {
      regex.lastIndex++;
      continue;
    }
    if (validate && !validate(m[0])) continue;
    const match = toMatch(map, m.index, m.index + m[0].length);
    if (match) out.push(pattern ? { ...match, pattern } : match);
  }
  return out;
}

function toMatch(map: PageTextMap, start: number, end: number): TextMatch | null {
  const glyphs: number[] = [];
  for (let i = start; i < end; i++) {
    const g = map.charToGlyph[i];
    if (g >= 0 && glyphs[glyphs.length - 1] !== g) glyphs.push(g);
  }
  if (!glyphs.length) return null;
  // Duplicates drawn over a matched glyph (fake bold) belong to the match as well.
  const set = new Set(glyphs);
  const byLine = new Map<number, Box>();
  for (const gi of glyphs) {
    const g = map.glyphs[gi];
    byLine.set(g.line, byLine.has(g.line) ? unionBox(byLine.get(g.line)!, g) : { x: g.x, y: g.y, width: g.width, height: g.height });
  }
  map.glyphs.forEach((g, i) => {
    if (!g.duplicate || set.has(i)) return;
    const box = byLine.get(g.line);
    if (box && g.x + g.width / 2 > box.x && g.x + g.width / 2 < box.x + box.width && g.y + g.height / 2 > box.y && g.y + g.height / 2 < box.y + box.height) {
      glyphs.push(i);
    }
  });
  glyphs.sort((a, b) => a - b);
  const boxes = [...byLine.values()];
  const first = map.glyphs[glyphs[0]];
  const firstBox = byLine.get(first.line)!;
  // The next glyph after the match on the first line, if any.
  const line = map.lines[first.line];
  const lastOnLine = Math.max(...glyphs.filter((i) => map.glyphs[i].line === first.line));
  let next: number | undefined;
  for (let i = lastOnLine + 1; i < line.end; i++) {
    const g = map.glyphs[i];
    if (!g.duplicate && g.text.trim() && g.x >= firstBox.x + firstBox.width - 0.5) {
      next = i;
      break;
    }
  }
  const leftMargin = Math.min(...map.glyphs.map((g) => g.x));
  const limit = next !== undefined ? map.glyphs[next].x - first.fontSize * 0.3 : Math.max(firstBox.x + firstBox.width, map.width - leftMargin);
  const flat = (s: string) => s.replace(/\n/g, ' ');
  return {
    page: map.page,
    text: map.text.slice(start, end),
    start,
    end,
    glyphs,
    boxes,
    fontSize: first.fontSize,
    maxWidth: Math.max(firstBox.width, limit - firstBox.x),
    before: flat(map.text.slice(Math.max(0, start - 30), start)),
    after: flat(map.text.slice(end, end + 30)),
  };
}

/** Searches the document. `query` is a literal string, a RegExp or one of TEXT_PATTERNS. */
export async function findText(source: Uint8Array | ArrayBuffer | PDFDocument, query: Query | Query[], options: FindOptions = {}): Promise<TextMatch[]> {
  const doc = source instanceof PDFDocument ? source : await loadPdf(source);
  const pages = options.pages ?? doc.getPageIndices();
  const limit = options.limit ?? 10000;
  const decoders = new Map<PDFObject, FontDecoder>();
  const queries = Array.isArray(query) ? query : [query];
  const out: TextMatch[] = [];
  for (const p of pages) {
    const map = buildTextMap(doc, p, decoders);
    for (const q of queries) {
      out.push(...findInTextMap(map, q, { caseSensitive: options.caseSensitive, limit: limit - out.length }));
    }
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * One `redact` operation per page covering every match on it. `center` mode is the default: the
 * boxes are the glyphs' exact boxes, so each matched glyph's centre lies inside, while glyphs of
 * tightly spaced neighbouring lines (whose ascent/descent boxes may reach into the area) are spared.
 */
export function redactOpsForMatches(
  matches: TextMatch[],
  options: { fill?: RgbColor | null; mode?: 'center' | 'overlap' } = {},
): Array<Extract<PdfOperation, { type: 'redact' }>> {
  const byPage = new Map<number, Box[]>();
  for (const m of matches) byPage.set(m.page, [...(byPage.get(m.page) ?? []), ...m.boxes]);
  return [...byPage]
    .sort((a, b) => a[0] - b[0])
    .map(([page, areas]) => ({
      type: 'redact',
      page,
      areas: areas.filter((a) => a.width > 0 && a.height > 0),
      mode: options.mode ?? 'center',
      ...(options.fill !== undefined ? { fill: options.fill } : {}),
    }));
}
