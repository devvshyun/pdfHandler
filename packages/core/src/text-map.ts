/**
 * Page text with exact glyph positions, built on the same content-stream interpreter that redaction
 * uses (see `visitGlyphs` in redact.ts). Every glyph gets its Unicode text and its box in visual,
 * top-left-origin page coordinates (the coordinate system of the `redact` / `replaceText` operations),
 * so a search hit can be turned into redaction areas that remove exactly the matched glyphs.
 */
import { Encodings } from '@pdf-lib/standard-fonts';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFObject, PDFPage, PDFRef, PDFStream } from 'pdf-lib';
import { parseToUnicode, streamBytes } from './font-metrics';
import { GlyphVisit, Rect, visitGlyphs } from './redact';
import { loadPdf } from './engine';

/** Visual, top-left-origin box in PDF points (same convention as the operations). */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TextGlyph extends Box {
  /** Unicode text of the glyph (may be several characters for ligatures; U+FFFD when unknown). */
  text: string;
  /** Index into `PageTextMap.lines`. */
  line: number;
  /** Font size in points (user space). */
  fontSize: number;
  /** The font gives no reliable way to know what this glyph is. */
  unknown?: boolean;
  /** Drawn again on top of an identical glyph (fake bold, shadows); left out of `text`. */
  duplicate?: boolean;
}

export interface TextLine extends Box {
  /** Glyph index range [first, last + 1). */
  start: number;
  end: number;
}

export interface PageTextMap {
  page: number;
  /** Visual page size (after /Rotate). */
  width: number;
  height: number;
  glyphs: TextGlyph[];
  lines: TextLine[];
  /**
   * The page text in content order: glyph texts, a virtual space where glyphs on one line are
   * separated by a gap but no space glyph, and "\n" between lines.
   */
  text: string;
  /** For each UTF-16 unit of `text`, the glyph it came from, or -1 for virtual spaces / newlines. */
  charToGlyph: Int32Array;
  /** Number of glyphs whose text could not be determined. */
  unknownGlyphs: number;
}

type Source = Uint8Array | ArrayBuffer | PDFDocument;

async function toDoc(source: Source): Promise<PDFDocument> {
  return source instanceof PDFDocument ? source : loadPdf(source);
}

/** Glyphs and text of one page (0-based index). */
export async function getTextMap(source: Source, pageIndex: number): Promise<PageTextMap> {
  return buildTextMap(await toDoc(source), pageIndex);
}

