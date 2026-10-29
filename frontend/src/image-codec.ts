/**
 * JPEG codec for image pixel redaction, using the browser's own decoder (createImageBitmap) and
 * encoder (OffscreenCanvas.convertToBlob). The core library handles Flate/uncompressed images
 * itself; without this codec JPEG images (most scans and photos) could only be covered.
 *
 * Colour notes: the browser decodes every JPEG to RGB (CMYK JPEGs included), so a redacted
 * CMYK JPEG is stored as an RGB one. Greyscale results stay one component (stored as Flate).
 */
import type { ImageCodec, RasterImage } from '@pdfhandler/core';

const QUALITY = 0.92;

function canvas2d(width: number, height: number): OffscreenCanvasRenderingContext2D {
  const ctx = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas unavailable');
  return ctx;
}

async function decode(_filter: string, data: Uint8Array): Promise<RasterImage> {
  const blob = new Blob([data as BlobPart], { type: 'image/jpeg' });
  // No colour management: samples must stay what the file says, as PDF viewers render them.
  const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  try {
    const { width, height } = bitmap;
    const ctx = canvas2d(width, height);
    ctx.drawImage(bitmap, 0, 0);
    const rgba = ctx.getImageData(0, 0, width, height).data;
    const pixels = width * height;
    let gray = true;
    for (let i = 0; i < pixels && gray; i++) gray = rgba[i * 4] === rgba[i * 4 + 1] && rgba[i * 4] === rgba[i * 4 + 2];
    const components = gray ? 1 : 3;
    const samples = new Uint8Array(pixels * components);
    for (let i = 0; i < pixels; i++) {
      if (gray) samples[i] = rgba[i * 4];
      else {
        samples[i * 3] = rgba[i * 4];
        samples[i * 3 + 1] = rgba[i * 4 + 1];
        samples[i * 3 + 2] = rgba[i * 4 + 2];
      }
    }
    return { width, height, components, samples };
  } finally {
    bitmap.close();
  }
}

async function encode(_filter: string, img: RasterImage): Promise<Uint8Array | undefined> {
  // The canvas always writes a 3-component JPEG, which must not be labelled DeviceGray (or CMYK):
  // other images are stored Flate-compressed by the core instead.
  if (img.components !== 3) return undefined;
  const { width, height, samples } = img;
  const ctx = canvas2d(width, height);
  const data = ctx.createImageData(width, height);
  for (let i = 0; i < width * height; i++) {
    const s = i * 3;
    data.data[i * 4] = samples[s];
    data.data[i * 4 + 1] = samples[s + 1];
    data.data[i * 4 + 2] = samples[s + 2];
    data.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(data, 0, 0);
  const blob = await (ctx.canvas as OffscreenCanvas).convertToBlob({ type: 'image/jpeg', quality: QUALITY });
  if (blob.type !== 'image/jpeg') return undefined;
  return new Uint8Array(await blob.arrayBuffer());
}

/** Undefined where the browser lacks OffscreenCanvas (JPEG images are then only covered). */
export const browserImageCodec: ImageCodec | undefined =
  typeof OffscreenCanvas === 'function' && typeof createImageBitmap === 'function'
    ? { filters: ['DCTDecode'], decode, encode }
    : undefined;
