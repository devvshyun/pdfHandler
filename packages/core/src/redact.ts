/**
 * True redaction: removes the glyphs that fall inside the given areas from the page's content
 * streams (and from Form XObjects drawn on the page), instead of merely covering them.
 *
 * Text after a removed glyph keeps its exact position: each removed glyph is replaced by a
 * TJ displacement equal to its advance. Only the affected operators are rewritten; every other
 * byte of the content stream is kept as is.
 *
 * Not handled (reported so the UI can warn): text inside raster images (scans) and glyph
 * shapes drawn as vector paths. Overlapping annotations are removed.
 */
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFObject, PDFPage, PDFRef, PDFStream } from 'pdf-lib';
import { ContentOp, formatNumber, hexString, Name, Operand, parseContent, Str } from './content-lexer';
import { FontMetrics, loadFontMetrics, streamBytes } from './font-metrics';

export interface Rect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface RedactionReport {
  page: number;
  removedGlyphs: number;
  removedAnnotations: number;
  /** Images overlapping the area; their pixels are NOT altered. */
  imagesOverlapping: number;
  /** Fonts whose widths had to be estimated, so edges of the area may be imprecise. */
  approximateFonts: number;
}

/** `overlap`: any glyph touching the area goes. `center`: only glyphs whose centre lies inside. */
export type HitMode = 'overlap' | 'center';

export type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

const mul = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[1] * n[2],
  m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2],
  m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4],
  m[4] * n[1] + m[5] * n[3] + n[5],
];
const apply = (m: Matrix, x: number, y: number) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });

function boxOf(m: Matrix, x1: number, y1: number, x2: number, y2: number): Rect {
  const pts = [apply(m, x1, y1), apply(m, x2, y1), apply(m, x1, y2), apply(m, x2, y2)];
  return {
    x1: Math.min(...pts.map((p) => p.x)),
    y1: Math.min(...pts.map((p) => p.y)),
    x2: Math.max(...pts.map((p) => p.x)),
    y2: Math.max(...pts.map((p) => p.y)),
  };
}

const EPS = 0.01;
const overlaps = (a: Rect, b: Rect) =>
  Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1) > EPS && Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1) > EPS;
const contains = (r: Rect, x: number, y: number) => x >= r.x1 && x <= r.x2 && y >= r.y1 && y <= r.y2;

interface TextState {
  Tc: number;
  Tw: number;
  Th: number;
  TL: number;
  Tfs: number;
  Trise: number;
  font?: FontMetrics;
  fontRaw?: PDFObject;
}

interface GState {
  ctm: Matrix;
  ts: TextState;
  /** DeviceRGB fill colour when known (g/rg/k); null after other colour spaces. */
  fill: [number, number, number] | null;
}

/** Typography of the first removed glyph, so replacement text can be drawn the same way. */
export interface CapturedRun {
  /** Font dictionary (or a reference to it) the glyph was shown with. */
  fontRaw: PDFObject;
  /** Text rendering matrix of the glyph in page user space (includes size, scaling and rise). */
  trm: Matrix;
  /** Character and word spacing relative to the font size (Tc / Tfs, Tw / Tfs). */
  charSpacing: number;
  wordSpacing: number;
  fill: [number, number, number] | null;
}

interface Ctx {
  doc: PDFDocument;
  areas: Rect[];
  mode: HitMode;
  report: RedactionReport;
  fontCache: Map<PDFObject, FontMetrics | null>;
  /** Guards against Form XObjects that (directly or not) draw themselves. */
  formDepth: number;
  capture?: CapturedRun;
  /** Read-only observer of every positioned glyph (see visitGlyphs). */
  onGlyph?: (glyph: GlyphVisit) => void;
}

/** A glyph as the interpreter positions it; `box` and `trm` are in page user space. */
export interface GlyphVisit {
  code: number;
  /** Byte length of the character code (distinguishes 1-byte from 2-byte codes). */
  byteLength: number;
  font: FontMetrics;
  fontRaw?: PDFObject;
  trm: Matrix;
  /** Advance width of the glyph in text space (font size 1). */
  width: number;
  box: Rect;
}

