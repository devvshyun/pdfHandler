import jpeg from 'jpeg-js';
import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFObject,
  PDFPage,
  PDFRawStream,
  PDFRef,
} from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { applyOperations, type ImageCodec, type PdfOperation, type RedactionReport } from '../src';

type Area = { x: number; y: number; width: number; height: number };

interface ImageSpec {
  width: number;
  height: number;
  samples: Uint8Array;
  colorSpace?: string | PDFObject;
  bpc?: number;
  decode?: number[];
  imageMask?: boolean;
  /** Extra dictionary entries (e.g. DecodeParms, SMask). */
  extra?: Record<string, PDFObject>;
  /** Store already-encoded bytes with this filter instead of Flate-compressing `samples`. */
  filter?: string;
}

function addImage(doc: PDFDocument, spec: ImageSpec): PDFRef {
  const dict: Record<string, unknown> = { Type: 'XObject', Subtype: 'Image', Width: spec.width, Height: spec.height };
  if (spec.imageMask) dict.ImageMask = true;
  else {
    dict.ColorSpace = spec.colorSpace ?? 'DeviceRGB';
    dict.BitsPerComponent = spec.bpc ?? 8;
  }
  if (spec.decode) dict.Decode = spec.decode;
  const stream = spec.filter
    ? doc.context.stream(spec.samples, { ...(dict as object), Filter: spec.filter } as never)
    : doc.context.flateStream(spec.samples, dict as never);
  for (const [k, v] of Object.entries(spec.extra ?? {})) stream.dict.set(PDFName.of(k), v);
  return doc.context.register(stream);
}

/** Sets a page's content to `content` with the given XObjects. */
function setContent(doc: PDFDocument, page: PDFPage, content: string | Uint8Array, xobjects: Record<string, PDFRef>) {
  for (const [name, ref] of Object.entries(xobjects)) page.node.setXObject(PDFName.of(name), ref);
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(content)));
}

/** One 600x400 page drawing image `spec` with matrix `cm`. */
async function imagePdf(spec: ImageSpec, cm = '200 0 0 200 100 100') {
  const doc = await PDFDocument.create();
  const page = doc.addPage([600, 400]);
  setContent(doc, page, `q ${cm} cm /Im1 Do Q`, { Im1: addImage(doc, spec) });
  return doc.save();
}

async function redact(bytes: Uint8Array, areas: Area[], extra: Partial<Extract<PdfOperation, { type: 'redact' }>> = {}, imageCodec?: ImageCodec) {
  const reports: RedactionReport[] = [];
  const out = await applyOperations(bytes, [{ type: 'redact', page: 0, areas, ...extra }], { onRedaction: (r) => reports.push(r), imageCodec });
  return { out, report: reports[0] };
}

interface FoundImage {
  name: string;
  stream: PDFRawStream;
  samples: Uint8Array;
}

/** Image XObjects drawn on a page (through its resources, including inside forms). */
async function imagesOn(bytes: Uint8Array, pageIndex = 0): Promise<FoundImage[]> {
  const doc = await PDFDocument.load(bytes);
  const found: FoundImage[] = [];
  const visit = (resources: PDFObject | undefined) => {
    const xobjects = resources instanceof PDFDict ? resources.lookup(PDFName.of('XObject')) : undefined;
    if (!(xobjects instanceof PDFDict)) return;
    for (const [name, ref] of xobjects.entries()) {
      const s = ref instanceof PDFRef ? doc.context.lookup(ref) : ref;
      if (!(s instanceof PDFRawStream)) continue;
      if (s.dict.get(PDFName.of('Subtype')) === PDFName.of('Form')) visit(s.dict.lookup(PDFName.of('Resources')));
      else found.push({ name: name.decodeText(), stream: s, samples: decodeSamples(s) });
    }
  };
  visit(doc.getPage(pageIndex).node.Resources());
  return found;
}

function decodeSamples(s: PDFRawStream): Uint8Array {
  const filter = s.dict.lookup(PDFName.of('Filter'));
  if (filter === PDFName.of('DCTDecode')) return jpeg.decode(s.contents, { useTArray: true, formatAsRGBA: false }).data;
  try {
    return filter ? decodePDFRawStream(s).decode() : s.contents;
  } catch {
    return new Uint8Array();
  }
}

/** Every image stream left in the saved file, referenced or not. */
async function allImages(bytes: Uint8Array): Promise<PDFRawStream[]> {
  const doc = await PDFDocument.load(bytes);
  return [...doc.context.enumerateIndirectObjects()]
    .map(([, o]) => o)
    .filter((o): o is PDFRawStream => o instanceof PDFRawStream && o.dict.get(PDFName.of('Subtype')) === PDFName.of('Image'));
}

