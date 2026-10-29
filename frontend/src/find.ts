// Find / replace / pattern redaction panel. Matching runs on the core glyph map (exact glyph boxes),
// so a hit can be removed from the file or replaced without touching its neighbours.
import {
  buildTextMap,
  findInTextMap,
  loadPdf,
  redactOpsForMatches,
  TEXT_PATTERNS,
  type FontDecoder,
  type PageTextMap,
  type PdfOperation,
  type Query,
  type TextMatch,
} from '@pdfhandler/core';
import type { PDFDocument, PDFObject } from 'pdf-lib';
import type { CommitReports } from './annotate';
import { rasterText } from './raster';
import { $, ask, toast } from './ui';
import type { Viewer } from './viewer';
import './find.css';

export interface FindHost {
  viewer: Viewer;
  /** Bytes of the document as currently shown (a new array for every history state). */
  bytes(): Uint8Array | undefined;
  commit(ops: PdfOperation[], label: string): Promise<CommitReports>;
}

/** Text maps of one document state; history states keep theirs, so undo/redo reuses them. */
interface DocCache {
  doc: Promise<PDFDocument>;
  maps: Map<number, PageTextMap>;
  decoders: Map<PDFObject, FontDecoder>;
}

const MAX_MATCHES = 10000;
const MAX_LISTED = 1000;
/** Time slice for building text maps before yielding to the UI. */
const SLICE_MS = 30;

type Mode = { kind: 'text'; query: string } | { kind: 'pattern'; ids: string[] };

export class FindPanel {
  private readonly caches = new WeakMap<Uint8Array, DocCache>();
  private matches: TextMatch[] = [];
  private checked = new Set<number>();
  private active = -1;
  private mode: Mode | null = null;
  /** Document state the current matches were found in; actions refuse stale boxes. */
  private matchesOf: Uint8Array | undefined;
  private run = 0;
  private timer: number | undefined;

  private readonly section = $('#search-section');
  private readonly query = $<HTMLInputElement>('#find-query');
  private readonly toolbarQuery = $<HTMLInputElement>('#search-input');
  private readonly replacement = $<HTMLInputElement>('#find-replacement');
  private readonly caseBox = $<HTMLInputElement>('#find-case');
  private readonly list = $<HTMLOListElement>('#search-results');
  private readonly count = $('#search-count');
  private readonly progress = $('#find-progress');

