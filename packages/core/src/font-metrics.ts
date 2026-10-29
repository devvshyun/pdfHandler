/**
 * Just enough font knowledge to position glyphs: how a string splits into character codes
 * and how wide each code is. Exactness matters only to the degree of deciding which glyphs
 * fall inside a redaction box, so unknown cases degrade to reasonable defaults and are flagged.
 */
import { Encodings, Font, FontNames } from '@pdf-lib/standard-fonts';
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFObject, PDFRawStream, PDFRef, PDFStream, decodePDFRawStream } from 'pdf-lib';
import { Name, parseContent, Str } from './content-lexer';

export interface FontMetrics {
  /** Splits a shown string into character codes, with each code's byte span. */
  codes(bytes: Uint8Array): Array<{ code: number; start: number; end: number }>;
  /** Advance width in text-space units (already divided by 1000). */
  width(code: number): number;
  /** Word spacing applies only to single-byte code 32. */
  isSpace(code: number, byteLength: number): boolean;
  ascent: number;
  descent: number;
  /** True when widths are guessed (unknown CMap or missing metrics). */
  approximate: boolean;
}

const STANDARD_ALIASES: Record<string, FontNames> = {
  Arial: FontNames.Helvetica,
  'Arial,Bold': FontNames.HelveticaBold,
  'Arial-BoldMT': FontNames.HelveticaBold,
  ArialMT: FontNames.Helvetica,
  'Arial,Italic': FontNames.HelveticaOblique,
  TimesNewRoman: FontNames.TimesRoman,
  'TimesNewRoman,Bold': FontNames.TimesRomanBold,
  TimesNewRomanPSMT: FontNames.TimesRoman,
  CourierNew: FontNames.Courier,
  CourierNewPSMT: FontNames.Courier,
};

let winAnsiNames: Map<number, string> | undefined;
function winAnsiCodeToName(): Map<number, string> {
  if (!winAnsiNames) {
    winAnsiNames = new Map();
    for (const cp of Encodings.WinAnsi.supportedCodePoints) {
      const { code, name } = Encodings.WinAnsi.encodeUnicodeCodePoint(cp);
      winAnsiNames.set(code, name);
    }
  }
  return winAnsiNames;
}

const lookup = (dict: PDFDict, key: string): PDFObject | undefined => {
  const v = dict.get(PDFName.of(key));
  return v instanceof PDFRef ? dict.context.lookup(v) : v;
};
const num = (o: PDFObject | undefined, fallback: number): number => (o instanceof PDFNumber ? o.asNumber() : fallback);

export function streamBytes(stream: PDFStream): Uint8Array {
  if (stream instanceof PDFRawStream) {
    return stream.dict.has(PDFName.of('Filter')) ? decodePDFRawStream(stream).decode() : stream.contents;
  }
  const s = stream as unknown as { getUnencodedContents?: () => Uint8Array };
  return s.getUnencodedContents ? s.getUnencodedContents() : stream.getContents();
}

export function loadFontMetrics(font: PDFDict): FontMetrics {
  const subtype = (lookup(font, 'Subtype') as PDFName | undefined)?.decodeText();
  return subtype === 'Type0' ? cidFont(font) : simpleFont(font, subtype);
}

function descriptorExtents(descriptor: PDFObject | undefined): { ascent: number; descent: number } {
  if (descriptor instanceof PDFDict) {
    const a = num(lookup(descriptor, 'Ascent'), 0);
    const d = num(lookup(descriptor, 'Descent'), 0);
    if (a > 0) return { ascent: a / 1000, descent: d < 0 ? d / 1000 : -0.2 };
  }
  return { ascent: 0.8, descent: -0.2 };
}

