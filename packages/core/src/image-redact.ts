/**
 * Pixel redaction of raster images: the samples of an image that fall inside a redaction area are
 * overwritten, so the original pixels are gone from the file (not merely covered by a box).
 *
 * The interpreter in redact.ts finds each image placement (unit square × CTM) and computes which
 * image pixels the areas touch (`pixelMask`); the image is then decoded, the pixels filled, and a
 * redacted copy written under a new resource name (copy-on-write, like Form XObjects).
 *
 * Decoding without help: uncompressed data and the generic filters (Flate, LZW, ASCIIHex,
 * ASCII85, RunLength, with PNG/TIFF predictors) for any colour space whose component count is
 * known, at 1/2/4/8/16 bits per component, including stencil masks (/ImageMask).
 * JPEG (DCTDecode) and other image codecs (JPX, JBIG2, CCITT) need an injected `ImageCodec`;
 * without one such images are reported as unredacted and only covered.
 */
import {
  decodePDFRawStream,
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNull,
  PDFNumber,
  PDFObject,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
} from 'pdf-lib';
import type { PDFContext } from 'pdf-lib';
import { Dict, Name, Operand, parseContent, Str } from './content-lexer';
import type { Matrix, Rect } from './redact';

/** Decoded samples: `components` interleaved 8-bit values per pixel, rows top to bottom. */
export interface RasterImage {
  width: number;
  height: number;
  components: number;
  samples: Uint8Array;
}

/**
 * Codec for image filters the core cannot decode itself (JavaScript has no built-in JPEG codec
 * in Node). The browser build provides one based on createImageBitmap / OffscreenCanvas.
 */
export interface ImageCodec {
  /** Filter names this codec decodes, e.g. `['DCTDecode']`. */
  readonly filters: readonly string[];
  /** Decodes the image data (earlier filters in the chain already removed) to 8-bit samples. */
  decode(filter: string, data: Uint8Array): Promise<RasterImage>;
  /**
   * Re-encodes redacted samples with the same filter. Optional; return undefined (or omit) to
   * store the result Flate-compressed instead (lossless, but larger than JPEG).
   */
  encode?(filter: string, image: RasterImage): Promise<Uint8Array | undefined>;
}

export type Rgb = [number, number, number];

/** One image placement to redact; `ref` is reserved for the redacted copy. */
export interface ImageJob {
  ref: PDFRef;
  source: PDFRawStream;
  ctm: Matrix;
  areas: Rect[];
  /** 1 for every pixel (row-major, top row first) to overwrite. */
  mask: Uint8Array;
}

const IMAGE_FILTERS = new Set(['DCTDecode', 'JPXDecode', 'JBIG2Decode', 'CCITTFaxDecode']);
const NATIVE_FILTERS = new Set(['FlateDecode', 'LZWDecode', 'ASCIIHexDecode', 'ASCII85Decode', 'RunLengthDecode']);
/** Entries of the original image dictionary that do not carry over to the redacted copy. */
const DROPPED_KEYS = ['Filter', 'DecodeParms', 'Length', 'DL', 'Alternates', 'OPI'];
const MAX_PIXELS = 80_000_000;

const num = (o: PDFObject | undefined, fallback = 0) => (o instanceof PDFNumber ? o.asNumber() : fallback);
const key = (k: string) => PDFName.of(k);

interface ColorInfo {
  kind: 'gray' | 'rgb' | 'cmyk' | 'lab' | 'indexed' | 'ink';
  n: number;
  base?: ColorInfo;
  hival?: number;
  lookup?: Uint8Array;
  range?: number[];
}
const GRAY: ColorInfo = { kind: 'gray', n: 1 };
const RGB: ColorInfo = { kind: 'rgb', n: 3 };
const CMYK: ColorInfo = { kind: 'cmyk', n: 4 };

function deviceSpace(name: string): ColorInfo | undefined {
  if (name === 'DeviceGray' || name === 'G' || name === 'CalGray') return GRAY;
  if (name === 'DeviceRGB' || name === 'RGB' || name === 'CalRGB') return RGB;
  if (name === 'DeviceCMYK' || name === 'CMYK') return CMYK;
  return undefined;
}

