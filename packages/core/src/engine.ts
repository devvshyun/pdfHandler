import {
  degrees,
  EncryptedPDFError,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFFont,
  PDFName,
  PDFNumber,
  PDFPage,
  PDFRef,
  rgb,
  StandardFonts,
} from 'pdf-lib';
import { base64ToBytes } from './base64';
import { PdfOperation, PdfOperationError, RgbColor } from './operations';
import { makeEncoder, loadFontMetrics, TextElement } from './font-metrics';
import { formatNumber, hexString } from './content-lexer';
import { CapturedRun, collectGarbage, Matrix, RedactionReport, redactPage } from './redact';

export interface ApplyOptions {
  /** TTF/OTF bytes used for text operations. Needed for non-Latin text (e.g. Korean). */
  font?: Uint8Array;
  /** Receives what each `redact` operation removed (and what it could not). */
  onRedaction?: (report: RedactionReport) => void;
  /** Receives how each `replaceText` operation was carried out. */
  onReplaceText?: (report: ReplaceTextReport) => void;
}

export interface ReplaceTextReport {
  page: number;
  removedGlyphs: number;
  /** The new text uses the document's own font for that run. */
  reusedFont: boolean;
  /** Horizontal scale applied to fit `maxWidth` (1 = none). */
  scale: number;
  /** Still wider than `maxWidth` even at the narrowest allowed scale. */
  overflow: boolean;
}

const MIN_FIT_SCALE = 0.6;

export interface PdfPageInfo {
  width: number;
  height: number;
  rotation: number;
}

export interface PdfInfo {
  pageCount: number;
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
  producer?: string;
  pages: PdfPageInfo[];
}

const PRODUCER = 'pdfHandler (pdf-lib)';

export async function loadPdf(bytes: Uint8Array | ArrayBuffer): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(bytes);
  } catch (e) {
    if (e instanceof EncryptedPDFError) {
      throw new PdfOperationError('암호화된 PDF는 편집할 수 없습니다. 먼저 암호를 해제하세요.');
    }
    throw new PdfOperationError(`PDF를 읽을 수 없습니다: ${(e as Error).message}`);
  }
}

export function isPdf(bytes: Uint8Array): boolean {
  // "%PDF-" may be preceded by junk bytes; the spec allows it within the first 1024 bytes.
  const head = bytes.subarray(0, 1024);
  for (let i = 0; i + 4 < head.length; i++) {
    if (head[i] === 0x25 && head[i + 1] === 0x50 && head[i + 2] === 0x44 && head[i + 3] === 0x46 && head[i + 4] === 0x2d) {
      return true;
    }
  }
  return false;
}

export async function getPdfInfo(bytes: Uint8Array | ArrayBuffer): Promise<PdfInfo> {
  const doc = await loadPdf(bytes);
  return {
    pageCount: doc.getPageCount(),
    title: doc.getTitle(),
    author: doc.getAuthor(),
    subject: doc.getSubject(),
    keywords: doc.getKeywords(),
    creator: doc.getCreator(),
    producer: doc.getProducer(),
    pages: doc.getPages().map((p) => {
      const { width, height } = p.getCropBox();
      return { width, height, rotation: normalizeAngle(p.getRotation().angle) };
    }),
  };
}

export async function applyOperations(
  bytes: Uint8Array | ArrayBuffer,
  operations: PdfOperation[],
  options: ApplyOptions = {},
): Promise<Uint8Array> {
  let doc = await loadPdf(bytes);
  const fonts = new FontCache(options.font);

  for (const op of operations) {
    doc = await applyOne(doc, op, fonts, options);
  }
  // Redaction must not leave the replaced streams behind as unreferenced objects.
  if (operations.some((op) => op.type === 'redact' || op.type === 'replaceText')) collectGarbage(doc);

  doc.setProducer(PRODUCER);
  doc.setModificationDate(new Date());
  return doc.save();
}

