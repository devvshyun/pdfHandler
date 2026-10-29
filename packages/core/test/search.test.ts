import fontkit from '@pdf-lib/fontkit';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { degrees, PDFDocument, PDFFont, PDFName, StandardFonts } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import {
  applyOperations,
  findInTextMap,
  findText,
  getTextMap,
  redactOpsForMatches,
  TEXT_PATTERNS,
  type PageTextMap,
  type RedactionReport,
  type TextMatch,
} from '../src';

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');

const TTF = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';

/** Page text as pdf.js extracts it, whitespace removed. */
async function pdfjsText(bytes: Uint8Array, pageNo = 1): Promise<string> {
  const doc = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  const content = await (await doc.getPage(pageNo)).getTextContent();
  await doc.destroy();
  return content.items.map((i) => ('str' in i ? i.str : '')).join('').replace(/\s+/g, '');
}

/** Redacts all matches and returns the result plus what was removed. */
async function redactAll(bytes: Uint8Array, matches: TextMatch[]) {
  const reports: RedactionReport[] = [];
  const out = await applyOperations(bytes, redactOpsForMatches(matches, { fill: null }), { onRedaction: (r) => reports.push(r) });
  return { out, removed: reports.reduce((n, r) => n + r.removedGlyphs, 0) };
}

/** Width as drawn (drawText applies no kerning; pdf-lib's widthOfTextAtSize does). */
const plainWidth = (font: PDFFont, text: string, size: number) => [...text].reduce((w, ch) => w + font.widthOfTextAtSize(ch, size), 0);

async function rawPage(content: string, opts: { rotate?: number; size?: [number, number] } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage(opts.size ?? [600, 400]);
  if (opts.rotate) page.setRotation(degrees(opts.rotate));
  page.node.setFontDictionary(PDFName.of('F1'), font.ref);
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(content)));
  return { bytes: await doc.save(), font, doc };
}