/** Calls `onGlyph` for every glyph drawn on the page (Form XObjects included), changing nothing. */
export function visitGlyphs(doc: PDFDocument, page: PDFPage, onGlyph: (glyph: GlyphVisit) => void): void {
  const report: RedactionReport = { page: 0, removedGlyphs: 0, removedAnnotations: 0, imagesOverlapping: 0, approximateFonts: 0 };
  const ctx: Ctx = { doc, areas: [], mode: 'overlap', report, fontCache: new Map(), formDepth: 0, onGlyph };
  processStream(ctx, pageContentBytes(page), page.node.Resources() ?? doc.context.obj({}), IDENTITY);
}

/** Redacts `areas` (page user space) on one page. */
export function redactPage(
  doc: PDFDocument,
  page: PDFPage,
  pageIndex: number,
  areas: Rect[],
  mode: HitMode,
): RedactionReport & { capture?: CapturedRun } {
  const report: RedactionReport = { page: pageIndex, removedGlyphs: 0, removedAnnotations: 0, imagesOverlapping: 0, approximateFonts: 0 };
  const ctx: Ctx = { doc, areas, mode, report, fontCache: new Map(), formDepth: 0 };

  const contents = pageContentBytes(page);
  const resources = page.node.Resources() ?? doc.context.obj({});
  const result = processStream(ctx, contents, resources, IDENTITY);
  if (result) {
    // q/Q isolates the original drawing state from anything drawn afterwards (e.g. a fill box).
    const wrapped = new Uint8Array(result.bytes.length + 4);
    wrapped.set([0x71, 0x0a]);
    wrapped.set(result.bytes, 2);
    wrapped.set([0x0a, 0x51], result.bytes.length + 2);
    const ref = doc.context.register(doc.context.flateStream(wrapped));
    // An array, because pdf-lib appends later drawings to /Contents with push().
    page.node.set(PDFName.of('Contents'), doc.context.obj([ref]));
    // Inherited resources are materialised on the page so the page owns its copy.
    page.node.set(PDFName.of('Resources'), result.resources);
    // PDFPage caches the stream it appends drawings to; that stream is no longer in /Contents.
    const cached = page as unknown as { contentStream?: unknown; contentStreamRef?: unknown };
    cached.contentStream = undefined;
    cached.contentStreamRef = undefined;
  }
  removeAnnotations(ctx, page);
  return { ...report, capture: ctx.capture };
}

function pageContentBytes(page: PDFPage): Uint8Array {
  const contents = page.node.Contents();
  const streams: PDFStream[] = [];
  if (contents instanceof PDFStream) streams.push(contents);
  else if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i++) {
      const s = contents.lookup(i);
      if (s instanceof PDFStream) streams.push(s);
    }
  }
  // Streams of one page may only be split between tokens, so joining with a newline is safe.
  const parts = streams.map(streamBytes);
  const total = parts.reduce((n, p) => n + p.length + 1, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    out[at + p.length] = 0x0a;
    at += p.length + 1;
  }
  return out;
}

/**
 * Interprets one content stream. Returns the rewritten bytes and the (possibly cloned)
 * resource dictionary when anything changed, or null when the stream is untouched.
 */