/** Synchronous variant for an already loaded document. */
export function buildTextMap(doc: PDFDocument, pageIndex: number, decoders = new Map<PDFObject, FontDecoder>()): PageTextMap {
  const page = doc.getPage(pageIndex);
  const frame = visualFrame(page);
  const raw: Array<{ g: GlyphVisit; text: string; unknown: boolean }> = [];
  visitGlyphs(doc, page, (g) => {
    let dec = g.fontRaw ? decoders.get(g.fontRaw) : undefined;
    if (!dec) {
      const dict = g.fontRaw instanceof PDFRef ? doc.context.lookup(g.fontRaw) : g.fontRaw;
      dec = dict instanceof PDFDict ? fontDecoder(dict) : () => null;
      if (g.fontRaw) decoders.set(g.fontRaw, dec);
    }
    const t = dec(g.code, g.byteLength);
    raw.push({ g, text: t === null ? '�' : normalizeGlyphText(t), unknown: t === null });
  });

  // Phase 1: glyph records in content order, split into fragments (runs that continue forward on
  // one baseline), with overprinted twins set aside.
  const fragments: Fragment[] = [];
  const duplicates: Rec[] = [];
  // Placed glyphs on a 4pt grid, for spotting glyphs drawn twice (offsets up to 4pt are found).
  const seen = new Map<number, Rec[]>();
  // Small-integer keys keep the map fast; distant cells may share a key, which only costs a compare.
  const cell = (cx: number, cy: number) => ((cx & 0x7fff) << 15) | (cy & 0x7fff);
  // A twin has the same text, sits on (nearly) the same baseline and is shifted along it by less
  // than 40% of its width, i.e. the two boxes overlap over most of their width.
  const findTwin = (t: string, cx: number, cy: number, ox: number, oy: number, dx: number, dy: number, along: number, across: number) => {
    for (let kx = -1; kx <= 1; kx++)
      for (let ky = -1; ky <= 1; ky++) {
        const list = seen.get(cell(cx + kx, cy + ky));
        if (!list) continue;
        for (const r of list) {
          if (r.glyph.text !== t) continue;
          const ux = ox - r.ox;
          const uy = oy - r.oy;
          if (Math.abs(dx * ux + dy * uy) < along && Math.abs(dx * uy - dy * ux) < across) return r;
        }
      }
    return undefined;
  };
  let prev: { ox: number; oy: number; ex: number; ey: number; dx: number; dy: number; size: number } | undefined;
  let frag: Fragment | undefined;
  let unknownGlyphs = 0;
  let inDuplicateRun = false;

  for (const { g, text: t, unknown } of raw) {
    const { trm } = g;
    const scaleX = Math.sqrt(trm[0] * trm[0] + trm[1] * trm[1]);
    const size = Math.sqrt(trm[2] * trm[2] + trm[3] * trm[3]) || scaleX;
    if (!(size > 0) || !Number.isFinite(trm[4]) || !Number.isFinite(trm[5])) continue;
    const dx = scaleX ? trm[0] / scaleX : 1;
    const dy = scaleX ? trm[1] / scaleX : 0;
    const ox = trm[4];
    const oy = trm[5];
    const advance = g.width * scaleX;
    const box = frame.toVisualBox(g.box);
    const glyph: TextGlyph = { x: box.x, y: box.y, width: box.width, height: box.height, text: t, line: -1, fontSize: size };
    if (unknown) {
      glyph.unknown = true;
      unknownGlyphs++;
    }

    let newFragment = !prev;
    let gap = 0;
    if (prev) {
      const sameDir = prev.dx * dx + prev.dy * dy > 0.99;
      // Distance of this origin from the previous glyph's baseline, and progress along it.
      const across = Math.abs(prev.dx * (oy - prev.oy) - prev.dy * (ox - prev.ox));
      gap = prev.dx * (ox - prev.ex) + prev.dy * (oy - prev.ey);
      const em = Math.max(size, prev.size);
      newFragment = !sameDir || across > em * 0.5 || gap < -em * 0.6;
    }

    // Identical glyph drawn on (almost) the same spot: fake bold or a shadow. Keep it for its box,
    // but leave it out of the text so "Hello" drawn twice still reads "Hello". Only a glyph that
    // does not simply continue forward can repeat an earlier one, so only those are looked up.
    const cx = Math.round(ox / 4);
    const cy = Math.round(oy / 4);
    const suspicious: boolean = newFragment || gap < -size * 0.05 || inDuplicateRun;
    const twin: Rec | undefined = !suspicious ? undefined : findTwin(t, cx, cy, ox, oy, dx, dy, Math.min(4, 0.4 * Math.max(advance, size * 0.25)), Math.min(4, size * 0.15));
    inDuplicateRun = !!twin;
    if (twin) {
      glyph.duplicate = true;
      duplicates.push({ glyph, ox, oy, t0: 0, t1: 0, twin });
      continue;
    }
    if (newFragment || !frag) {
      frag = { dx, dy, c: dx * oy - dy * ox, size, tStart: Infinity, tEnd: -Infinity, recs: [] };
      fragments.push(frag);
    }
    const t0 = frag.dx * ox + frag.dy * oy;
    const rec: Rec = { glyph, ox, oy, t0, t1: t0 + advance };
    frag.recs.push(rec);
    frag.tStart = Math.min(frag.tStart, t0);
    frag.tEnd = Math.max(frag.tEnd, t0 + advance);
    frag.size = Math.max(frag.size, size);
    const list = seen.get(cell(cx, cy));
    if (list) list.push(rec);
    else seen.set(cell(cx, cy), [rec]);
    prev = { ox, oy, ex: ox + dx * advance, ey: oy + dy * advance, dx, dy, size };
  }

  // Phase 2: a fragment on the same baseline that fits beside (or into a gap of) an earlier line
  // joins it, so text drawn later (an edit appended to the page, a table cell) reads in place.
  const lineList: Fragment[] = [];
  for (const f of fragments) {
    const em = f.size;
    const lo = f.tStart + em * 0.1;
    const hi = f.tEnd - em * 0.1;
    const fits = (l: Fragment) =>
      l.dx * f.dx + l.dy * f.dy > 0.99 &&
      Math.abs(l.c - f.c) <= Math.min(em, l.size) * 0.3 &&
      f.tStart <= l.tEnd + em * 3 &&
      f.tEnd >= l.tStart - em * 3 &&
      // No glyph of the line may sit where this fragment's glyphs go.
      !l.recs.some((r) => r.t1 > lo && r.t0 < hi && r.glyph.text !== ' ');
    const target = lineList.find(fits);
    if (target) {
      target.recs.push(...f.recs);
      target.tStart = Math.min(target.tStart, f.tStart);
      target.tEnd = Math.max(target.tEnd, f.tEnd);
      target.size = Math.max(target.size, f.size);
    } else {
      lineList.push({ ...f, recs: [...f.recs] });
    }
  }

  // Phase 3: text in line order, glyphs sorted along each line, virtual spaces for gaps.
  const glyphs: TextGlyph[] = [];
  const lines: TextLine[] = [];
  let text = '';
  const map: number[] = [];
  for (const l of lineList) {
    l.recs.sort((a, b) => a.t0 - b.t0); // stable: equal positions keep content order
    const lineIndex = lines.length;
    if (lineIndex) {
      text += '\n';
      map.push(-1);
    }
    const start = glyphs.length;
    let last: Rec | undefined;
    for (const r of l.recs) {
      const t = r.glyph.text;
      if (last && t.trim() && last.glyph.text.trim() && r.t0 - last.t1 > Math.max(r.glyph.fontSize, last.glyph.fontSize) * 0.18) {
        text += ' ';
        map.push(-1);
      }
      r.glyph.line = lineIndex;
      const index = glyphs.length;
      glyphs.push(r.glyph);
      text += t;
      for (let i = 0; i < t.length; i++) map.push(index);
      last = r;
    }
    let box: Box = glyphs[start];
    for (let i = start + 1; i < glyphs.length; i++) box = unionBox(box, glyphs[i]);
    lines.push({ x: box.x, y: box.y, width: box.width, height: box.height, start, end: glyphs.length });
  }
  // Duplicates go last, attached to the line of the glyph they repeat (and widen its box).
  for (const d of duplicates) {
    d.glyph.line = d.twin!.glyph.line;
    glyphs.push(d.glyph);
    const line = lines[d.glyph.line];
    if (line) {
      const u = unionBox(line, d.glyph);
      Object.assign(line, { x: u.x, y: u.y, width: u.width, height: u.height });
    }
  }

  return { page: pageIndex, width: frame.width, height: frame.height, glyphs, lines, text, charToGlyph: Int32Array.from(map), unknownGlyphs };
}