describe('text map', () => {
  it('reads standard-font text with exact glyph boxes in visual coordinates', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([600, 400]);
    page.drawText('ID: 900101-1234567 END', { x: 50, y: 300, size: 20, font });
    page.drawText('Second line', { x: 50, y: 250, size: 20, font });
    const map = await getTextMap(await doc.save(), 0);
    expect(map.text).toBe('ID: 900101-1234567 END\nSecond line');
    expect(map.lines).toHaveLength(2);
    expect(map.unknownGlyphs).toBe(0);
    const nine = map.glyphs[map.charToGlyph[map.text.indexOf('9')]];
    expect(nine.x).toBeCloseTo(50 + plainWidth(font, 'ID: ', 20), 3);
    expect(nine.width).toBeCloseTo(font.widthOfTextAtSize('9', 20), 3);
    // Baseline at 300 (from the bottom) → visual top = 400 - 300 - ascent.
    expect(nine.y + nine.height).toBeGreaterThan(100);
    expect(nine.y).toBeLessThan(100);
    expect(nine.fontSize).toBeCloseTo(20);
  });

  it('inserts virtual spaces for gaps, keeps kerning together, and breaks lines', async () => {
    const { bytes } = await rawPage(
      [
        'BT /F1 20 Tf 1 0 0 1 50 300 Tm',
        '[(W) 80 (orld) -2000 (Wide)] TJ',
        '0 -30 Td (Next) Tj',
        '200 0 Td (Column) Tj',
        'ET',
      ].join('\n'),
    );
    const map = await getTextMap(bytes, 0);
    expect(map.text).toBe('World Wide\nNext Column');
    // Virtual characters map to no glyph.
    expect(map.charToGlyph[map.text.indexOf(' ')]).toBe(-1);
    expect(map.glyphs.map((g) => g.text).join('')).toBe('WorldWideNextColumn');
  });

  it('decodes Type0 / Identity-H fonts through ToUnicode', async () => {
    if (!existsSync(TTF)) return;
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const font = await doc.embedFont(readFileSync(TTF), { subset: true });
    doc.addPage([600, 400]).drawText('Привет секретный мир Ωmega', { x: 50, y: 300, size: 20, font });
    const bytes = await doc.save();
    const map = await getTextMap(bytes, 0);
    expect(map.text).toBe('Привет секретный мир Ωmega');
    const [m] = await findText(bytes, 'СЕКРЕТНЫЙ');
    expect(m.text).toBe('секретный');
    expect(m.boxes[0].x).toBeCloseTo(50 + font.widthOfTextAtSize('Привет ', 20), 2);
    expect(m.boxes[0].width).toBeCloseTo(font.widthOfTextAtSize('секретный', 20), 2);
    const { out, removed } = await redactAll(bytes, [m]);
    expect(removed).toBe(9);
    expect(await pdfjsText(out)).toBe('ПриветмирΩmega');
  });

  it('decodes /Differences glyph names (uniXXXX, ligatures)', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([600, 400]);
    const font = doc.context.obj({
      Type: 'Font',
      Subtype: 'Type1',
      BaseFont: 'Helvetica',
      Encoding: { Type: 'Encoding', BaseEncoding: 'WinAnsiEncoding', Differences: [1, 'uni00C5', 'f_i', 'g7'] },
    });
    page.node.setFontDictionary(PDFName.of('F1'), doc.context.register(font));
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream('BT /F1 20 Tf 50 300 Td <0102414203> Tj ET')));
    const map = await getTextMap(await doc.save(), 0);
    expect(map.text).toBe('ÅfiAB�');
    expect(map.unknownGlyphs).toBe(1);
    expect(map.glyphs[4].unknown).toBe(true);
  });

  it('maps boxes on rotated pages so redaction removes exactly the match', async () => {
    for (const rotate of [90, 180, 270]) {
      const { bytes } = await rawPage(
        ['BT /F1 20 Tf 50 300 Td (keep SECRET keep) Tj ET', 'BT /F1 20 Tf 50 270 Td (below SECRET line) Tj ET'].join('\n'),
        { rotate },
      );
      const map = await getTextMap(bytes, 0);
      expect(map.width).toBe(rotate === 180 ? 600 : 400);
      const matches = await findText(bytes, 'secret');
      expect(matches).toHaveLength(2);
      for (const b of matches.flatMap((m) => m.boxes)) {
        expect(b.x).toBeGreaterThanOrEqual(0);
        expect(b.y).toBeGreaterThanOrEqual(0);
        expect(b.x + b.width).toBeLessThanOrEqual(map.width);
        expect(b.y + b.height).toBeLessThanOrEqual(map.height);
      }
      const { out, removed } = await redactAll(bytes, matches);
      expect(removed).toBe(12);
      expect(await pdfjsText(out)).toBe('keepkeepbelowline');
    }
  });

  it('reads text inside Form XObjects with the form matrix applied', async () => {
    const src = await PDFDocument.create();
    const f = await src.embedFont(StandardFonts.Helvetica);
    src.addPage([300, 200]).drawText('FORM 010-1234-5678 X', { x: 20, y: 100, size: 20, font: f });
    const doc = await PDFDocument.create();
    const [embedded] = await doc.embedPdf(await src.save());
    doc.addPage([600, 400]).drawPage(embedded, { x: 100, y: 100 });
    const bytes = await doc.save();
    const map = await getTextMap(bytes, 0);
    expect(map.text).toBe('FORM 010-1234-5678 X');
    expect(map.glyphs[0].x).toBeCloseTo(120, 1);
    const matches = await findText(bytes, TEXT_PATTERNS.find((p) => p.id === 'phone')!);
    expect(matches.map((m) => m.text)).toEqual(['010-1234-5678']);
    const { out } = await redactAll(bytes, matches);
    expect(await pdfjsText(out)).toBe('FORMX');
  });

  it('keeps fake-bold double drawing out of the text but inside the match', async () => {
    const { bytes } = await rawPage('BT /F1 20 Tf 50 300 Td (Bold) Tj ET BT /F1 20 Tf 50.4 300 Td (Bold) Tj ET');
    const map = await getTextMap(bytes, 0);
    expect(map.text).toBe('Bold');
    expect(map.glyphs.filter((g) => g.duplicate)).toHaveLength(4);
    const [m] = await findText(bytes, 'bold');
    expect(m.glyphs).toHaveLength(8);
    const { out, removed } = await redactAll(bytes, [m]);
    expect(removed).toBe(8);
    expect(await pdfjsText(out)).toBe('');
  });
});

describe('findText', () => {
  it('is case-insensitive by default, normalises whitespace and spans lines', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([600, 400]);
    page.drawText('Hello   world, and the end of a', { x: 50, y: 300, size: 12, font });
    page.drawText('sentence here. HELLO WORLD', { x: 50, y: 285, size: 12, font });
    const bytes = await doc.save();
    expect((await findText(bytes, 'hello world')).map((m) => m.text)).toEqual(['Hello   world', 'HELLO WORLD']);
    expect(await findText(bytes, 'hello world', { caseSensitive: true })).toHaveLength(0);
    const [span] = await findText(bytes, 'of a sentence');
    expect(span.text).toBe('of a\nsentence');
    expect(span.boxes).toHaveLength(2);
    expect(await findText(bytes, /h\w+o/gi)).toHaveLength(2);
    expect(await findText(bytes, '   ')).toHaveLength(0);
  });

  it('gives the room to the next glyph as maxWidth and context around the match', async () => {
    const { bytes, font } = await rawPage('BT /F1 10 Tf 50 300 Td (Name: Kim) Tj 200 0 Td (Next) Tj ET');
    const [m] = await findText(bytes, 'Kim');
    expect(m.before).toBe('Name: ');
    expect(m.after).toBe(' Next');
    const start = 50 + plainWidth(font, 'Name: ', 10);
    expect(m.maxWidth).toBeCloseTo(250 - 3 - start, 1);
    // Nothing follows: up to the right margin mirroring the left one.
    const [last] = await findText(bytes, 'Next');
    expect(last.maxWidth).toBeCloseTo(600 - 50 - 250, 1);
  });

  it('redacts a match without touching tightly spaced lines above and below', async () => {
    const { bytes } = await rawPage(
      ['BT /F1 12 Tf 11 TL 50 300 Td (ABCDEFGH) Tj T* (abc SECRET def) Tj T* (IJKLMNOP) Tj ET'].join('\n'),
    );
    const matches = await findText(bytes, 'secret');
    const { out, removed } = await redactAll(bytes, matches);
    expect(removed).toBe(6);
    expect(await pdfjsText(out)).toBe('ABCDEFGHabcdefIJKLMNOP');
    expect(redactOpsForMatches(matches)[0]).toMatchObject({ type: 'redact', page: 0, mode: 'center' });
  });

  it('limits pages and the number of matches', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < 3; i++) doc.addPage([300, 200]).drawText('abc abc', { x: 20, y: 100, size: 12, font });
    const bytes = await doc.save();
    expect(await findText(bytes, 'abc')).toHaveLength(6);
    expect((await findText(bytes, 'abc', { pages: [1] })).every((m) => m.page === 1)).toBe(true);
    expect(await findText(bytes, 'abc', { limit: 4 })).toHaveLength(4);
  });
});

