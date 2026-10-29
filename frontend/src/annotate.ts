// Annotation tools. Everything is flattened into the PDF as images via the `addImage` operation,
// so the result looks identical in every viewer and supports any language.
import { bytesToBase64, type PdfOperation, type RedactionReport, type ReplaceTextReport } from '@pdfhandler/core';
import { rasterShape, rasterStroke, rasterText, type ShapeKind, type Stroke } from './raster';
import type { Viewer } from './viewer';

export interface CommitReports {
  redactions: RedactionReport[];
  replacements: ReplaceTextReport[];
}

export type Tool = 'select' | 'edit-text' | 'redact' | 'text' | 'pen' | 'highlight' | 'rect' | 'whiteout' | 'image';

export interface AnnotatorHost {
  viewer: Viewer;
  tool(): Tool;
  color(): string;
  size(): number;
  /** Applies the operations; resolves with what the redact / replaceText operations did. */
  commit(ops: PdfOperation[], label: string): Promise<CommitReports>;
  pickImage(): Promise<{ base64: string; width: number; height: number } | null>;
  resetTool(): void;
  toast(message: string): void;
  notify(message: string): void;
}

export class Annotator {
  private pendingImage: { base64: string; width: number; height: number } | null = null;

  constructor(private readonly host: AnnotatorHost) {}

  /** Called by the viewer whenever it creates a page overlay. */
  attach(index: number, overlay: HTMLDivElement): void {
    // Existing text is picked from pdf.js's text layer, which sits under the overlay;
    // in this mode the overlay lets clicks through (see styles.css).
    overlay.parentElement!.addEventListener('click', (e) => {
      if (this.host.tool() !== 'edit-text') return;
      const span = (e.target as HTMLElement).closest<HTMLElement>('.textLayer span');
      if (span && span.textContent?.trim()) this.startEditText(index, span);
    });
    overlay.addEventListener('pointerdown', (e) => {
      // Ignore extra fingers of a multi-touch gesture and non-primary mouse buttons.
      if (e.button !== 0 || !e.isPrimary) return;
      switch (this.host.tool()) {
        case 'text':
          return this.startText(index, overlay, e);
        case 'pen':
          return this.startPen(index, overlay, e);
        case 'highlight':
        case 'rect':
        case 'whiteout':
        case 'redact':
          return this.startShape(index, overlay, e, this.host.tool() as ShapeKind | 'redact');
        case 'image':
          return void this.placeImage(index, e);
      }
    });
  }

  async armImage(): Promise<boolean> {
    this.pendingImage = await this.host.pickImage();
    return this.pendingImage !== null;
  }

  // ---------------------------------------------------------------------------

  private startText(index: number, overlay: HTMLDivElement, e: PointerEvent): void {
    e.preventDefault();
    // A click outside an open text box only finishes that box.
    const open = document.querySelector<HTMLTextAreaElement>('.inline-text');
    if (open) return open.blur();
    const { viewer } = this.host;
    const pt = viewer.toPdfPoint(index, e.clientX, e.clientY);
    const size = this.host.size();
    const color = this.host.color();
    const box = document.createElement('textarea');
    box.className = 'inline-text';
    box.style.left = `${pt.x * viewer.scale}px`;
    box.style.top = `${pt.y * viewer.scale}px`;
    box.style.fontSize = `${size * viewer.scale}px`;
    box.style.color = color;
    box.placeholder = '입력 후 바깥 클릭 (Esc 취소)';
    overlay.parentElement!.append(box);
    box.focus();

    let done = false;
    const finish = async (save: boolean) => {
      if (done) return;
      done = true;
      const text = box.value.replace(/\s+$/, '');
      box.remove();
      if (!save || !text) return;
      const img = await rasterText(text, size, color);
      await this.host.commit(
        [{ type: 'addImage', page: index, x: pt.x, y: pt.y, width: img.width, height: img.height, imageBase64: img.base64 }],
        '텍스트 추가',
      );
    };
    box.addEventListener('blur', () => void finish(true));
    box.addEventListener('keydown', (k) => {
      if (k.key === 'Escape') void finish(false);
      if (k.key === 'Enter' && (k.ctrlKey || k.metaKey)) box.blur();
      k.stopPropagation();
    });
  }

