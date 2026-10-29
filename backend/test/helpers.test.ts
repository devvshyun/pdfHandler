import { describe, expect, it } from 'vitest';
import { contentDisposition, decodeFilename } from '../src/common/upload';
import { loadConfig } from '../src/config/configuration';

describe('upload helpers', () => {
  it('re-decodes UTF-8 filenames that multer read as latin1', () => {
    const latin1 = Buffer.from('한글문서.pdf', 'utf8').toString('latin1');
    expect(decodeFilename(latin1)).toBe('한글문서.pdf');
    expect(decodeFilename('plain.pdf')).toBe('plain.pdf');
  });

  it('builds an RFC 5987 Content-Disposition', () => {
    expect(contentDisposition('보고서 "최종".pdf')).toBe(
      `attachment; filename="___ ____.pdf"; filename*=UTF-8''${encodeURIComponent('보고서 "최종".pdf')}`,
    );
    expect(contentDisposition('a.pdf', true)).toMatch(/^inline;/);
  });
});

describe('loadConfig', () => {
  it('applies defaults and parses env values', () => {
    const cfg = loadConfig({ PORT: '4000', DB_MIGRATE_ON_BOOT: 'false', MAX_UPLOAD_MB: '10' });
    expect(cfg.port).toBe(4000);
    expect(cfg.db.migrateOnBoot).toBe(false);
    expect(cfg.storage.maxUploadBytes).toBe(10 * 1024 * 1024);
    expect(cfg.redis.url).toBe('redis://127.0.0.1:6379');
    expect(cfg.pdfFontPath).toBeUndefined();
  });
});
