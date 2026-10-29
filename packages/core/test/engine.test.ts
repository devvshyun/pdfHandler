import { existsSync, readFileSync } from 'node:fs';
import { PDFDocument, degrees } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import {
  applyOperations,
  bytesToBase64,
  chunkPages,
  getPdfInfo,
  isPdf,
  mergePdfs,
  parsePageRanges,
  PdfOperationError,
  splitPdf,
} from '../src';

/** Creates an N-page PDF whose page i is (100 + i) points wide, so pages are identifiable. */
async function makePdf(pages: number, title?: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([100 + i, 200]);
  if (title) doc.setTitle(title);
  return doc.save();
}

async function widths(bytes: Uint8Array): Promise<number[]> {
  const info = await getPdfInfo(bytes);
  return info.pages.map((p) => p.width);
}

// 1x1 transparent PNG
const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('parsePageRanges', () => {
  it('parses lists, ranges and open ranges', () => {
    expect(parsePageRanges('1-3, 5, 8-', 9)).toEqual([0, 1, 2, 4, 7, 8]);
    expect(parsePageRanges('-2', 5)).toEqual([0, 1]);
  });
  it('rejects out-of-range and garbage', () => {
    expect(() => parsePageRanges('0', 3)).toThrow(PdfOperationError);
    expect(() => parsePageRanges('2-9', 3)).toThrow(PdfOperationError);
    expect(() => parsePageRanges('a', 3)).toThrow(PdfOperationError);
    expect(() => parsePageRanges(' ', 3)).toThrow(PdfOperationError);
  });
});

describe('chunkPages', () => {
  it('splits into fixed-size groups', () => {
    expect(chunkPages(5, 2)).toEqual([[0, 1], [2, 3], [4]]);
  });
});

describe('applyOperations', () => {
  it('rotates, normalising the angle', async () => {
    const out = await applyOperations(await makePdf(2), [
      { type: 'rotate', pages: [0], degrees: 270 },
      { type: 'rotate', pages: [0], degrees: 180 },
      { type: 'rotate', pages: [1], degrees: -90 },
    ]);
    const info = await getPdfInfo(out);
    expect(info.pages.map((p) => p.rotation)).toEqual([90, 270]);
  });

  it('deletes pages but refuses to delete all', async () => {
    const src = await makePdf(4);
    expect(await widths(await applyOperations(src, [{ type: 'delete', pages: [3, 1, 1] }]))).toEqual([100, 102]);
    await expect(applyOperations(src, [{ type: 'delete', pages: [0, 1, 2, 3] }])).rejects.toThrow(PdfOperationError);
  });

  it('reorders and keeps the title', async () => {
    const out = await applyOperations(await makePdf(3, 'Doc'), [{ type: 'reorder', order: [2, 0, 1] }]);
    expect(await widths(out)).toEqual([102, 100, 101]);
    expect((await getPdfInfo(out)).title).toBe('Doc');
  });

  it('rejects a reorder that is not a permutation', async () => {
    await expect(applyOperations(await makePdf(3), [{ type: 'reorder', order: [0, 0, 1] }])).rejects.toThrow(
      PdfOperationError,
    );
  });

  it('extracts, duplicates and inserts blank pages', async () => {
    const out = await applyOperations(await makePdf(3), [
      { type: 'extract', pages: [2, 0] },
      { type: 'duplicate', page: 0 },
      { type: 'insertBlank', after: -1, width: 50, height: 50 },
    ]);
    expect(await widths(out)).toEqual([50, 102, 102, 100]);
  });

  it('draws watermark, page numbers, text and image on rotated pages', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 300]).setRotation(degrees(90));
    doc.addPage([200, 300]);
    const out = await applyOperations(await doc.save(), [
      { type: 'watermark', text: 'CONFIDENTIAL' },
      { type: 'pageNumbers', position: 'bottom-right' },
      { type: 'addText', page: 0, x: 10, y: 10, text: 'hello\nworld' },
      { type: 'addImage', page: 1, x: 10, y: 10, width: 20, height: 20, imageBase64: PNG_1PX },
      { type: 'metadata', title: 'T', author: 'A', keywords: ['x', 'y'] },
    ]);
    const info = await getPdfInfo(out);
    expect(info.pageCount).toBe(2);
    expect(info.title).toBe('T');
    expect(info.author).toBe('A');
    expect(out.length).toBeGreaterThan(1000);
  });

  it('gives a clear error for Korean text without a custom font', async () => {
    await expect(applyOperations(await makePdf(1), [{ type: 'watermark', text: '대외비' }])).rejects.toThrow(/폰트/);
  });

  const TTF = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
  it.skipIf(!existsSync(TTF))('draws non-Latin text with a custom font', async () => {
    const out = await applyOperations(await makePdf(1), [{ type: 'watermark', text: 'Привет ünïcödé' }], {
      font: readFileSync(TTF),
    });
    expect((await getPdfInfo(out)).pageCount).toBe(1);
  });

  it('validates page indexes', async () => {
    await expect(applyOperations(await makePdf(1), [{ type: 'rotate', pages: [1], degrees: 90 }])).rejects.toThrow(
      PdfOperationError,
    );
  });

  it('rejects garbage input', async () => {
    await expect(applyOperations(new TextEncoder().encode('not a pdf'), [])).rejects.toThrow(PdfOperationError);
  });
});

describe('merge / split', () => {
  it('merges in order', async () => {
    const out = await mergePdfs([await makePdf(2), await makePdf(1)]);
    expect(await widths(out)).toEqual([100, 101, 100]);
  });

  it('splits into groups', async () => {
    const parts = await splitPdf(await makePdf(5), chunkPages(5, 2));
    expect(parts).toHaveLength(3);
    expect(await widths(parts[2])).toEqual([104]);
  });
});

describe('helpers', () => {
  it('detects PDFs and round-trips base64', async () => {
    const pdf = await makePdf(1);
    expect(isPdf(pdf)).toBe(true);
    expect(isPdf(new TextEncoder().encode('hello world'))).toBe(false);
    expect(bytesToBase64(new Uint8Array([1, 2, 255]))).toBe('AQL/');
  });
});