  /**
   * Edits the line segment around the clicked text: neighbouring text-layer runs on the same line
   * (not across wide gaps such as table columns) are edited together. The old glyphs are removed
   * from the content and the new text is drawn on the same baseline, in the document's own font
   * when it has the characters, and narrowed to fit the space before the next text on the line.
   */
  private startEditText(index: number, span: HTMLElement): void {
    if (document.querySelector('.inline-text')) return;
    if (/rotate/.test(span.style.transform)) {
      this.host.toast('기울어지거나 세로로 놓인 텍스트는 수정할 수 없습니다.');
      return;
    }
    const { viewer } = this.host;
    const pageEl = viewer.pageElement(index)!;
    const segment = lineSegment(pageEl, span, viewer.scale);
    const { box, fontSize, maxWidth, original, spans } = segment;
    const family = getComputedStyle(span).fontFamily;
    const serif = /(^|[^-])serif/i.test(family) && !/sans/i.test(family);
    const colors = sampleColors(pageEl.querySelector<HTMLCanvasElement>('canvas.render')!, pageEl, spans);

    const input = document.createElement('textarea');
    input.className = 'inline-text editing';
    input.value = original;
    input.rows = 1;
    input.title = '점선 상자까지가 이 줄에서 쓸 수 있는 공간입니다';
    Object.assign(input.style, {
      left: `${box.x * viewer.scale - 2}px`,
      top: `${box.y * viewer.scale - 2}px`,
      width: `${Math.max(maxWidth * viewer.scale + 4, 60)}px`,
      fontSize: `${fontSize * viewer.scale}px`,
      color: colors.fg,
      background: colors.bg,
      fontFamily: serif ? 'serif' : '',
    });
    pageEl.append(input);
    input.focus();
    input.select();

    let done = false;
    const finish = async (save: boolean) => {
      if (done) return;
      done = true;
      const text = input.value.replace(/\s+$/, '');
      input.remove();
      if (!save || text === original) return;
      const pad = Math.max(1, fontSize * 0.08);
      const op: PdfOperation = {
        type: 'replaceText',
        page: index,
        area: { x: box.x - pad, y: box.y - pad, width: box.width + pad * 2, height: box.height + pad * 2 },
        text,
        maxWidth: maxWidth + pad,
        textColor: hexToRgb(colors.fg),
        coverColor: hexToRgb(colors.bg),
      };
      if (text && !/^[\x20-\x7e]*$/.test(text)) {
        const img = await rasterText(text, fontSize, colors.fg, false, serif);
        op.fallbackImage = { imageBase64: img.base64, width: img.width, height: img.height };
      }
      const { replacements } = await this.host.commit([op], text ? '텍스트 수정' : '텍스트 삭제');
      const r = replacements[0];
      if (!r) return;
      const notes: string[] = [];
      if (r.removedGlyphs === 0) notes.push('원본 글자를 찾지 못해 배경색으로 덮었습니다(이미지 속 글자일 수 있음)');
      if (text && !r.reusedFont) notes.push('원본 글꼴에 없는 글자가 있어 다른 글꼴로 넣었습니다');
      if (r.overflow) notes.push('줄 공간을 넘칩니다. 내용을 줄이거나 나눠서 고치세요');
      else if (r.scale < 1) notes.push(`공간에 맞추려고 글자 폭을 ${Math.round(r.scale * 100)}%로 줄였습니다`);
      if (notes.length) (r.overflow ? this.host.toast : this.host.notify)(notes.join(' · '));
    };
    input.addEventListener('blur', () => void finish(true));
    input.addEventListener('keydown', (k) => {
      k.stopPropagation();
      if (k.key === 'Escape') void finish(false);
      else if (k.key === 'Enter' && !k.shiftKey) {
        k.preventDefault();
        input.blur();
      }
    });
  }

  private startPen(index: number, overlay: HTMLDivElement, e: PointerEvent): void {
    e.preventDefault();
    const { viewer } = this.host;
    const stroke: Stroke = { points: [], color: this.host.color(), width: Math.max(1, this.host.size() / 5) };
    const preview = document.createElement('canvas');
    const dpr = window.devicePixelRatio || 1;
    preview.width = overlay.clientWidth * dpr;
    preview.height = overlay.clientHeight * dpr;
    preview.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none';
    overlay.append(preview);
    const ctx = preview.getContext('2d')!;
    ctx.scale(viewer.scale * dpr, viewer.scale * dpr);
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const add = (ev: PointerEvent) => {
      const p = viewer.toPdfPoint(index, ev.clientX, ev.clientY);
      const last = stroke.points[stroke.points.length - 1];
      stroke.points.push(p);
      if (last) {
        ctx.beginPath();
        ctx.moveTo(last.x, last.y);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
      }
    };
    add(e);
    trackPointer(overlay, e, {
      move: add,
      up: async () => {
        const img = await rasterStroke(stroke);
        await this.host.commit(
          [{ type: 'addImage', page: index, x: img.x, y: img.y, width: img.width, height: img.height, imageBase64: img.base64 }],
          '펜',
        );
        preview.remove();
      },
      cancel: () => preview.remove(),
    });
  }