function colorInfo(context: PDFContext, raw: PDFObject | undefined): ColorInfo | undefined {
  const cs = raw instanceof PDFRef ? context.lookup(raw) : raw;
  if (cs instanceof PDFName) return deviceSpace(cs.decodeText());
  if (!(cs instanceof PDFArray) || cs.size() === 0) return undefined;
  const family = cs.lookup(0);
  const name = family instanceof PDFName ? family.decodeText() : '';
  switch (name) {
    case 'ICCBased': {
      const s = cs.lookup(1);
      const n = s instanceof PDFStream ? num(s.dict.lookup(key('N'))) : 0;
      return n === 1 ? GRAY : n === 3 ? RGB : n === 4 ? CMYK : undefined;
    }
    case 'Lab': {
      const d = cs.lookup(1);
      const r = d instanceof PDFDict ? d.lookup(key('Range')) : undefined;
      const range = r instanceof PDFArray && r.size() === 4 ? r.asArray().map((o) => num(o)) : [-100, 100, -100, 100];
      return { kind: 'lab', n: 3, range };
    }
    case 'Indexed':
    case 'I': {
      const base = colorInfo(context, cs.get(1));
      const table = cs.lookup(3);
      let lookup: Uint8Array | undefined;
      if (table instanceof PDFString || table instanceof PDFHexString) lookup = table.asBytes();
      else if (table instanceof PDFRawStream) {
        try {
          lookup = decodePDFRawStream(table).decode();
        } catch {
          lookup = undefined;
        }
      }
      return { kind: 'indexed', n: 1, base: base?.kind === 'indexed' ? undefined : base, hival: num(cs.lookup(2)), lookup };
    }
    case 'Separation':
      return { kind: 'ink', n: 1 };
    case 'DeviceN': {
      const names = cs.lookup(1);
      return names instanceof PDFArray && names.size() > 0 ? { kind: 'ink', n: names.size() } : undefined;
    }
    default:
      return deviceSpace(name);
  }
}

function filterChain(dict: PDFDict): { names: string[]; parms: Array<PDFDict | undefined> } {
  const f = dict.lookup(key('Filter'));
  const p = dict.lookup(key('DecodeParms'));
  const names =
    f instanceof PDFName
      ? [f.decodeText()]
      : f instanceof PDFArray
        ? f.asArray().map((_, i) => {
            const n = f.lookup(i);
            return n instanceof PDFName ? n.decodeText() : '?';
          })
        : [];
  const parms = names.map((_, i) => {
    const v = p instanceof PDFArray ? p.lookup(i) : i === 0 ? p : undefined;
    return v instanceof PDFDict ? v : undefined;
  });
  return { names, parms };
}

function imageShape(dict: PDFDict) {
  const isMask = dict.lookup(key('ImageMask')) === PDFBool.True;
  return {
    width: Math.floor(num(dict.lookup(key('Width')))),
    height: Math.floor(num(dict.lookup(key('Height')))),
    isMask,
    bpc: isMask ? 1 : num(dict.lookup(key('BitsPerComponent')), 8),
  };
}

/** Why the pixels of `image` cannot be redacted with `codec`, or undefined when they can. */
export function unsupportedReason(doc: PDFDocument, image: PDFStream, codec: ImageCodec | undefined): string | undefined {
  if (!(image instanceof PDFRawStream)) return 'stream';
  const { width, height, isMask, bpc } = imageShape(image.dict);
  if (!(width > 0 && height > 0) || width * height > MAX_PIXELS) return 'size';
  const { names, parms } = filterChain(image.dict);
  for (let i = 0; i < names.length; i++) {
    const n = names[i];
    if (IMAGE_FILTERS.has(n)) {
      if (i !== names.length - 1 || !codec?.filters.includes(n)) return n;
    } else if (!NATIVE_FILTERS.has(n)) return n;
    const predictor = num(parms[i]?.lookup(key('Predictor')), 1);
    if (predictor === 2 && num(parms[i]?.lookup(key('BitsPerComponent')), 8) !== 8) return 'TIFF predictor';
  }
  const viaCodec = names.length > 0 && IMAGE_FILTERS.has(names[names.length - 1]);
  if (!viaCodec && ![1, 2, 4, 8, 16].includes(bpc)) return `BitsPerComponent ${bpc}`;
  if (!isMask && !colorInfo(doc.context, image.dict.get(key('ColorSpace'))) && !(viaCodec && names[names.length - 1] === 'JPXDecode')) {
    return 'ColorSpace';
  }
  return undefined;
}

