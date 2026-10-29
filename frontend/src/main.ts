import {
  applyOperations,
  chunkPages,
  isPdf,
  mergePdfs,
  parsePageRanges,
  splitPdf,
  type PdfOperation,
} from '@pdfhandler/core';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { Annotator, readImageFile, type CommitReports, type Tool } from './annotate';
import { api, type ServerDocumentDetail } from './api';
import { browserImageCodec } from './image-codec';
import { rasterRotatedText } from './raster';
import { buildSamplePdf } from './sample';
import { $, ask, busy, downloadBytes, form, formatBytes, formatDate, setStatus, toast } from './ui';
import { extractText, openPdf, Thumbnails, Viewer, type Zoom } from './viewer';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const MAX_HISTORY = 30;

interface State {
  history: Uint8Array[];
  index: number;
  /** History index at the last download / server save; -1 when never saved. */
  savedIndex: number;
  fileName: string;
  server?: ServerDocumentDetail;
  serverOnline: boolean;
  selection: Set<number>;
  texts?: string[];
  pdf?: PDFDocumentProxy;
  tool: Tool;
}

const state: State = {
  history: [],
  index: -1,
  savedIndex: -1,
  fileName: 'document.pdf',
  serverOnline: false,
  selection: new Set(),
  tool: 'select',
};

const current = () => state.history[state.index];
const hasDoc = () => state.index >= 0;
const isDirty = () => hasDoc() && state.index !== state.savedIndex;
const baseName = () => state.fileName.replace(/\.pdf$/i, '');

// ---------------------------------------------------------------------------
// Viewer wiring
// ---------------------------------------------------------------------------

const viewer: Viewer = new Viewer(
  $('#viewer'),
  $('#pages'),
  (index) => onPageChange(index),
  (index, overlay) => annotator.attach(index, overlay),
);
const thumbnails = new Thumbnails($('#thumbnails'), $('#sidebar'));
const annotator = new Annotator({
  viewer,
  tool: () => state.tool,
  color: () => $<HTMLInputElement>('#tool-color').value,
  size: () => Math.max(1, Number($<HTMLInputElement>('#tool-size').value) || 16),
  commit: (ops, label) => commit(ops, label),
  pickImage: () => pickFile('#file-image').then((files) => (files[0] ? readImageFile(files[0]) : null)),
  resetTool: () => setTool('select'),
  toast: (message) => toast(message, 'error'),
  notify: (message) => {
    toast(message);
    setStatus(message);
  },
});

async function render(keepPage = viewer.current): Promise<void> {
  const pdf = await openPdf(current());
  state.pdf = pdf;
  state.texts = undefined;
  await viewer.load(pdf, keepPage);
  const items = thumbnails.load(pdf, viewer.sizes);
  items.forEach((item, i) => wireThumbnail(item, i));
  $('#dropzone').hidden = true;
  onPageChange(viewer.current);
  updateSelection();
  await updateInfo();
  updateControls();
}

function onPageChange(index: number): void {
  $<HTMLInputElement>('#page-input').value = String(index + 1);
  document.querySelectorAll('.thumb.current').forEach((el) => el.classList.remove('current'));
  const thumb = document.querySelector<HTMLElement>(`.thumb[data-index="${index}"]`);
  if (thumb) {
    thumb.classList.add('current');
    const sidebar = $('#sidebar');
    const r = thumb.getBoundingClientRect();
    const s = sidebar.getBoundingClientRect();
    if (r.top < s.top + 40 || r.bottom > s.bottom) thumb.scrollIntoView({ block: 'nearest' });
  }
}

// ---------------------------------------------------------------------------
// Document lifecycle
// ---------------------------------------------------------------------------