  private startShape(index: number, overlay: HTMLDivElement, e: PointerEvent, kind: ShapeKind | 'redact'): void {
    e.preventDefault();
    const { viewer } = this.host;
    const color = this.host.color();
    const stroke = Math.max(1, this.host.size() / 8);
    const start = viewer.toPdfPoint(index, e.clientX, e.clientY);
    let end = start;
    const box = document.createElement('div');
    box.style.cssText = 'position:absolute;pointer-events:none;box-sizing:border-box';
    if (kind === 'highlight') box.style.background = hexAlpha(color, 0.35);
    else if (kind === 'whiteout') box.style.cssText += ';background:#fff;outline:1px dashed #999';
    else if (kind === 'redact') box.style.cssText += ';background:rgba(0,0,0,0.55);outline:2px dashed #d93025';
    else box.style.border = `${stroke * viewer.scale}px solid ${color}`;
    overlay.append(box);

    const draw = () => {
      const x = Math.min(start.x, end.x);
      const y = Math.min(start.y, end.y);
      Object.assign(box.style, {
        left: `${x * viewer.scale}px`,
        top: `${y * viewer.scale}px`,
        width: `${Math.abs(end.x - start.x) * viewer.scale}px`,
        height: `${Math.abs(end.y - start.y) * viewer.scale}px`,
      });
    };
    const move = (ev: PointerEvent) => {
      end = viewer.toPdfPoint(index, ev.clientX, ev.clientY);
      draw();
    };
    const up = async () => {
      const x = Math.min(start.x, end.x);
      const y = Math.min(start.y, end.y);
      const width = Math.abs(end.x - start.x);
      const height = Math.abs(end.y - start.y);
      if (width < 3 || height < 3) return box.remove();
      if (kind === 'redact') {
        const {
          redactions: [report],
        } = await this.host.commit([{ type: 'redact', page: index, areas: [{ x, y, width, height }] }], '영역 삭제');
        box.remove();
        if (report) this.host.notify(describeRedaction(report));
        return;
      }
      const base64 = await rasterShape(kind, width, height, color, stroke);
      await this.host.commit(
        [
          {
            type: 'addImage',
            page: index,
            x,
            y,
            width,
            height,
            imageBase64: base64,
            opacity: kind === 'highlight' ? 0.35 : 1,
          },
        ],
        kind === 'highlight' ? '형광펜' : kind === 'whiteout' ? '가리기' : '사각형',
      );
      box.remove();
    };
    trackPointer(overlay, e, { move, up, cancel: () => box.remove() });
  }

  private async placeImage(index: number, e: PointerEvent): Promise<void> {
    e.preventDefault();
    if (!this.pendingImage && !(await this.armImage())) return;
    const img = this.pendingImage!;
    const { viewer } = this.host;
    const pt = viewer.toPdfPoint(index, e.clientX, e.clientY);
    const page = viewer.sizes[index];
    // Assume 96 dpi source images, but never cover more than 40% of the page width.
    let width = img.width * 0.75;
    let height = img.height * 0.75;
    const max = page.width * 0.4;
    if (width > max) {
      height *= max / width;
      width = max;
    }
    this.pendingImage = null;
    await this.host.commit(
      [{ type: 'addImage', page: index, x: pt.x - width / 2, y: pt.y - height / 2, width, height, imageBase64: img.base64 }],
      '이미지 삽입',
    );
    this.host.resetTool();
  }
}

/**
 * Follows one pointer from pointerdown to pointerup on the overlay. A cancelled gesture (the browser
 * took over a touch, or capture was lost) calls `cancel` instead of `up`, so nothing is committed.
 */
