// pdf.js based renderer: continuous page view + thumbnails, both lazily rendered.
import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const ASSET_BASE = new URL('./pdfjs/', document.baseURI).href;
const PAGE_GAP = 16;
const THUMB_WIDTH = 130;

export type Zoom = 'fit-width' | 'fit-page' | number;

export interface PageSize {
  /** Visual size in PDF points (rotation applied). */
  width: number;
  height: number;
}

interface PageSlot {
  el: HTMLDivElement;
  canvas: HTMLCanvasElement;
  overlay: HTMLDivElement;
  textLayer: HTMLDivElement;
  renderedScale: number;
  task?: RenderTask;
}

/**
 * Hosts that refuse binary .bcmap files (e.g. a claude.ai artifact) get the CMaps as base64 JSON instead;
 * build with VITE_PDFJS_ASSETS=json and convert them with scripts/make-artifact.mjs.
 */
const JSON_ASSETS = import.meta.env.VITE_PDFJS_ASSETS === 'json';

class JsonCMapReaderFactory {
  async fetch({ name }: { name: string }) {
    const res = await fetch(`${ASSET_BASE}cmaps/${name}.json`);
    if (!res.ok) throw new Error(`CMap ${name}을(를) 불러오지 못했습니다.`);
    const base64: string = await res.json();
    return { cMapData: Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)), isCompressed: true };
  }
}

export interface OpenPdfOptions {
  /** Password known for this document (e.g. entered when it was first opened). */
  password?: string;
  /**
   * Asks the user for the password; `incorrect` is true when the last attempt was wrong.
   * Resolve with null to cancel. Without it, a password-protected file fails to open.
   */
  askPassword?: (incorrect: boolean) => Promise<string | null>;
}

export interface OpenedPdf {
  pdf: PDFDocumentProxy;
  /** The password that opened the file, if one was needed. */
  password?: string;
  /** The file is encrypted (with or without an open password); pdf-lib cannot edit it. */
  encrypted: boolean;
}

/** Thrown by openPdf when the user cancels the password prompt. */
export class PasswordCancelledError extends Error {
  constructor() {
    super('암호 입력을 취소해 문서를 열지 않았습니다.');
    this.name = 'PasswordCancelledError';
  }
}

export async function openPdf(bytes: Uint8Array, options: OpenPdfOptions = {}): Promise<OpenedPdf> {
  // pdf.js transfers the buffer to its worker, so hand it a copy.
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    password: options.password,
    ...(JSON_ASSETS
      ? // Without standard font files pdf.js falls back to similar system fonts.
        { CMapReaderFactory: JsonCMapReaderFactory as never }
      : {
          cMapUrl: `${ASSET_BASE}cmaps/`,
          cMapPacked: true,
          standardFontDataUrl: `${ASSET_BASE}standard_fonts/`,
        }),
  });
  let password = options.password;
  let cancelled = false;
  let failure: Error | undefined;
  task.onPassword = (update: (password: string) => void, reason: number) => {
    const incorrect = reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD;
    const stop = (error: Error) => {
      failure = error;
      void task.destroy();
    };
    if (!options.askPassword) {
      return stop(new Error(incorrect ? 'PDF 암호가 맞지 않습니다.' : '암호로 보호된 PDF입니다. 암호가 필요합니다.'));
    }
    options.askPassword(incorrect).then(
      (answer) => {
        if (answer === null) {
          cancelled = true;
          return stop(new PasswordCancelledError());
        }
        password = answer;
        update(answer);
      },
      (e: Error) => stop(e),
    );
  };
  try {
    const pdf = await task.promise;
    const info = (await pdf.getMetadata()).info as { EncryptFilterName?: string | null };
    return { pdf, password, encrypted: password !== undefined || !!info.EncryptFilterName };
  } catch (e) {
    if (cancelled) throw new PasswordCancelledError();
    throw failure ?? e;
  }
}

export class Viewer {
  pdf?: PDFDocumentProxy;
  sizes: PageSize[] = [];
  scale = 1;
  zoom: Zoom = 'fit-width';
  current = 0;

  private slots: PageSlot[] = [];
  private observer?: IntersectionObserver;
  private generation = 0;

  constructor(
    private readonly scroller: HTMLElement,
    private readonly container: HTMLElement,
    private readonly onPageChange: (index: number) => void,
    /** Lets the annotation layer attach handlers to each page's overlay. */
    private readonly onPageCreated: (index: number, overlay: HTMLDivElement) => void,
  ) {
    scroller.addEventListener('scroll', () => this.trackCurrentPage(), { passive: true });
    new ResizeObserver(() => {
      if (this.pdf && typeof this.zoom === 'string') this.applyZoom();
    }).observe(scroller);
  }