async function openBytes(bytes: Uint8Array, fileName: string, server?: ServerDocumentDetail): Promise<void> {
  if (!isPdf(bytes)) throw new Error(`${fileName}은(는) PDF 파일이 아닙니다.`);
  if (isDirty() && !(await ask('새 파일 열기', '저장하지 않은 변경 사항이 있습니다. 버리고 새 파일을 열까요?'))) return;
  state.history = [bytes];
  state.index = 0;
  state.savedIndex = 0;
  state.fileName = fileName;
  state.server = server;
  state.selection.clear();
  await render(0);
  renderLibraryActive();
  renderVersions();
  setStatus(`${fileName} 열림`);
}

/** Records a new document state and re-renders. */
async function pushBytes(bytes: Uint8Array, label: string, keepPage = viewer.current): Promise<void> {
  state.history = state.history.slice(0, state.index + 1);
  state.history.push(bytes);
  if (state.history.length > MAX_HISTORY) {
    const drop = state.history.length - MAX_HISTORY;
    state.history.splice(0, drop);
    state.savedIndex -= drop;
  }
  state.index = state.history.length - 1;
  await render(keepPage);
  toast(label);
}

async function commit(ops: PdfOperation[], label: string, keepPage?: number): Promise<CommitReports> {
  const reports: CommitReports = { redactions: [], replacements: [] };
  await busy(label, async () => {
    const out = await applyOperations(current(), ops, {
      onRedaction: (r) => reports.redactions.push(r),
      onReplaceText: (r) => reports.replacements.push(r),
      imageCodec: browserImageCodec,
    });
    await pushBytes(out, label, keepPage);
  });
  return reports;
}

async function undo(): Promise<void> {
  if (state.index <= 0) return;
  state.index--;
  state.selection.clear();
  await render();
  toast('실행 취소');
}

async function redo(): Promise<void> {
  if (state.index >= state.history.length - 1) return;
  state.index++;
  state.selection.clear();
  await render();
  toast('다시 실행');
}

/** Selected pages, or the current page when nothing is selected. 0-based, ascending. */
function targetPages(): number[] {
  return state.selection.size ? [...state.selection].sort((a, b) => a - b) : [viewer.current];
}

function rangeLabel(pages: number[]): string {
  const sorted = [...pages].sort((a, b) => a - b).map((p) => p + 1);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(i === j ? `${sorted[i]}` : `${sorted[i]}-${sorted[j]}`);
    i = j;
  }
  return parts.join(', ');
}

// ---------------------------------------------------------------------------
// Thumbnails: selection + drag-to-reorder
// ---------------------------------------------------------------------------

let anchor = 0;
let dragging: number[] = [];

function wireThumbnail(item: HTMLDivElement, index: number): void {
  item.addEventListener('click', (e) => {
    if (e.shiftKey) {
      const [a, b] = [Math.min(anchor, index), Math.max(anchor, index)];
      state.selection = new Set(Array.from({ length: b - a + 1 }, (_, k) => a + k));
    } else if (e.ctrlKey || e.metaKey) {
      if (state.selection.has(index)) state.selection.delete(index);
      else state.selection.add(index);
      anchor = index;
    } else {
      state.selection = new Set([index]);
      anchor = index;
    }
    updateSelection();
    viewer.scrollToPage(index);
  });

  item.addEventListener('dragstart', (e) => {
    dragging = state.selection.has(index) ? [...state.selection].sort((a, b) => a - b) : [index];
    e.dataTransfer!.effectAllowed = 'move';
    e.dataTransfer!.setData('text/plain', dragging.join(','));
    requestAnimationFrame(() =>
      dragging.forEach((i) => document.querySelector(`.thumb[data-index="${i}"]`)?.classList.add('dragging')),
    );
  });
  item.addEventListener('dragend', () => {
    document.querySelectorAll('.thumb').forEach((el) => el.classList.remove('dragging', 'drop-before', 'drop-after'));
    dragging = [];
  });
  item.addEventListener('dragover', (e) => {
    if (!dragging.length) return;
    e.preventDefault();
    const before = e.offsetY < item.clientHeight / 2;
    item.classList.toggle('drop-before', before);
    item.classList.toggle('drop-after', !before);
  });
  item.addEventListener('dragleave', () => item.classList.remove('drop-before', 'drop-after'));
  item.addEventListener('drop', (e) => {
    if (!dragging.length) return;
    e.preventDefault();
    e.stopPropagation();
    const before = item.classList.contains('drop-before');
    const moved = dragging;
    const rest = Array.from({ length: viewer.pageCount }, (_, i) => i).filter((i) => !moved.includes(i));
    let insertAt = rest.findIndex((i) => i === index);
    if (insertAt === -1) insertAt = rest.filter((i) => i < index).length; // dropped onto a moved page
    else if (!before) insertAt++;
    const order = [...rest.slice(0, insertAt), ...moved, ...rest.slice(insertAt)];
    if (order.every((p, i) => p === i)) return;
    state.selection = new Set(moved.map((p) => order.indexOf(p)));
    void commit([{ type: 'reorder', order }], '쪽 순서 변경', order.indexOf(moved[0]));
  });
}