function trackPointer(
  overlay: HTMLElement,
  down: PointerEvent,
  handlers: { move(ev: PointerEvent): void; up(ev: PointerEvent): unknown; cancel(): void },
): void {
  const id = down.pointerId;
  const mine = (ev: PointerEvent) => ev.pointerId === id;
  const detach = () => {
    overlay.removeEventListener('pointermove', move);
    overlay.removeEventListener('pointerup', up);
    overlay.removeEventListener('pointercancel', cancel);
    overlay.removeEventListener('lostpointercapture', cancel);
  };
  const move = (ev: PointerEvent) => {
    if (mine(ev)) handlers.move(ev);
  };
  const up = (ev: PointerEvent) => {
    if (!mine(ev)) return;
    detach(); // before capture is released, so the following lostpointercapture is not a cancel
    void handlers.up(ev);
  };
  const cancel = (ev: PointerEvent) => {
    if (!mine(ev)) return;
    detach();
    handlers.cancel();
  };
  overlay.addEventListener('pointermove', move);
  overlay.addEventListener('pointerup', up);
  overlay.addEventListener('pointercancel', cancel);
  try {
    overlay.setPointerCapture(id);
    overlay.addEventListener('lostpointercapture', cancel);
  } catch {
    // The pointer is already gone (e.g. cancelled before we got here).
    detach();
    handlers.cancel();
  }
}

/**
 * The browser's minimum font size in CSS px, measured the way pdf.js's TextLayer does. pdf.js
 * multiplies every text-layer font-size by it (and scales the span back down with a transform),
 * so it must be divided out to get the real font size; it is 1 unless the user set a minimum.
 */
let minFontSize: number | undefined;
function browserMinFontSize(): number {
  if (minFontSize === undefined) {
    const div = document.createElement('div');
    div.style.cssText = 'opacity:0;line-height:1;font-size:1px;position:absolute';
    div.textContent = 'X';
    document.body.append(div);
    minFontSize = div.getBoundingClientRect().height || 1;
    div.remove();
  }
  return minFontSize;
}

interface Segment {
  spans: HTMLElement[];
  /** Union of the spans, PDF points, visual top-left origin. */
  box: { x: number; y: number; width: number; height: number };
  fontSize: number;
  /** Room from box.x up to the next text on the line (or the right margin). */
  maxWidth: number;
  original: string;
}

/** The clicked run plus its neighbours on the same line, stopping at column-sized gaps. */
function lineSegment(pageEl: HTMLElement, clicked: HTMLElement, scale: number): Segment {
  const pageRect = pageEl.getBoundingClientRect();
  const toPt = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    return { el, x: (r.left - pageRect.left) / scale, y: (r.top - pageRect.top) / scale, w: r.width / scale, h: r.height / scale };
  };
  const all = [...pageEl.querySelectorAll<HTMLElement>('.textLayer span')]
    .filter((el) => el.textContent && !/rotate/.test(el.style.transform))
    .map(toPt);
  const me = toPt(clicked);
  // pdf.js: font-size = scale-factor × minFontSize × fontHeight (see browserMinFontSize).
  const fontSize = parseFloat(getComputedStyle(clicked).fontSize) / scale / browserMinFontSize() || me.h;
  const midY = me.y + me.h / 2;
  const line = all
    .filter((o) => Math.abs(o.y + o.h / 2 - midY) < me.h * 0.35 && Math.abs(o.h - me.h) < me.h * 0.5)
    .sort((a, b) => a.x - b.x);
  const gapLimit = fontSize * 1.2;
  let lo = line.findIndex((o) => o.el === clicked);
  let hi = lo;
  while (lo > 0 && line[lo].x - (line[lo - 1].x + line[lo - 1].w) < gapLimit) lo--;
  while (hi < line.length - 1 && line[hi + 1].x - (line[hi].x + line[hi].w) < gapLimit) hi++;
  const group = line.slice(lo, hi + 1);

  let original = '';
  group.forEach((o, i) => {
    const t = o.el.textContent ?? '';
    if (i > 0) {
      const prev = group[i - 1];
      const gap = o.x - (prev.x + prev.w);
      if (gap > fontSize * 0.15 && !/\s$/.test(original) && !/^\s/.test(t)) original += ' ';
    }
    original += t;
  });
  const x = group[0].x;
  const right = Math.max(...group.map((o) => o.x + o.w));
  const top = Math.min(...group.map((o) => o.y));
  const bottom = Math.max(...group.map((o) => o.y + o.h));
  const next = line[hi + 1];
  const pageWidth = pageRect.width / scale;
  const leftMargin = Math.min(...all.map((o) => o.x));
  const limit = next ? next.x - fontSize * 0.3 : Math.max(right, pageWidth - leftMargin);
  return {
    spans: group.map((o) => o.el),
    box: { x, y: top, width: right - x, height: bottom - top },
    fontSize,
    maxWidth: Math.max(right, limit) - x,
    original: original.trim(),
  };
}