function simpleFont(font: PDFDict, subtype: string | undefined): FontMetrics {
  const descriptor = lookup(font, 'FontDescriptor');
  const missing = descriptor instanceof PDFDict ? num(lookup(descriptor, 'MissingWidth'), 0) : 0;
  const firstChar = num(lookup(font, 'FirstChar'), 0);
  const widthsObj = lookup(font, 'Widths');
  let scale = 1;
  if (subtype === 'Type3') {
    const m = lookup(font, 'FontMatrix');
    scale = m instanceof PDFArray ? num(m.lookup(0), 0.001) * 1000 : 1;
  }
  let approximate = false;
  let widthOf: (code: number) => number;

  if (widthsObj instanceof PDFArray) {
    const widths = widthsObj.asArray().map((o) => num(o instanceof PDFRef ? font.context.lookup(o) : o, missing));
    widthOf = (code) => widths[code - firstChar] ?? missing;
  } else {
    // Standard 14 fonts are allowed to omit /Widths; take metrics from the AFM data.
    const base = ((lookup(font, 'BaseFont') as PDFName | undefined)?.decodeText() ?? '').replace(/^[A-Z]{6}\+/, '');
    const stdName = (Object.values(FontNames) as string[]).includes(base) ? (base as FontNames) : STANDARD_ALIASES[base];
    if (stdName) {
      const afm = Font.load(stdName);
      const names = encodingNames(font);
      widthOf = (code) => afm.getWidthOfGlyph(names.get(code) ?? '') ?? missing ?? 0;
    } else {
      approximate = true;
      widthOf = () => missing || 500;
    }
  }
  const { ascent, descent } = descriptorExtents(descriptor);
  return {
    codes: (bytes) => Array.from(bytes, (code, i) => ({ code, start: i, end: i + 1 })),
    width: (code) => (widthOf(code) * scale) / 1000,
    isSpace: (code) => code === 32,
    ascent: subtype === 'Type3' ? 0.8 : ascent,
    descent: subtype === 'Type3' ? -0.2 : descent,
    approximate,
  };
}

/** Code → glyph name for a simple font: WinAnsi base plus any /Differences. */
function encodingNames(font: PDFDict): Map<number, string> {
  const names = new Map(winAnsiCodeToName());
  const enc = lookup(font, 'Encoding');
  if (enc instanceof PDFDict) {
    const diffs = lookup(enc, 'Differences');
    if (diffs instanceof PDFArray) {
      let code = 0;
      for (const item of diffs.asArray()) {
        if (item instanceof PDFNumber) code = item.asNumber();
        else if (item instanceof PDFName) names.set(code++, item.decodeText());
      }
    }
  }
  return names;
}

function cidFont(font: PDFDict): FontMetrics {
  const descendants = lookup(font, 'DescendantFonts');
  const cid = descendants instanceof PDFArray ? descendants.lookup(0) : undefined;
  const cidDict = cid instanceof PDFDict ? cid : undefined;
  const dw = cidDict ? num(lookup(cidDict, 'DW'), 1000) : 1000;
  const widths = new Map<number, number>();
  const w = cidDict ? lookup(cidDict, 'W') : undefined;
  if (w instanceof PDFArray) {
    const items = w.asArray().map((o) => (o instanceof PDFRef ? font.context.lookup(o) : o));
    for (let i = 0; i < items.length; ) {
      const first = num(items[i], 0);
      const next = items[i + 1];
      if (next instanceof PDFArray) {
        next.asArray().forEach((v, k) => widths.set(first + k, num(v instanceof PDFRef ? font.context.lookup(v) : v, dw)));
        i += 2;
      } else {
        const last = num(next, first);
        const width = num(items[i + 2], dw);
        for (let c = first; c <= last; c++) widths.set(c, width);
        i += 3;
      }
    }
  }

  const encoding = lookup(font, 'Encoding');
  let cmap: CMap;
  let approximate = false;
  if (encoding instanceof PDFName && /^Identity-[HV]$/.test(encoding.decodeText())) cmap = IDENTITY;
  else if (encoding instanceof PDFStream) cmap = parseCMap(streamBytes(encoding));
  else {
    // Predefined CJK CMaps: codes are (almost always) 2 bytes but the code→CID table is not
    // available here, so widths fall back to the default width.
    cmap = { ...IDENTITY, toCid: () => -1 };
    approximate = true;
  }
  const { ascent, descent } = descriptorExtents(cidDict ? lookup(cidDict, 'FontDescriptor') : undefined);
  return {
    codes: (bytes) => cmap.split(bytes),
    width: (code) => (widths.get(cmap.toCid(code)) ?? dw) / 1000,
    isSpace: (code, byteLength) => byteLength === 1 && code === 32,
    ascent,
    descent,
    approximate,
  };
}