const filled = (n: number, v: number | number[]) => {
  const per = Array.isArray(v) ? v : [v];
  const out = new Uint8Array(n * per.length);
  for (let i = 0; i < n; i++) out.set(per, i * per.length);
  return out;
};
/** Samples of pixel (x, y) for byte-aligned images with `n` bytes per pixel. */
function pixelAt(img: FoundImage, x: number, y: number, n = 3): number[] {
  const w = Number(img.stream.dict.lookup(PDFName.of('Width'))!.toString());
  return Array.from(img.samples.subarray((y * w + x) * n, (y * w + x + 1) * n));
}

/** Image 100x100 at user (100,100)-(300,300): 2pt per pixel. Visual area over user (150..250)². */
const CENTER: Area = { x: 150, y: 150, width: 100, height: 100 };
const inCenter = (x: number, y: number) => x >= 25 && x < 75 && y >= 25 && y < 75;

describe('image redaction: Flate samples (no codec needed)', () => {
  it('overwrites DeviceRGB pixels in the area, keeps the rest, and drops the original', async () => {
    const bytes = await imagePdf({ width: 100, height: 100, samples: filled(10000, [255, 255, 255]) });
    const { out, report } = await redact(bytes, [CENTER]);
    expect(report).toMatchObject({ imagesOverlapping: 1, imagesRedacted: 1, imagesUnredacted: 0 });
    const [img] = await imagesOn(out);
    let black = 0;
    for (let y = 0; y < 100; y++)
      for (let x = 0; x < 100; x++) {
        const p = pixelAt(img, x, y);
        if (inCenter(x, y)) expect(p).toEqual([0, 0, 0]);
        else expect(p).toEqual([255, 255, 255]);
        if (p[0] === 0) black++;
      }
    expect(black).toBe(2500);
    // No all-white copy survives anywhere in the file.
    const images = await allImages(out);
    expect(images).toHaveLength(1);
  });

  it('uses the fill colour for pixels, and black when fill is null', async () => {
    const bytes = await imagePdf({ width: 100, height: 100, samples: filled(10000, [255, 255, 255]) });
    const red = await redact(bytes, [CENTER], { fill: { r: 1, g: 0, b: 0 } });
    expect(pixelAt((await imagesOn(red.out))[0], 50, 50)).toEqual([255, 0, 0]);
    const none = await redact(bytes, [CENTER], { fill: null });
    expect(pixelAt((await imagesOn(none.out))[0], 50, 50)).toEqual([0, 0, 0]);
  });

  it('handles DeviceGray with an inverted /Decode, DeviceCMYK and 16-bit samples', async () => {
    const gray = await redact(await imagePdf({ width: 100, height: 100, samples: filled(10000, 0), colorSpace: 'DeviceGray', decode: [1, 0] }), [CENTER]);
    const g = (await imagesOn(gray.out))[0];
    expect(pixelAt(g, 50, 50, 1)).toEqual([255]); // decoded as black
    expect(pixelAt(g, 5, 5, 1)).toEqual([0]);

    const cmyk = await redact(await imagePdf({ width: 100, height: 100, samples: filled(10000, [0, 0, 0, 0]), colorSpace: 'DeviceCMYK' }), [CENTER]);
    const c = (await imagesOn(cmyk.out))[0];
    expect(pixelAt(c, 50, 50, 4)).toEqual([0, 0, 0, 255]);
    expect(pixelAt(c, 5, 5, 4)).toEqual([0, 0, 0, 0]);

    const deep = await redact(await imagePdf({ width: 100, height: 100, samples: filled(10000, [0xff, 0xff]), colorSpace: 'DeviceGray', bpc: 16 }), [CENTER]);
    const d = (await imagesOn(deep.out))[0];
    expect(pixelAt(d, 50, 50, 2)).toEqual([0, 0]);
    expect(pixelAt(d, 5, 5, 2)).toEqual([0xff, 0xff]);
  });

  it('packs 1-bit samples (stencil masks and gray, odd widths)', async () => {
    // 13 px wide → 2 bytes per row; all bits 1 (= not painted for a mask, white for gray).
    const rows = 10;
    const mask = await redact(
      await imagePdf({ width: 13, height: rows, samples: filled(rows * 2, 0xff), imageMask: true }, '130 0 0 100 100 100'),
      // user x 150..200 → pixels 5..9 (10pt each); all rows.
      [{ x: 150, y: 400 - 200, width: 50, height: 100 }],
    );
    expect(mask.report.imagesRedacted).toBe(1);
    const m = (await imagesOn(mask.out))[0];
    const bitsOf = (row: number) => {
      const v = (m.samples[row * 2] << 8) | m.samples[row * 2 + 1];
      return Array.from({ length: 13 }, (_, i) => (v >> (15 - i)) & 1);
    };
    for (let r = 0; r < rows; r++) expect(bitsOf(r)).toEqual([1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 1, 1, 1]);
    // Padding bits of each row are untouched.
    expect(m.samples[1] & 0b111).toBe(0b111);

    const gray = await redact(
      await imagePdf({ width: 13, height: rows, samples: filled(rows * 2, 0xff), colorSpace: 'DeviceGray', bpc: 1 }, '130 0 0 100 100 100'),
      [{ x: 150, y: 400 - 200, width: 50, height: 100 }],
    );
    const g = (await imagesOn(gray.out))[0];
    expect(((g.samples[0] << 8) | g.samples[1]) >> 3).toBe(0b1111100000111);
  });

  it('fills Indexed images with the palette entry closest to the fill colour', async () => {
    const doc = await PDFDocument.create();
    const palette = PDFHexString.of('ffffff000000ff0000');
    const cs = doc.context.obj([PDFName.of('Indexed'), PDFName.of('DeviceRGB'), 2, palette]);
    const bytes = await imagePdf({ width: 100, height: 100, samples: filled(10000, 0), colorSpace: cs });
    expect(pixelAt((await imagesOn((await redact(bytes, [CENTER])).out))[0], 50, 50, 1)).toEqual([1]);
    expect(pixelAt((await imagesOn((await redact(bytes, [CENTER], { fill: { r: 0.9, g: 0.1, b: 0 } })).out))[0], 50, 50, 1)).toEqual([2]);
  });

  it('undoes PNG predictors', async () => {
    // 4x2 gray: row 0 "Sub"-encoded, row 1 "Up"-encoded; both decode to 10 20 30 40.
    const encoded = Uint8Array.from([1, 10, 10, 10, 10, 2, 0, 0, 0, 0]);
    const doc = await PDFDocument.create();
    const parms = doc.context.obj({ Predictor: 15, Colors: 1, BitsPerComponent: 8, Columns: 4 });
    const bytes = await imagePdf({ width: 4, height: 2, samples: encoded, colorSpace: 'DeviceGray', extra: { DecodeParms: parms } }, '200 0 0 100 100 100');
    // Column 0 = user x 100..150.
    const { out } = await redact(bytes, [{ x: 100, y: 400 - 200, width: 50, height: 100 }]);
    const img = (await imagesOn(out))[0];
    expect(Array.from(img.samples)).toEqual([0, 20, 30, 40, 0, 20, 30, 40]);
    expect(img.stream.dict.has(PDFName.of('DecodeParms'))).toBe(false);
  });

  it('makes the soft mask opaque in the region (shapes in the alpha channel are content too)', async () => {
    const doc = await PDFDocument.create();
    const smask = addImage(doc, { width: 100, height: 100, samples: filled(10000, 0), colorSpace: 'DeviceGray' });
    const page = doc.addPage([600, 400]);
    setContent(doc, page, 'q 200 0 0 200 100 100 cm /Im1 Do Q', {
      Im1: addImage(doc, { width: 100, height: 100, samples: filled(10000, [255, 255, 255]), extra: { SMask: smask } }),
    });
    const { out } = await redact(await doc.save(), [CENTER]);
    const reloaded = await PDFDocument.load(out);
    const [img] = await imagesOn(out);
    const sm = reloaded.context.lookup(img.stream.dict.get(PDFName.of('SMask')) as PDFRef) as PDFRawStream;
    const alpha = decodePDFRawStream(sm).decode();
    expect(alpha[50 * 100 + 50]).toBe(255);
    expect(alpha[5 * 100 + 5]).toBe(0);
  });
});

