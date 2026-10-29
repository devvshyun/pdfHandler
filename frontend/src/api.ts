// Client for the NestJS backend. Every call is optional: the editor works fully offline.
const BASE = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, '') ?? './api';

export interface ServerDocument {
  id: string;
  title: string;
  originalName: string;
  currentVersion: number;
  pageCount: number;
  size: number;
  createdAt: string;
  updatedAt: string;
}

export interface ServerVersion {
  version: number;
  source: 'upload' | 'client_edit' | 'server_operations';
  size: number;
  pageCount: number;
  sha256: string;
  note?: string;
  createdAt: string;
}

export interface ServerDocumentDetail extends ServerDocument {
  versions: ServerVersion[];
}

export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init);
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      message = Array.isArray(body.message) ? body.message.join(', ') : (body.message ?? message);
    } catch {
      /* not JSON */
    }
    throw new Error(message);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

function pdfForm(bytes: Uint8Array, filename: string, extra: Record<string, string> = {}): FormData {
  const form = new FormData();
  form.append('file', new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/pdf' }), filename);
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  return form;
}

export const api = {
  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return false;
      const body = await res.json();
      return body.db === true;
    } catch {
      return false;
    }
  },

  list(q = '', page = 1, limit = 30): Promise<PageResult<ServerDocument>> {
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (q) params.set('q', q);
    return request(`/documents?${params}`);
  },

  get(id: string): Promise<ServerDocumentDetail> {
    return request(`/documents/${id}`);
  },

  upload(bytes: Uint8Array, filename: string, title?: string): Promise<ServerDocumentDetail> {
    return request('/documents', { method: 'POST', body: pdfForm(bytes, filename, title ? { title } : {}) });
  },

  addVersion(id: string, bytes: Uint8Array, note?: string): Promise<ServerDocumentDetail> {
    return request(`/documents/${id}/versions`, {
      method: 'POST',
      body: pdfForm(bytes, 'edit.pdf', note ? { note } : {}),
    });
  },

  revert(id: string, version: number): Promise<ServerDocumentDetail> {
    return request(`/documents/${id}/versions/${version}/revert`, { method: 'POST' });
  },

  remove(id: string): Promise<void> {
    return request(`/documents/${id}`, { method: 'DELETE' });
  },

  async download(id: string, version?: number): Promise<Uint8Array> {
    const res = await fetch(`${BASE}/documents/${id}/file${version ? `?version=${version}` : ''}`);
    if (!res.ok) throw new Error(`다운로드 실패: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  },
};
