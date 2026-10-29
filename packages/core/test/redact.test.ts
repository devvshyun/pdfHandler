import fontkit from '@pdf-lib/fontkit';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { degrees, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream, StandardFonts } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { applyOperations, type PdfOperation, type RedactionReport, type ReplaceTextReport } from '../src';

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');

interface Item {
  str: string;
  x: number;
  y: number;
  width: number;
}

/** Text items as pdf.js sees them, in visual coordinates of the page. */
async function textItems(bytes: Uint8Array, pageNo = 1): Promise<Item[]> {
  const doc = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  const page = await doc.getPage(pageNo);
  const content = await page.getTextContent();
  const items = content.items
    .filter((i): i is typeof i & { str: string; transform: number[]; width: number } => 'str' in i && i.str.trim() !== '')
    .map((i) => ({ str: i.str, x: i.transform[4], y: i.transform[5], width: i.width }));
  await doc.destroy();
  return items;
}
const textOf = async (bytes: Uint8Array, pageNo = 1) => (await textItems(bytes, pageNo)).map((i) => i.str).join(' ');

/** Every decoded stream in the saved file, so nothing can hide in an unreferenced object. */
async function allStreamText(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes);
  let out = '';
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    try {
      out += Buffer.from(obj.dict.has(PDFName.of('Filter')) ? decodePDFRawStream(obj).decode() : obj.contents).toString('latin1');
    } catch {
      /* images etc. */
    }
  }
  return out;
}

const hex = (s: string) => Buffer.from(s, 'latin1').toString('hex');

async function redact(bytes: Uint8Array, op: Omit<Extract<PdfOperation, { type: 'redact' }>, 'type'>) {
  const reports: RedactionReport[] = [];
  const out = await applyOperations(bytes, [{ type: 'redact', ...op }], { onRedaction: (r) => reports.push(r) });
  return { out, report: reports[0] };
}

/** One page, 600x400, Helvetica 20pt lines at given baselines (PDF y). */
async function helveticaPage(lines: Array<[string, number]>) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([600, 400]);
  for (const [text, y] of lines) page.drawText(text, { x: 50, y, size: 20, font });
  return { doc, font, bytes: await doc.save() };
}

describe('redact: standard fonts (no /Widths)', () => {
  it('removes only the glyphs in the area and keeps the rest of the line in place', async () => {
    const { font, bytes } = await helveticaPage([
      ['ID: 900101-1234567 END', 300],
      ['Public line', 250],
    ]);
    const before = await textItems(bytes);
    // Area over "1234567": x from the width of the prefix, visual y measured from the top (400 - 300 baseline).
    const x = 50 + font.widthOfTextAtSize('ID: 900101-', 20);
    const width = font.widthOfTextAtSize('1234567', 20);
    const { out, report } = await redact(bytes, { page: 0, areas: [{ x: x + 1, y: 400 - 300 - 15, width: width - 2, height: 18 }] });

    expect(report.removedGlyphs).toBe(7);
    const text = await textOf(out);
    expect(text).toContain('ID: 900101-');
    expect(text).toContain('END');
    expect(text).toContain('Public line');
    expect(text).not.toContain('1234567');

    // "END" must not move: the line still ends exactly where it did.
    const rightEdge = (items: Item[]) => Math.max(...items.filter((i) => i.y === 300).map((i) => i.x + i.width));
    expect(Math.abs(rightEdge(await textItems(out)) - rightEdge(before))).toBeLessThan(0.01);
    const endItem = (await textItems(out)).find((i) => i.str === 'END')!;
    expect(endItem.x + endItem.width).toBeCloseTo(rightEdge(before), 2);

    // Not in any stream of the saved file, in either string notation.
    const raw = await allStreamText(out);
    expect(raw).not.toContain('1234567');
    expect(raw.toLowerCase()).not.toContain(hex('1234567'));
  });

  it('paints the fill box (black by default, none when null)', async () => {
    const { bytes } = await helveticaPage([['Hello', 300]]);
    const area = [{ x: 40, y: 80, width: 100, height: 30 }];
    const black = await redact(bytes, { page: 0, areas: area });
    const none = await redact(bytes, { page: 0, areas: area, fill: null });
    // pdf-lib draws the box as a path (`l` = lineto); text alone never uses one.
    expect(await allStreamText(black.out)).toMatch(/0 0 0 rg[\s\S]*\d l\n/);
    expect(await allStreamText(none.out)).not.toMatch(/\d l\n/);
  });

  it('center mode spares glyphs only grazed by the area', async () => {
    const { font, bytes } = await helveticaPage([['ABCDEF', 300]]);
    const wA = font.widthOfTextAtSize('A', 20);
    const wB = font.widthOfTextAtSize('B', 20);
    // Covers B fully and the right 20% of A.
    const area = [{ x: 50 + wA * 0.8, y: 85, width: wA * 0.2 + wB, height: 20 }];
    expect(await textOf((await redact(bytes, { page: 0, areas: area, mode: 'center', fill: null })).out)).toContain('A');
    expect(await textOf((await redact(bytes, { page: 0, areas: area, mode: 'overlap', fill: null })).out)).not.toMatch(/A/);
  });

  it('does nothing outside the area and still reports', async () => {
    const { bytes } = await helveticaPage([['Keep me', 300]]);
    const { out, report } = await redact(bytes, { page: 0, areas: [{ x: 300, y: 300, width: 50, height: 50 }], fill: null });
    expect(report.removedGlyphs).toBe(0);
    expect(await textOf(out)).toContain('Keep me');
  });

  it('paints coverIfUntouched only when nothing was removed', async () => {
    const { bytes } = await helveticaPage([['Text', 300]]);
    const miss = await redact(bytes, { page: 0, areas: [{ x: 300, y: 300, width: 50, height: 50 }], fill: null, coverIfUntouched: { r: 1, g: 0, b: 0 } });
    expect(await allStreamText(miss.out)).toMatch(/1 0 0 rg[\s\S]*\d l\n/);
    const hit = await redact(bytes, { page: 0, areas: [{ x: 40, y: 80, width: 200, height: 30 }], fill: null, coverIfUntouched: { r: 1, g: 0, b: 0 } });
    expect(await allStreamText(hit.out)).not.toMatch(/\d l\n/);
  });
});

