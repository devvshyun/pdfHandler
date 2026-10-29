import {
  degrees,
  EncryptedPDFError,
  PDFDocument,
  PDFFont,
  PDFPage,
  rgb,
  StandardFonts,
} from 'pdf-lib';
import { base64ToBytes } from './base64';
import { PdfOperation, PdfOperationError, RgbColor } from './operations';

export interface ApplyOptions {
  /** TTF/OTF bytes used for text operations. Needed for non-Latin text (e.g. Korean). */
  font?: Uint8Array;
}

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
    doc = await applyOne(doc, op, fonts);
  }

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

async function applyOne(doc: PDFDocument, op: PdfOperation, fonts: FontCache): Promise<PDFDocument> {
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
