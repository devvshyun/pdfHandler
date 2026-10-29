import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { PDFDict, PDFDocument, PDFName, PDFString, StandardFonts } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { applyOperations, type PdfOperation, type RedactionReport, type ReplaceTextReport, type SanitizeReport } from '../src';
import { allObjectText } from './scan';

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');

async function textOf(bytes: Uint8Array, pageNo = 1): Promise<string> {
  const doc = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  const content = await (await doc.getPage(pageNo)).getTextContent();
  await doc.destroy();
  return content.items.map((i) => ('str' in i ? i.str : '')).join(' ');
}

async function redact(bytes: Uint8Array, op: Omit<Extract<PdfOperation, { type: 'redact' }>, 'type' | 'page'>, page = 0) {
  const reports: RedactionReport[] = [];
  const out = await applyOperations(bytes, [{ type: 'redact', page, ...op }], { onRedaction: (r) => reports.push(r) });
  return { out, report: reports[0] };
}

/** A 600x400 page with Helvetica as /F1 and the given raw content. */
async function rawPage(content: string) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([600, 400]);
  page.node.setFontDictionary(PDFName.of('F1'), font.ref);
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(content)));
  return { doc, page };
}

/** Visual area over the line with baseline y=300 (Helvetica 20pt from x=50). */
const TOP_LINE = { x: 40, y: 82, width: 400, height: 22 };

describe('redact sanitize: marked content', () => {
  it('drops /ActualText of inline property lists that held removed glyphs, keeping others', async () => {
    const { doc } = await rawPage(
      [
        'BT /F1 20 Tf 50 300 Td /Span <</ActualText (SECRET-AT) /MCID 0 /Lang (en)>> BDC (hidden) Tj EMC ET',
        'BT /F1 20 Tf 50 100 Td /Span <</ActualText (KEEP-AT)>> BDC (shown) Tj EMC ET',
      ].join('\n'),
    );
    const bytes = await doc.save();
    const { out, report } = await redact(bytes, { areas: [TOP_LINE] });
    expect(report.removedHiddenTexts).toBe(1);
    const raw = await allObjectText(out);
    expect(raw).not.toContain('SECRET-AT');
    expect(raw).toContain('KEEP-AT');
    // The sequence itself (tag, MCID, other entries) stays.
    expect(raw).toMatch(/\/Span <<\/MCID 0 \/Lang <656e>>> BDC/);

    const off = await redact(bytes, { areas: [TOP_LINE], sanitize: false });
    expect(await allObjectText(off.out)).toContain('SECRET-AT');
  });

  it('replaces named property lists by a cleaned copy and drops the original', async () => {
    const { doc, page } = await rawPage('BT /F1 20 Tf 50 300 Td /Span /P0 BDC (hidden) Tj EMC ET');
    const props = doc.context.register(doc.context.obj({ Alt: PDFString.of('SECRET-ALT'), MCID: 0 }));
    page.node.normalizedEntries().Resources.set(PDFName.of('Properties'), doc.context.obj({ P0: props }));
    const { out } = await redact(await doc.save(), { areas: [TOP_LINE] });
    expect(await allObjectText(out)).not.toContain('SECRET-ALT');
    const reloaded = await PDFDocument.load(out);
    const properties = reloaded.getPage(0).node.Resources()!.lookup(PDFName.of('Properties')) as PDFDict;
    expect(properties.keys().map((k) => k.decodeText())).toEqual(['P0_r1']);
  });
});

describe('redact sanitize: tagged Chromium PDF', () => {
  const fixture = new Uint8Array(readFileSync(new URL('./fixtures/chromium-tagged.pdf', import.meta.url)));
  // Page 450x450pt; the <img alt="900101-1234567"> sits at 75,75 (150x75), the number in text at ~126,225.
  const areas = [
    { x: 70, y: 70, width: 160, height: 85 },
    { x: 126.5, y: 222, width: 120, height: 18 },
  ];

  it('leaves no trace of the secret in any object: pixels, glyphs, /Alt', async () => {
    expect(await allObjectText(fixture)).toContain('900101-1234567');
    expect(await textOf(fixture)).toContain('900101-1234567');

    const { out, report } = await redact(fixture, { areas });
    expect(report).toMatchObject({ imagesRedacted: 1, imagesUnredacted: 0 });
    expect(report.removedGlyphs).toBe('900101-1234567'.length);
    expect(report.removedHiddenTexts).toBeGreaterThanOrEqual(1);
    const raw = await allObjectText(out);
    expect(raw).not.toContain('1234567');
    expect(raw).not.toContain('900101');
    const text = await textOf(out);
    expect(text).not.toContain('1234567');
    expect(text).toContain('Public paragraph stays.');
    expect(text).toContain('Tagged document');
    // The structure tree survives (only the alternate text went).
    const reloaded = await PDFDocument.load(out);
    expect(reloaded.catalog.lookup(PDFName.of('StructTreeRoot'))).toBeInstanceOf(PDFDict);
  });

  it('keeps /Alt when sanitize is off (so the test above proves something)', async () => {
    const { out } = await redact(fixture, { areas, sanitize: false });
    expect(await allObjectText(out)).toContain('900101-1234567');
  });
});