describe('redact: content stream operators', () => {
  /** Builds a page from a raw content stream using a Helvetica font resource /F1. */
  async function rawPage(content: string, rotate = 0) {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([600, 400]);
    if (rotate) page.setRotation(degrees(rotate));
    page.node.setFontDictionary(PDFName.of('F1'), font.ref);
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(content)));
    return { bytes: await doc.save(), font };
  }

  it("handles TJ kerning, ' and \" and literal-string escapes", async () => {
    const { bytes } = await rawPage(
      [
        'BT /F1 20 Tf 14 TL 1 0 0 1 50 300 Tm',
        '[(Kern) -250 (ed SECRET1) 120 (tail)] TJ',
        "(next SECRET2 \\(x\\)) '",
        '2 0.5 (spaced SECRET3 end) "',
        'ET',
      ].join('\n'),
    );
    const items = await textItems(bytes);
    const area = (needle: string) => {
      const it = items.find((i) => i.str.includes(needle))!;
      return { x: 40, y: 400 - it.y - 16, width: 500, height: 20 };
    };
    // Remove each line's SECRET word only: find its x via a second pass with center mode on a narrow box.
    let out = bytes;
    for (const word of ['SECRET1', 'SECRET2', 'SECRET3']) {
      const line = area(word);
      const lineItems = (await textItems(out)).filter((i) => Math.abs(400 - i.y - 16 - line.y) < 1);
      const joined = lineItems.map((i) => i.str).join('');
      expect(joined).toContain(word);
      out = (await redact(out, { page: 0, areas: [line], mode: 'center', fill: null })).out;
    }
    const text = await textOf(out);
    expect(text).not.toMatch(/SECRET/);
    expect(await allStreamText(out)).not.toMatch(/SECRET/);
  });

  it('maps visual areas on rotated pages', async () => {
    const { bytes } = await rawPage('BT /F1 20 Tf 50 300 Td (ROTATED secret) Tj ET', 90);
    // Page rotated 90 clockwise: visual size 400x600; unrotated (x=50..,y=300) appears at visual x = 300 - ..., y = 50...
    const all = { x: 0, y: 0, width: 400, height: 600 };
    const { out, report } = await redact(bytes, { page: 0, areas: [all], fill: null });
    expect(report.removedGlyphs).toBe('ROTATED secret'.length);
    expect(await textOf(out)).toBe('');
    // A visual area in the bottom half (where unrotated x>=300 lands after rotation) leaves the text alone.
    const miss = await redact(bytes, { page: 0, areas: [{ x: 0, y: 300, width: 400, height: 300 }], fill: null });
    expect(miss.report.removedGlyphs).toBe(0);
  });

  it('redacts the pixels of images in the area (pdf-lib PNG: Flate RGB + SMask)', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([600, 400]);
    const png = await doc.embedPng(
      Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'),
    );
    page.drawImage(png, { x: 100, y: 100, width: 100, height: 100 });
    const { report } = await redact(await doc.save(), { page: 0, areas: [{ x: 120, y: 220, width: 20, height: 20 }] });
    expect(report).toMatchObject({ imagesOverlapping: 1, imagesRedacted: 1, imagesUnredacted: 0 });
  });
});

