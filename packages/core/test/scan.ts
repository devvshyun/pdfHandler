import { decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFObject, PDFRawStream, PDFString } from 'pdf-lib';

const FONT_PROGRAM_SUBTYPES = ['Type1C', 'CIDFontType0C', 'OpenType'];

/**
 * Every piece of text the saved file carries: decoded streams (content, CMaps, XMP, …) and every
 * string in every dictionary or array, decoded (UTF-16 included) and raw. Font programs and
 * image samples are skipped: their bytes can contain any short sequence by chance.
 */
export async function allObjectText(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes);
  const parts: string[] = [];
  const strings = (obj: PDFObject | undefined): void => {
    if (obj instanceof PDFString || obj instanceof PDFHexString) {
      parts.push(obj.decodeText(), Buffer.from(obj.asBytes()).toString('latin1'));
    } else if (obj instanceof PDFDict) for (const [, v] of obj.entries()) strings(v);
    else if (obj instanceof PDFArray) for (const v of obj.asArray()) strings(v);
  };
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) {
      strings(obj);
      continue;
    }
    const d = obj.dict;
    strings(d);
    const subtype = d.get(PDFName.of('Subtype'));
    const fontProgram =
      d.has(PDFName.of('Length1')) || d.has(PDFName.of('Length2')) || FONT_PROGRAM_SUBTYPES.some((s) => subtype === PDFName.of(s));
    if (fontProgram || subtype === PDFName.of('Image')) continue;
    try {
      parts.push(Buffer.from(d.has(PDFName.of('Filter')) ? decodePDFRawStream(obj).decode() : obj.contents).toString('latin1'));
    } catch {
      parts.push(Buffer.from(obj.contents).toString('latin1'));
    }
  }
  return parts.join('\n');
}