export async function mergePdfs(files: Array<Uint8Array | ArrayBuffer>): Promise<Uint8Array> {
  if (files.length === 0) throw new PdfOperationError('병합할 파일이 없습니다.');
  const out = await PDFDocument.create();
  for (const file of files) {
    const src = await loadPdf(file);
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((p) => out.addPage(p));
  }
  out.setProducer(PRODUCER);
  return out.save();
}

/** Each entry of `groups` is a list of 0-based page indexes that form one output file. */
export async function splitPdf(bytes: Uint8Array | ArrayBuffer, groups: number[][]): Promise<Uint8Array[]> {
  const src = await loadPdf(bytes);
  const results: Uint8Array[] = [];
  for (const group of groups) {
    assertPages(group, src.getPageCount());
    if (group.length === 0) continue;
    const out = await PDFDocument.create();
    const pages = await out.copyPages(src, group);
    pages.forEach((p) => out.addPage(p));
    out.setProducer(PRODUCER);
    results.push(await out.save());
  }
  return results;
}

/** Split every `size` pages. */
export function chunkPages(pageCount: number, size: number): number[][] {
  if (!Number.isInteger(size) || size < 1) throw new PdfOperationError('분할 단위는 1 이상의 정수여야 합니다.');
  const groups: number[][] = [];
  for (let i = 0; i < pageCount; i += size) {
    groups.push(Array.from({ length: Math.min(size, pageCount - i) }, (_, k) => i + k));
  }
  return groups;
}

/**
 * Parses a human page-range string ("1-3, 5, 8-") into 0-based indexes, preserving order.
 * Open-ended ranges ("8-") run to the last page.
 */
export function parsePageRanges(input: string, pageCount: number): number[] {
  const result: number[] = [];
  const parts = input.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) throw new PdfOperationError('페이지 범위가 비어 있습니다.');
  for (const part of parts) {
    const m = /^(\d+)?\s*(-)?\s*(\d+)?$/.exec(part);
    if (!m || (!m[1] && !m[3])) throw new PdfOperationError(`잘못된 페이지 범위: "${part}"`);
    const start = m[1] ? Number(m[1]) : 1;
    const end = m[2] ? (m[3] ? Number(m[3]) : pageCount) : start;
    if (start < 1 || end > pageCount || start > end) {
      throw new PdfOperationError(`페이지 범위 "${part}"가 문서(1-${pageCount})를 벗어납니다.`);
    }
    for (let p = start; p <= end; p++) result.push(p - 1);
  }
  return result;
}

// ---------------------------------------------------------------------------

