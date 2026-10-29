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
  'metadata',
] as const;

export class PdfOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfOperationError';
  }
}