/**
 * Pixels of a `width`×`height` image drawn into the unit square under `ctm` that touch any area.
 * A pixel counts when the bounding box of its (possibly rotated or skewed) cell overlaps an area,
 * which errs on the side of filling a sliver more. Null when no pixel is touched.
 */
export function pixelMask(width: number, height: number, ctm: Matrix, areas: Rect[]): Uint8Array | null {
  const [a, b, c, d, e, f] = ctm;
  const det = a * d - b * c;
  if (!(width > 0 && height > 0) || !Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  // Top-left corner of pixel (i, j) is ctm · (i / W, 1 - j / H); stepping i or j adds a fixed vector.
  const ix = a / width;
  const iy = b / width;
  const jx = -c / height;
  const jy = -d / height;
  const ox = [0, ix, jx, ix + jx];
  const oy = [0, iy, jy, iy + jy];
  const oxMin = Math.min(...ox);
  const oxMax = Math.max(...ox);
  const oyMin = Math.min(...oy);
  const oyMax = Math.max(...oy);
  const tol = 1e-6;
  const mask = new Uint8Array(width * height);
  let any = false;
  for (const r of areas) {
    // The area's corners in pixel coordinates bound the rows and columns worth testing.
    const corners = [
      [r.x1, r.y1],
      [r.x2, r.y1],
      [r.x1, r.y2],
      [r.x2, r.y2],
    ].map(([x, y]) => {
      const u = (d * (x - e) - c * (y - f)) / det;
      const v = (-b * (x - e) + a * (y - f)) / det;
      return [u * width, (1 - v) * height];
    });
    const i0 = Math.max(0, Math.floor(Math.min(...corners.map((p) => p[0]))) - 1);
    const i1 = Math.min(width, Math.ceil(Math.max(...corners.map((p) => p[0]))) + 1);
    const j0 = Math.max(0, Math.floor(Math.min(...corners.map((p) => p[1]))) - 1);
    const j1 = Math.min(height, Math.ceil(Math.max(...corners.map((p) => p[1]))) + 1);
    for (let j = j0; j < j1; j++) {
      const rowX = c * (1 - j / height) + e;
      const rowY = d * (1 - j / height) + f;
      for (let i = i0; i < i1; i++) {
        const px = a * (i / width) + rowX;
        const py = b * (i / width) + rowY;
        if (px + oxMax > r.x1 + tol && px + oxMin < r.x2 - tol && py + oyMax > r.y1 + tol && py + oyMin < r.y2 - tol) {
          mask[j * width + i] = 1;
          any = true;
        }
      }
    }
  }
  return any ? mask : null;
}

/**
 * Writes the redacted copy of each job's image to its reserved ref. Returns how many succeeded;
 * a failed job gets the original image instead (it stays covered only).
 */
export async function runImageJobs(doc: PDFDocument, jobs: ImageJob[], codec: ImageCodec | undefined, fill: Rgb): Promise<number> {
  let done = 0;
  for (const job of jobs) if (await runImageJob(doc, job, codec, fill)) done++;
  return done;
}

async function runImageJob(doc: PDFDocument, job: ImageJob, codec: ImageCodec | undefined, fill: Rgb): Promise<boolean> {
  const { context } = doc;
  try {
    // Stencil masks: redacted samples are "painted" (in the current fill colour, like the box).
    const result = await redactSamples(context, job.source, job.mask, codec, (info) => (info ? targetValues(info, fill) : [0]));
    // Masks are not content but carry shapes (e.g. text cut out of a logo): their region becomes
    // opaque. A mask that cannot be processed is dropped, so the image shows unmasked.
    for (const k of ['SMask', 'Mask']) {
      const m = job.source.dict.lookup(key(k));
      if (!(m instanceof PDFRawStream)) continue;
      try {
        const s = imageShape(m.dict);
        const mm = pixelMask(s.width, s.height, job.ctm, job.areas);
        if (mm) result.dict.set(key(k), context.register(await redactSamples(context, m, mm, codec, (info) => (info ? [1] : [0]))));
      } catch {
        result.dict.delete(key(k));
      }
    }
    context.assign(job.ref, result);
    return true;
  } catch {
    context.assign(job.ref, job.source);
    return false;
  }
}

/** Decodes `stream`, overwrites the masked pixels with the samples for `decoded`, re-encodes. */
async function redactSamples(
  context: PDFContext,
  stream: PDFRawStream,
  mask: Uint8Array,
  codec: ImageCodec | undefined,
  decoded: (info: ColorInfo | undefined) => number[],
): Promise<PDFRawStream> {
  const dict = stream.dict;
  const { width, height, isMask } = imageShape(dict);
  let { bpc } = imageShape(dict);
  const { names, parms } = filterChain(dict);
  const last = names[names.length - 1];
  let info = isMask ? undefined : colorInfo(context, dict.get(key('ColorSpace')));
  const decodeObj = dict.lookup(key('Decode'));
  let decodeArr = decodeObj instanceof PDFArray ? decodeObj.asArray().map((o) => num(o)) : undefined;
  const out = new Map<string, PDFObject>();
  for (const [k, v] of dict.entries()) if (!DROPPED_KEYS.includes(k.decodeText())) out.set(k.decodeText(), v);

  let samples: Uint8Array;
  let n: number;
  let encodeWith: string | undefined;
  if (last && IMAGE_FILTERS.has(last)) {
    if (!codec?.filters.includes(last) || isMask) throw new Error(`no codec for ${last}`);
    const pre = decodeChain(context, stream.contents, names.slice(0, -1), parms.slice(0, -1));
    const img = await codec.decode(last, pre);
    if (img.width !== width || img.height !== height) throw new Error('decoded size differs');
    samples = img.samples;
    n = img.components;
    bpc = 8;
    out.set('BitsPerComponent', PDFNumber.of(8));
    if (!info || info.n !== n) {
      // The codec converted colours (e.g. CMYK JPEG to RGB): describe what it returned.
      info = n === 1 ? GRAY : n === 3 ? RGB : undefined;
      if (!info) throw new Error('unexpected component count');
      out.set('ColorSpace', PDFName.of(n === 1 ? 'DeviceGray' : 'DeviceRGB'));
      out.delete('Decode');
      decodeArr = undefined;
    }
    encodeWith = last;
  } else {
    samples = decodeChain(context, stream.contents, names, parms);
    n = info ? info.n : 1;
  }

  const rowBytes = Math.ceil((width * n * bpc) / 8);
  if (samples.length !== rowBytes * height) {
    const sized = new Uint8Array(rowBytes * height);
    sized.set(samples.subarray(0, sized.length));
    samples = sized;
  } else samples = samples.slice();
  fillSamples(samples, width, height, n, bpc, rowBytes, mask, toSamples(decoded(info), decodeArr, info, bpc));

  let result: PDFRawStream | undefined;
  if (encodeWith && codec?.encode) {
    const bytes = await codec.encode(encodeWith, { width, height, components: n, samples });
    if (bytes) result = context.stream(bytes, { Filter: encodeWith });
  }
  result ??= context.flateStream(samples);
  for (const [k, v] of out) result.dict.set(key(k), v);
  return result;
}

function decodeChain(context: PDFContext, contents: Uint8Array, names: string[], parms: Array<PDFDict | undefined>): Uint8Array {
  let data = contents;
  for (let i = 0; i < names.length; i++) {
    const dict = context.obj({ Filter: names[i] }) as PDFDict;
    if (parms[i]) dict.set(key('DecodeParms'), parms[i]!);
    data = decodePDFRawStream(PDFRawStream.of(dict, data)).decode();
    if (parms[i] && num(parms[i]!.lookup(key('Predictor')), 1) > 1) data = undoPredictor(data, parms[i]!);
  }
  return data;
}

function undoPredictor(data: Uint8Array, parms: PDFDict): Uint8Array {
  const predictor = num(parms.lookup(key('Predictor')), 1);
  const colors = num(parms.lookup(key('Colors')), 1);
  const bpc = num(parms.lookup(key('BitsPerComponent')), 8);
  const columns = num(parms.lookup(key('Columns')), 1);
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowBytes = Math.ceil((colors * bpc * columns) / 8);
  if (predictor === 2) {
    if (bpc !== 8) throw new Error('TIFF predictor');
    const out = data.slice();
    for (let r = 0; r + rowBytes <= out.length; r += rowBytes) {
      for (let i = bpp; i < rowBytes; i++) out[r + i] = (out[r + i] + out[r + i - bpp]) & 0xff;
    }
    return out;
  }
  const rows = Math.floor(data.length / (rowBytes + 1));
  const out = new Uint8Array(rows * rowBytes);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowBytes + 1)];
    const src = r * (rowBytes + 1) + 1;
    const cur = r * rowBytes;
    const prev = cur - rowBytes;
    for (let i = 0; i < rowBytes; i++) {
      const raw = data[src + i];
      const left = i >= bpp ? out[cur + i - bpp] : 0;
      const up = r > 0 ? out[prev + i] : 0;
      const upLeft = r > 0 && i >= bpp ? out[prev + i - bpp] : 0;
      let v = raw;
      if (type === 1) v = raw + left;
      else if (type === 2) v = raw + up;
      else if (type === 3) v = raw + ((left + up) >> 1);
      else if (type === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        v = raw + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
      }
      out[cur + i] = v & 0xff;
    }
  }
  return out;
}

