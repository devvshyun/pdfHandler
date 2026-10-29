/**
 * Page-level PDF operations. Page indexes are 0-based everywhere in this package;
 * the UI and REST API translate to/from 1-based page numbers.
 */
export type RotationDegrees = 90 | 180 | 270 | -90;

export interface RgbColor {
  r: number; // 0..1
  g: number;
  b: number;
}

export type PdfOperation =
  | { type: 'rotate'; pages: number[]; degrees: RotationDegrees }
  | { type: 'delete'; pages: number[] }
  | { type: 'reorder'; order: number[] }
  | { type: 'extract'; pages: number[] }
  | { type: 'duplicate'; page: number }
  | { type: 'insertBlank'; after: number; width?: number; height?: number }
  | {
      type: 'watermark';
      text: string;
      fontSize?: number;
      opacity?: number;
      color?: RgbColor;
      rotate?: number;
      pages?: number[];
    }
  | {
      type: 'pageNumbers';
      /** `{n}` = current page, `{total}` = page count. */
      format?: string;
      position?: 'bottom-center' | 'bottom-right' | 'bottom-left' | 'top-center' | 'top-right' | 'top-left';
      fontSize?: number;
      startAt?: number;
    }
  | {
      type: 'addText';
      page: number;
      /** PDF user-space coordinates (origin bottom-left of the unrotated page). */
      x: number;
      y: number;
      text: string;
      fontSize?: number;
      color?: RgbColor;
    }
  | {
      type: 'addImage';
      page: number;
      x: number;
      y: number;
      width: number;
      height: number;
      /** PNG or JPEG bytes, base64 encoded (so the op stays JSON-serialisable). */
      imageBase64: string;
      opacity?: number;
    }
  | {
      /**
       * Permanently removes the text inside `areas` from the page content (not just covers it).
       * Areas use the same visual, top-left-origin coordinates as addImage.
       */
      type: 'redact';
      page: number;
      areas: Array<{ x: number; y: number; width: number; height: number }>;
      /** `overlap` (default): any glyph touching an area. `center`: glyphs centred inside. */
      mode?: 'overlap' | 'center';
      /** Box painted over each area afterwards; default black, `null` for none. */
      fill?: RgbColor | null;
      /** Painted only when no glyph was found to remove (e.g. text that is part of an image). */
      coverIfUntouched?: RgbColor;
    }
  | {
      /**
       * Replaces the text inside `area` (visual, top-left origin) with `text`: the old glyphs are
       * removed from the content and the new text is drawn at the same baseline, in the original
       * font when it contains every character, otherwise in Helvetica (Latin) or `fallbackImage`.
       * Text wider than `maxWidth` is narrowed (down to 60%) to fit.
       */
      type: 'replaceText';
      page: number;
      area: { x: number; y: number; width: number; height: number };
      text: string;
      /** Width available for the new text, in points from the area's left edge. */
      maxWidth?: number;
      /** Ink colour to use when the original colour cannot be read. */
      textColor?: RgbColor;
      /** Painted over the area when no original glyph was found (e.g. text inside an image). */
      coverColor?: RgbColor;
      /** Rendered text for scripts the standard font cannot show and the original font lacks. */
      fallbackImage?: { imageBase64: string; width: number; height: number };
    }
  | {
      type: 'metadata';
      title?: string;
      author?: string;
      subject?: string;
      keywords?: string[];
    };

export type PdfOperationType = PdfOperation['type'];

export const OPERATION_TYPES: readonly PdfOperationType[] = [
  'rotate',
  'delete',
  'reorder',
  'extract',
  'duplicate',
  'insertBlank',
  'watermark',
  'pageNumbers',
  'addText',
  'addImage',
  'redact',
  'replaceText',
  'metadata',
] as const;

export class PdfOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfOperationError';
  }
}