async function applyOne(doc: PDFDocument, op: PdfOperation, fonts: FontCache, options: ApplyOptions): Promise<PDFDocument> {
  const count = doc.getPageCount();
  switch (op.type) {
    case 'rotate': {
      assertPages(op.pages, count);
      if (![90, 180, 270, -90].includes(op.degrees)) throw new PdfOperationError('회전 각도는 90/180/270/-90만 허용됩니다.');
      for (const i of unique(op.pages)) {
        const page = doc.getPage(i);
        page.setRotation(degrees(normalizeAngle(page.getRotation().angle + op.degrees)));
      }
      return doc;
    }
    case 'delete': {
      assertPages(op.pages, count);
      const toDelete = unique(op.pages).sort((a, b) => b - a);
      if (toDelete.length >= count) throw new PdfOperationError('모든 페이지를 삭제할 수는 없습니다.');
      toDelete.forEach((i) => doc.removePage(i));
      return doc;
    }
    case 'reorder': {
      assertPages(op.order, count);
      if (op.order.length !== count || unique(op.order).length !== count) {
        throw new PdfOperationError('reorder.order는 모든 페이지를 정확히 한 번씩 포함해야 합니다.');
      }
      return rebuild(doc, op.order);
    }
    case 'extract': {
      assertPages(op.pages, count);
      if (op.pages.length === 0) throw new PdfOperationError('추출할 페이지가 없습니다.');
      return rebuild(doc, op.pages);
    }
    case 'duplicate': {
      assertPages([op.page], count);
      const [copy] = await doc.copyPages(doc, [op.page]);
      doc.insertPage(op.page + 1, copy);
      return doc;
    }
    case 'insertBlank': {
      if (!Number.isInteger(op.after) || op.after < -1 || op.after >= count) {
        throw new PdfOperationError(`insertBlank.after는 -1 ~ ${count - 1} 범위여야 합니다.`);
      }
      const ref = doc.getPage(Math.max(op.after, 0)).getCropBox();
      doc.insertPage(op.after + 1, [op.width ?? ref.width, op.height ?? ref.height]);
      return doc;
    }
    case 'watermark': {
      const font = await fonts.get(doc, StandardFonts.HelveticaBold);
      assertEncodable(font, op.text);
      const size = op.fontSize ?? 48;
      const angle = op.rotate ?? 45;
      const rad = (angle * Math.PI) / 180;
      const textWidth = font.widthOfTextAtSize(op.text, size);
      const targets = op.pages ? (assertPages(op.pages, count), unique(op.pages)) : doc.getPageIndices();
      for (const i of targets) {
        const page = doc.getPage(i);
        const v = visualSize(page);
        // Centre the (rotated) text on the visible page.
        const vx = v.width / 2 - (textWidth / 2) * Math.cos(rad) + (size / 3) * Math.sin(rad);
        const vy = v.height / 2 - (textWidth / 2) * Math.sin(rad) - (size / 3) * Math.cos(rad);
        const pt = visualToUser(page, vx, vy);
        page.drawText(op.text, {
          x: pt.x,
          y: pt.y,
          size,
          font,
          color: toRgb(op.color ?? { r: 0.6, g: 0.6, b: 0.6 }),
          opacity: op.opacity ?? 0.3,
          rotate: degrees(angle + pageRotation(page)),
        });
      }
      return doc;
    }
    case 'pageNumbers': {
      const font = await fonts.get(doc, StandardFonts.Helvetica);
      const size = op.fontSize ?? 11;
      const format = op.format ?? '{n} / {total}';
      const position = op.position ?? 'bottom-center';
      const start = op.startAt ?? 1;
      const margin = 24;
      const total = count + start - 1;
      doc.getPages().forEach((page, idx) => {
        const label = format.replace('{n}', String(idx + start)).replace('{total}', String(total));
        assertEncodable(font, label);
        const w = font.widthOfTextAtSize(label, size);
        const v = visualSize(page);
        const vx = position.endsWith('left') ? margin : position.endsWith('right') ? v.width - margin - w : (v.width - w) / 2;
        const vy = position.startsWith('top') ? v.height - margin - size : margin;
        const pt = visualToUser(page, vx, vy);
        page.drawText(label, { x: pt.x, y: pt.y, size, font, color: rgb(0.2, 0.2, 0.2), rotate: degrees(pageRotation(page)) });
      });
      return doc;
    }
    case 'addText': {
      assertPages([op.page], count);
      const font = await fonts.get(doc, StandardFonts.Helvetica);
      const lines = op.text.split(/\r?\n/);
      lines.forEach((line) => assertEncodable(font, line));
      const page = doc.getPage(op.page);
      const size = op.fontSize ?? 14;
      const v = visualSize(page);
      lines.forEach((line, k) => {
        // x/y are the top-left of the text box in visual (top-left origin) coordinates.
        const baseline = op.y + size + k * size * 1.2;
        const pt = visualToUser(page, op.x, v.height - baseline);
        page.drawText(line, { x: pt.x, y: pt.y, size, font, color: toRgb(op.color ?? { r: 0, g: 0, b: 0 }), rotate: degrees(pageRotation(page)) });
      });
      return doc;
    }
    case 'addImage': {
      assertPages([op.page], count);
      const data = base64ToBytes(op.imageBase64);
      const image = isPng(data) ? await doc.embedPng(data) : await doc.embedJpg(data);
      const page = doc.getPage(op.page);
      const v = visualSize(page);
      // Anchor the image's own bottom-left corner at the box's visual bottom-left.
      const pt = visualToUser(page, op.x, v.height - op.y - op.height);
      page.drawImage(image, {
        x: pt.x,
        y: pt.y,
        width: op.width,
        height: op.height,
        opacity: op.opacity ?? 1,
        rotate: degrees(pageRotation(page)),
      });
      return doc;
    }
    case 'redact': {
      assertPages([op.page], count);
      if (!Array.isArray(op.areas) || op.areas.length === 0) throw new PdfOperationError('redact.areas가 비어 있습니다.');
      const page = doc.getPage(op.page);
      const v = visualSize(page);
      const areas = op.areas.map((a) => {
        if (![a.x, a.y, a.width, a.height].every(Number.isFinite) || a.width <= 0 || a.height <= 0) {
          throw new PdfOperationError('redact 영역의 좌표가 올바르지 않습니다.');
        }
        const p1 = visualToUser(page, a.x, v.height - a.y);
        const p2 = visualToUser(page, a.x + a.width, v.height - a.y - a.height);
        return { x1: Math.min(p1.x, p2.x), y1: Math.min(p1.y, p2.y), x2: Math.max(p1.x, p2.x), y2: Math.max(p1.y, p2.y) };
      });
      const report = redactPage(doc, page, op.page, areas, op.mode ?? 'overlap');
      const fill = op.fill === undefined ? { r: 0, g: 0, b: 0 } : op.fill;
      const paint = fill ?? (report.removedGlyphs === 0 ? op.coverIfUntouched : undefined);
      if (paint) {
        for (const a of areas) {
          page.drawRectangle({ x: a.x1, y: a.y1, width: a.x2 - a.x1, height: a.y2 - a.y1, color: toRgb(paint) });
        }
      }
      options.onRedaction?.(report);
      return doc;
    }
    case 'replaceText': {
      assertPages([op.page], count);
      const a = op.area;
      if (![a.x, a.y, a.width, a.height].every(Number.isFinite) || a.width <= 0 || a.height <= 0) {
        throw new PdfOperationError('replaceText 영역의 좌표가 올바르지 않습니다.');
      }
      const page = doc.getPage(op.page);
      const v = visualSize(page);
      const p1 = visualToUser(page, a.x, v.height - a.y);
      const p2 = visualToUser(page, a.x + a.width, v.height - a.y - a.height);
      const area = { x1: Math.min(p1.x, p2.x), y1: Math.min(p1.y, p2.y), x2: Math.max(p1.x, p2.x), y2: Math.max(p1.y, p2.y) };
      const result = redactPage(doc, page, op.page, [area], 'center');
      const report: ReplaceTextReport = { page: op.page, removedGlyphs: result.removedGlyphs, reusedFont: false, scale: 1, overflow: false };

      if (result.removedGlyphs === 0 && op.coverColor) {
        page.drawRectangle({ x: area.x1, y: area.y1, width: area.x2 - area.x1, height: area.y2 - area.y1, color: toRgb(op.coverColor) });
      }
      // maxWidth counts from the area's left edge; the new text starts where the old run did.
      const startOffset = result.capture ? userToVisual(page, { x: result.capture.trm[4], y: result.capture.trm[5] }).x - a.x : 0;
      const maxWidth = (op.maxWidth ?? Infinity) - Math.max(0, startOffset);
      const text = op.text.replace(/\s+$/, '');
      if (text) {
        const color = result.capture?.fill ?? (op.textColor ? [op.textColor.r, op.textColor.g, op.textColor.b] : [0, 0, 0]);
        const drawn = result.capture ? drawInOriginalFont(doc, page, result.capture, text, maxWidth, color, report) : false;
        if (!drawn) {
          // Baseline and size from the removed run when known, else estimated from the area.
          const rot = pageRotation(page);
          const size = result.capture ? Math.hypot(result.capture.trm[2], result.capture.trm[3]) : a.height * 0.8;
          const origin = result.capture
            ? { x: result.capture.trm[4], y: result.capture.trm[5] }
            : visualToUser(page, a.x, v.height - a.y - a.height * 0.8);
          if (/^[\x20-\x7e]*$/.test(text)) {
            const font = await fonts.get(doc, standardLookalike(doc, result.capture));
            const natural = font.widthOfTextAtSize(text, size);
            fitScale(report, natural, maxWidth);
            const rad = (rot * Math.PI) / 180;
            const trm: Matrix = [size * Math.cos(rad), size * Math.sin(rad), -size * Math.sin(rad), size * Math.cos(rad), origin.x, origin.y];
            const fontName = page.node.newFontDictionary('RpH', font.ref);
            appendText(doc, page, fontName.decodeText(), [Uint8Array.from(font.encodeText(text).asBytes())], trm, report.scale, color, 0, 0);
          } else if (op.fallbackImage) {
            const img = op.fallbackImage;
            fitScale(report, img.width, maxWidth);
            // The raster's line box puts the baseline ~0.8 of the height down.
            const top = result.capture ? v.height - userToVisual(page, origin).y - img.height * 0.78 : a.y + (a.height - img.height) / 2;
            const left = result.capture ? userToVisual(page, origin).x : a.x;
            doc = await applyOne(
              doc,
              { type: 'addImage', page: op.page, x: left, y: top, width: img.width * report.scale, height: img.height, imageBase64: img.imageBase64 },
              fonts,
              options,
            );
          } else {
            throw new PdfOperationError('기본 PDF 폰트로는 이 글자를 쓸 수 없습니다. fallbackImage를 함께 보내세요.');
          }
        }
      }
      options.onReplaceText?.(report);
      return doc;
    }
    case 'metadata': {
      if (op.title !== undefined) doc.setTitle(op.title);
      if (op.author !== undefined) doc.setAuthor(op.author);
      if (op.subject !== undefined) doc.setSubject(op.subject);
      if (op.keywords !== undefined) doc.setKeywords(op.keywords);
      return doc;
    }
    default: {
      const unknown = op as { type?: string };
      throw new PdfOperationError(`알 수 없는 작업: ${unknown.type}`);
    }
  }
}