/**
 * Colour component values (in colour-space terms, before /Decode) for the fill colour.
 * Indexed images use the palette entry closest to it; spot colours (Separation/DeviceN) full ink.
 */
function targetValues(info: ColorInfo, [r, g, b]: Rgb): number[] {
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  switch (info.kind) {
    case 'gray':
      return [lum];
    case 'rgb':
      return [r, g, b];
    case 'cmyk': {
      const k = 1 - Math.max(r, g, b);
      return k >= 1 ? [0, 0, 0, 1] : [(1 - r - k) / (1 - k), (1 - g - k) / (1 - k), (1 - b - k) / (1 - k), k];
    }
    case 'lab':
      return [lum * 100, 0, 0];
    case 'ink':
      return new Array(info.n).fill(1 - lum);
    case 'indexed':
      return [nearestIndex(info, [r, g, b])];
  }
}

function nearestIndex(info: ColorInfo, target: Rgb): number {
  const { base, lookup } = info;
  const hival = Math.max(0, Math.floor(info.hival ?? 0));
  if (!base || !lookup || !['gray', 'rgb', 'cmyk'].includes(base.kind)) return 0;
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i <= hival && (i + 1) * base.n <= lookup.length; i++) {
    const c = Array.from(lookup.subarray(i * base.n, (i + 1) * base.n), (v) => v / 255);
    const rgb =
      base.kind === 'gray' ? [c[0], c[0], c[0]] : base.kind === 'rgb' ? c : [0, 1, 2].map((k) => (1 - c[k]) * (1 - c[3]));
    const dist = rgb.reduce((s, v, k) => s + (v - target[k]) ** 2, 0);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

/** Maps colour values to raw samples through /Decode (or the colour space's default). */
function toSamples(values: number[], decode: number[] | undefined, info: ColorInfo | undefined, bpc: number): number[] {
  const max = 2 ** bpc - 1;
  const n = values.length;
  const fallback = !info
    ? [0, 1]
    : info.kind === 'indexed'
      ? [0, max]
      : info.kind === 'lab'
        ? [0, 100, ...(info.range ?? [-100, 100, -100, 100])]
        : new Array(n).fill([0, 1]).flat();
  const D = decode && decode.length >= 2 * n ? decode : fallback;
  return values.map((v, k) => {
    const lo = D[2 * k];
    const hi = D[2 * k + 1];
    if (hi === lo) return 0;
    return Math.min(max, Math.max(0, Math.round(((v - lo) / (hi - lo)) * max)));
  });
}

function fillSamples(
  buf: Uint8Array,
  width: number,
  height: number,
  n: number,
  bpc: number,
  rowBytes: number,
  mask: Uint8Array,
  values: number[],
): void {
  for (let y = 0; y < height; y++) {
    const row = y * rowBytes;
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      for (let k = 0; k < n; k++) {
        const v = values[k];
        const idx = x * n + k;
        if (bpc === 8) buf[row + idx] = v;
        else if (bpc === 16) {
          buf[row + idx * 2] = v >> 8;
          buf[row + idx * 2 + 1] = v & 0xff;
        } else {
          const bit = idx * bpc;
          const at = row + (bit >> 3);
          const shift = 8 - bpc - (bit & 7);
          const m = ((1 << bpc) - 1) << shift;
          buf[at] = (buf[at] & ~m) | ((v << shift) & m);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Inline images (BI … ID … EI) as XObject streams

const INLINE_KEYS: Record<string, string> = {
  BPC: 'BitsPerComponent',
  CS: 'ColorSpace',
  D: 'Decode',
  DP: 'DecodeParms',
  F: 'Filter',
  H: 'Height',
  IM: 'ImageMask',
  I: 'Interpolate',
  W: 'Width',
};
const INLINE_NAMES: Record<string, string> = {
  G: 'DeviceGray',
  RGB: 'DeviceRGB',
  CMYK: 'DeviceCMYK',
  I: 'Indexed',
  AHx: 'ASCIIHexDecode',
  A85: 'ASCII85Decode',
  LZW: 'LZWDecode',
  Fl: 'FlateDecode',
  RL: 'RunLengthDecode',
  CCF: 'CCITTFaxDecode',
  DCT: 'DCTDecode',
};

/**
 * The inline image occupying `data[start, end)` (from `BI` through `EI`) as an equivalent
 * image XObject, so it can be redacted and drawn with `Do`. Undefined when malformed.
 */
export function inlineImageStream(context: PDFContext, data: Uint8Array, start: number, end: number, resources: PDFDict): PDFRawStream | undefined {
  const head = data.subarray(start + 2, end);
  const first = parseContent(head).next();
  if (first.done || first.value.op !== 'ID') return undefined;
  const dataStart = start + 2 + first.value.end + 1;
  // The lexer ends an inline image at whitespace + "EI"; that whitespace is not image data.
  if (dataStart > end - 3) return undefined;
  const args = first.value.args;
  const dict = context.obj({ Type: 'XObject', Subtype: 'Image' }) as PDFDict;
  const colorSpaces = resources.lookup(key('ColorSpace'));
  for (let i = 0; i + 1 < args.length; i += 2) {
    const k = args[i];
    if (!(k instanceof Name)) return undefined;
    const full = INLINE_KEYS[k.value] ?? k.value;
    if (full === 'Length' || full === 'L') continue;
    const v = args[i + 1];
    if (full === 'ColorSpace' && v instanceof Name && !INLINE_NAMES[v.value] && !deviceSpace(v.value)) {
      const named = colorSpaces instanceof PDFDict ? colorSpaces.get(key(v.value)) : undefined;
      if (!named) return undefined;
      dict.set(key(full), named);
      continue;
    }
    dict.set(key(full), toPdf(context, v, full === 'ColorSpace' || full === 'Filter'));
  }
  return PDFRawStream.of(dict, data.slice(dataStart, end - 3));
}

function toPdf(context: PDFContext, v: Operand, expandNames: boolean): PDFObject {
  if (typeof v === 'number') return PDFNumber.of(v);
  if (typeof v === 'boolean') return v ? PDFBool.True : PDFBool.False;
  if (v === null) return PDFNull;
  if (v instanceof Name) return PDFName.of(expandNames ? (INLINE_NAMES[v.value] ?? v.value) : v.value);
  if (v instanceof Str) return PDFHexString.of(Array.from(v.bytes, (b) => b.toString(16).padStart(2, '0')).join(''));
  if (v instanceof Dict) {
    const d = context.obj({}) as PDFDict;
    for (const [k, val] of v.entries) d.set(key(k), toPdf(context, val, false));
    return d;
  }
  const arr = PDFArray.withContext(context);
  for (const item of v) arr.push(toPdf(context, item, expandNames));
  return arr;
}