/** A one-line text map with one glyph per character, for pattern tests. */
function fakeMap(text: string): PageTextMap {
  const glyphs = [...text].map((ch, i) => ({ text: ch, x: i * 6, y: 0, width: 6, height: 12, line: 0, fontSize: 10 }));
  return {
    page: 0,
    width: 600,
    height: 400,
    glyphs,
    lines: [{ x: 0, y: 0, width: text.length * 6, height: 12, start: 0, end: glyphs.length }],
    text,
    charToGlyph: Int32Array.from([...text].map((_, i) => i)),
    unknownGlyphs: 0,
  };
}

const pattern = (id: string) => TEXT_PATTERNS.find((p) => p.id === id)!;
const find = (id: string, text: string) => findInTextMap(fakeMap(text), pattern(id)).map((m) => m.text);

describe('built-in patterns', () => {
  it('has Korean labels for every pattern', () => {
    expect(TEXT_PATTERNS.map((p) => p.label)).toEqual(['주민등록번호', '전화번호', '카드번호', '계좌번호', '이메일']);
  });

  it('주민등록번호', () => {
    expect(find('rrn', '주민번호: 900101-1234567, 외국인 851231-5234567')).toEqual(['900101-1234567', '851231-5234567']);
    expect(find('rrn', '900101 - 2234567')).toEqual(['900101 - 2234567']);
    // Without the hyphen only with a valid check digit.
    expect(find('rrn', '번호 9001011234568 끝')).toEqual(['9001011234568']);
    expect(find('rrn', '번호 9001011234567 끝')).toEqual([]);
    // Invalid month/day, gender digit, or part of a longer number.
    expect(find('rrn', '901301-1234567 900132-1234567 900101-9234567 1900101-1234567 900101-12345678')).toEqual([]);
    expect(find('rrn', 'EAN 8801234567893')).toEqual([]); // a valid Korean EAN-13 barcode
  });

  it('전화번호', () => {
    expect(find('phone', '연락처 010-9876-5432 / 010.1234.5678 / 01012345678 / 011-123-4567')).toEqual([
      '010-9876-5432',
      '010.1234.5678',
      '01012345678',
      '011-123-4567',
    ]);
    expect(find('phone', '02-123-4567, 031-1234-5678, (02) 345-6789, 070-1234-5678')).toEqual([
      '02-123-4567',
      '031-1234-5678',
      '(02) 345-6789',
      '070-1234-5678',
    ]);
    // Mixed separators, too short/long, bare landline digits, other numbers.
    expect(find('phone', '010-1234.5678 010-12-5678 0212345678 2024-01-15 1,200,000 010-1234-56789')).toEqual([]);
  });

  it('카드번호', () => {
    expect(find('card', 'Card: 4321 8765 2109 6543 (VISA), 1234-5678-9012-3456, 3782 822463 10005')).toEqual([
      '4321 8765 2109 6543',
      '1234-5678-9012-3456',
      '3782 822463 10005',
    ]);
    expect(find('card', '4111111111111111')).toEqual(['4111111111111111']); // Luhn-valid run
    expect(find('card', '4111111111111112 1234 5678-9012 3456 2019 2020 2021 2022 1234 5678 9012 3456 7')).toEqual([]);
  });

  it('계좌번호', () => {
    expect(find('account', '110-234-567890, 1002-123-456789, 123-456789-01-234, 3333-01-1234567, 301-0123-4567-01')).toEqual([
      '110-234-567890',
      '1002-123-456789',
      '123-456789-01-234',
      '3333-01-1234567',
      '301-0123-4567-01',
    ]);
    // Phones, business numbers, dates, RRNs, short codes and cards are not accounts.
    expect(find('account', '010-1234-5678 123-45-67890 2024-01-15 900101-1234567 12-34-56 1234-5678-9012-3456')).toEqual([]);
  });

  it('이메일', () => {
    expect(find('email', '문의: hong.gildong+tax@example.co.kr, a_b@sub.domain.com.')).toEqual(['hong.gildong+tax@example.co.kr', 'a_b@sub.domain.com']);
    expect(find('email', 'user@localhost @handle foo@bar. a@b.c')).toEqual([]);
  });
});