/** Draws `text` with the font of the removed run; false when that font lacks a character. */
function drawInOriginalFont(
  doc: PDFDocument,
  page: PDFPage,
  run: CapturedRun,
  text: string,
  maxWidth: number,
  color: number[],
  report: ReplaceTextReport,
): boolean {
  const fontDict = run.fontRaw instanceof PDFRef ? doc.context.lookup(run.fontRaw) : run.fontRaw;
  if (!(fontDict instanceof PDFDict)) return false;
  const encode = makeEncoder(fontDict);
  const elements = encode?.(text);
  if (!elements) return false;
  const metrics = loadFontMetrics(fontDict);
  // Width in text space (font size 1), then in user space through the run's matrix.
  let width = 0;
  for (const el of elements) {
    if (typeof el === 'number') width -= el / 1000;
    else
      for (const { code, start, end } of metrics.codes(el)) {
        width += metrics.width(code) + run.charSpacing + (metrics.isSpace(code, end - start) ? run.wordSpacing : 0);
      }
  }
  fitScale(report, width * Math.hypot(run.trm[0], run.trm[1]), maxWidth);
  const ref = run.fontRaw instanceof PDFRef ? run.fontRaw : doc.context.register(fontDict);
  // A fresh resource name: the run may have come from a Form XObject with its own font names.
  const name = page.node.newFontDictionary('RpF', ref).decodeText();
  appendText(doc, page, name, elements, run.trm, report.scale, color, run.charSpacing, run.wordSpacing);
  report.reusedFont = true;
  return true;
}