interface Rec {
  glyph: TextGlyph;
  ox: number;
  oy: number;
  /** Position of the origin and of the advance end along the fragment direction. */
  t0: number;
  t1: number;
  twin?: Rec;
}

/** A run of glyphs continuing forward on one baseline; also used for merged lines. */
interface Fragment {
  dx: number;
  dy: number;
  /** Baseline offset across the direction. */
  c: number;
  size: number;
  tStart: number;
  tEnd: number;
  recs: Rec[];
}

export function unionBox(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

/** Compatibility forms (fullwidth digits, ligatures, non-breaking spaces) as plain characters. */
const normalized = new Map<string, string>();
function normalizeGlyphText(t: string): string {
  let out = normalized.get(t);
  if (out === undefined) {
    const n = t.normalize('NFKC');
    out = /^\s+$/.test(n) ? ' ' : n.replace(/[\u0000-\u001f]/g, '');
    if (normalized.size < 20000) normalized.set(t, out);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Page geometry
// ---------------------------------------------------------------------------

function visualFrame(page: PDFPage) {
  const crop = page.getCropBox();
  const rot = (((page.getRotation().angle % 360) + 360) % 360) as 0 | 90 | 180 | 270;
  const swap = rot === 90 || rot === 270;
  const width = swap ? crop.height : crop.width;
  const height = swap ? crop.width : crop.height;
  // User space → visual (bottom-left origin) → top-left origin.
  const toVisual = (ux: number, uy: number) => {
    const x = ux - crop.x;
    const y = uy - crop.y;
    let vx = x;
    let vy = y;
    if (rot === 90) [vx, vy] = [y, crop.width - x];
    else if (rot === 180) [vx, vy] = [crop.width - x, crop.height - y];
    else if (rot === 270) [vx, vy] = [crop.height - y, x];
    return { x: vx, y: height - vy };
  };
  const toVisualBox = (r: Rect): Box => {
    const a = toVisual(r.x1, r.y1);
    const b = toVisual(r.x2, r.y2);
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    return { x, y, width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
  };
  return { width, height, toVisualBox };
}

// ---------------------------------------------------------------------------
// Character code → Unicode
// ---------------------------------------------------------------------------

/** Unicode text for a character code, or null when the font gives no way to tell. */
export type FontDecoder = (code: number, byteLength: number) => string | null;

const lookup = (dict: PDFDict, key: string): PDFObject | undefined => {
  const v = dict.get(PDFName.of(key));
  return v instanceof PDFRef ? dict.context.lookup(v) : v;
};

function fontDecoder(font: PDFDict): FontDecoder {
  const toUnicode = new Map<string, string>();
  const tu = lookup(font, 'ToUnicode');
  if (tu instanceof PDFStream) {
    try {
      for (const [unicode, bytes] of parseToUnicode(streamBytes(tu))) {
        const code = bytes.reduce((a, b) => a * 256 + b, 0);
        toUnicode.set(`${bytes.length}:${code}`, unicode);
      }
    } catch {
      /* broken CMap: fall back to the encoding */
    }
  }
  const subtype = (lookup(font, 'Subtype') as PDFName | undefined)?.decodeText();
  let fallback: FontDecoder = () => null;
  if (subtype === 'Type0') {
    // Without ToUnicode only the UCS-2 / UTF-16 CMaps say what a code means.
    const enc = lookup(font, 'Encoding');
    const name = enc instanceof PDFName ? enc.decodeText() : '';
    if (/^Uni.*(UCS2|UTF16)-[HV]$/.test(name)) fallback = (code) => (code > 0 ? String.fromCharCode(code) : null);
  } else {
    fallback = simpleFontDecoder(font, subtype);
  }
  if (!toUnicode.size) return fallback;
  return (code, n) => {
    const t = toUnicode.get(`${n}:${code}`);
    return t !== undefined && t !== '' && t !== '\u0000' ? t : fallback(code, n);
  };
}

function simpleFontDecoder(font: PDFDict, subtype: string | undefined): FontDecoder {
  const base = ((lookup(font, 'BaseFont') as PDFName | undefined)?.decodeText() ?? '').replace(/^[A-Z]{6}\+/, '');
  const enc = lookup(font, 'Encoding');
  let baseName = enc instanceof PDFName ? enc.decodeText() : '';
  const differences = new Map<number, string>();
  if (enc instanceof PDFDict) {
    const be = lookup(enc, 'BaseEncoding');
    if (be instanceof PDFName) baseName = be.decodeText();
    const diffs = lookup(enc, 'Differences');
    if (diffs instanceof PDFArray) {
      let code = 0;
      for (const item of diffs.asArray()) {
        if (item instanceof PDFNumber) code = item.asNumber();
        else if (item instanceof PDFName) differences.set(code++, item.decodeText());
      }
    }
  }
  const descriptor = lookup(font, 'FontDescriptor');
  const flags = descriptor instanceof PDFDict ? ((lookup(descriptor, 'Flags') as PDFNumber | undefined)?.asNumber() ?? 0) : 0;
  const symbolic = (flags & 4) !== 0 && (flags & 32) === 0;

  let table: (code: number) => string | undefined;
  if (/^Symbol/.test(base) && !baseName) table = (c) => symbolTable().get(c);
  else if (base === 'ZapfDingbats' && !baseName) table = () => undefined;
  else if (baseName === 'MacRomanEncoding') table = macRoman;
  else if (baseName === 'StandardEncoding' || (!baseName && subtype === 'Type1' && !symbolic)) table = standard;
  else table = winAnsi;

  return (code) => {
    const name = differences.get(code);
    if (name !== undefined) {
      const fromName = glyphNameToUnicode(name);
      if (fromName !== null) return fromName;
      // Names such as "g17" or "cid42" say nothing; an unknown name over a printable code is
      // usually that very character (subset fonts renaming glyphs), so accept it as a guess.
      return code >= 0x21 && code < 0x7f && !/^(g|cid|glyph|index)\d+$/i.test(name) ? String.fromCharCode(code) : null;
    }
    const t = table(code);
    if (t !== undefined) return t;
    // Symbolic TrueType fonts without an encoding very often use plain ASCII codes.
    return code >= 0x20 && code < 0x7f ? String.fromCharCode(code) : null;
  };
}

let winAnsiMap: Map<number, string> | undefined;
let nameMap: Map<string, string> | undefined;
let symbolMap: Map<number, string> | undefined;

function winAnsi(code: number): string | undefined {
  if (!winAnsiMap) {
    winAnsiMap = new Map();
    for (const cp of Encodings.WinAnsi.supportedCodePoints) winAnsiMap.set(Encodings.WinAnsi.encodeUnicodeCodePoint(cp).code, String.fromCodePoint(cp));
  }
  return winAnsiMap.get(code);
}

function symbolTable(): Map<number, string> {
  if (!symbolMap) {
    symbolMap = new Map();
    for (const cp of Encodings.Symbol.supportedCodePoints) symbolMap.set(Encodings.Symbol.encodeUnicodeCodePoint(cp).code, String.fromCodePoint(cp));
  }
  return symbolMap;
}

// StandardEncoding differs from WinAnsi in two ASCII positions and in its upper half.
const STANDARD_HIGH: Record<number, string> = {
  0x27: '’', 0x60: '‘', 0xa1: '¡', 0xa2: '¢', 0xa3: '£', 0xa4: '⁄', 0xa5: '¥', 0xa6: 'ƒ', 0xa7: '§', 0xa8: '¤', 0xa9: "'",
  0xaa: '“', 0xab: '«', 0xac: '‹', 0xad: '›', 0xae: 'ﬁ', 0xaf: 'ﬂ', 0xb1: '–', 0xb2: '†', 0xb3: '‡', 0xb4: '·', 0xb6: '¶',
  0xb7: '•', 0xb8: '‚', 0xb9: '„', 0xba: '”', 0xbb: '»', 0xbc: '…', 0xbd: '‰', 0xbf: '¿', 0xc1: '`', 0xc2: '´', 0xc3: 'ˆ',
  0xc4: '˜', 0xc5: '¯', 0xc6: '˘', 0xc7: '˙', 0xc8: '¨', 0xca: '˚', 0xcb: '¸', 0xcd: '˝', 0xce: '˛', 0xcf: 'ˇ', 0xd0: '—',
  0xe1: 'Æ', 0xe3: 'ª', 0xe8: 'Ł', 0xe9: 'Ø', 0xea: 'Œ', 0xeb: 'º', 0xf1: 'æ', 0xf5: 'ı', 0xf8: 'ł', 0xf9: 'ø', 0xfa: 'œ', 0xfb: 'ß',
};
function standard(code: number): string | undefined {
  if (code in STANDARD_HIGH) return STANDARD_HIGH[code];
  return code >= 0x20 && code < 0x7f ? String.fromCharCode(code) : undefined;
}

const MAC_ROMAN_HIGH =
  'ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ';
function macRoman(code: number): string | undefined {
  if (code >= 0x80) return MAC_ROMAN_HIGH[code - 0x80];
  return code >= 0x20 && code < 0x7f ? String.fromCharCode(code) : undefined;
}

const EXTRA_NAMES: Record<string, string> = {
  fi: 'fi', fl: 'fl', ff: 'ff', ffi: 'ffi', ffl: 'ffl', space: ' ', nbspace: ' ', hyphen: '-', sfthyphen: '-', minus: '-',
  quoteright: '’', quoteleft: '‘', dotlessi: 'ı', fraction: '⁄', Euro: '€', periodcentered: '·', bullet: '•',
};

/** Adobe glyph name → Unicode (common names, uniXXXX, uXXXX[XX], ligatures "f_i"), or null. */
export function glyphNameToUnicode(name: string): string | null {
  if (!nameMap) {
    nameMap = new Map(Object.entries(EXTRA_NAMES));
    for (const enc of [Encodings.WinAnsi, Encodings.Symbol]) {
      for (const cp of enc.supportedCodePoints) {
        const n = enc.encodeUnicodeCodePoint(cp).name;
        if (!nameMap.has(n)) nameMap.set(n, String.fromCodePoint(cp));
      }
    }
  }
  const direct = nameMap.get(name);
  if (direct !== undefined) return direct;
  const bare = name.replace(/\..*$/, '');
  if (bare !== name && bare) return glyphNameToUnicode(bare);
  if (bare.includes('_')) {
    const parts = bare.split('_').map(glyphNameToUnicode);
    return parts.every((p) => p !== null) ? parts.join('') : null;
  }
  let m = /^uni((?:[0-9A-F]{4})+)$/.exec(bare);
  if (m) {
    const units = m[1].match(/.{4}/g)!.map((h) => parseInt(h, 16));
    return String.fromCharCode(...units);
  }
  m = /^u([0-9A-F]{4,6})$/.exec(bare);
  if (m) {
    const cp = parseInt(m[1], 16);
    return cp <= 0x10ffff ? String.fromCodePoint(cp) : null;
  }
  return null;
}