function updateSelection(): void {
  document.querySelectorAll<HTMLElement>('.thumb').forEach((el) => {
    el.classList.toggle('selected', state.selection.has(Number(el.dataset.index)));
  });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

const DEMO = import.meta.env.VITE_DEMO === '1';

const actions: Record<string, () => unknown> = {
  sample: () => busy('샘플 만드는 중', async () => openBytes(await buildSamplePdf(), '샘플.pdf')),

  open: async () => {
    const [file] = await pickFile('#file-open');
    if (file) await openFile(file);
  },

  download: () =>
    busy('다운로드', async () => {
      if (!(await downloadBytes(current(), state.fileName))) return;
      state.savedIndex = state.index;
      updateControls();
    }),

  'save-server': () =>
    busy('서버에 저장', async () => {
      let doc: ServerDocumentDetail;
      if (state.server) {
        const values = await form('서버에 새 버전 저장', [{ name: 'note', label: '버전 메모 (선택)', type: 'text' }]);
        if (!values) return;
        doc = await api.addVersion(state.server.id, current(), values.note || undefined);
        toast(`v${doc.currentVersion} 저장됨`);
      } else {
        doc = await api.upload(current(), state.fileName);
        toast('서버 문서함에 업로드됨');
      }
      state.server = doc;
      state.savedIndex = state.index;
      updateControls();
      renderVersions();
      await updateInfo();
      await refreshLibrary();
    }),

  undo,
  redo,

  'zoom-in': () => setZoom(viewer.scale * 1.2),
  'zoom-out': () => setZoom(viewer.scale / 1.2),
  prev: () => viewer.scrollToPage(Math.max(0, viewer.current - 1)),
  next: () => viewer.scrollToPage(Math.min(viewer.pageCount - 1, viewer.current + 1)),

  'rotate-left': () => commit([{ type: 'rotate', pages: targetPages(), degrees: -90 }], '왼쪽으로 회전'),
  'rotate-right': () => commit([{ type: 'rotate', pages: targetPages(), degrees: 90 }], '오른쪽으로 회전'),

  delete: async () => {
    const pages = targetPages();
    if (pages.length >= viewer.pageCount) return toast('모든 쪽을 삭제할 수는 없습니다.', 'error');
    if (pages.length > 1 && !(await ask('쪽 삭제', `${rangeLabel(pages)}쪽 (${pages.length}개)을 삭제할까요?`))) return;
    state.selection.clear();
    await commit([{ type: 'delete', pages }], `${rangeLabel(pages)}쪽 삭제`, Math.min(pages[0], viewer.pageCount - pages.length - 1));
  },

  duplicate: () => {
    // Duplicate from the back so earlier indexes stay valid.
    const pages = targetPages().reverse();
    state.selection.clear();
    return commit(pages.map((page) => ({ type: 'duplicate', page }) as PdfOperation), '쪽 복제');
  },

  'insert-blank': () => commit([{ type: 'insertBlank', after: viewer.current }], '빈 쪽 삽입', viewer.current + 1),

  merge: async () => {
    const files = await pickFile('#file-merge');
    if (!files.length) return;
    await busy('병합', async () => {
      const others = await Promise.all(files.map(async (f) => new Uint8Array(await f.arrayBuffer())));
      const bad = files.find((_, i) => !isPdf(others[i]));
      if (bad) throw new Error(`${bad.name}은(는) PDF가 아닙니다.`);
      const before = viewer.pageCount;
      await pushBytes(await mergePdfs([current(), ...others]), `${files.length}개 파일 병합`, before);
    });
  },

  extract: async () => {
    const values = await form('쪽 추출', [
      { name: 'range', label: '추출할 쪽 (예: 1-3, 5)', type: 'text', value: rangeLabel(targetPages()), required: true },
    ], '선택한 쪽만 담은 새 PDF를 내려받습니다. 원본은 바뀌지 않습니다.');
    if (!values) return;
    await busy('추출', async () => {
      const pages = parsePageRanges(values.range, viewer.pageCount);
      const out = await applyOperations(current(), [{ type: 'extract', pages }]);
      await downloadBytes(out, `${baseName()}_p${values.range.replace(/\s+/g, '')}.pdf`);
    });
  },

  split: async () => {
    const values = await form('분할', [
      {
        name: 'mode',
        label: '방식',
        type: 'select',
        options: [
          ['every', 'N쪽마다 나누기'],
          ['ranges', '범위 지정 (세미콜론으로 구분)'],
        ],
      },
      { name: 'every', label: 'N (방식이 N쪽마다일 때)', type: 'number', value: 1, min: 1 },
      { name: 'ranges', label: '범위 (예: 1-3; 4-6; 7-)', type: 'text', placeholder: '1-3; 4-6; 7-' },
    ], '나눈 파일을 각각 내려받습니다. 브라우저가 여러 파일 다운로드 허용을 물을 수 있습니다.');
    if (!values) return;
    await busy('분할', async () => {
      const groups =
        values.mode === 'every'
          ? chunkPages(viewer.pageCount, Number(values.every))
          : values.ranges
              .split(';')
              .map((s) => s.trim())
              .filter(Boolean)
              .map((r) => parsePageRanges(r, viewer.pageCount));
      if (!groups.length) throw new Error('나눌 범위를 입력하세요.');
      if (groups.length > 50 && !(await ask('분할', `${groups.length}개 파일이 만들어집니다. 계속할까요?`))) return;
      const parts = await splitPdf(current(), groups);
      // One at a time: a host save prompt may need confirming for each file.
      let saved = 0;
      for (const [i, bytes] of parts.entries()) {
        if (await downloadBytes(bytes, `${baseName()}_${i + 1}.pdf`)) saved++;
      }
      toast(`${parts.length}개 파일로 분할, ${saved}개 저장`);
    });
  },

  watermark: async () => {
    const values = await form('워터마크', [
      { name: 'text', label: '문구 (한글 가능)', type: 'text', value: '대외비', required: true },
      { name: 'size', label: '글자 크기(pt)', type: 'number', value: 60, min: 6, max: 300 },
      { name: 'angle', label: '각도(°)', type: 'number', value: 45, min: -180, max: 180 },
      { name: 'opacity', label: '불투명도 (0~1)', type: 'number', value: 0.2, min: 0.05, max: 1, step: 0.05 },
      { name: 'color', label: '색', type: 'color', value: '#888888' },
      { name: 'range', label: '적용할 쪽 (비우면 전체)', type: 'text', placeholder: '예: 1-3, 5' },
    ]);
    if (!values) return;
    await busy('워터마크', async () => {
      const pages = values.range.trim()
        ? parsePageRanges(values.range, viewer.pageCount)
        : Array.from({ length: viewer.pageCount }, (_, i) => i);
      const img = await rasterRotatedText(values.text, Number(values.size), values.color, Number(values.angle));
      const ops: PdfOperation[] = [...new Set(pages)].map((page) => {
        const { width, height } = viewer.sizes[page];
        return {
          type: 'addImage',
          page,
          x: (width - img.width) / 2,
          y: (height - img.height) / 2,
          width: img.width,
          height: img.height,
          imageBase64: img.base64,
          opacity: Number(values.opacity),
        };
      });
      await pushBytes(await applyOperations(current(), ops), '워터마크 추가');
    });
  },

  'page-numbers': async () => {
    const values = await form('쪽 번호', [
      { name: 'format', label: '형식 ({n}=쪽, {total}=전체)', type: 'text', value: '{n} / {total}', required: true },
      {
        name: 'position',
        label: '위치',
        type: 'select',
        options: [
          ['bottom-center', '아래 가운데'],
          ['bottom-right', '아래 오른쪽'],
          ['bottom-left', '아래 왼쪽'],
          ['top-center', '위 가운데'],
          ['top-right', '위 오른쪽'],
          ['top-left', '위 왼쪽'],
        ],
      },
      { name: 'size', label: '글자 크기(pt)', type: 'number', value: 11, min: 6, max: 48 },
      { name: 'start', label: '시작 번호', type: 'number', value: 1, min: 0 },
    ], '쪽 번호 형식은 숫자/영문만 지원합니다(기본 PDF 폰트).');
    if (!values) return;
    await commit(
      [
        {
          type: 'pageNumbers',
          format: values.format,
          position: values.position as Extract<PdfOperation, { type: 'pageNumbers' }>['position'],
          fontSize: Number(values.size),
          startAt: Number(values.start),
        },
      ],
      '쪽 번호 추가',
    );
  },

  metadata: async () => {
    const info = ((await state.pdf?.getMetadata())?.info ?? {}) as Record<string, string>;
    const values = await form('문서 속성', [
      { name: 'title', label: '제목', type: 'text', value: info.Title ?? '' },
      { name: 'author', label: '작성자', type: 'text', value: info.Author ?? '' },
      { name: 'subject', label: '주제', type: 'text', value: info.Subject ?? '' },
      { name: 'keywords', label: '키워드 (쉼표로 구분)', type: 'text', value: info.Keywords ?? '' },
    ]);
    if (!values) return;
    await commit(
      [
        {
          type: 'metadata',
          title: values.title,
          author: values.author,
          subject: values.subject,
          keywords: values.keywords.split(',').map((k) => k.trim()).filter(Boolean),
        },
      ],
      '문서 속성 변경',
    );
  },
};

function setZoom(zoom: Zoom): void {
  viewer.setZoom(zoom);
  const select = $<HTMLSelectElement>('#zoom');
  const match = [...select.options].find((o) => o.value === String(zoom));
  if (match) select.value = match.value;
  else {
    let custom = select.querySelector<HTMLOptionElement>('option[data-custom]');
    if (!custom) {
      custom = new Option('', '');
      custom.dataset.custom = '1';
      select.prepend(custom);
    }
    custom.value = String(viewer.scale);
    custom.textContent = `${Math.round(viewer.scale * 100)}%`;
    select.value = custom.value;
  }
}

function setTool(tool: Tool): void {
  state.tool = tool;
  document.body.dataset.tool = tool;
  document.querySelectorAll<HTMLElement>('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
}

async function openFile(file: File): Promise<void> {
  await busy('파일 여는 중', async () => openBytes(new Uint8Array(await file.arrayBuffer()), file.name));
}

function pickFile(selector: string): Promise<File[]> {
  const input = $<HTMLInputElement>(selector);
  input.value = '';
  return new Promise((resolve) => {
    input.onchange = () => resolve([...(input.files ?? [])]);
    input.oncancel = () => resolve([]);
    input.click();
  });
}

// ---------------------------------------------------------------------------
// Panel: info, search, server library, versions
// ---------------------------------------------------------------------------

async function updateInfo(): Promise<void> {
  const dl = $('#doc-info');
  if (!hasDoc()) return;
  const meta = ((await state.pdf?.getMetadata())?.info ?? {}) as Record<string, string>;
  const rows: Array<[string, string]> = [
    ['파일', state.fileName],
    ['쪽 수', String(viewer.pageCount)],
    ['크기', formatBytes(current().byteLength)],
    ['PDF 버전', meta.PDFFormatVersion ?? '-'],
  ];
  if (meta.Title) rows.push(['제목', meta.Title]);
  if (meta.Author) rows.push(['작성자', meta.Author]);
  if (state.server) rows.push(['서버', `v${state.server.currentVersion} (${state.server.id.slice(0, 8)})`]);
  dl.replaceChildren(
    ...rows.flatMap(([k, v]) => {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      return [dt, dd];
    }),
  );
}

async function search(query: string): Promise<void> {
  const section = $('#search-section');
  const list = $('#search-results');
  query = query.trim();
  if (!query || !state.pdf) {
    section.hidden = true;
    return;
  }
  state.texts ??= await extractText(state.pdf);
  const needle = query.toLocaleLowerCase();
  const hits: Array<{ page: number; before: string; match: string; after: string }> = [];
  state.texts.forEach((text, page) => {
    const hay = text.toLocaleLowerCase();
    let at = hay.indexOf(needle);
    while (at !== -1 && hits.length < 500) {
      hits.push({
        page,
        before: text.slice(Math.max(0, at - 30), at),
        match: text.slice(at, at + query.length),
        after: text.slice(at + query.length, at + query.length + 30),
      });
      at = hay.indexOf(needle, at + needle.length);
    }
  });
  section.hidden = false;
  $('#search-count').textContent = `${hits.length}건`;
  list.replaceChildren(
    ...hits.map((h) => {
      const li = document.createElement('li');
      const page = document.createElement('strong');
      page.textContent = `${h.page + 1}쪽 `;
      const mark = document.createElement('mark');
      mark.textContent = h.match;
      li.append(page, `…${h.before}`, mark, `${h.after}…`);
      li.onclick = () => viewer.scrollToPage(h.page);
      return li;
    }),
  );
  if (hits.length) viewer.scrollToPage(hits[0].page);
}

async function checkServer(): Promise<void> {
  state.serverOnline = await api.health();
  const badge = $('#server-status');
  badge.textContent = state.serverOnline ? '연결됨' : '오프라인';
  badge.className = `badge ${state.serverOnline ? 'online' : 'offline'}`;
  updateControls();
  await refreshLibrary();
}

async function refreshLibrary(): Promise<void> {
  const root = $('#library');
  if (!state.serverOnline) {
    root.innerHTML =
      '<p class="muted">백엔드(NestJS)에 연결되지 않았습니다. 편집은 브라우저에서 그대로 쓸 수 있고, 서버 저장/버전 기록만 비활성화됩니다.</p>';
    return;
  }
  try {
    const { items, total } = await api.list();
    if (!items.length) {
      root.innerHTML = '<p class="muted">저장된 문서가 없습니다. 문서를 연 뒤 "서버 저장"을 누르세요.</p>';
      return;
    }
    root.replaceChildren(
      ...items.map((doc) => {
        const row = document.createElement('div');
        row.className = 'row';
        row.dataset.id = doc.id;
        const meta = document.createElement('div');
        meta.className = 'meta';
        const title = document.createElement('div');
        title.className = 'title';
        title.textContent = doc.title;
        title.title = doc.originalName;
        const small = document.createElement('small');
        small.textContent = `v${doc.currentVersion} · ${doc.pageCount}쪽 · ${formatBytes(doc.size)} · ${formatDate(doc.updatedAt)}`;
        meta.append(title, small);
        const open = document.createElement('button');
        open.textContent = '열기';
        open.onclick = () => openServerDoc(doc.id);
        const del = document.createElement('button');
        del.textContent = '삭제';
        del.onclick = async () => {
          if (!(await ask('서버 문서 삭제', `"${doc.title}"과(와) 모든 버전을 서버에서 삭제할까요?`))) return;
          await busy('삭제', async () => {
            await api.remove(doc.id);
            if (state.server?.id === doc.id) {
              state.server = undefined;
              renderVersions();
              await updateInfo();
            }
            await refreshLibrary();
          });
        };
        row.append(meta, open, del);
        return row;
      }),
    );
    if (total > items.length) {
      const more = document.createElement('p');
      more.className = 'muted';
      more.textContent = `최근 ${items.length}개 / 전체 ${total}개`;
      root.append(more);
    }
    renderLibraryActive();
  } catch (e) {
    root.textContent = `목록을 불러오지 못했습니다: ${(e as Error).message}`;
  }
}

function renderLibraryActive(): void {
  document.querySelectorAll<HTMLElement>('#library .row').forEach((row) => {
    row.classList.toggle('active', row.dataset.id === state.server?.id);
  });
}

async function openServerDoc(id: string, version?: number): Promise<void> {
  await busy('서버 문서 여는 중', async () => {
    const [doc, bytes] = await Promise.all([api.get(id), api.download(id, version)]);
    const suffix = version && version !== doc.currentVersion ? ` (v${version})` : '';
    await openBytes(bytes, `${doc.title}${suffix}.pdf`, doc);
  });
}

function renderVersions(): void {
  const section = $('#versions-section');
  const list = $('#versions');
  const doc = state.server;
  section.hidden = !doc;
  if (!doc) return;
  const sourceLabel = { upload: '업로드', client_edit: '브라우저 편집', server_operations: '서버 작업' } as const;
  list.replaceChildren(
    ...doc.versions.map((v) => {
      const li = document.createElement('li');
      li.classList.toggle('current', v.version === doc.currentVersion);
      const meta = document.createElement('div');
      meta.className = 'meta';
      const title = document.createElement('div');
      title.textContent = `v${v.version} · ${sourceLabel[v.source]}`;
      const small = document.createElement('small');
      small.textContent = `${formatDate(v.createdAt)} · ${v.pageCount}쪽 · ${formatBytes(v.size)}${v.note ? ` · ${v.note}` : ''}`;
      meta.append(title, small);
      const open = document.createElement('button');
      open.textContent = '열기';
      open.onclick = () => openServerDoc(doc.id, v.version);
      li.append(meta, open);
      if (v.version !== doc.currentVersion) {
        const revert = document.createElement('button');
        revert.textContent = '복원';
        revert.title = '이 버전을 새 최신 버전으로 복사';
        revert.onclick = async () => {
          if (!(await ask('버전 복원', `v${v.version}을(를) 최신 버전으로 복원할까요? (기록은 보존됩니다)`))) return;
          await busy('복원', async () => {
            await api.revert(doc.id, v.version);
            await openServerDoc(doc.id);
            await refreshLibrary();
          });
        };
        li.append(revert);
      }
      return li;
    }),
  );
}

// ---------------------------------------------------------------------------
// Controls & events
// ---------------------------------------------------------------------------

function updateControls(): void {
  document.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('[data-needs-doc]').forEach((el) => {
    el.disabled = !hasDoc() || (el.hasAttribute('data-needs-server') && !state.serverOnline);
  });
  $<HTMLButtonElement>('[data-action="undo"]').disabled = state.index <= 0;
  $<HTMLButtonElement>('[data-action="redo"]').disabled = state.index >= state.history.length - 1;
  $('#page-total').textContent = `/ ${viewer.pageCount}`;
  $('#dirty').hidden = !isDirty();
  document.title = hasDoc() ? `${isDirty() ? '* ' : ''}${state.fileName} - pdfHandler` : 'pdfHandler';
}

document.addEventListener('click', (e) => {
  const button = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
  if (!button || (button as HTMLButtonElement).disabled) return;
  const action = actions[button.dataset.action!];
  if (action) void Promise.resolve(action()).catch((err) => toast((err as Error).message, 'error'));
});

document.querySelectorAll<HTMLElement>('[data-tool]').forEach((b) =>
  b.addEventListener('click', async () => {
    const tool = b.dataset.tool as Tool;
    if (tool === 'image' && !(await annotator.armImage())) return;
    setTool(tool);
    if (tool === 'image') toast('이미지를 넣을 위치를 클릭하세요');
    if (tool === 'edit-text') toast('고칠 텍스트를 클릭하세요 (Enter 적용, Esc 취소)');
    if (tool === 'redact') toast('지울 영역을 드래그하세요. 안의 글자가 파일에서 완전히 삭제됩니다');
  }),
);

$<HTMLSelectElement>('#zoom').addEventListener('change', (e) => {
  const v = (e.target as HTMLSelectElement).value;
  setZoom(v === 'fit-width' || v === 'fit-page' ? v : Number(v));
});

$<HTMLInputElement>('#page-input').addEventListener('change', (e) => {
  const n = Number((e.target as HTMLInputElement).value);
  if (n >= 1 && n <= viewer.pageCount) viewer.scrollToPage(n - 1);
});

let searchTimer: number | undefined;
$<HTMLInputElement>('#search-input').addEventListener('input', (e) => {
  window.clearTimeout(searchTimer);
  const q = (e.target as HTMLInputElement).value;
  searchTimer = window.setTimeout(() => void search(q), 300);
});

document.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement;
  if (target.matches('input, textarea, select') || document.querySelector('dialog[open]')) return;
  const mod = e.ctrlKey || e.metaKey;
  const run = (name: string) => {
    e.preventDefault();
    const btn = document.querySelector<HTMLButtonElement>(`[data-action="${name}"]`);
    if (name === 'open' || (btn && !btn.disabled)) void actions[name]();
  };
  if (mod && e.key.toLowerCase() === 'o') run('open');
  else if (mod && e.key.toLowerCase() === 's') run('download');
  else if (mod && e.key.toLowerCase() === 'z') run(e.shiftKey ? 'redo' : 'undo');
  else if (mod && e.key.toLowerCase() === 'y') run('redo');
  else if (mod && e.key.toLowerCase() === 'a' && hasDoc()) {
    e.preventDefault();
    state.selection = new Set(Array.from({ length: viewer.pageCount }, (_, i) => i));
    updateSelection();
  } else if (!mod && (e.key === 'Delete' || e.key === 'Backspace') && hasDoc()) run('delete');
  else if (!mod && (e.key === '+' || e.key === '=')) run('zoom-in');
  else if (!mod && e.key === '-') run('zoom-out');
  else if (!mod && (e.key === 'PageDown' || e.key === 'ArrowRight')) run('next');
  else if (!mod && (e.key === 'PageUp' || e.key === 'ArrowLeft')) run('prev');
  else if (e.key === 'Escape') {
    setTool('select');
    state.selection.clear();
    updateSelection();
  }
});

