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

// ---- access token (see auth.ts) ---------------------------------------------
// localStorage can throw (sandboxed iframes, blocked storage), so every access is guarded and the
// token is also kept in memory for the current page.
const TOKEN_KEY = 'pdfhandler.token';
let memoryToken: string | null | undefined;

export const AUTH_CHANGED = 'pdfhandler:auth-changed';

export function getToken(): string | null {
  if (memoryToken === undefined) {
    try {
      memoryToken = localStorage.getItem(TOKEN_KEY);
    } catch {
      memoryToken = null;
    }
  }
  return memoryToken;
}

export function setToken(token: string | null): void {
  memoryToken = token;
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable: the in-memory token still works until reload */
  }
  window.dispatchEvent(new Event(AUTH_CHANGED));
}

function authFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const token = getToken();
  if (!token) return fetch(url, init);
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  return fetch(url, { ...init, headers }).then((res) => {
    // Expired or revoked token: forget it so the UI offers the login button again.
    if (res.status === 401) setToken(null);
    return res;
  });
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await authFetch(`${BASE}${path}`, init);
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

export interface AuthUser {
  id: string;
  email: string;
}

export interface AuthSession {
  token: string;
  expiresAt: string;
  user: AuthUser;
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const api = {
  /** `authRequired: false` also for older servers without /auth (everything stays usable). */
  async me(): Promise<{ authRequired: boolean; user: AuthUser | null }> {
    const res = await authFetch(`${BASE}/auth/me`);
    if (res.status === 404) return { authRequired: false, user: null };
    if (!res.ok) throw new Error(`로그인 상태 확인 실패: ${res.status}`);
    return res.json();
  },

  login(email: string, password: string): Promise<AuthSession> {
    return request('/auth/login', json({ email, password }));
  },

  register(email: string, password: string): Promise<AuthSession> {
    return request('/auth/register', json({ email, password }));
  },

  deleteVersion(id: string, version: number): Promise<ServerDocumentDetail> {
    return request(`/documents/${id}/versions/${version}`, { method: 'DELETE' });
  },

  purgeVersions(id: string): Promise<ServerDocumentDetail & { deleted: number }> {
    return request(`/documents/${id}/versions/purge`, { method: 'POST' });
  },

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
    const res = await authFetch(`${BASE}/documents/${id}/file${version ? `?version=${version}` : ''}`);
    if (!res.ok) throw new Error(`다운로드 실패: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  },
};
