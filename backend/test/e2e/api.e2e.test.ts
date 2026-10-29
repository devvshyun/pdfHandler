/**
 * API end-to-end tests: the compiled server against real MySQL + Redis.
 * Configure with E2E_DB_HOST/PORT/USER/PASSWORD/NAME (default database `pdfhandler_test`, which
 * this suite wipes) and E2E_REDIS_URL. Skipped, with the reason printed, when either is unreachable.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureBuilt, prepareDatabase, startServer, TestServer } from './harness';

const skipReason = await prepareDatabase();
if (skipReason && process.env.E2E_REQUIRED === '1') throw new Error(`[e2e] required but unavailable: ${skipReason}`);
if (skipReason) console.warn(`\n[e2e] SKIPPED: ${skipReason}\n`);

async function makePdf(pages: number, linesPerPage = 2): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) {
    const page = doc.addPage([595, 842]);
    for (let l = 0; l < linesPerPage; l++) page.drawText(`Page ${i} line ${l} secret text 0123456789`, { x: 40, y: 800 - l * 17, size: 10, font });
  }
  return doc.save();
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function client(base: string) {
  const call = async (method: string, path: string, opts: { token?: string; json?: unknown; form?: FormData; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { ...opts.headers };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    let body: BodyInit | undefined;
    if (opts.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.json);
    } else if (opts.form) body = opts.form;
    const res = await fetch(`${base}${path}`, { method, headers, body });
    const type = res.headers.get('content-type') ?? '';
    const data: Json = type.includes('json') ? await res.json() : { bytes: new Uint8Array(await res.arrayBuffer()) };
    return { status: res.status, headers: res.headers, body: data };
  };
  return {
    call,
    register: async (email: string, password = 'password123') => (await call('POST', '/auth/register', { json: { email, password } })).body.token as string,
    upload: (token: string | undefined, bytes: Uint8Array, name = 'doc.pdf') => {
      const form = new FormData();
      form.append('file', new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/pdf' }), name);
      return call('POST', '/documents', { token, form });
    },
  };
}

const pdfForm = (field: string, files: Array<[Uint8Array, string]>) => {
  const form = new FormData();
  for (const [bytes, name] of files) form.append(field, new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/pdf' }), name);
  return form;
};

describe.skipIf(!!skipReason)('API e2e', () => {
  let main: TestServer; // AUTH_REQUIRED (default), 2 worker threads, small upload limits
  let open: TestServer; // AUTH_REQUIRED=false, in-process PDF work, tight tools rate limit
  let tight: TestServer; // 1 worker, no queue, short timeout
  let api: ReturnType<typeof client>;
  let small: Uint8Array;
  const stamp = Date.now();

  beforeAll(async () => {
    ensureBuilt();
    small = await makePdf(3);
    // main and open share a Redis namespace like two instances of one deployment would.
    const sharedPrefix = `e2e:${stamp}:`;
    main = await startServer({
      REDIS_KEY_PREFIX: sharedPrefix,
      PDF_WORKERS: '2',
      PDF_QUEUE_MAX: '4',
      MAX_UPLOAD_MB: '1',
      MAX_MERGE_FILES: '3',
      MAX_REQUEST_MB: '2',
      RATE_LIMIT_LOGIN: '3/900',
      RATE_LIMIT_AUTH: '100/60',
      RATE_LIMIT_TOOLS: '0',
    });
    // Second instance on the same database (migrations already applied by `main`).
    [open, tight] = await Promise.all([
      startServer({ REDIS_KEY_PREFIX: sharedPrefix, AUTH_REQUIRED: 'false', PDF_WORKERS: '0', RATE_LIMIT_TOOLS: '3/60' }),
      startServer({ PDF_WORKERS: '1', PDF_QUEUE_MAX: '0', PDF_TASK_TIMEOUT_MS: '400', RATE_LIMIT_TOOLS: '0' }),
    ]);
    api = client(main.base);
  }, 180_000);

  afterAll(async () => {
    await Promise.all([main, open, tight].filter(Boolean).map((s) => s.stop()));
  });

  describe('auth', () => {
    it('registers, rejects duplicates and bad input, logs in and reports /me', async () => {
      const email = `alice${stamp}@example.com`;
      const reg = await api.call('POST', '/auth/register', { json: { email: email.toUpperCase(), password: 'password123' } });
      expect(reg.status).toBe(201);
      expect(reg.body.user.email).toBe(email);
      expect(reg.body.token.split('.')).toHaveLength(3);
      expect(reg.body).not.toHaveProperty('user.passwordHash');

      expect((await api.call('POST', '/auth/register', { json: { email, password: 'password123' } })).status).toBe(409);
      expect((await api.call('POST', '/auth/register', { json: { email: 'not-an-email', password: 'password123' } })).status).toBe(400);
      expect((await api.call('POST', '/auth/register', { json: { email: `x${stamp}@example.com`, password: 'short' } })).status).toBe(400);

      const login = await api.call('POST', '/auth/login', { json: { email, password: 'password123' } });
      expect(login.status).toBe(200);
      const me = await api.call('GET', '/auth/me', { token: login.body.token });
      expect(me.body).toMatchObject({ authRequired: true, user: { email } });
      expect((await api.call('GET', '/auth/me')).body).toEqual({ authRequired: true, user: null });
      expect((await api.call('GET', '/auth/me', { token: 'a.b.c' })).body.user).toBeNull();
    });

    it('requires a valid token for /documents', async () => {
      expect((await api.call('GET', '/documents')).status).toBe(401);
      expect((await api.call('GET', '/documents', { token: 'garbage' })).status).toBe(401);
      expect((await api.upload(undefined, small)).status).toBe(401);
    });

    it('locks an account after repeated failed logins (per e-mail, across IPs)', async () => {
      const email = `brute${stamp}@example.com`;
      await api.register(email);
      for (let i = 0; i < 3; i++) {
        expect((await api.call('POST', '/auth/login', { json: { email, password: `wrong-pass-${i}` } })).status).toBe(401);
      }
      const blocked = await api.call('POST', '/auth/login', { json: { email, password: 'password123' } });
      expect(blocked.status).toBe(429);
      expect(blocked.body.message).toMatch(/요청이 너무 많습니다/);
    });
  });

  describe('ownership isolation', () => {
    let alice: string;
    let bob: string;
    let docId: string;

    beforeAll(async () => {
      alice = await api.register(`owner-a${stamp}@example.com`);
      bob = await api.register(`owner-b${stamp}@example.com`);
      const up = await api.upload(alice, small, 'alice.pdf');
      expect(up.status).toBe(201);
      docId = up.body.id;
    });

    it('hides other users documents behind 404 on every route', async () => {
      // Warm Alice's caches first: Bob must not be served from them.
      expect((await api.call('GET', '/documents', { token: alice })).body.total).toBe(1);
      expect((await api.call('GET', `/documents/${docId}`, { token: alice })).status).toBe(200);

      const list = await api.call('GET', '/documents', { token: bob });
      expect(list.body).toMatchObject({ items: [], total: 0 });
      for (const [method, path, json] of [
        ['GET', `/documents/${docId}`],
        ['GET', `/documents/${docId}/file`],
        ['GET', `/documents/${docId}/file?version=1`],
        ['PATCH', `/documents/${docId}`, { title: 'pwned' }],
        ['POST', `/documents/${docId}/operations`, { operations: [{ type: 'rotate', pages: [0], degrees: 90 }] }],
        ['POST', `/documents/${docId}/versions/1/revert`],
        ['DELETE', `/documents/${docId}/versions/1`],
        ['POST', `/documents/${docId}/versions/purge`],
        ['DELETE', `/documents/${docId}`],
      ] as Array<[string, string, unknown?]>) {
        const res = await api.call(method, path, { token: bob, json });
        expect(res.status, `${method} ${path}`).toBe(404);
        expect(res.body.message).toBe('문서를 찾을 수 없습니다.');
      }
      const random = await api.call('GET', '/documents/00000000-0000-4000-8000-000000000000', { token: bob });
      expect(random.body).toEqual((await api.call('GET', `/documents/${docId}`, { token: bob })).body);

      const mine = await api.call('GET', `/documents/${docId}`, { token: alice });
      expect(mine.body).toMatchObject({ title: 'alice', currentVersion: 1 });
      const file = await api.call('GET', `/documents/${docId}/file`, { token: alice });
      expect(file.status).toBe(200);
      expect(file.headers.get('cache-control')).toMatch(/private/);
    });

    it('keeps list caches per user after writes', async () => {
      const bobsDoc = await api.upload(bob, small, 'bob.pdf');
      expect(bobsDoc.status).toBe(201);
      const aliceList = await api.call('GET', '/documents', { token: alice });
      expect(aliceList.body.items.map((d: Json) => d.id)).toEqual([docId]);
      const bobList = await api.call('GET', '/documents', { token: bob });
      expect(bobList.body.items.map((d: Json) => d.id)).toEqual([bobsDoc.body.id]);
    });

    it('single-tenant mode (AUTH_REQUIRED=false) sees everything; its ownerless docs stay invisible to users', async () => {
      const o = client(open.base);
      expect((await o.call('GET', '/auth/me')).body).toEqual({ authRequired: false, user: null });
      const legacy = await o.upload(undefined, small, 'legacy.pdf');
      expect(legacy.status).toBe(201);
      const all = await o.call('GET', '/documents?limit=100');
      const ids = all.body.items.map((d: Json) => d.id);
      expect(ids).toContain(docId);
      expect(ids).toContain(legacy.body.id);

      expect((await api.call('GET', `/documents/${legacy.body.id}`, { token: alice })).status).toBe(404);
      const aliceIds = (await api.call('GET', '/documents', { token: alice })).body.items.map((d: Json) => d.id);
      expect(aliceIds).not.toContain(legacy.body.id);

      // A rename in single-tenant mode must invalidate the owner's cached detail too.
      await o.call('PATCH', `/documents/${docId}`, { json: { title: 'renamed by admin' } });
      expect((await api.call('GET', `/documents/${docId}`, { token: alice })).body.title).toBe('renamed by admin');
    });
  });

  describe('versions', () => {
    let token: string;
    let id: string;

    beforeAll(async () => {
      token = await api.register(`versions${stamp}@example.com`);
      id = (await api.upload(token, small)).body.id;
      for (let i = 0; i < 2; i++) {
        const res = await api.call('POST', `/documents/${id}/operations`, { token, json: { operations: [{ type: 'rotate', pages: [0], degrees: 90 }] } });
        expect(res.status).toBe(201);
      }
    });

    it('deletes a single old version and its file, never the current one', async () => {
      const current = await api.call('DELETE', `/documents/${id}/versions/3`, { token });
      expect(current.status).toBe(400);
      expect(current.body.message).toMatch(/현재 버전은 삭제할 수 없습니다/);
      expect((await api.call('DELETE', `/documents/${id}/versions/9`, { token })).status).toBe(404);

      expect(existsSync(join(main.storageDir, id, 'v1.pdf'))).toBe(true);
      const res = await api.call('DELETE', `/documents/${id}/versions/1`, { token });
      expect(res.status).toBe(200);
      expect(res.body.versions.map((v: Json) => v.version)).toEqual([3, 2]);
      expect(existsSync(join(main.storageDir, id, 'v1.pdf'))).toBe(false);
      expect((await api.call('GET', `/documents/${id}/file?version=1`, { token })).status).toBe(404);
      expect((await api.call('POST', `/documents/${id}/versions/1/revert`, { token })).status).toBe(404);
    });

    it('purges all but the current version and keeps numbering', async () => {
      const res = await api.call('POST', `/documents/${id}/versions/purge`, { token });
      expect(res.status).toBe(200);
      expect(res.body.deleted).toBe(1);
      expect(res.body.versions.map((v: Json) => v.version)).toEqual([3]);
      expect(readdirSync(join(main.storageDir, id))).toEqual(['v3.pdf']);
      const next = await api.call('POST', `/documents/${id}/operations`, { token, json: { operations: [{ type: 'rotate', pages: [0], degrees: 90 }] } });
      expect(next.body.currentVersion).toBe(4);
      expect((await api.call('POST', `/documents/${id}/versions/purge`, { token })).body.versions.map((v: Json) => v.version)).toEqual([4]);
    });
  });

  describe('upload validation and limits', () => {
    let token: string;
    beforeAll(async () => {
      token = await api.register(`uploads${stamp}@example.com`);
    });

    it('rejects missing files and non-PDF content', async () => {
      const empty = await api.call('POST', '/documents', { token, form: new FormData() });
      expect(empty.status).toBe(400);
      const text = new TextEncoder().encode('just some text, definitely not a pdf');
      const notPdf = await api.upload(token, text, 'fake.pdf');
      expect(notPdf.status).toBe(400);
      expect(notPdf.body.message).toMatch(/PDF 파일이 아닙니다/);
    });

    it('enforces per-file, file-count and total request limits (413)', async () => {
      const big = new Uint8Array(1.5 * 1024 * 1024);
      big.set(new TextEncoder().encode('%PDF-1.7\n'));
      const tooBig = await api.upload(token, big, 'big.pdf');
      expect(tooBig.status).toBe(413);
      expect(tooBig.body.message).toMatch(/1MB/);

      const many = await api.call('POST', '/tools/merge', { form: pdfForm('files', [[small, 'a.pdf'], [small, 'b.pdf'], [small, 'c.pdf'], [small, 'd.pdf']]) });
      expect(many.status).toBe(413);
      expect(many.body.message).toMatch(/3개까지/);

      const chunk = new Uint8Array(0.9 * 1024 * 1024);
      chunk.set(new TextEncoder().encode('%PDF-1.7\n'));
      const total = await api.call('POST', '/tools/merge', { form: pdfForm('files', [[chunk, 'a.pdf'], [chunk, 'b.pdf'], [chunk, 'c.pdf']]) });
      expect(total.status).toBe(413);
      expect(total.body.message).toMatch(/요청 전체 크기/);
    });

    it('maps bad operation payloads and engine errors to 400', async () => {
      const id = (await api.upload(token, small)).body.id;
      const op = (operations: unknown) => api.call('POST', `/documents/${id}/operations`, { token, json: { operations } });
      const badImage = await op([{ type: 'addImage', page: 0, x: 0, y: 0, width: 10, height: 10, imageBase64: 'not*base64' }]);
      expect(badImage.status).toBe(400);
      expect(badImage.body.message).toMatch(/operations\[0\]\.imageBase64/);
      expect((await op([{ type: 'addText', page: 0, x: '1', y: 2, text: 'x' }])).status).toBe(400);
      expect((await op([{ type: 'nope' }])).status).toBe(400);
      const range = await op([{ type: 'rotate', pages: [99], degrees: 90 }]);
      expect(range.status).toBe(400);
      expect(range.body.error).toBe('PdfOperationError');
      const toolBad = await api.call('POST', '/tools/apply', { form: (() => {
        const f = pdfForm('file', [[small, 'x.pdf']]);
        f.append('operations', JSON.stringify([{ type: 'watermark', text: 'x', opacity: 5 }]));
        return f;
      })() });
      expect(toolBad.status).toBe(400);
      expect((await api.call('GET', `/documents/${id}`, { token })).body.currentVersion).toBe(1);
    });

    it('removes temporary upload files after every request', async () => {
      const merged = await api.call('POST', '/tools/merge', { form: pdfForm('files', [[small, 'a.pdf'], [small, 'b.pdf']]) });
      expect(merged.status).toBe(201);
      expect(merged.body.bytes.length).toBeGreaterThan(500);
      await new Promise((r) => setTimeout(r, 200));
      expect(readdirSync(main.uploadsDir)).toEqual([]);
    });
  });

  describe('rate limiting', () => {
    it('limits anonymous tool use per IP with 429 + Retry-After', async () => {
      const o = client(open.base);
      const info = () => o.call('POST', '/tools/info', { form: pdfForm('file', [[small, 'a.pdf']]) });
      for (let i = 0; i < 3; i++) {
        const ok = await info();
        expect(ok.status).toBe(201);
        expect(ok.body.pageCount).toBe(3);
        expect(ok.headers.get('x-ratelimit-remaining')).toBe(String(2 - i));
      }
      const limited = await info();
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(limited.body.message).toMatch(/요청이 너무 많습니다/);
      // /health is never limited.
      expect((await o.call('GET', '/health')).status).toBe(200);
    });
  });

  describe('worker pool', () => {
    let heavy: Uint8Array;
    const heavyOps = (pages: number) => [
      { type: 'watermark', text: 'CONFIDENTIAL' },
      { type: 'pageNumbers' },
      ...Array.from({ length: pages }, (_, i) => ({ type: 'redact', page: i, areas: [{ x: 30, y: 30, width: 400, height: 200 }] })),
    ];

    beforeAll(async () => {
      heavy = await makePdf(300, 40);
    });

    it('runs heavy operations off the event loop (health stays responsive)', async () => {
      expect((await api.call('GET', '/health')).body.workers).toMatchObject({ threads: 2 });
      const token = await api.register(`heavy${stamp}@example.com`);
      const id = (await api.upload(token, heavy)).body.id;
      const latencies: number[] = [];
      let done = false;
      const poll = (async () => {
        while (!done) {
          const t = performance.now();
          await fetch(`${main.base}/health`);
          latencies.push(performance.now() - t);
          await new Promise((r) => setTimeout(r, 20));
        }
      })();
      const t0 = performance.now();
      const res = await api.call('POST', `/documents/${id}/operations`, { token, json: { operations: heavyOps(300) } });
      const opMs = performance.now() - t0;
      done = true;
      await poll;
      expect(res.status).toBe(201);
      expect(res.body.currentVersion).toBe(2);
      const max = Math.max(...latencies);
      console.log(`[e2e] 300-page operation took ${Math.round(opMs)} ms; /health max ${max.toFixed(1)} ms over ${latencies.length} samples`);
      // In-process this blocks /health for the whole operation; with workers it stays far below it.
      expect(max).toBeLessThan(Math.max(250, opMs / 3));
    }, 60_000);

    it('answers 503 when the queue is full or a task times out, then recovers', async () => {
      const t = client(tight.base);
      const apply = () => {
        const f = pdfForm('file', [[heavy, 'heavy.pdf']]);
        f.append('operations', JSON.stringify(heavyOps(300)));
        return t.call('POST', '/tools/apply', { form: f });
      };
      const [a, b] = await Promise.all([apply(), apply()]);
      const messages = [a, b].map((r) => r.body.message as string);
      expect([a.status, b.status]).toEqual([503, 503]);
      expect(messages.some((m) => /바쁩니다/.test(m))).toBe(true);
      expect(messages.some((m) => /안에 끝나지 않아 중단했습니다/.test(m))).toBe(true);
      // The timed-out worker was replaced: a small task works again.
      const info = await t.call('POST', '/tools/info', { form: pdfForm('file', [[small, 'a.pdf']]) });
      expect(info.status).toBe(201);
      expect(info.body.pageCount).toBe(3);
    }, 60_000);
  });
});