  constructor(private readonly host: FindHost) {
    const patterns = $('#find-patterns');
    for (const p of TEXT_PATTERNS) {
      const b = document.createElement('button');
      b.textContent = p.label;
      b.dataset.pattern = p.id;
      b.title = `${p.label} 모두 찾기`;
      b.onclick = () => this.findPatterns([p.id]);
      patterns.append(b);
    }
    const all = document.createElement('button');
    all.textContent = '개인정보 전체';
    all.dataset.pattern = '*';
    all.title = '위 패턴을 모두 찾기';
    all.onclick = () => this.findPatterns(TEXT_PATTERNS.map((p) => p.id));
    patterns.append(all);

    // The toolbar box and the panel box are the same query.
    for (const input of [this.query, this.toolbarQuery]) {
      input.addEventListener('input', () => {
        const other = input === this.query ? this.toolbarQuery : this.query;
        other.value = input.value;
        this.schedule(() => this.findText(input.value));
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (this.matches.length) this.select((this.active + (e.shiftKey ? -1 : 1) + this.matches.length) % this.matches.length);
          else this.findText(input.value);
        } else if (e.key === 'Escape') {
          input.value = '';
          this.findText('');
        }
      });
    }
    this.caseBox.addEventListener('change', () => this.mode?.kind === 'text' && this.findText(this.query.value));
    $('#find-check-all').addEventListener('change', (e) => {
      const on = (e.target as HTMLInputElement).checked;
      this.checked = on ? new Set(this.matches.map((_, i) => i)) : new Set();
      this.list.querySelectorAll<HTMLInputElement>('input[type=checkbox]').forEach((c) => (c.checked = on));
      this.updateButtons();
    });
    $('#find-redact-selected').addEventListener('click', () => void this.redact(this.selected()));
    $('#find-redact-all').addEventListener('click', () => void this.redact(this.matches));
    $('#find-replace-selected').addEventListener('click', () => void this.replace(this.selected()));
    $('#find-replace-all').addEventListener('click', () => void this.replace(this.matches));

    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && this.host.bytes()) {
        e.preventDefault();
        const target = getComputedStyle(this.section).display !== 'none' && this.section.offsetParent ? this.query : this.toolbarQuery;
        target.focus();
        target.select();
      }
    });
    this.updateButtons();
  }

  /** Called after every re-render: the document (or the history position) may have changed. */
  documentChanged(): void {
    this.section.hidden = !this.host.bytes();
    if (this.mode) this.schedule(() => this.rerun(), 0);
    else this.paintHighlights();
  }

  // ---------------------------------------------------------------------------

  private schedule(fn: () => void, delay = 250): void {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(fn, delay);
  }

  private rerun(): void {
    if (!this.mode) return;
    if (this.mode.kind === 'text') this.findText(this.mode.query, true);
    else this.findPatterns(this.mode.ids, true);
  }

  private findText(query: string, keepPosition = false): void {
    if (!query.trim()) {
      this.run++; // cancels a search in flight
      delete this.section.dataset.searching;
      this.mode = null;
      this.setMatches([], false);
      this.status('');
      return;
    }
    this.mode = { kind: 'text', query };
    void this.search([query], keepPosition);
  }

  private findPatterns(ids: string[], keepPosition = false): void {
    window.clearTimeout(this.timer); // a pending query from the search box must not override this
    this.mode = { kind: 'pattern', ids };
    this.query.value = '';
    this.toolbarQuery.value = '';
    void this.search(
      TEXT_PATTERNS.filter((p) => ids.includes(p.id)),
      keepPosition,
    );
  }

  private markPatternButtons(): void {
    const ids = this.mode?.kind === 'pattern' ? this.mode.ids : [];
    document.querySelectorAll<HTMLElement>('#find-patterns button').forEach((b) => {
      const on = b.dataset.pattern === '*' ? ids.length === TEXT_PATTERNS.length : ids.length === 1 && ids[0] === b.dataset.pattern;
      b.classList.toggle('active', on);
    });
  }

  private cache(bytes: Uint8Array): DocCache {
    let c = this.caches.get(bytes);
    if (!c) {
      c = { doc: loadPdf(bytes), maps: new Map(), decoders: new Map() };
      this.caches.set(bytes, c);
    }
    return c;
  }

  /** Searches page by page, yielding to the UI between slices; a newer search cancels this one. */
  private async search(queries: Query[], keepPosition: boolean): Promise<void> {
    const run = ++this.run;
    this.section.dataset.searching = '1';
    const bytes = this.host.bytes();
    this.markPatternButtons();
    if (!bytes) return void delete this.section.dataset.searching;
    const previous = keepPosition && this.active >= 0 ? this.matches[this.active] : undefined;
    const cache = this.cache(bytes);
    let doc: PDFDocument;
    try {
      doc = await cache.doc;
    } catch (e) {
      this.status(`텍스트를 읽을 수 없습니다: ${(e as Error).message}`);
      delete this.section.dataset.searching;
      return;
    }
    if (run !== this.run) return;
    const pageCount = doc.getPageCount();
    const caseSensitive = this.caseBox.checked;
    const found: TextMatch[] = [];
    let unknown = 0;
    let sliceStart = performance.now();
    for (let p = 0; p < pageCount; p++) {
      let map = cache.maps.get(p);
      if (!map) {
        try {
          map = buildTextMap(doc, p, cache.decoders);
        } catch (e) {
          console.warn(`text map of page ${p + 1} failed`, e);
          continue;
        }
        cache.maps.set(p, map);
      }
      unknown += map.unknownGlyphs;
      for (const q of queries) {
        if (found.length >= MAX_MATCHES) break;
        found.push(...findInTextMap(map, q, { caseSensitive, limit: MAX_MATCHES - found.length }));
      }
      if (performance.now() - sliceStart > SLICE_MS) {
        this.status(`검색 중… ${p + 1}/${pageCount}쪽 · ${found.length}건`);
        await new Promise((r) => setTimeout(r, 0));
        if (run !== this.run) return;
        sliceStart = performance.now();
      }
    }
    // Several patterns: page order, then position on the page.
    found.sort((a, b) => a.page - b.page || a.start - b.start);
    const notes: string[] = [];
    if (found.length >= MAX_MATCHES) notes.push(`최대 ${MAX_MATCHES}건까지만 찾았습니다`);
    if (unknown) notes.push(`글자 ${unknown}개는 글꼴 정보가 없어 읽을 수 없습니다(검색에서 빠질 수 있음)`);
    this.status(notes.join(' · '));
    delete this.section.dataset.searching;
    this.matchesOf = bytes;
    this.setMatches(found, !keepPosition);
    if (previous) {
      // Keep the cursor near where it was after the document changed.
      const i = found.findIndex((m) => m.page > previous.page || (m.page === previous.page && m.start >= previous.start));
      if (i >= 0) this.select(i, false);
    }
  }

  private setMatches(matches: TextMatch[], jump: boolean): void {
    this.matches = matches;
    this.checked = new Set();
    this.active = -1;
    ($('#find-check-all') as HTMLInputElement).checked = false;
    this.count.textContent = this.mode ? `${matches.length}건` : '';
    const items = matches.slice(0, MAX_LISTED).map((m, i) => this.item(m, i));
    if (matches.length > MAX_LISTED) {
      const more = document.createElement('li');
      more.className = 'muted';
      more.textContent = `… 외 ${matches.length - MAX_LISTED}건 (모두 삭제/바꾸기에는 포함됩니다)`;
      items.push(more);
    }
    if (this.mode && !matches.length) {
      const none = document.createElement('li');
      none.className = 'muted';
      none.textContent = '찾은 항목이 없습니다.';
      items.push(none);
    }
    this.list.replaceChildren(...items);
    this.updateButtons();
    this.paintHighlights();
    if (jump && matches.length) this.select(0);
  }

  private item(m: TextMatch, i: number): HTMLLIElement {
    const li = document.createElement('li');
    li.dataset.index = String(i);
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.title = '선택';
    check.onclick = (e) => {
      e.stopPropagation();
      if (check.checked) this.checked.add(i);
      else this.checked.delete(i);
      this.updateButtons();
    };
    const body = document.createElement('span');
    body.className = 'hit';
    const page = document.createElement('strong');
    page.textContent = `${m.page + 1}쪽 `;
    const label = m.pattern ? TEXT_PATTERNS.find((p) => p.id === m.pattern)?.label : undefined;
    if (label) {
      const tag = document.createElement('em');
      tag.className = 'tag';
      tag.textContent = label;
      page.append(tag);
    }
    const mark = document.createElement('mark');
    mark.textContent = m.text.replace(/\n/g, ' ');
    body.append(page, `…${m.before}`, mark, `${m.after}…`);
    li.append(check, body);
    li.onclick = () => this.select(i);
    return li;
  }

  private select(i: number, scroll = true): void {
    const m = this.matches[i];
    if (!m) return;
    this.active = i;
    this.list.querySelectorAll('li.active').forEach((el) => el.classList.remove('active'));
    const li = this.list.querySelector<HTMLElement>(`li[data-index="${i}"]`);
    li?.classList.add('active');
    li?.scrollIntoView({ block: 'nearest' });
    this.paintHighlights();
    if (!scroll) return;
    const { viewer } = this.host;
    const pageEl = viewer.pageElement(m.page);
    if (!pageEl) return;
    viewer.scrollToPage(m.page, 'instant');
    // Bring the match itself into view, a third of the way down.
    const scroller = pageEl.closest<HTMLElement>('#viewer');
    if (scroller) {
      const top = pageEl.offsetTop + m.boxes[0].y * viewer.scale - scroller.clientHeight / 3;
      scroller.scrollTo({ top: Math.max(0, top), behavior: 'instant' });
    }
  }

  /** Transient boxes on the pages (not part of the PDF); positioned in % so zoom needs no redraw. */
  private paintHighlights(): void {
    document.querySelectorAll('.find-layer').forEach((el) => el.remove());
    const { viewer } = this.host;
    const byPage = new Map<number, Array<{ m: TextMatch; i: number }>>();
    this.matches.forEach((m, i) => {
      if (byPage.size > 400 && !byPage.has(m.page)) return;
      byPage.set(m.page, [...(byPage.get(m.page) ?? []), { m, i }]);
    });
    for (const [page, hits] of byPage) {
      const pageEl = viewer.pageElement(page);
      const size = viewer.sizes[page];
      if (!pageEl || !size) continue;
      const layer = document.createElement('div');
      layer.className = 'find-layer';
      for (const { m, i } of hits) {
        for (const b of m.boxes) {
          const box = document.createElement('div');
          box.className = i === this.active ? 'find-hit active' : 'find-hit';
          Object.assign(box.style, {
            left: `${(b.x / size.width) * 100}%`,
            top: `${(b.y / size.height) * 100}%`,
            width: `${(b.width / size.width) * 100}%`,
            height: `${(b.height / size.height) * 100}%`,
          });
          layer.append(box);
        }
      }
      pageEl.insertBefore(layer, pageEl.querySelector('.overlay'));
    }
  }

  private selected(): TextMatch[] {
    return [...this.checked].sort((a, b) => a - b).map((i) => this.matches[i]);
  }

  private updateButtons(): void {
    const any = this.matches.length > 0;
    const sel = this.checked.size > 0;
    $<HTMLButtonElement>('#find-redact-selected').disabled = !sel;
    $<HTMLButtonElement>('#find-replace-selected').disabled = !sel;
    $<HTMLButtonElement>('#find-redact-all').disabled = !any;
    $<HTMLButtonElement>('#find-replace-all').disabled = !any;
    $('#find-selected-count').textContent = sel ? `${this.checked.size}건 선택` : '';
  }

  private status(text: string): void {
    this.progress.textContent = text;
    this.progress.hidden = !text;
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  /** Boxes of an older document state must never be applied to the current one. */
  private stale(): boolean {
    if (this.matchesOf === this.host.bytes() && !this.section.dataset.searching) return false;
    toast('문서가 바뀌어 검색 결과를 다시 찾는 중입니다. 잠시 후 다시 누르세요.', 'error');
    return true;
  }

  private async redact(matches: TextMatch[]): Promise<void> {
    if (!matches.length || this.stale()) return;
    const pages = new Set(matches.map((m) => m.page));
    const ok = await ask(
      '검색 결과 삭제',
      `${matches.length}건 (${pages.size}쪽)의 글자를 파일에서 완전히 지우고 검게 칠합니다. 실행 취소로만 되돌릴 수 있습니다. 계속할까요?`,
    );
    if (!ok) return;
    const ops = redactOpsForMatches(matches);
    const { redactions } = await this.host.commit(ops, `검색 결과 ${matches.length}건 삭제`);
    if (!redactions.length) return;
    const removed = redactions.reduce((n, r) => n + r.removedGlyphs, 0);
    const parts = [`${matches.length}건 · 글자 ${removed}개를 ${redactions.filter((r) => r.removedGlyphs).length}쪽에서 삭제했습니다`];
    const annots = redactions.reduce((n, r) => n + r.removedAnnotations, 0);
    const images = redactions.reduce((n, r) => n + r.imagesOverlapping, 0);
    if (annots) parts.push(`겹친 주석·입력란 ${annots}개 삭제`);
    if (images) parts.push(`이미지 ${images}개는 검게 덮기만 함`);
    toast(parts.join(' · '));
  }

  private async replace(matches: TextMatch[]): Promise<void> {
    if (!matches.length || this.stale()) return;
    const text = this.replacement.value;
    const pages = new Set(matches.map((m) => m.page));
    const what = text ? `"${text}"(으)로 바꿉니다` : '빈 내용으로 바꿉니다(글자만 지우고 칠하지 않음)';
    if (!(await ask('바꾸기', `${matches.length}건 (${pages.size}쪽)을 ${what}. 계속할까요?`))) return;
    const ops: PdfOperation[] = [];
    // Rendered images for scripts the document's fonts may lack, one per font size.
    const images = new Map<number, { imageBase64: string; width: number; height: number }>();
    const needsImage = text !== '' && !/^[\x20-\x7e]*$/.test(text);
    for (const m of matches) {
      const [first, ...rest] = m.boxes;
      const op: PdfOperation = { type: 'replaceText', page: m.page, area: first, text, maxWidth: m.maxWidth };
      if (needsImage) {
        const size = Math.round(m.fontSize * 10) / 10;
        if (!images.has(size)) {
          const img = await rasterText(text, size, '#000000');
          images.set(size, { imageBase64: img.base64, width: img.width, height: img.height });
        }
        op.fallbackImage = images.get(size);
      }
      ops.push(op);
      // A match across lines: the new text goes on the first line, the rest is removed.
      if (rest.length) ops.push({ type: 'redact', page: m.page, areas: rest, mode: 'center', fill: null });
    }
    const { replacements } = await this.host.commit(ops, `${matches.length}건 바꾸기`);
    if (!replacements.length) return;
    const reused = replacements.filter((r) => r.reusedFont).length;
    const narrowed = replacements.filter((r) => r.scale < 1 && !r.overflow).length;
    const overflow = replacements.filter((r) => r.overflow).length;
    const missing = replacements.filter((r) => r.removedGlyphs === 0).length;
    const parts = [`${replacements.length}건 바꿈`];
    if (text) parts.push(`원본 글꼴 사용 ${reused}건`, `다른 글꼴/이미지 ${replacements.length - reused}건`);
    if (narrowed) parts.push(`폭을 줄여 맞춤 ${narrowed}건`);
    if (overflow) parts.push(`줄 공간을 넘침 ${overflow}건(확인 필요)`);
    if (missing) parts.push(`원본 글자를 찾지 못함 ${missing}건`);
    toast(parts.join(' · '), overflow || missing ? 'error' : 'info');
  }
}
