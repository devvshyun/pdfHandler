// Annotation tools. Everything is flattened into the PDF as images via the `addImage` operation,
// so the result looks identical in every viewer and supports any language.
import { bytesToBase64, type PdfOperation } from '@pdfhandler/core';
import { rasterShape, rasterStroke, rasterText, type ShapeKind, type Stroke } from './raster';
import type { Viewer } from './viewer';

export type Tool = 'select' | 'text' | 'pen' | 'highlight' | 'rect' | 'whiteout' | 'image';

export interface AnnotatorHost {
  viewer: Viewer;
  tool(): Tool;
  color(): string;
  size(): number;
  commit(ops: PdfOperation[], label: string): Promise<void>;
  pickImage(): Promise<{ base64: string; width: number; height: number } | null>;
  resetTool(): void;
}

export class Annotator {
  private pendingImage: { base64: string; width: number; height: number } | null = null;

  constructor(private readonly host: AnnotatorHost) {}

  /** Called by the viewer whenever it creates a page overlay. */
  attach(index: number, overlay: HTMLDivElement): void {
    overlay.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      switch (this.host.tool()) {
        case 'text':
          return this.startText(index, overlay, e);
        case 'pen':
          return this.startPen(index, overlay, e);
        case 'highlight':
        case 'rect':
        case 'whiteout':
          return this.startShape(index, overlay, e, this.host.tool() as ShapeKind);
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
    overlay.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => add(ev);
    const up = async () => {
      overlay.removeEventListener('pointermove', move);
      overlay.removeEventListener('pointerup', up);
      const img = await rasterStroke(stroke);
      await this.host.commit(
        [{ type: 'addImage', page: index, x: img.x, y: img.y, width: img.width, height: img.height, imageBase64: img.base64 }],
        '펜',
      );
      preview.remove();
    };
    overlay.addEventListener('pointermove', move);
    overlay.addEventListener('pointerup', up);
  }

  private startShape(index: number, overlay: HTMLDivElement, e: PointerEvent, kind: ShapeKind): void {
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
    overlay.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      end = viewer.toPdfPoint(index, ev.clientX, ev.clientY);
      draw();
    };
    const up = async () => {
      overlay.removeEventListener('pointermove', move);
      overlay.removeEventListener('pointerup', up);
      const x = Math.min(start.x, end.x);
      const y = Math.min(start.y, end.y);
      const width = Math.abs(end.x - start.x);
      const height = Math.abs(end.y - start.y);
      if (width < 3 || height < 3) return box.remove();
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
    overlay.addEventListener('pointermove', move);
    overlay.addEventListener('pointerup', up);
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