describe('image redaction: placement', () => {
  it('follows rotated and skewed placements pixel by pixel', async () => {
    const W = 60;
    const H = 40;
    const rad = Math.PI / 6;
    const m = [150 * Math.cos(rad), 150 * Math.sin(rad), -100 * Math.sin(rad) + 30, 100 * Math.cos(rad), 300, 100];
    const bytes = await imagePdf({ width: W, height: H, samples: filled(W * H, [255, 255, 255]) }, m.map((v) => v.toFixed(6)).join(' '));
    const area = { x1: 280, y1: 160, x2: 340, y2: 220 };
    const { out, report } = await redact(bytes, [{ x: area.x1, y: 400 - area.y2, width: 60, height: 60 }]);
    expect(report.imagesRedacted).toBe(1);
    const img = (await imagesOn(out))[0];
    const corner = (i: number, j: number) => {
      const u = i / W;
      const v = 1 - j / H;
      return [m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5]];
    };
    let inside = 0;
    let outside = 0;
    for (let j = 0; j < H; j++)
      for (let i = 0; i < W; i++) {
        const cs = [corner(i, j), corner(i + 1, j), corner(i, j + 1), corner(i + 1, j + 1)];
        const allIn = cs.every(([x, y]) => x > area.x1 && x < area.x2 && y > area.y1 && y < area.y2);
        const xs = cs.map((c) => c[0]);
        const ys = cs.map((c) => c[1]);
        const disjoint = Math.max(...xs) < area.x1 || Math.min(...xs) > area.x2 || Math.max(...ys) < area.y1 || Math.min(...ys) > area.y2;
        if (allIn) {
          expect(pixelAt(img, i, j)).toEqual([0, 0, 0]);
          inside++;
        }
        if (disjoint) {
          expect(pixelAt(img, i, j)).toEqual([255, 255, 255]);
          outside++;
        }
      }
    expect(inside).toBeGreaterThan(50);
    expect(outside).toBeGreaterThan(500);
  });

  it('keeps a shared image intact on other pages and on other placements of the same page', async () => {
    const doc = await PDFDocument.create();
    const ref = addImage(doc, { width: 100, height: 100, samples: filled(10000, [255, 255, 255]) });
    const p1 = doc.addPage([600, 400]);
    // Drawn twice on page 1: once under the area, once far away (x 400..500).
    setContent(doc, p1, 'q 200 0 0 200 100 100 cm /Im1 Do Q q 100 0 0 100 400 100 cm /Im1 Do Q', { Im1: ref });
    const p2 = doc.addPage([600, 400]);
    setContent(doc, p2, 'q 200 0 0 200 100 100 cm /Im1 Do Q', { Im1: ref });
    const { out, report } = await redact(await doc.save(), [CENTER]);
    expect(report.imagesRedacted).toBe(1);
    const page1 = await imagesOn(out, 0);
    expect(page1.map((i) => i.name).sort()).toEqual(['Im1', 'Im1_r1']);
    expect(pixelAt(page1.find((i) => i.name === 'Im1')!, 50, 50)).toEqual([255, 255, 255]);
    expect(pixelAt(page1.find((i) => i.name === 'Im1_r1')!, 50, 50)).toEqual([0, 0, 0]);
    const page2 = await imagesOn(out, 1);
    expect(page2.map((i) => i.name)).toEqual(['Im1']);
    expect(pixelAt(page2[0], 50, 50)).toEqual([255, 255, 255]);
  });

  it('redacts images inside Form XObjects without touching the shared original', async () => {
    const doc = await PDFDocument.create();
    const image = addImage(doc, { width: 100, height: 100, samples: filled(10000, [255, 255, 255]) });
    const form = doc.context.flateStream('q 200 0 0 200 0 0 cm /Im1 Do Q', {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 200, 200],
      Resources: { XObject: { Im1: image } },
    } as never);
    const formRef = doc.context.register(form);
    setContent(doc, doc.addPage([600, 400]), 'q 1 0 0 1 100 100 cm /Fm1 Do Q', { Fm1: formRef });
    setContent(doc, doc.addPage([600, 400]), 'q 1 0 0 1 100 100 cm /Fm1 Do Q', { Fm1: formRef });
    const { out, report } = await redact(await doc.save(), [CENTER]);
    expect(report.imagesRedacted).toBe(1);
    expect(pixelAt((await imagesOn(out, 0))[0], 50, 50)).toEqual([0, 0, 0]);
    expect(pixelAt((await imagesOn(out, 1))[0], 50, 50)).toEqual([255, 255, 255]);
  });

  it('turns an overlapping inline image into a redacted image XObject', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([600, 400]);
    const head = Buffer.from('q 200 0 0 200 100 100 cm\nBI /W 4 /H 4 /CS /G /BPC 8 ID\n', 'latin1');
    const tail = Buffer.from('\nEI\nQ\nq 100 0 0 100 400 100 cm BI /W 2 /H 1 /CS /G /BPC 8 /F /AHx ID 7f7f> EI Q', 'latin1');
    setContent(doc, page, Buffer.concat([head, Buffer.from(filled(16, 200)), tail]), {});
    // Left half of the first image (user x 100..200) → columns 0 and 1.
    const { out, report } = await redact(await doc.save(), [{ x: 100, y: 400 - 300, width: 100, height: 200 }]);
    expect(report).toMatchObject({ imagesOverlapping: 1, imagesRedacted: 1 });
    const [img] = await imagesOn(out);
    expect(Array.from(img.samples)).toEqual([0, 0, 200, 200, 0, 0, 200, 200, 0, 0, 200, 200, 0, 0, 200, 200]);
    const reloaded = await PDFDocument.load(out);
    const contents = reloaded.getPage(0).node.Contents() as PDFArray;
    const text = contents
      .asArray()
      .map((_, i) => Buffer.from(decodePDFRawStream(contents.lookup(i) as PDFRawStream).decode()).toString('latin1'))
      .join('\n');
    expect(text).toMatch(/\/InlineImage_r1 Do/);
    // Only the second (untouched, hex-encoded) inline image is left inline.
    expect(text.match(/\bBI\b/g)).toHaveLength(1);
    expect(text).toContain('7f7f>');
  });
});