// Drag & drop a PDF anywhere to open it.
let dragDepth = 0;
const isFileDrag = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!isFileDrag(e)) return;
  dragDepth++;
  document.body.classList.add('drag-over');
});
window.addEventListener('dragleave', (e) => {
  if (!isFileDrag(e)) return;
  if (--dragDepth <= 0) document.body.classList.remove('drag-over');
});
window.addEventListener('dragover', (e) => {
  if (isFileDrag(e)) e.preventDefault();
});
window.addEventListener('drop', (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('drag-over');
  const file = [...(e.dataTransfer?.files ?? [])].find((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  if (file) void openFile(file);
  else toast('PDF 파일만 열 수 있습니다.', 'error');
});

window.addEventListener('beforeunload', (e) => {
  if (isDirty()) e.preventDefault();
});

setTool('select');
updateControls();
if (DEMO) {
  // Static build (e.g. a hosted demo): no backend, so show what the server features need and open a sample.
  const badge = $('#server-status');
  badge.textContent = '데모';
  badge.className = 'badge offline';
  $('#library').innerHTML =
    '<p class="muted">이 데모는 브라우저 안에서만 동작합니다. 문서함과 버전 기록은 NestJS 백엔드를 함께 띄우면 켜집니다.</p>';
  $('[data-action="save-server"]').hidden = true;
  void actions.sample();
} else {
  void checkServer();
}
