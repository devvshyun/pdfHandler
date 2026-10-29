/**
 * True redaction: removes the glyphs that fall inside the given areas from the page's content
 * streams (and from Form XObjects drawn on the page), instead of merely covering them.
 *
 * Text after a removed glyph keeps its exact position: each removed glyph is replaced by a
 * TJ displacement equal to its advance. Only the affected operators are rewritten; every other
 * byte of the content stream is kept as is.
 *
 * Raster images (image XObjects and inline images) under an area get their pixels overwritten
 * (see image-redact.ts); formats that cannot be decoded are reported and only covered.
 * Overlapping annotations are removed (unless disabled), and with `sanitize` the hidden text of
 * affected marked content (/ActualText, /Alt, /E) and of the structure tree goes too.
 *
 * Not handled: glyph shapes drawn as vector paths.
 */
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFObject, PDFPage, PDFRawStream, PDFRef, PDFStream } from 'pdf-lib';
import { ContentOp, Dict, formatNumber, hexString, Name, Operand, parseContent, serializeOperand, Str } from './content-lexer';
import { FontMetrics, loadFontMetrics, streamBytes } from './font-metrics';
import { ImageCodec, ImageJob, inlineImageStream, pixelMask, unsupportedReason } from './image-redact';

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
  /** Image placements with pixels inside the area (= imagesRedacted + imagesUnredacted). */
  imagesOverlapping: number;
  /** Images whose pixels inside the area were overwritten in the file. */
  imagesRedacted: number;
  /** Images that could only be covered: their original pixels are still in the file. */
  imagesUnredacted: number;
  /** Why images could not be redacted, e.g. "DCTDecode" (no JPEG codec) or "JBIG2Decode". */
  unredactedImageReasons: string[];
  /** /ActualText, /Alt and /E entries removed from marked content and structure elements. */
  removedHiddenTexts: number;
  /** Fonts whose widths had to be estimated, so edges of the area may be imprecise. */
  approximateFonts: number;
}

export interface RedactPageOptions {
  /** Remove annotations (links, form fields, comments) overlapping an area. Default true. */
  removeAnnotations?: boolean;
  /**
   * Drop /ActualText, /Alt and /E of marked content and structure elements whose content was
   * removed or redacted, and the page thumbnail. Default false.
   */
  sanitize?: boolean;
  /** Redact image pixels; without it overlapping images are only counted. */
  images?: { codec?: ImageCodec };
}