describe('image redaction: formats needing a codec', () => {
  // A copy: pdf-lib reads the bytes through `.buffer`, which for a pooled Buffer is shared.
  const white = new Uint8Array(jpeg.encode({ width: 64, height: 64, data: filled(64 * 64, [255, 255, 255, 255]) }, 90).data);

  async function jpegPdf() {
    const doc = await PDFDocument.create();
    const page = doc.addPage([600, 400]);
    page.drawImage(await doc.embedJpg(white), { x: 100, y: 100, width: 200, height: 200 });
    return doc.save();
  }

  const codec = (withEncode: boolean): ImageCodec => ({
    filters: ['DCTDecode'],
    async decode(_filter, data) {
      const img = jpeg.decode(data, { useTArray: true, formatAsRGBA: false });
      return { width: img.width, height: img.height, components: img.data.length / (img.width * img.height), samples: img.data };
    },
    encode: withEncode
      ? async (_filter, img) => {
          if (img.components !== 3) return undefined;
          const rgba = new Uint8Array(img.width * img.height * 4);
          for (let i = 0; i < img.width * img.height; i++) rgba.set([...img.samples.subarray(i * 3, i * 3 + 3), 255], i * 4);
          return new Uint8Array(jpeg.encode({ width: img.width, height: img.height, data: rgba }, 90).data);
        }
      : undefined,
  });

  it('reports JPEG images as unredacted without a codec and leaves them as they were', async () => {
    const bytes = await jpegPdf();
    const { out, report } = await redact(bytes, [CENTER]);
    expect(report).toMatchObject({ imagesOverlapping: 1, imagesRedacted: 0, imagesUnredacted: 1, unredactedImageReasons: ['DCTDecode'] });
    const [img] = await imagesOn(out);
    expect(Buffer.from(img.stream.contents).equals(Buffer.from(white))).toBe(true);
  });

  it('reports JBIG2 / JPX / CCITT images', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([600, 400]);
    setContent(doc, page, 'q 200 0 0 200 100 100 cm /Im1 Do Q', {
      Im1: addImage(doc, { width: 8, height: 8, samples: Uint8Array.from([1, 2, 3]), colorSpace: 'DeviceGray', bpc: 1, filter: 'JBIG2Decode' }),
    });
    const { report } = await redact(await doc.save(), [CENTER], {}, codec(true));
    expect(report).toMatchObject({ imagesUnredacted: 1, unredactedImageReasons: ['JBIG2Decode'] });
  });

  it('redacts JPEG pixels through an injected codec (re-encoded as JPEG)', async () => {
    const { out, report } = await redact(await jpegPdf(), [CENTER], {}, codec(true));
    expect(report).toMatchObject({ imagesRedacted: 1, imagesUnredacted: 0 });
    const [img] = await imagesOn(out);
    expect(img.stream.dict.lookup(PDFName.of('Filter'))).toBe(PDFName.of('DCTDecode'));
    // 64 px over 200pt: the area (user 150..250) covers pixels 16..48. JPEG is lossy: allow noise.
    expect(Math.max(...pixelAt(img, 32, 32))).toBeLessThan(20);
    expect(Math.min(...pixelAt(img, 3, 3))).toBeGreaterThan(235);
    expect(Math.min(...pixelAt(img, 60, 32))).toBeGreaterThan(235);
  });

  it('stores codec-decoded pixels Flate-compressed when the codec cannot encode', async () => {
    const { out } = await redact(await jpegPdf(), [CENTER], {}, codec(false));
    const [img] = await imagesOn(out);
    expect(img.stream.dict.lookup(PDFName.of('Filter'))).toBe(PDFName.of('FlateDecode'));
    expect(pixelAt(img, 32, 32)).toEqual([0, 0, 0]);
    expect(Math.min(...pixelAt(img, 3, 3))).toBeGreaterThan(250);
  });
});