describe('redact: annotations', () => {
  it('unlinks removed form fields so their value and appearance leave the file', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([600, 400]);
    const form = doc.getForm();
    const ssn = form.createTextField('ssn');
    ssn.setText('900101-1234567');
    ssn.addToPage(page, { x: 50, y: 300, width: 200, height: 30 });
    const note = form.createTextField('note');
    note.setText('keep');
    note.addToPage(page, { x: 50, y: 50, width: 200, height: 30 });
    const { out, report } = await redact(await doc.save(), { areas: [{ x: 40, y: 60, width: 220, height: 50 }] });
    expect(report.removedAnnotations).toBe(1);
    const raw = await allObjectText(out);
    expect(raw).not.toContain('1234567');
    expect(raw).toContain('keep');
    expect((await PDFDocument.load(out)).getForm().getFields().map((f) => f.getName())).toEqual(['note']);
  });

  it('removes popups and replies of a removed comment, and structure references to it', async () => {
    const { doc, page } = await rawPage('');
    const ctx = doc.context;
    const comment = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: [60, 300, 80, 320], Contents: PDFString.of('SECRET-NOTE') }));
    const popup = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Popup', Rect: [400, 300, 550, 380], Parent: comment }));
    (ctx.lookup(comment) as PDFDict).set(PDFName.of('Popup'), popup);
    const reply = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: [400, 50, 420, 70], IRT: comment, Contents: PDFString.of('SECRET-REPLY') }));
    const link = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [50, 50, 150, 70], A: { S: 'URI', URI: PDFString.of('https://keep.example') } }));
    page.node.set(PDFName.of('Annots'), ctx.obj([comment, popup, reply, link]));
    // A tagged reference to the comment (OBJR) must not keep it alive.
    const root = ctx.obj({ Type: 'StructTreeRoot' }) as PDFDict;
    const elem = ctx.register(ctx.obj({ Type: 'StructElem', S: 'Annot', Pg: page.ref, Alt: PDFString.of('SECRET-ALT'), K: [{ Type: 'OBJR', Obj: comment }] }));
    root.set(PDFName.of('K'), ctx.obj([elem]));
    doc.catalog.set(PDFName.of('StructTreeRoot'), ctx.register(root));

    const { out, report } = await redact(await doc.save(), { areas: [{ x: 55, y: 75, width: 30, height: 30 }] });
    expect(report.removedAnnotations).toBe(3);
    const raw = await allObjectText(out);
    expect(raw).not.toMatch(/SECRET/);
    expect(raw).toContain('keep.example');
    expect((await PDFDocument.load(out)).getPage(0).node.Annots()?.size()).toBe(1);
  });

  it('replaceText keeps links and form fields over the edited line', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([600, 400]);
    page.drawText('Total due: 1,200 USD', { x: 50, y: 300, size: 20, font });
    const link = doc.context.register(
      doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [50, 295, 300, 320], A: { S: 'URI', URI: PDFString.of('https://pay.example') } }),
    );
    page.node.set(PDFName.of('Annots'), doc.context.obj([link]));
    const field = doc.getForm().createTextField('amount');
    field.setText('1200');
    field.addToPage(page, { x: 320, y: 295, width: 100, height: 25 });
    const reports: ReplaceTextReport[] = [];
    const out = await applyOperations(
      await doc.save(),
      [{ type: 'replaceText', page: 0, area: { x: 40, y: 82, width: 400, height: 22 }, text: 'Total due: 980 USD' }],
      { onReplaceText: (r) => reports.push(r) },
    );
    expect(reports[0].removedGlyphs).toBeGreaterThan(0);
    const reloaded = await PDFDocument.load(out);
    expect(reloaded.getPage(0).node.Annots()?.size()).toBe(2);
    expect(reloaded.getForm().getTextField('amount').getText()).toBe('1200');
    expect(await textOf(out)).toContain('980 USD');
  });
});