describe('redact: embedded and composite fonts', () => {
  const TTF = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
  it.skipIf(!existsSync(TTF))('removes glyphs from a Type0 / Identity-H font', async () => {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const font = await doc.embedFont(readFileSync(TTF), { subset: true });
    const page = doc.addPage([600, 400]);
    page.drawText('Привет секретный мир', { x: 50, y: 300, size: 20, font });
    const bytes = await doc.save();
    const x = 50 + font.widthOfTextAtSize('Привет ', 20);
    const width = font.widthOfTextAtSize('секретный', 20);
    const { out, report } = await redact(bytes, { page: 0, areas: [{ x, y: 82, width, height: 22 }], mode: 'center', fill: null });
    expect(report.removedGlyphs).toBe('секретный'.length);
    const text = await textOf(out);
    expect(text).toContain('Привет');
    expect(text).toContain('мир');
    expect(text).not.toContain('секрет');
  });
});

describe('redact: form xobjects and annotations', () => {
  it('redacts text drawn through a Form XObject and drops the unredacted original', async () => {
    const src = await PDFDocument.create();
    const f = await src.embedFont(StandardFonts.Helvetica);
    src.addPage([300, 200]).drawText('FORM SECRET', { x: 20, y: 100, size: 20, font: f });
    const doc = await PDFDocument.create();
    const [embedded] = await doc.embedPdf(await src.save());
    doc.addPage([600, 400]).drawPage(embedded, { x: 100, y: 100 });
    const bytes = await doc.save();
    expect(await textOf(bytes)).toContain('FORM SECRET');

    const { out, report } = await redact(bytes, { page: 0, areas: [{ x: 0, y: 0, width: 600, height: 400 }], fill: null });
    expect(report.removedGlyphs).toBe('FORM SECRET'.length);
    expect(await textOf(out)).toBe('');
    expect(await allStreamText(out)).not.toContain('SECRET');
  });

  it('keeps a shared form intact on other pages', async () => {
    const src = await PDFDocument.create();
    const f = await src.embedFont(StandardFonts.Helvetica);
    src.addPage([300, 200]).drawText('SHARED', { x: 20, y: 100, size: 20, font: f });
    const doc = await PDFDocument.create();
    const [embedded] = await doc.embedPdf(await src.save());
    doc.addPage([600, 400]).drawPage(embedded, { x: 100, y: 100 });
    doc.addPage([600, 400]).drawPage(embedded, { x: 100, y: 100 });
    const { out } = await redact(await doc.save(), { page: 0, areas: [{ x: 0, y: 0, width: 600, height: 400 }], fill: null });
    expect(await textOf(out, 1)).toBe('');
    expect(await textOf(out, 2)).toContain('SHARED');
  });

  it('removes overlapping annotations and the field value they carry', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([600, 400]);
    const form = doc.getForm();
    const field = form.createTextField('ssn');
    field.setText('900101-1234567');
    field.addToPage(page, { x: 50, y: 300, width: 200, height: 30 });
    const other = form.createTextField('note');
    other.setText('keep');
    other.addToPage(page, { x: 50, y: 50, width: 200, height: 30 });
    const { out, report } = await redact(await doc.save(), { page: 0, areas: [{ x: 40, y: 60, width: 220, height: 50 }] });
    expect(report.removedAnnotations).toBe(1);
    const reloaded = await PDFDocument.load(out);
    expect(reloaded.getPage(0).node.Annots()?.size()).toBe(1);
    expect(await allStreamText(out)).not.toContain('1234567');
    expect(Buffer.from(out).toString('latin1')).not.toContain('1234567');
  });
});

describe('redact: combined with other operations', () => {
  it('replaces text (redact + addText in one pass) and survives repeated redactions', async () => {
    const { bytes } = await helveticaPage([
      ['Total due: 1,200 USD', 300],
      ['Account 12345', 250],
    ]);
    const out = await applyOperations(bytes, [
      { type: 'redact', page: 0, areas: [{ x: 40, y: 82, width: 400, height: 22 }], mode: 'center', fill: null },
      { type: 'addText', page: 0, x: 50, y: 85, text: 'Total due: 980 USD', fontSize: 20 },
      { type: 'redact', page: 0, areas: [{ x: 40, y: 132, width: 400, height: 22 }], mode: 'center' },
    ]);
    const text = await textOf(out);
    expect(text).toContain('980 USD');
    expect(text).not.toContain('1,200');
    expect(text).not.toContain('12345');
    const raw = await allStreamText(out);
    expect(raw).not.toContain('1,200');
    expect(raw).not.toContain('12345');
  });
});