function processStream(ctx: Ctx, data: Uint8Array, resources: PDFDict, baseCtm: Matrix): { bytes: Uint8Array; resources: PDFDict } | null {
  const edits: Array<{ start: number; end: number; text: string }> = [];
  let outResources = resources;
  let xobjectsClone: PDFDict | undefined;
  const replacedNames = new Set<string>();
  const untouchedUses = new Set<string>();

  const stack: GState[] = [];
  let gs: GState = { ctm: baseCtm, ts: { Tc: 0, Tw: 0, Th: 1, TL: 0, Tfs: 0, Trise: 0 }, fill: [0, 0, 0] };
  let Tm: Matrix = IDENTITY;
  let Tlm: Matrix = IDENTITY;

  const fonts = dictEntry(resources, 'Font');
  const xobjects = dictEntry(resources, 'XObject');

  const showText = (op: ContentOp, elements: Operand[], prefix: string) => {
    const ts = gs.ts;
    const font = ts.font;
    if (!font) return; // unknown font: cannot locate glyphs
    const out: Array<Uint8Array | number> = [];
    let changed = false;
    let pendingNumber = 0;
    const flushNumber = () => {
      if (pendingNumber) out.push(pendingNumber);
      pendingNumber = 0;
    };
    const scaleX = ts.Tfs * ts.Th;

    for (const el of elements) {
      if (typeof el === 'number') {
        pendingNumber += el;
        Tm = mul([1, 0, 0, 1, (-el / 1000) * ts.Tfs * ts.Th, 0], Tm);
        continue;
      }
      if (!(el instanceof Str)) continue;
      let kept: number[] = [];
      for (const { code, start, end } of font.codes(el.bytes)) {
        const w = font.width(code);
        const advance = (w * ts.Tfs + ts.Tc + (font.isSpace(code, end - start) ? ts.Tw : 0)) * ts.Th;
        const trm = mul([ts.Tfs * ts.Th, 0, 0, ts.Tfs, 0, ts.Trise], mul(Tm, gs.ctm));
        const box = boxOf(trm, 0, font.descent, w || 0.5, font.ascent);
        ctx.onGlyph?.({ code, byteLength: end - start, font, fontRaw: ts.fontRaw, trm, width: w, box });
        const hit = ctx.areas.some((a) =>
          ctx.mode === 'center' ? contains(a, (box.x1 + box.x2) / 2, (box.y1 + box.y2) / 2) : overlaps(a, box),
        );
        if (hit && scaleX !== 0) {
          if (!ctx.capture && ts.fontRaw) {
            ctx.capture = {
              fontRaw: ts.fontRaw,
              trm,
              charSpacing: ts.Tfs ? ts.Tc / ts.Tfs : 0,
              wordSpacing: ts.Tfs ? ts.Tw / ts.Tfs : 0,
              fill: gs.fill,
            };
          }
          if (kept.length) {
            flushNumber();
            out.push(Uint8Array.from(kept));
            kept = [];
          }
          pendingNumber += (-advance * 1000) / scaleX;
          ctx.report.removedGlyphs++;
          changed = true;
        } else {
          if (!kept.length) flushNumber();
          for (let k = start; k < end; k++) kept.push(el.bytes[k]);
        }
        Tm = mul([1, 0, 0, 1, advance, 0], Tm);
      }
      if (kept.length) {
        flushNumber();
        out.push(Uint8Array.from(kept));
      }
    }
    flushNumber();
    if (!changed) return;
    const body = out.map((e) => (typeof e === 'number' ? formatNumber(e) : hexString(e))).join(' ');
    edits.push({ start: op.start, end: op.end, text: `${prefix}[${body}] TJ` });
  };

  const nextLine = () => {
    Tlm = mul([1, 0, 0, 1, 0, -gs.ts.TL], Tlm);
    Tm = Tlm;
  };

  for (const op of parseContent(data)) {
    const a = op.args;
    const n = (i: number) => (typeof a[i] === 'number' ? (a[i] as number) : 0);
    switch (op.op) {
      case 'q':
        stack.push({ ctm: gs.ctm, ts: { ...gs.ts }, fill: gs.fill });
        break;
      case 'g':
        gs.fill = [n(0), n(0), n(0)];
        break;
      case 'rg':
        gs.fill = [n(0), n(1), n(2)];
        break;
      case 'k':
        gs.fill = [(1 - n(0)) * (1 - n(3)), (1 - n(1)) * (1 - n(3)), (1 - n(2)) * (1 - n(3))];
        break;
      case 'cs':
      case 'sc':
      case 'scn':
        gs.fill = null;
        break;
      case 'Q':
        gs = stack.pop() ?? gs;
        break;
      case 'cm':
        gs.ctm = mul([n(0), n(1), n(2), n(3), n(4), n(5)], gs.ctm);
        break;
      case 'BT':
        Tm = IDENTITY;
        Tlm = IDENTITY;
        break;
      case 'Tc':
        gs.ts.Tc = n(0);
        break;
      case 'Tw':
        gs.ts.Tw = n(0);
        break;
      case 'Tz':
        gs.ts.Th = n(0) / 100;
        break;
      case 'TL':
        gs.ts.TL = n(0);
        break;
      case 'Ts':
        gs.ts.Trise = n(0);
        break;
      case 'Tf': {
        gs.ts.Tfs = n(1);
        const name = a[0] instanceof Name ? a[0].value : '';
        gs.ts.font = fonts ? fontMetrics(ctx, fonts, name) : undefined;
        gs.ts.fontRaw = fonts?.get(PDFName.of(name));
        break;
      }
      case 'Td':
        Tlm = mul([1, 0, 0, 1, n(0), n(1)], Tlm);
        Tm = Tlm;
        break;
      case 'TD':
        gs.ts.TL = -n(1);
        Tlm = mul([1, 0, 0, 1, n(0), n(1)], Tlm);
        Tm = Tlm;
        break;
      case 'Tm':
        Tlm = [n(0), n(1), n(2), n(3), n(4), n(5)];
        Tm = Tlm;
        break;
      case 'T*':
        nextLine();
        break;
      case 'Tj':
        showText(op, [a[0]], '');
        break;
      case 'TJ':
        showText(op, Array.isArray(a[0]) ? a[0] : [], '');
        break;
      case "'":
        nextLine();
        showText(op, [a[0]], 'T* ');
        break;
      case '"':
        gs.ts.Tw = n(0);
        gs.ts.Tc = n(1);
        nextLine();
        showText(op, [a[2]], `${formatNumber(n(0))} Tw ${formatNumber(n(1))} Tc T* `);
        break;
      case 'BI':
        if (ctx.areas.some((r) => overlaps(r, boxOf(gs.ctm, 0, 0, 1, 1)))) ctx.report.imagesOverlapping++;
        break;
      case 'Do': {
        const name = a[0] instanceof Name ? a[0].value : '';
        const ref = xobjects?.get(PDFName.of(name));
        const xobj = ref instanceof PDFRef ? ctx.doc.context.lookup(ref) : ref;
        if (!(xobj instanceof PDFStream)) break;
        const subtype = xobj.dict.get(PDFName.of('Subtype'));
        if (subtype === PDFName.of('Image')) {
          if (ctx.areas.some((r) => overlaps(r, boxOf(gs.ctm, 0, 0, 1, 1)))) ctx.report.imagesOverlapping++;
          break;
        }
        if (subtype !== PDFName.of('Form') || ctx.formDepth > 12) break;
        const matrixObj = xobj.dict.lookup(PDFName.of('Matrix'));
        const fm: Matrix =
          matrixObj instanceof PDFArray && matrixObj.size() === 6
            ? (matrixObj.asArray().map((o) => (o instanceof PDFNumber ? o.asNumber() : 0)) as Matrix)
            : IDENTITY;
        const formResources = xobj.dict.lookup(PDFName.of('Resources'));
        ctx.formDepth++;
        const sub = processStream(ctx, streamBytes(xobj), formResources instanceof PDFDict ? formResources : resources, mul(fm, gs.ctm));
        ctx.formDepth--;
        if (!sub) {
          untouchedUses.add(name);
          break;
        }
        replacedNames.add(name);
        // A redacted copy of the form, drawn under a fresh name so other uses keep the original.
        const copy = ctx.doc.context.flateStream(sub.bytes);
        for (const [k, v] of xobj.dict.entries()) {
          if (!['Filter', 'DecodeParms', 'Length'].includes(k.decodeText())) copy.dict.set(k, v);
        }
        copy.dict.set(PDFName.of('Resources'), sub.resources);
        const copyRef = ctx.doc.context.register(copy);
        if (!xobjectsClone) {
          outResources = resources.clone(ctx.doc.context);
          xobjectsClone = (xobjects ?? ctx.doc.context.obj({})).clone(ctx.doc.context);
          outResources.set(PDFName.of('XObject'), xobjectsClone);
        }
        let alias = `${name}_r1`;
        for (let i = 2; xobjectsClone.has(PDFName.of(alias)); i++) alias = `${name}_r${i}`;
        xobjectsClone.set(PDFName.of(alias), copyRef);
        edits.push({ start: op.start, end: op.end, text: `/${alias} Do` });
        break;
      }
    }
  }

  if (!edits.length) return null;
  // Forms this stream no longer draws in their original form must not stay reachable from here,
  // or their unredacted text would survive in the file.
  for (const name of replacedNames) if (!untouchedUses.has(name)) xobjectsClone?.delete(PDFName.of(name));
  return { bytes: splice(data, edits), resources: outResources };
}