/** Times or Helvetica (bold or not), whichever resembles the removed run's font. */
function standardLookalike(doc: PDFDocument, run: CapturedRun | undefined): StandardFonts {
  let serif = false;
  let bold = false;
  const font = run && (run.fontRaw instanceof PDFRef ? doc.context.lookup(run.fontRaw) : run.fontRaw);
  if (font instanceof PDFDict) {
    let dict = font;
    const descendants = font.lookup(PDFName.of('DescendantFonts'));
    if (descendants instanceof PDFArray && descendants.lookup(0) instanceof PDFDict) dict = descendants.lookup(0) as PDFDict;
    const name = (dict.lookup(PDFName.of('BaseFont')) as PDFName | undefined)?.decodeText() ?? '';
    const descriptor = dict.lookup(PDFName.of('FontDescriptor'));
    const flags = descriptor instanceof PDFDict ? ((descriptor.lookup(PDFName.of('Flags')) as PDFNumber | undefined)?.asNumber() ?? 0) : 0;
    const weight = descriptor instanceof PDFDict ? ((descriptor.lookup(PDFName.of('FontWeight')) as PDFNumber | undefined)?.asNumber() ?? 0) : 0;
    serif = (flags & 2) !== 0 || /times|serif|roman|georgia|garamond|myeongjo|myungjo|batang/i.test(name.replace(/sans/i, ''));
    bold = weight >= 600 || /bold|black|heavy|semibold/i.test(name);
  }
  if (serif) return bold ? StandardFonts.TimesRomanBold : StandardFonts.TimesRoman;
  return bold ? StandardFonts.HelveticaBold : StandardFonts.Helvetica;
}