  get pageCount(): number {
    return this.sizes.length;
  }

  pageElement(index: number): HTMLDivElement | undefined {
    return this.slots[index]?.el;
  }

  /** Replaces the displayed document, keeping the scroll position as close as possible. */
  async load(pdf: PDFDocumentProxy, keepPage = 0): Promise<void> {
    const generation = ++this.generation;
    const old = this.pdf;
    this.pdf = pdf;
    this.sizes = await Promise.all(
      Array.from({ length: pdf.numPages }, async (_, i) => {
        const vp = (await pdf.getPage(i + 1)).getViewport({ scale: 1 });
        return { width: vp.width, height: vp.height };
      }),
    );
    if (generation !== this.generation) return;
    this.build();
    this.applyZoom();
    this.scrollToPage(Math.min(keepPage, this.pageCount - 1), 'instant');
    old?.destroy();
  }

  clear(): void {
    this.generation++;
    this.observer?.disconnect();
    this.slots.forEach((s) => s.task?.cancel());
    this.slots = [];
    this.sizes = [];
    this.container.replaceChildren();
    this.pdf?.destroy();
    this.pdf = undefined;
  }

  setZoom(zoom: Zoom): void {
    this.zoom = typeof zoom === 'number' ? Math.min(5, Math.max(0.1, zoom)) : zoom;
    const anchor = this.current;
    this.applyZoom();
    this.scrollToPage(anchor, 'instant');
  }

  scrollToPage(index: number, behavior: ScrollBehavior = 'smooth'): void {
    const slot = this.slots[index];
    if (!slot) return;
    this.scroller.scrollTo({ top: slot.el.offsetTop - PAGE_GAP, behavior });
    this.setCurrent(index);
  }

  /** Converts a pointer event on a page overlay to PDF points (visual, top-left origin). */
  toPdfPoint(index: number, clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.slots[index].el.getBoundingClientRect();
    return { x: (clientX - rect.left) / this.scale, y: (clientY - rect.top) / this.scale };
  }

  // ---------------------------------------------------------------------------

  private build(): void {
    this.observer?.disconnect();
    this.slots.forEach((s) => s.task?.cancel());
    this.container.replaceChildren();
    this.slots = this.sizes.map((_, i) => {
      const el = document.createElement('div');
      el.className = 'page';
      el.dataset.index = String(i);
      const canvas = document.createElement('canvas');
      canvas.className = 'render';
      const textLayer = document.createElement('div');
      textLayer.className = 'textLayer';
      const overlay = document.createElement('div');
      overlay.className = 'overlay';
      const label = document.createElement('span');
      label.className = 'page-label';
      label.textContent = `${i + 1}`;
      el.append(canvas, textLayer, overlay, label);
      this.container.append(el);
      this.onPageCreated(i, overlay);
      return { el, canvas, overlay, textLayer, renderedScale: 0 };
    });
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) void this.renderPage(Number((e.target as HTMLElement).dataset.index));
        }
      },
      { root: this.scroller, rootMargin: '600px 0px' },
    );
    this.slots.forEach((s) => this.observer!.observe(s.el));
  }

  private applyZoom(): void {
    if (!this.sizes.length) return;
    const availW = this.scroller.clientWidth - 2 * 20 - 16;
    const availH = this.scroller.clientHeight - 2 * PAGE_GAP;
    const widest = Math.max(...this.sizes.map((s) => s.width));
    const first = this.sizes[this.current] ?? this.sizes[0];
    if (this.zoom === 'fit-width') this.scale = availW / widest;
    else if (this.zoom === 'fit-page') this.scale = Math.min(availW / first.width, availH / first.height);
    else this.scale = this.zoom;
    this.scale = Math.max(0.1, this.scale);

    this.slots.forEach((slot, i) => {
      const { width, height } = this.sizes[i];
      slot.el.style.width = `${Math.floor(width * this.scale)}px`;
      slot.el.style.height = `${Math.floor(height * this.scale)}px`;
      slot.el.style.setProperty('--scale-factor', String(this.scale));
      if (slot.renderedScale && slot.renderedScale !== this.scale) slot.renderedScale = -1; // stale
    });
    // Re-render whatever is visible at the new scale.
    this.slots.forEach((s, i) => {
      if (s.renderedScale === -1 && this.isNearViewport(s.el)) void this.renderPage(i);
    });
  }

  private isNearViewport(el: HTMLElement): boolean {
    const r = el.getBoundingClientRect();
    const v = this.scroller.getBoundingClientRect();
    return r.bottom > v.top - 600 && r.top < v.bottom + 600;
  }

  private async renderPage(index: number): Promise<void> {
    const slot = this.slots[index];
    const pdf = this.pdf;
    if (!slot || !pdf || slot.renderedScale === this.scale) return;
    const scale = this.scale;
    slot.renderedScale = scale;
    slot.task?.cancel();

    const page = await pdf.getPage(index + 1);
    if (this.pdf !== pdf || slot.renderedScale !== scale) return;
    const dpr = window.devicePixelRatio || 1;
    const viewport = page.getViewport({ scale: scale * dpr });
    const canvas = document.createElement('canvas');
    canvas.className = 'render';
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const task = page.render({ canvasContext: canvas.getContext('2d')!, viewport });
    slot.task = task;
    try {
      await task.promise;
    } catch (e) {
      if ((e as Error).name !== 'RenderingCancelledException') console.error(e);
      return;
    }
    if (this.pdf !== pdf || slot.renderedScale !== scale) return;
    slot.canvas.replaceWith(canvas);
    slot.canvas = canvas;
    await this.renderTextLayer(slot, page, scale);
  }

  private async renderTextLayer(slot: PageSlot, page: PDFPageProxy, scale: number): Promise<void> {
    const layer = document.createElement('div');
    layer.className = 'textLayer';
    const textLayer = new pdfjs.TextLayer({
      textContentSource: page.streamTextContent(),
      container: layer,
      viewport: page.getViewport({ scale }),
    });
    try {
      await textLayer.render();
    } catch {
      return; // text layer is a nicety; never block rendering on it
    }
    slot.textLayer.replaceWith(layer);
    slot.textLayer = layer;
  }

  private trackCurrentPage(): void {
    if (!this.slots.length) return;
    const mid = this.scroller.scrollTop + this.scroller.clientHeight / 3;
    let best = 0;
    for (let i = 0; i < this.slots.length; i++) {
      if (this.slots[i].el.offsetTop <= mid) best = i;
      else break;
    }
    if (best !== this.current) this.setCurrent(best);
  }

  private setCurrent(index: number): void {
    this.slots[this.current]?.el.classList.remove('current');
    this.current = index;
    this.slots[index]?.el.classList.add('current');
    this.onPageChange(index);
  }
}