const HIDDEN_TEXT_KEYS = ['ActualText', 'Alt', 'E'];

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
  // Extents of the transformed corners, without intermediate arrays (called for every glyph).
  const ax = m[0] * x1, bx = m[0] * x2, cx = m[2] * y1, dx = m[2] * y2;
  const ay = m[1] * x1, by = m[1] * x2, cy = m[3] * y1, dy = m[3] * y2;
  return {
    x1: Math.min(ax, bx) + Math.min(cx, dx) + m[4],
    y1: Math.min(ay, by) + Math.min(cy, dy) + m[5],
    x2: Math.max(ax, bx) + Math.max(cx, dx) + m[4],
    y2: Math.max(ay, by) + Math.max(cy, dy) + m[5],
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
  /** Image pixel redaction; jobs are queued here and carried out (async) by the caller. */
  images?: { codec?: ImageCodec; jobs: ImageJob[] };
  sanitize?: boolean;
  /** Stream whose MCIDs are being read: the page, or the Form XObject being interpreted. */
  owner?: PDFRef;
  /** `${owner}:${mcid}` of marked content that contained removed or redacted content. */
  hitMcids?: Set<string>;
  /** Forms whose use on this page was replaced by a redacted copy. */
  replacedForms?: Set<string>;
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

function emptyReport(page: number): RedactionReport {
  return {
    page,
    removedGlyphs: 0,
    removedAnnotations: 0,
    imagesOverlapping: 0,
    imagesRedacted: 0,
    imagesUnredacted: 0,
    unredactedImageReasons: [],
    removedHiddenTexts: 0,
    approximateFonts: 0,
  };
}

/** Calls `onGlyph` for every glyph drawn on the page (Form XObjects included), changing nothing. */
export function visitGlyphs(doc: PDFDocument, page: PDFPage, onGlyph: (glyph: GlyphVisit) => void): void {
  const ctx: Ctx = { doc, areas: [], mode: 'overlap', report: emptyReport(0), fontCache: new Map(), formDepth: 0, onGlyph };
  processStream(ctx, pageContentBytes(page), page.node.Resources() ?? doc.context.obj({}), IDENTITY);
}

/** Redacts `areas` (page user space) on one page. */
export function redactPage(
  doc: PDFDocument,
  page: PDFPage,
  pageIndex: number,
  areas: Rect[],
  mode: HitMode,
  options: RedactPageOptions = {},
): RedactionReport & { capture?: CapturedRun; imageJobs: ImageJob[] } {
  const report = emptyReport(pageIndex);
  const ctx: Ctx = { doc, areas, mode, report, fontCache: new Map(), formDepth: 0 };
  ctx.images = options.images ? { codec: options.images.codec, jobs: [] } : undefined;
  ctx.sanitize = options.sanitize ?? false;
  ctx.owner = page.ref;
  ctx.hitMcids = new Set();
  ctx.replacedForms = new Set();

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
  const removedAnnots = options.removeAnnotations === false ? new Set<string>() : removeAnnotations(ctx, page);
  cleanStructTree(ctx, page.ref, removedAnnots);
  // The thumbnail is a picture of the page as it was.
  if (ctx.sanitize && (report.removedGlyphs || report.imagesOverlapping)) page.node.delete(PDFName.of('Thumb'));
  return { ...report, capture: ctx.capture, imageJobs: ctx.images?.jobs ?? [] };
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
  /** Resource sub-dictionaries (XObject, Properties) cloned so new entries do not leak into shared ones. */
  const clones = new Map<string, PDFDict>();
  const writable = (kind: string): PDFDict => {
    let d = clones.get(kind);
    if (!d) {
      if (outResources === resources) outResources = resources.clone(ctx.doc.context);
      d = (dictEntry(resources, kind) ?? ctx.doc.context.obj({})).clone(ctx.doc.context);
      outResources.set(PDFName.of(kind), d);
      clones.set(kind, d);
    }
    return d;
  };
  const addResource = (kind: string, base: string, ref: PDFRef): string => {
    const d = writable(kind);
    let alias = `${base}_r1`;
    for (let i = 2; d.has(PDFName.of(alias)); i++) alias = `${base}_r${i}`;
    d.set(PDFName.of(alias), ref);
    return alias;
  };
  const replacedNames = new Set<string>();
  const untouchedUses = new Set<string>();
  const replacedProps = new Set<string>();
  const untouchedProps = new Set<string>();
  /** Open marked-content sequences; `hit` once removed or redacted content was inside. */
  const spans: Array<{ op: ContentOp; tag?: Operand; props?: Dict; propName?: string; hit: boolean }> = [];

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

  /** Rewrites an image draw (`Do` or inline image) to a pixel-redacted copy when it overlaps. */
  const redactImage = (op: ContentOp, image: PDFStream, name: string | undefined): void => {
    const width = numberIn(image.dict, 'Width');
    const height = numberIn(image.dict, 'Height');
    const mask = ctx.areas.some((r) => overlaps(r, boxOf(gs.ctm, 0, 0, 1, 1))) ? pixelMask(width, height, gs.ctm, ctx.areas) : null;
    if (!mask) {
      if (name) untouchedUses.add(name);
      return;
    }
    ctx.report.imagesOverlapping++;
    if (!ctx.images) {
      if (name) untouchedUses.add(name);
      return;
    }
    const problem = unsupportedReason(ctx.doc, image, ctx.images.codec);
    if (problem || !(image instanceof PDFRawStream)) {
      ctx.report.imagesUnredacted++;
      if (problem && !ctx.report.unredactedImageReasons.includes(problem)) ctx.report.unredactedImageReasons.push(problem);
      if (name) untouchedUses.add(name);
      return;
    }
    // The redacted copy is written later (decoding may be async); its ref is reserved now.
    const ref = ctx.doc.context.nextRef();
    ctx.images.jobs.push({ ref, source: image, ctm: gs.ctm, areas: ctx.areas, mask });
    if (name) replacedNames.add(name);
    edits.push({ start: op.start, end: op.end, text: `/${addResource('XObject', name ?? 'InlineImage', ref)} Do` });
  };

  /** Records a closed marked-content sequence that contained removed content. */
  const closeSpan = (span: (typeof spans)[number]) => {
    const props = span.props ?? (span.propName ? namedProperties(resources, span.propName) : undefined);
    const mcid = span.props ? span.props.entries.get('MCID') : props instanceof PDFDict ? props.lookup(PDFName.of('MCID')) : undefined;
    const mcidValue = typeof mcid === 'number' ? mcid : mcid instanceof PDFNumber ? mcid.asNumber() : undefined;
    if (mcidValue !== undefined && ctx.owner) ctx.hitMcids?.add(`${ctx.owner.toString()}:${mcidValue}`);
    if (!ctx.sanitize) return;
    const tag = span.tag ? serializeOperand(span.tag) : '/Span';
    if (span.props) {
      const kept = new Map([...span.props.entries].filter(([k]) => !HIDDEN_TEXT_KEYS.includes(k)));
      if (kept.size === span.props.entries.size) return;
      ctx.report.removedHiddenTexts += span.props.entries.size - kept.size;
      edits.push({ start: span.op.start, end: span.op.end, text: `${tag} ${serializeOperand(new Dict(kept))} BDC` });
    } else if (span.propName && props instanceof PDFDict && HIDDEN_TEXT_KEYS.some((k) => props.has(PDFName.of(k)))) {
      // A shared property list: point this sequence at a cleaned copy.
      const copy = props.clone(ctx.doc.context);
      for (const k of HIDDEN_TEXT_KEYS) if (copy.has(PDFName.of(k))) {
        copy.delete(PDFName.of(k));
        ctx.report.removedHiddenTexts++;
      }
      const alias = addResource('Properties', span.propName, ctx.doc.context.register(copy));
      replacedProps.add(span.propName);
      edits.push({ start: span.op.start, end: span.op.end, text: `${tag} /${alias} BDC` });
    }
  };

  for (const op of parseContent(data)) {
    const a = op.args;
    const n = (i: number) => (typeof a[i] === 'number' ? (a[i] as number) : 0);
    const hitsBefore = ctx.report.removedGlyphs + ctx.report.imagesOverlapping;
    switch (op.op) {
      case 'BMC':
        spans.push({ op, tag: a[0], hit: false });
        break;
      case 'BDC':
        spans.push({ op, tag: a[0], props: a[1] instanceof Dict ? a[1] : undefined, propName: a[1] instanceof Name ? a[1].value : undefined, hit: false });
        break;
      case 'EMC': {
        const span = spans.pop();
        if (span?.hit) closeSpan(span);
        else if (span?.propName) untouchedProps.add(span.propName);
        break;
      }
      case 'DP':
        if (a[1] instanceof Name) untouchedProps.add(a[1].value);
        break;
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
      case 'BI': {
        if (!ctx.areas.some((r) => overlaps(r, boxOf(gs.ctm, 0, 0, 1, 1)))) break;
        const inline = inlineImageStream(ctx.doc.context, data, op.start, op.end, resources);
        if (inline) redactImage(op, inline, undefined);
        else {
          ctx.report.imagesOverlapping++;
          ctx.report.imagesUnredacted++;
        }
        break;
      }
      case 'Do': {
        const name = a[0] instanceof Name ? a[0].value : '';
        const ref = xobjects?.get(PDFName.of(name));
        const xobj = ref instanceof PDFRef ? ctx.doc.context.lookup(ref) : ref;
        if (!(xobj instanceof PDFStream)) break;
        const subtype = xobj.dict.get(PDFName.of('Subtype'));
        if (subtype === PDFName.of('Image')) {
          redactImage(op, xobj, name);
          break;
        }
        if (subtype !== PDFName.of('Form') || ctx.formDepth > 12) break;
        const matrixObj = xobj.dict.lookup(PDFName.of('Matrix'));
        const fm: Matrix =
          matrixObj instanceof PDFArray && matrixObj.size() === 6
            ? (matrixObj.asArray().map((o) => (o instanceof PDFNumber ? o.asNumber() : 0)) as Matrix)
            : IDENTITY;
        const formResources = xobj.dict.lookup(PDFName.of('Resources'));
        const owner = ctx.owner;
        ctx.owner = ref instanceof PDFRef ? ref : undefined;
        ctx.formDepth++;
        const sub = processStream(ctx, streamBytes(xobj), formResources instanceof PDFDict ? formResources : resources, mul(fm, gs.ctm));
        ctx.formDepth--;
        ctx.owner = owner;
        if (!sub) {
          untouchedUses.add(name);
          break;
        }
        replacedNames.add(name);
        if (ref instanceof PDFRef) ctx.replacedForms?.add(ref.toString());
        // A redacted copy of the form, drawn under a fresh name so other uses keep the original.
        const copy = ctx.doc.context.flateStream(sub.bytes);
        for (const [k, v] of xobj.dict.entries()) {
          if (!['Filter', 'DecodeParms', 'Length'].includes(k.decodeText())) copy.dict.set(k, v);
        }
        copy.dict.set(PDFName.of('Resources'), sub.resources);
        const copyRef = ctx.doc.context.register(copy);
        edits.push({ start: op.start, end: op.end, text: `/${addResource('XObject', name, copyRef)} Do` });
        break;
      }
    }
    if (ctx.report.removedGlyphs + ctx.report.imagesOverlapping > hitsBefore) for (const s of spans) s.hit = true;
  }
  // Sequences left open at the end of the stream.
  for (const s of spans) if (s.hit) closeSpan(s);

  if (!edits.length) return null;
  // Forms and images this stream no longer draws in their original form must not stay reachable
  // from here, or their unredacted content would survive in the file.
  for (const name of replacedNames) if (!untouchedUses.has(name)) clones.get('XObject')?.delete(PDFName.of(name));
  for (const name of replacedProps) if (!untouchedProps.has(name)) clones.get('Properties')?.delete(PDFName.of(name));
  return { bytes: splice(data, edits), resources: outResources };
}

function namedProperties(resources: PDFDict, name: string): PDFDict | undefined {
  const v = dictEntry(resources, 'Properties')?.lookup(PDFName.of(name));
  return v instanceof PDFDict ? v : undefined;
}

function numberIn(dict: PDFDict, key: string): number {
  const v = dict.lookup(PDFName.of(key));
  return v instanceof PDFNumber ? Math.floor(v.asNumber()) : 0;
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

/** Removes annotations overlapping the areas; returns the refs of the removed ones. */
function removeAnnotations(ctx: Ctx, page: PDFPage): Set<string> {
  const removed = new Set<string>();
  const annots = page.node.Annots();
  if (!annots) return removed;
  const hits = new Set<number>();
  for (let i = 0; i < annots.size(); i++) {
    const dict = annots.lookup(i);
    const rect = dict instanceof PDFDict ? dict.lookup(PDFName.of('Rect')) : undefined;
    if (rect instanceof PDFArray && rect.size() === 4) {
      const [x1, y1, x2, y2] = rect.asArray().map((o) => (o instanceof PDFNumber ? o.asNumber() : 0));
      const r = { x1: Math.min(x1, x2), y1: Math.min(y1, y2), x2: Math.max(x1, x2), y2: Math.max(y1, y2) };
      if (ctx.areas.some((a) => overlaps(a, r))) hits.add(i);
    }
  }
  // Popups and replies point back at their annotation (/Parent, /IRT) and would keep it, with
  // its text, in the file: they go with it.
  const key = (i: number) => annots.get(i).toString();
  for (let grew = true; grew; ) {
    grew = false;
    const gone = new Set([...hits].map(key));
    for (let i = 0; i < annots.size(); i++) {
      const dict = annots.lookup(i);
      if (hits.has(i) || !(dict instanceof PDFDict)) continue;
      const link = [dict.get(PDFName.of('Parent')), dict.get(PDFName.of('IRT'))];
      if (link.some((l) => l instanceof PDFRef && gone.has(l.toString()))) {
        hits.add(i);
        grew = true;
      }
    }
  }
  if (!hits.size) return removed;
  const keep: PDFObject[] = [];
  for (let i = 0; i < annots.size(); i++) {
    if (!hits.has(i)) {
      keep.push(annots.get(i));
      continue;
    }
    const raw = annots.get(i);
    const dict = annots.lookup(i);
    if (raw instanceof PDFRef) removed.add(raw.toString());
    if (dict instanceof PDFDict && dict.get(PDFName.of('Subtype')) === PDFName.of('Widget')) detachWidget(ctx, raw, dict);
    ctx.report.removedAnnotations++;
  }
  page.node.set(PDFName.of('Annots'), ctx.doc.context.obj(keep));
  return removed;
}

/**
 * A widget stays reachable from the AcroForm field tree (with its appearance stream) and its
 * field keeps the value in /V: drop the value and unlink the widget, and fields left empty.
 */
function detachWidget(ctx: Ctx, raw: PDFObject, widget: PDFDict): void {
  widget.delete(PDFName.of('V'));
  let child: PDFObject = raw;
  let parentRaw = widget.get(PDFName.of('Parent'));
  while (parentRaw instanceof PDFRef) {
    const parent = ctx.doc.context.lookup(parentRaw);
    if (!(parent instanceof PDFDict)) return;
    parent.delete(PDFName.of('V'));
    const kids = parent.lookup(PDFName.of('Kids'));
    if (kids instanceof PDFArray) {
      const at = kids.asArray().findIndex((k) => k === child || k.toString() === child.toString());
      if (at >= 0) kids.remove(at);
      if (kids.size() > 0) return;
    }
    child = parentRaw;
    parentRaw = parent.get(PDFName.of('Parent'));
  }
  // Top of the field tree: unlink it from the form when it is listed there.
  const acroForm = ctx.doc.catalog.lookup(PDFName.of('AcroForm'));
  const fields = acroForm instanceof PDFDict ? acroForm.lookup(PDFName.of('Fields')) : undefined;
  if (fields instanceof PDFArray) {
    const at = fields.asArray().findIndex((k) => k === child || k.toString() === child.toString());
    if (at >= 0) fields.remove(at);
  }
}

/**
 * Structure-tree upkeep for one redacted page:
 * - elements whose marked content (MCIDs recorded in `ctx.hitMcids`) contained removed content
 *   lose /ActualText, /Alt and /E, along with their ancestors (with `sanitize`);
 * - references to removed annotations (OBJR) and to Form XObjects replaced on this page (MCR
 *   with /Stm) are dropped, since they would keep the unredacted originals in the file.
 */
function cleanStructTree(ctx: Ctx, pageRef: PDFRef, removedAnnots: Set<string>): void {
  const hitMcids = ctx.hitMcids ?? new Set<string>();
  const replacedForms = ctx.replacedForms ?? new Set<string>();
  if (!hitMcids.size && !removedAnnots.size && !replacedForms.size) return;
  const root = ctx.doc.catalog.lookup(PDFName.of('StructTreeRoot'));
  if (!(root instanceof PDFDict)) return;
  const { context } = ctx.doc;
  const page = pageRef.toString();
  const seen = new Set<PDFDict>();
  const strip = (elem: PDFDict) => {
    for (const k of HIDDEN_TEXT_KEYS) {
      if (elem.has(PDFName.of(k))) {
        elem.delete(PDFName.of(k));
        ctx.report.removedHiddenTexts++;
      }
    }
  };

  /** Walks one element; drops dead kids from its /K and strips it (and ancestors) when hit. */
  const visit = (elem: PDFDict, inheritedPg: string | undefined, ancestors: PDFDict[]): void => {
    if (seen.has(elem)) return;
    seen.add(elem);
    const pgRaw = elem.get(PDFName.of('Pg'));
    const pg = pgRaw instanceof PDFRef ? pgRaw.toString() : inheritedPg;
    const kRaw = elem.get(PDFName.of('K'));
    const k = kRaw instanceof PDFRef ? context.lookup(kRaw) : kRaw;
    const kids: PDFObject[] = k instanceof PDFArray ? k.asArray() : k !== undefined ? [kRaw!] : [];
    let hit = false;
    const keep: PDFObject[] = [];
    for (const kidRaw of kids) {
      const kid = kidRaw instanceof PDFRef ? context.lookup(kidRaw) : kidRaw;
      if (kid instanceof PDFNumber) {
        if (pg && hitMcids.has(`${pg}:${kid.asNumber()}`)) hit = true;
      } else if (kid instanceof PDFDict) {
        const type = kid.get(PDFName.of('Type'));
        if (type === PDFName.of('MCR')) {
          const kPg = kid.get(PDFName.of('Pg'));
          const mcrPage = kPg instanceof PDFRef ? kPg.toString() : pg;
          const stm = kid.get(PDFName.of('Stm'));
          const mcid = kid.lookup(PDFName.of('MCID'));
          const owner = stm instanceof PDFRef ? stm.toString() : mcrPage;
          if (mcid instanceof PDFNumber && hitMcids.has(`${owner}:${mcid.asNumber()}`)) hit = true;
          if (stm instanceof PDFRef && replacedForms.has(stm.toString()) && mcrPage === page) {
            hit = true;
            continue;
          }
        } else if (type === PDFName.of('OBJR')) {
          const obj = kid.get(PDFName.of('Obj'));
          if (obj instanceof PDFRef && removedAnnots.has(obj.toString())) {
            hit = true;
            continue;
          }
        } else {
          visit(kid, pg, [...ancestors, elem]);
        }
      }
      keep.push(kidRaw);
    }
    if (keep.length !== kids.length) elem.set(PDFName.of('K'), context.obj(keep));
    if (hit && ctx.sanitize) [elem, ...ancestors].forEach(strip);
  };

  const top = root.get(PDFName.of('K'));
  const topK = top instanceof PDFRef ? context.lookup(top) : top;
  const tops = topK instanceof PDFArray ? topK.asArray() : topK ? [topK] : [];
  for (const t of tops) {
    const d = t instanceof PDFRef ? context.lookup(t) : t;
    if (d instanceof PDFDict) visit(d, undefined, []);
  }
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