function fontMetrics(ctx: Ctx, fonts: PDFDict, name: string): FontMetrics | undefined {
  const raw = fonts.get(PDFName.of(name));
  if (!raw) return undefined;
  if (!ctx.fontCache.has(raw)) {
    const dict = raw instanceof PDFRef ? ctx.doc.context.lookup(raw) : raw;
    let metrics: FontMetrics | null = null;
    if (dict instanceof PDFDict) {
      try {
        metrics = loadFontMetrics(dict);
        if (metrics.approximate) ctx.report.approximateFonts++;
      } catch {
        metrics = null;
      }
    }
    ctx.fontCache.set(raw, metrics);
  }
  return ctx.fontCache.get(raw) ?? undefined;
}

function dictEntry(dict: PDFDict, key: string): PDFDict | undefined {
  const v = dict.lookup(PDFName.of(key));
  return v instanceof PDFDict ? v : undefined;
}

function splice(data: Uint8Array, edits: Array<{ start: number; end: number; text: string }>): Uint8Array {
  edits.sort((a, b) => a.start - b.start);
  const chunks: Uint8Array[] = [];
  let at = 0;
  for (const e of edits) {
    chunks.push(data.subarray(at, e.start));
    chunks.push(Uint8Array.from(e.text, (c) => c.charCodeAt(0)));
    at = e.end;
  }
  chunks.push(data.subarray(at));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

function removeAnnotations(ctx: Ctx, page: PDFPage): void {
  const annots = page.node.Annots();
  if (!annots) return;
  const keep: PDFObject[] = [];
  for (let i = 0; i < annots.size(); i++) {
    const raw = annots.get(i);
    const dict = annots.lookup(i);
    const rect = dict instanceof PDFDict ? dict.lookup(PDFName.of('Rect')) : undefined;
    if (rect instanceof PDFArray && rect.size() === 4) {
      const [x1, y1, x2, y2] = rect.asArray().map((o) => (o instanceof PDFNumber ? o.asNumber() : 0));
      const r = { x1: Math.min(x1, x2), y1: Math.min(y1, y2), x2: Math.max(x1, x2), y2: Math.max(y1, y2) };
      if (ctx.areas.some((a) => overlaps(a, r))) {
        // A form field merged into its widget keeps its value in /V; drop it too.
        (dict as PDFDict).delete(PDFName.of('V'));
        ctx.report.removedAnnotations++;
        continue;
      }
    }
    keep.push(raw);
  }
  if (keep.length !== annots.size()) page.node.set(PDFName.of('Annots'), ctx.doc.context.obj(keep));
}

/**
 * Deletes every indirect object that is no longer reachable from the trailer. pdf-lib writes all
 * registered objects on save, so without this the replaced content streams would still carry the
 * removed text.
 */
export function collectGarbage(doc: PDFDocument): number {
  const { context } = doc;
  const seen = new Set<string>();
  const visit = (obj: PDFObject | undefined): void => {
    if (!obj) return;
    if (obj instanceof PDFRef) {
      const key = obj.toString();
      if (seen.has(key)) return;
      seen.add(key);
      visit(context.lookup(obj));
    } else if (obj instanceof PDFDict) {
      for (const [, v] of obj.entries()) visit(v);
    } else if (obj instanceof PDFArray) {
      for (const v of obj.asArray()) visit(v);
    } else if (obj instanceof PDFStream) {
      visit(obj.dict);
    }
  };
  const t = context.trailerInfo;
  [t.Root, t.Info, t.Encrypt, t.ID].forEach((o) => visit(o as PDFObject | undefined));
  let removed = 0;
  for (const [ref] of context.enumerateIndirectObjects()) {
    if (!seen.has(ref.toString())) {
      context.delete(ref);
      removed++;
    }
  }
  return removed;
}