interface CMap {
  split(bytes: Uint8Array): Array<{ code: number; start: number; end: number }>;
  toCid(code: number): number;
}

const IDENTITY: CMap = {
  split: (bytes) => {
    const out = [];
    for (let i = 0; i + 1 < bytes.length; i += 2) out.push({ code: (bytes[i] << 8) | bytes[i + 1], start: i, end: i + 2 });
    return out;
  },
  toCid: (code) => code,
};

/** Embedded CMap: codespace ranges decide code lengths; cidrange/cidchar map codes to CIDs. */
function parseCMap(data: Uint8Array): CMap {
  const spaces: Array<{ low: Uint8Array; high: Uint8Array }> = [];
  const ranges: Array<{ low: number; high: number; cid: number }> = [];
  const singles = new Map<number, number>();
  const toNum = (s: Str) => s.bytes.reduce((acc, b) => acc * 256 + b, 0);
  for (const { op, args } of parseContent(data)) {
    if (op === 'endcodespacerange') {
      for (let i = 0; i + 1 < args.length; i += 2) {
        const [lo, hi] = [args[i], args[i + 1]];
        if (lo instanceof Str && hi instanceof Str) spaces.push({ low: lo.bytes, high: hi.bytes });
      }
    } else if (op === 'endcidrange') {
      for (let i = 0; i + 2 < args.length; i += 3) {
        const [lo, hi, c] = [args[i], args[i + 1], args[i + 2]];
        if (lo instanceof Str && hi instanceof Str && typeof c === 'number') ranges.push({ low: toNum(lo), high: toNum(hi), cid: c });
      }
    } else if (op === 'endcidchar') {
      for (let i = 0; i + 1 < args.length; i += 2) {
        const [code, c] = [args[i], args[i + 1]];
        if (code instanceof Str && typeof c === 'number') singles.set(toNum(code), c);
      }
    } else if (op === 'usecmap' && args[0] instanceof Name && /^Identity-[HV]$/.test(args[0].value) && !spaces.length) {
      spaces.push({ low: Uint8Array.of(0, 0), high: Uint8Array.of(0xff, 0xff) });
    }
  }
  if (!spaces.length) spaces.push({ low: Uint8Array.of(0, 0), high: Uint8Array.of(0xff, 0xff) });
  const inSpace = (bytes: Uint8Array, at: number, n: number) =>
    spaces.some(({ low, high }) => {
      if (low.length !== n || at + n > bytes.length) return false;
      for (let k = 0; k < n; k++) if (bytes[at + k] < low[k] || bytes[at + k] > high[k]) return false;
      return true;
    });
  const minLen = Math.min(...spaces.map((s) => s.low.length));
  return {
    split(bytes) {
      const out = [];
      for (let i = 0; i < bytes.length; ) {
        let n = 1;
        while (n <= 4 && !inSpace(bytes, i, n)) n++;
        if (n > 4) n = Math.min(minLen, bytes.length - i);
        let code = 0;
        for (let k = 0; k < n; k++) code = code * 256 + bytes[i + k];
        out.push({ code, start: i, end: i + n });
        i += n;
      }
      return out;
    },
    toCid(code) {
      const single = singles.get(code);
      if (single !== undefined) return single;
      for (const r of ranges) if (code >= r.low && code <= r.high) return r.cid + (code - r.low);
      return ranges.length || singles.size ? 0 : code;
    },
  };
}

/** A shown-text element: a run of character codes, or a TJ displacement in thousandths of an em. */
export type TextElement = Uint8Array | number;