function fitScale(report: ReplaceTextReport, naturalWidth: number, maxWidth: number): void {
  if (!(naturalWidth > maxWidth)) return;
  const needed = maxWidth / naturalWidth;
  report.scale = Math.max(MIN_FIT_SCALE, needed);
  report.overflow = needed < MIN_FIT_SCALE;
}

/** Appends `BT … TJ ET` with font size 1 and the run's rendering matrix as the text matrix. */
function appendText(
  doc: PDFDocument,
  page: PDFPage,
  fontName: string,
  elements: TextElement[],
  trm: Matrix,
  scale: number,
  color: number[],
  charSpacing: number,
  wordSpacing: number,
): void {
  const f = formatNumber;
  const body = elements.map((e) => (typeof e === 'number' ? f(e) : hexString(e))).join(' ');
  const ops = [
    'q',
    'BT',
    `${color.map((c) => f(Math.min(1, Math.max(0, c)))).join(' ')} rg`,
    `/${fontName} 1 Tf`,
    `${f(charSpacing)} Tc ${f(wordSpacing)} Tw ${f(scale * 100)} Tz`,
    `${trm.map(f).join(' ')} Tm`,
    `[${body}] TJ`,
    'ET',
    'Q',
  ].join('\n');
  const ref = doc.context.register(doc.context.flateStream(ops));
  page.node.addContentStream(ref);
}

/** Inverse of visualToUser: page user space → visual coordinates (bottom-left origin). */
function userToVisual(page: PDFPage, p: { x: number; y: number }): { x: number; y: number } {
  const box = page.getCropBox();
  const x = p.x - box.x;
  const y = p.y - box.y;
  switch (pageRotation(page)) {
    case 90:
      return { x: y, y: box.width - x };
    case 180:
      return { x: box.width - x, y: box.height - y };
    case 270:
      return { x: box.height - y, y: x };
    default:
      return { x, y };
  }
}