describe('sanitize operation', () => {
  async function loaded() {
    const doc = await PDFDocument.create();
    const ctx = doc.context;
    doc.setTitle('SECRET-TITLE');
    doc.setAuthor('SECRET-AUTHOR');
    const page = doc.addPage([600, 400]);
    page.drawText('Body text', { x: 50, y: 300, size: 20, font: await doc.embedFont(StandardFonts.Helvetica) });
    doc.catalog.set(PDFName.of('Metadata'), ctx.register(ctx.stream('<x:xmpmeta>SECRET-XMP</x:xmpmeta>', { Type: 'Metadata', Subtype: 'XML' })));
    const js = ctx.register(ctx.obj({ S: 'JavaScript', JS: PDFString.of('app.alert("SECRET-JS")') }));
    doc.catalog.set(PDFName.of('OpenAction'), js);
    page.node.set(PDFName.of('AA'), ctx.obj({ O: { S: 'JavaScript', JS: PDFString.of('SECRET-PAGE-JS') } }));
    const link = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 10, 10], A: { S: 'URI', URI: PDFString.of('https://keep.example'), Next: { S: 'JavaScript', JS: PDFString.of('SECRET-NEXT') } } }));
    page.node.set(PDFName.of('Annots'), ctx.obj([link]));
    await doc.attach(new TextEncoder().encode('SECRET-ATTACHMENT'), 'secret.txt', { mimeType: 'text/plain' });
    const names = ctx.obj({ JavaScript: { Names: [PDFString.of('init'), ctx.obj({ S: 'JavaScript', JS: PDFString.of('SECRET-DOCJS') })] } }) as PDFDict;
    // doc.attach writes /Names /EmbeddedFiles on save; merge ours into it then.
    const outlines = ctx.obj({ Type: 'Outlines' }) as PDFDict;
    const outlinesRef = ctx.register(outlines);
    const first = ctx.register(ctx.obj({ Title: PDFString.of('SECRET-BOOKMARK'), Parent: outlinesRef }));
    const second = ctx.register(ctx.obj({ Title: PDFString.of('Second'), Parent: outlinesRef, Prev: first }));
    (ctx.lookup(first) as PDFDict).set(PDFName.of('Next'), second);
    outlines.set(PDFName.of('First'), first);
    outlines.set(PDFName.of('Last'), second);
    doc.catalog.set(PDFName.of('Outlines'), outlinesRef);
    doc.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'));
    const saved = await PDFDocument.load(await doc.save());
    const savedNames = saved.catalog.lookup(PDFName.of('Names')) as PDFDict;
    savedNames.set(PDFName.of('JavaScript'), saved.context.obj(names.lookup(PDFName.of('JavaScript')) as PDFDict));
    return saved.save();
  }

  async function sanitize(bytes: Uint8Array, op: Omit<Extract<PdfOperation, { type: 'sanitize' }>, 'type'> = {}) {
    const reports: SanitizeReport[] = [];
    const out = await applyOperations(bytes, [{ type: 'sanitize', ...op }], { onSanitize: (r) => reports.push(r) });
    return { out, report: reports[0] };
  }

  it('removes properties, XMP, scripts, attachments and bookmarks, and reports them', async () => {
    const bytes = await loaded();
    const before = await allObjectText(bytes);
    for (const s of ['SECRET-TITLE', 'SECRET-XMP', 'SECRET-JS', 'SECRET-PAGE-JS', 'SECRET-NEXT', 'SECRET-ATTACHMENT', 'SECRET-DOCJS', 'SECRET-BOOKMARK']) {
      expect(before).toContain(s);
    }
    const { out, report } = await sanitize(bytes);
    expect(report.metadataKeys).toEqual(expect.arrayContaining(['Title', 'Author']));
    expect(report).toMatchObject({ xmpStreams: 1, javaScripts: 4, embeddedFiles: 1, outlineItems: 2 });
    const raw = await allObjectText(out);
    expect(raw).not.toMatch(/SECRET/);
    expect(raw).toContain('keep.example');
    expect(await textOf(out)).toContain('Body text');
    const reloaded = await PDFDocument.load(out);
    expect(reloaded.catalog.has(PDFName.of('PageMode'))).toBe(false);
    expect(reloaded.getProducer()).toBeTruthy(); // set again on save
  });

  it('keeps the parts switched off', async () => {
    const { out, report } = await sanitize(await loaded(), { removeOutlines: false, removeMetadata: false });
    expect(report.outlineItems).toBe(0);
    expect(report.metadataKeys).toEqual([]);
    const raw = await allObjectText(out);
    expect(raw).toContain('SECRET-BOOKMARK');
    expect(raw).toContain('SECRET-TITLE');
    expect(raw).not.toContain('SECRET-XMP');
    const outlines = (await PDFDocument.load(out)).catalog.lookup(PDFName.of('Outlines'));
    expect(outlines).toBeInstanceOf(PDFDict);
  });
});