/**
 * Builds an encoder that writes `text` in an existing font of the document, so edited text keeps the
 * original typeface. Returns null for the whole string when any character is missing from the font
 * (subset fonts only contain the glyphs the document used). A missing space becomes a TJ gap.
 */
export function makeEncoder(font: PDFDict): ((text: string) => TextElement[] | null) | null {
  const map = new Map<string, Uint8Array>();
  const toUnicode = lookup(font, 'ToUnicode');
  if (toUnicode instanceof PDFStream) {
    for (const [unicode, code] of parseToUnicode(streamBytes(toUnicode))) {
      const prev = map.get(unicode);
      if (!prev || code.length < prev.length) map.set(unicode, code);
    }
  }
  const subtype = (lookup(font, 'Subtype') as PDFName | undefined)?.decodeText();
  if (subtype !== 'Type0' && subtype !== 'Type3' && !map.size) {
    // Simple font without ToUnicode: only safe when it uses a WinAnsi-compatible encoding.
    const enc = lookup(font, 'Encoding');
    const plain = !enc || (enc instanceof PDFName && enc.decodeText() === 'WinAnsiEncoding');
    if (!plain) return null;
    const widths = lookup(font, 'Widths');
    const firstChar = num(lookup(font, 'FirstChar'), 0);
    for (const cp of Encodings.WinAnsi.supportedCodePoints) {
      const { code } = Encodings.WinAnsi.encodeUnicodeCodePoint(cp);
      // With /Widths present a zero width means the glyph is not in the (subset) font.
      if (widths instanceof PDFArray && !num(widths.lookup(code - firstChar) as PDFObject | undefined, 0)) continue;
      map.set(String.fromCodePoint(cp), Uint8Array.of(code));
    }
  }
  if (!map.size) return null;
  return (text) => {
    const out: TextElement[] = [];
    let run: number[] = [];
    const flush = () => {
      if (run.length) out.push(Uint8Array.from(run));
      run = [];
    };
    for (const ch of text) {
      const code = map.get(ch);
      if (code) run.push(...code);
      else if (ch === ' ') {
        flush();
        out.push(-250); // a quarter-em gap stands in for a space glyph the subset lacks
      } else return null;
    }
    flush();
    return out;
  };
}

/** ToUnicode CMap → [unicode string, character code bytes]. */
export function parseToUnicode(data: Uint8Array): Array<[string, Uint8Array]> {
  const pairs: Array<[string, Uint8Array]> = [];
  const utf16 = (b: Uint8Array) => {
    let s = '';
    for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]);
    return s;
  };
  const bump = (bytes: Uint8Array, by: number) => {
    const out = Uint8Array.from(bytes);
    let v = by;
    for (let i = out.length - 1; i >= 0 && v; i--) {
      const sum = out[i] + v;
      out[i] = sum & 0xff;
      v = sum >> 8;
    }
    return out;
  };
  for (const { op, args } of parseContent(data)) {
    if (op === 'endbfchar') {
      for (let i = 0; i + 1 < args.length; i += 2) {
        const [src, dst] = [args[i], args[i + 1]];
        if (src instanceof Str && dst instanceof Str) pairs.push([utf16(dst.bytes), src.bytes]);
      }
    } else if (op === 'endbfrange') {
      for (let i = 0; i + 2 < args.length; i += 3) {
        const [lo, hi, dst] = [args[i], args[i + 1], args[i + 2]];
        if (!(lo instanceof Str && hi instanceof Str)) continue;
        const count = hi.bytes.reduce((a, b) => a * 256 + b, 0) - lo.bytes.reduce((a, b) => a * 256 + b, 0);
        for (let k = 0; k <= count && k < 65536; k++) {
          const code = bump(lo.bytes, k);
          if (dst instanceof Str) pairs.push([utf16(bump(dst.bytes, k)), code]);
          else if (Array.isArray(dst) && dst[k] instanceof Str) pairs.push([utf16((dst[k] as Str).bytes), code]);
        }
      }
    }
  }
  return pairs;
}