/** Renders small page previews into the sidebar as they scroll into view. */
export class Thumbnails {
  private observer?: IntersectionObserver;
  private pdf?: PDFDocumentProxy;

  constructor(
    private readonly root: HTMLElement,
    private readonly scroller: HTMLElement,
  ) {}

  load(pdf: PDFDocumentProxy, sizes: PageSize[]): HTMLDivElement[] {
    this.pdf = pdf;
    this.observer?.disconnect();
    this.root.replaceChildren();
    const items = sizes.map((size, i) => {
      const item = document.createElement('div');
      item.className = 'thumb';
      item.dataset.index = String(i);
      item.draggable = true;
      const canvas = document.createElement('canvas');
      const scale = THUMB_WIDTH / Math.max(size.width, size.height * 0.75);
      canvas.style.width = `${Math.round(size.width * scale)}px`;
      canvas.style.height = `${Math.round(size.height * scale)}px`;
      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = String(i + 1);
      item.append(canvas, num);
      this.root.append(item);
      return item;
    });
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          this.observer?.unobserve(e.target);
          void this.render(e.target as HTMLDivElement, pdf);
        }
      },
      { root: this.scroller, rootMargin: '300px 0px' },
    );
    items.forEach((el) => this.observer!.observe(el));
    return items;
  }

  clear(): void {
    this.observer?.disconnect();
    this.root.replaceChildren();
    this.pdf = undefined;
  }

  private async render(item: HTMLDivElement, pdf: PDFDocumentProxy): Promise<void> {
    const canvas = item.querySelector('canvas')!;
    const page = await pdf.getPage(Number(item.dataset.index) + 1);
    if (this.pdf !== pdf) return;
    const cssWidth = parseFloat(canvas.style.width);
    const dpr = window.devicePixelRatio || 1;
    const viewport = page.getViewport({ scale: (cssWidth / page.getViewport({ scale: 1 }).width) * dpr });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d')!, viewport }).promise.catch(() => undefined);
  }
}

/** Extracts plain text per page for searching. */
export async function extractText(pdf: PDFDocumentProxy): Promise<string[]> {
  const texts: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const content = await (await pdf.getPage(i)).getTextContent();
    texts.push(
      content.items
        .map((it) => ('str' in it ? it.str + (it.hasEOL ? '\n' : '') : ''))
        .join('')
        .replace(/\s+/g, ' '),
    );
  }
  return texts;
}