/** Builds a new document from `indexes` of `src`, carrying over document metadata. */
async function rebuild(src: PDFDocument, indexes: number[]): Promise<PDFDocument> {
  const out = await PDFDocument.create();
  const pages = await out.copyPages(src, indexes);
  pages.forEach((p) => out.addPage(p));
  const title = src.getTitle();
  const author = src.getAuthor();
  const subject = src.getSubject();
  const keywords = src.getKeywords();
  if (title) out.setTitle(title);
  if (author) out.setAuthor(author);
  if (subject) out.setSubject(subject);
  if (keywords) out.setKeywords(keywords.split(/\s*[,;]\s*|\s+/).filter(Boolean));
  return out;
}

class FontCache {
  private readonly cache = new Map<PDFDocument, Map<string, PDFFont>>();

  constructor(private readonly customFont?: Uint8Array) {}

  async get(doc: PDFDocument, fallback: StandardFonts): Promise<PDFFont> {
    let perDoc = this.cache.get(doc);
    if (!perDoc) {
      perDoc = new Map();
      this.cache.set(doc, perDoc);
    }
    const key = this.customFont ? 'custom' : fallback;
    let font = perDoc.get(key);
    if (!font) {
      if (this.customFont) {
        // Loaded lazily: fontkit is large and only needed for custom (e.g. Korean) fonts.
        const fontkit = await import('@pdf-lib/fontkit');
        doc.registerFontkit(fontkit.default ?? fontkit);
        font = await doc.embedFont(this.customFont, { subset: true });
      } else {
        font = await doc.embedFont(fallback);
      }
      perDoc.set(key, font);
    }
    return font;
  }
}

function assertEncodable(font: PDFFont, text: string): void {
  try {
    font.encodeText(text);
  } catch {
    throw new PdfOperationError(
      '기본 PDF 폰트로는 한글 등 비라틴 문자를 쓸 수 없습니다. 사용자 폰트(TTF/OTF)를 지정하거나 이미지(addImage)로 삽입하세요.',
    );
  }
}

function assertPages(pages: number[], count: number): void {
  if (!Array.isArray(pages)) throw new PdfOperationError('페이지 목록이 필요합니다.');
  for (const p of pages) {
    if (!Number.isInteger(p) || p < 0 || p >= count) {
      throw new PdfOperationError(`페이지 인덱스 ${p}가 범위(0-${count - 1})를 벗어납니다.`);
    }
  }
}

function unique(values: number[]): number[] {
  return [...new Set(values)];
}

function normalizeAngle(angle: number): number {
  return ((angle % 360) + 360) % 360;
}

function pageRotation(page: PDFPage): number {
  return normalizeAngle(page.getRotation().angle);
}

function visualSize(page: PDFPage): { width: number; height: number } {
  const { width, height } = page.getCropBox();
  const r = pageRotation(page);
  return r === 90 || r === 270 ? { width: height, height: width } : { width, height };
}

/**
 * Maps a point on the page as the viewer sees it (bottom-left origin, after /Rotate is applied)
 * back into the page's unrotated user space, which is what pdf-lib draws in.
 */
function visualToUser(page: PDFPage, vx: number, vy: number): { x: number; y: number } {
  const box = page.getCropBox();
  const W = box.width;
  const H = box.height;
  let x: number;
  let y: number;
  switch (pageRotation(page)) {
    case 90:
      x = W - vy;
      y = vx;
      break;
    case 180:
      x = W - vx;
      y = H - vy;
      break;
    case 270:
      x = vy;
      y = H - vx;
      break;
    default:
      x = vx;
      y = vy;
  }
  return { x: x + box.x, y: y + box.y };
}

function toRgb(c: RgbColor) {
  const clamp = (n: number) => Math.min(1, Math.max(0, n));
  return rgb(clamp(c.r), clamp(c.g), clamp(c.b));
}

function isPng(bytes: Uint8Array): boolean {
  return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
}