describe('replaceText', () => {
  const TTF = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
  const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

  async function replace(bytes: Uint8Array, op: Omit<Extract<PdfOperation, { type: 'replaceText' }>, 'type'>) {
    const reports: ReplaceTextReport[] = [];
    const out = await applyOperations(bytes, [{ type: 'replaceText', ...op }], { onReplaceText: (r) => reports.push(r) });
    return { out, report: reports[0] };
  }

  it('reuses the original standard font on the same baseline', async () => {
    const { bytes } = await helveticaPage([['Total due: 1,200 USD', 300]]);
    const { out, report } = await replace(bytes, { page: 0, area: { x: 40, y: 82, width: 300, height: 22 }, text: 'Total due: 980 USD' });
    expect(report).toMatchObject({ reusedFont: true, scale: 1, overflow: false });
    const items = await textItems(out);
    expect(items.map((i) => i.str).join('')).toBe('Total due: 980 USD');
    expect(items.every((i) => Math.abs(i.y - 300) < 0.01)).toBe(true);
    expect(await allStreamText(out)).not.toContain('1,200');
  });

  it.skipIf(!existsSync(TTF))('reuses an embedded subset font when it has the glyphs, else falls back', async () => {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const font = await doc.embedFont(readFileSync(TTF), { subset: true });
    doc.addPage([600, 400]).drawText('Привет секретный мир', { x: 50, y: 300, size: 20, font });
    const bytes = await doc.save();
    const x = 50 + font.widthOfTextAtSize('Привет ', 20);
    const area = { x, y: 82, width: font.widthOfTextAtSize('секретный', 20), height: 22 };

    const same = await replace(bytes, { page: 0, area, text: 'мир' });
    expect(same.report.reusedFont).toBe(true);
    expect(await textOf(same.out)).toMatch(/Привет\s*мир\s*мир/);

    const latin = await replace(bytes, { page: 0, area, text: 'Zebra' });
    expect(latin.report.reusedFont).toBe(false);
    expect(await textOf(latin.out)).toContain('Zebra');
    expect(await textOf(latin.out)).not.toContain('секрет');
  });

  it('narrows text to the available width and flags overflow', async () => {
    const { bytes } = await helveticaPage([['Short', 300]]);
    const area = { x: 40, y: 82, width: 80, height: 22 };
    const fit = await replace(bytes, { page: 0, area, text: 'Shortened', maxWidth: 80 });
    expect(fit.report.scale).toBeLessThan(1);
    expect(fit.report.scale).toBeGreaterThanOrEqual(0.6);
    expect(fit.report.overflow).toBe(false);
    const items = await textItems(fit.out);
    const right = Math.max(...items.map((i) => i.x + i.width));
    expect(right).toBeLessThanOrEqual(40 + 80 + 0.5);

    const over = await replace(bytes, { page: 0, area, text: 'A much much longer replacement', maxWidth: 80 });
    expect(over.report).toMatchObject({ scale: 0.6, overflow: true });
  });

  it('needs a fallback image for scripts the standard font cannot show', async () => {
    const { bytes } = await helveticaPage([['Name: John', 300]]);
    const area = { x: 40, y: 82, width: 200, height: 22 };
    await expect(replace(bytes, { page: 0, area, text: '이름: 홍길동' })).rejects.toThrow(/fallbackImage/);
    const ok = await replace(bytes, { page: 0, area, text: '이름: 홍길동', fallbackImage: { imageBase64: PNG_1PX, width: 90, height: 20 } });
    expect(ok.report.reusedFont).toBe(false);
    expect(await textOf(ok.out)).not.toContain('John');
  });

  it('covers the area when no original glyph is found', async () => {
    const { bytes } = await helveticaPage([['Text', 300]]);
    const { out, report } = await replace(bytes, { page: 0, area: { x: 300, y: 300, width: 50, height: 20 }, text: 'New', coverColor: { r: 1, g: 1, b: 0 } });
    expect(report.removedGlyphs).toBe(0);
    expect(await allStreamText(out)).toMatch(/1 1 0 rg[\s\S]*\d l\n/);
    expect(await textOf(out)).toContain('New');
  });
});

describe('redact: validation', () => {
  it('rejects empty and malformed areas', async () => {
    const { bytes } = await helveticaPage([['x', 300]]);
    await expect(redact(bytes, { page: 0, areas: [] })).rejects.toThrow();
    await expect(redact(bytes, { page: 0, areas: [{ x: 0, y: 0, width: -1, height: 5 }] })).rejects.toThrow();
  });
});