function describeRedaction(r: RedactionReport): string {
  const parts = [r.removedGlyphs ? `글자 ${r.removedGlyphs}개를 파일에서 삭제` : '삭제할 글자 없음'];
  if (r.removedAnnotations) parts.push(`주석·입력란 ${r.removedAnnotations}개 삭제`);
  if (r.imagesOverlapping) parts.push(`이미지 ${r.imagesOverlapping}개는 검게 덮기만 함(이미지 속 글자는 남음)`);
  if (r.approximateFonts) parts.push('일부 글꼴은 위치를 추정함(가장자리 확인 필요)');
  return parts.join(' · ');
}

/** Picks the background (most common edge colour) and ink (furthest from it) under a text run. */
function sampleColors(canvas: HTMLCanvasElement, pageEl: HTMLElement, spans: HTMLElement[]): { fg: string; bg: string } {
  const fallback = { fg: '#000000', bg: '#ffffff' };
  const rects = spans.map((sp) => sp.getBoundingClientRect());
  const r = {
    left: Math.min(...rects.map((x) => x.left)),
    top: Math.min(...rects.map((x) => x.top)),
    width: Math.max(...rects.map((x) => x.right)) - Math.min(...rects.map((x) => x.left)),
    height: Math.max(...rects.map((x) => x.bottom)) - Math.min(...rects.map((x) => x.top)),
  };
  const pageRect = pageEl.getBoundingClientRect();
  const k = canvas.width / pageRect.width;
  const x = Math.max(0, Math.floor((r.left - pageRect.left) * k));
  const y = Math.max(0, Math.floor((r.top - pageRect.top) * k));
  const w = Math.min(canvas.width - x, Math.ceil(r.width * k));
  const h = Math.min(canvas.height - y, Math.ceil(r.height * k));
  if (w < 2 || h < 2) return fallback;
  const data = canvas.getContext('2d')!.getImageData(x, y, w, h).data;
  const px = (i: number) => [data[i], data[i + 1], data[i + 2]];
  // Bucket edge pixels coarsely, then average the real pixels of the most common bucket.
  const buckets = new Map<string, { n: number; sum: number[] }>();
  const edge = (cx: number, cy: number) => {
    const c = px((cy * w + cx) * 4);
    const key = c.map((v) => v >> 4).join(',');
    const b = buckets.get(key) ?? { n: 0, sum: [0, 0, 0] };
    b.n++;
    c.forEach((v, j) => (b.sum[j] += v));
    buckets.set(key, b);
  };
  for (let cx = 0; cx < w; cx++) {
    edge(cx, 0);
    edge(cx, h - 1);
  }
  for (let cy = 0; cy < h; cy++) {
    edge(0, cy);
    edge(w - 1, cy);
  }
  const top = [...buckets.values()].sort((a, b) => b.n - a.n)[0];
  const bg = top.sum.map((v) => Math.round(v / top.n));
  let best = 0;
  let fg = [0, 0, 0];
  for (let i = 0; i < data.length; i += 4) {
    const c = px(i);
    const d = Math.abs(c[0] - bg[0]) + Math.abs(c[1] - bg[1]) + Math.abs(c[2] - bg[2]);
    if (d > best) {
      best = d;
      fg = c;
    }
  }
  const hex = (c: number[]) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  return { fg: best > 60 ? hex(fg) : fallback.fg, bg: hex(bg) };
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const n = parseInt(hex.slice(1), 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

export async function readImageFile(file: File): Promise<{ base64: string; width: number; height: number }> {
  if (!/^image\/(png|jpeg)$/.test(file.type)) throw new Error('PNG 또는 JPEG 이미지만 넣을 수 있습니다.');
  const bitmap = await createImageBitmap(file);
  const result = {
    base64: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
    width: bitmap.width,
    height: bitmap.height,
  };
  bitmap.close();
  return result;
}

function hexAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
