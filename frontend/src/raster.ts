// Rasterises text/shapes into PNGs so annotations can use any script (Korean included)
// without embedding a multi-megabyte CJK font into the PDF.
import { bytesToBase64 } from '@pdfhandler/core';

/** Oversampling factor: PNG pixels per PDF point. */
const DPI_SCALE = 3;
const FONT_STACK = `'Pretendard', 'Apple SD Gothic Neo', 'Malgun Gothic', 'Noto Sans KR', system-ui, sans-serif`;
const SERIF_STACK = `'AppleMyungjo', 'Batang', 'Noto Serif KR', 'Times New Roman', serif`;

export interface RasterResult {
  base64: string;
  /** Size in PDF points. */
  width: number;
  height: number;
}

export async function canvasToBase64(canvas: HTMLCanvasElement): Promise<string> {
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG 변환 실패'))), 'image/png'),
  );
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
}

/** Multi-line text, `fontSize` in points. */
export async function rasterText(
  text: string,
  fontSize: number,
  color: string,
  bold = false,
  serif = false,
): Promise<RasterResult> {
  const lines = text.split(/\r?\n/);
  const lineHeight = fontSize * 1.25;
  const font = `${bold ? '700 ' : ''}${fontSize * DPI_SCALE}px ${serif ? SERIF_STACK : FONT_STACK}`;
  const measure = document.createElement('canvas').getContext('2d')!;
  measure.font = font;
  const widthPt = Math.max(...lines.map((l) => measure.measureText(l).width)) / DPI_SCALE + 2;
  const heightPt = lineHeight * lines.length;

  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(widthPt * DPI_SCALE);
  canvas.height = Math.ceil(heightPt * DPI_SCALE);
  const ctx = canvas.getContext('2d')!;
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textBaseline = 'top';
  lines.forEach((line, i) => ctx.fillText(line, DPI_SCALE, (i * lineHeight + (lineHeight - fontSize) / 2) * DPI_SCALE));
  return { base64: await canvasToBase64(canvas), width: canvas.width / DPI_SCALE, height: canvas.height / DPI_SCALE };
}

/** Text rotated by `angle` degrees (counter-clockwise), tightly boxed. */
export async function rasterRotatedText(
  text: string,
  fontSize: number,
  color: string,
  angle: number,
): Promise<RasterResult> {
  const font = `700 ${fontSize * DPI_SCALE}px ${FONT_STACK}`;
  const measure = document.createElement('canvas').getContext('2d')!;
  measure.font = font;
  const w = measure.measureText(text).width;
  const h = fontSize * 1.2 * DPI_SCALE;
  const rad = (angle * Math.PI) / 180;
  const bw = Math.abs(w * Math.cos(rad)) + Math.abs(h * Math.sin(rad));
  const bh = Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad));
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(bw);
  canvas.height = Math.ceil(bh);
  const ctx = canvas.getContext('2d')!;
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(-rad);
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 0, 0);
  return { base64: await canvasToBase64(canvas), width: canvas.width / DPI_SCALE, height: canvas.height / DPI_SCALE };
}

export type ShapeKind = 'highlight' | 'rect' | 'whiteout';

export async function rasterShape(kind: ShapeKind, widthPt: number, heightPt: number, color: string, stroke: number): Promise<string> {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(widthPt * DPI_SCALE));
  canvas.height = Math.max(1, Math.ceil(heightPt * DPI_SCALE));
  const ctx = canvas.getContext('2d')!;
  if (kind === 'rect') {
    const lw = stroke * DPI_SCALE;
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    ctx.strokeRect(lw / 2, lw / 2, canvas.width - lw, canvas.height - lw);
  } else {
    ctx.fillStyle = kind === 'whiteout' ? '#ffffff' : color;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  return canvasToBase64(canvas);
}

export interface Stroke {
  points: Array<{ x: number; y: number }>; // PDF points, visual top-left origin
  color: string;
  width: number;
}

/** Crops a freehand stroke to its bounding box. */
export async function rasterStroke(stroke: Stroke): Promise<{ base64: string; x: number; y: number; width: number; height: number }> {
  const pad = stroke.width;
  const xs = stroke.points.map((p) => p.x);
  const ys = stroke.points.map((p) => p.y);
  const x = Math.min(...xs) - pad;
  const y = Math.min(...ys) - pad;
  const width = Math.max(...xs) - x + pad;
  const height = Math.max(...ys) - y + pad;
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(width * DPI_SCALE);
  canvas.height = Math.ceil(height * DPI_SCALE);
  const ctx = canvas.getContext('2d')!;
  ctx.scale(DPI_SCALE, DPI_SCALE);
  ctx.strokeStyle = stroke.color;
  ctx.lineWidth = stroke.width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  stroke.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x - x, p.y - y) : ctx.lineTo(p.x - x, p.y - y)));
  if (stroke.points.length === 1) ctx.lineTo(stroke.points[0].x - x + 0.01, stroke.points[0].y - y);
  ctx.stroke();
  return { base64: await canvasToBase64(canvas), x, y, width: canvas.width / DPI_SCALE, height: canvas.height / DPI_SCALE };
}
