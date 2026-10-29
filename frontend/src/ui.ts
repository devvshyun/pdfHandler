// Small DOM helpers: toast, status bar, modal forms, downloads.
export const $ = <T extends HTMLElement = HTMLElement>(selector: string): T => {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`Missing element ${selector}`);
  return el;
};

let toastTimer: number | undefined;
export function toast(message: string, kind: 'info' | 'error' = 'info'): void {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast show ${kind === 'error' ? 'error' : ''}`;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove('show'), kind === 'error' ? 5000 : 2500);
}

export function setStatus(text: string): void {
  $('#status').textContent = text;
}

export async function busy<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  document.body.classList.add('busy');
  setStatus(`${label}...`);
  try {
    const result = await fn();
    setStatus('준비');
    return result;
  } catch (e) {
    console.error(e);
    setStatus('오류');
    toast((e as Error).message, 'error');
    return undefined;
  } finally {
    document.body.classList.remove('busy');
  }
}

export type Field =
  | { name: string; label: string; type: 'text' | 'number' | 'color' | 'email' | 'password'; value?: string | number; placeholder?: string; min?: number; max?: number; step?: number; required?: boolean }
  | { name: string; label: string; type: 'select'; value?: string; options: Array<[string, string]> }
  | { name: string; label: string; type: 'textarea'; value?: string; placeholder?: string };

/** Shows a modal form and resolves with the field values, or null if cancelled. */
export function form(title: string, fields: Field[], hint?: string): Promise<Record<string, string> | null> {
  const dialog = $<HTMLDialogElement>('#dialog');
  const body = $('#dialog-body');
  $('#dialog-title').textContent = title;
  body.replaceChildren();
  if (hint) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = hint;
    body.append(p);
  }
  for (const f of fields) {
    const label = document.createElement('label');
    label.className = 'field';
    const caption = document.createElement('span');
    caption.textContent = f.label;
    let input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    if (f.type === 'select') {
      input = document.createElement('select');
      for (const [value, text] of f.options) input.append(new Option(text, value));
    } else if (f.type === 'textarea') {
      input = document.createElement('textarea');
      input.rows = 3;
      if (f.placeholder) input.placeholder = f.placeholder;
    } else {
      const i = document.createElement('input');
      i.type = f.type;
      if (f.placeholder) i.placeholder = f.placeholder;
      if (f.min !== undefined) i.min = String(f.min);
      if (f.max !== undefined) i.max = String(f.max);
      if (f.step !== undefined) i.step = String(f.step);
      if (f.required) i.required = true;
      input = i;
    }
    input.name = f.name;
    if (f.value !== undefined) input.value = String(f.value);
    label.append(caption, input);
    body.append(label);
  }
  dialog.returnValue = '';
  dialog.showModal();
  (body.querySelector('input, select, textarea') as HTMLElement | null)?.focus();
  return new Promise((resolve) => {
    dialog.addEventListener(
      'close',
      () => {
        if (dialog.returnValue !== 'ok') return resolve(null);
        const values: Record<string, string> = {};
        body.querySelectorAll<HTMLInputElement>('[name]').forEach((el) => (values[el.name] = el.value));
        resolve(values);
      },
      { once: true },
    );
  });
}

/** Yes/no confirmation inside the page (native confirm() is unavailable in sandboxed hosts). */
export async function ask(title: string, message: string): Promise<boolean> {
  return (await form(title, [], message)) !== null;
}

interface DownloadsCapability {
  save(req: { filename: string; data: Blob }): Promise<{ status: 'saved' | 'delivered' }>;
}
type ClaudeHost = { use(name: 'downloads'): Promise<DownloadsCapability | null> };

let downloadsCap: Promise<DownloadsCapability | null> | undefined;
function hostDownloads(): Promise<DownloadsCapability | null> {
  // Inside a claude.ai artifact, plain <a download> links are inert; the host offers a save prompt instead.
  const host = (window as unknown as { claude?: ClaudeHost }).claude;
  downloadsCap ??= host?.use ? host.use('downloads').catch(() => null) : Promise.resolve(null);
  return downloadsCap;
}

export async function downloadBytes(bytes: Uint8Array, filename: string): Promise<boolean> {
  const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/pdf' });
  const downloads = await hostDownloads();
  if (downloads) {
    try {
      await downloads.save({ filename, data: blob });
      return true;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'declined') return false;
      throw new Error(code === 'rate_limited' ? '이미 저장 확인 창이 열려 있습니다. 먼저 처리하세요.' : `저장 실패: ${(e as Error).message ?? code}`);
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return true;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' });
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const n = parseInt(hex.replace('#', ''), 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}
