import { BadRequestException } from '@nestjs/common';
import { OPERATION_TYPES, PdfOperation } from '@pdfhandler/core';

/**
 * Structural validation of operation payloads before they reach the PDF engine, so malformed
 * input (wrong field types, bad base64, non-PNG/JPEG images...) is a 400 with a precise message
 * instead of an arbitrary exception (500) deep inside pdf-lib. Range checks that need the
 * document (page index < pageCount) stay in the engine and surface as PdfOperationError (400).
 */
export const MAX_OPERATIONS = 500;
const MAX_TEXT = 10_000;
const MAX_PAGES_LIST = 100_000;
const MAX_IMAGE_BASE64 = 30 * 1024 * 1024;
const COORD_LIMIT = 1_000_000;

class Invalid extends Error {}

type Obj = Record<string, unknown>;

function fail(path: string, message: string): never {
  throw new Invalid(`${path}: ${message}`);
}

function obj(v: unknown, path: string): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(path, '객체여야 합니다.');
  return v as Obj;
}

function int(o: Obj, key: string, path: string, opts: { optional?: boolean; min?: number } = {}): void {
  const v = o[key];
  if (v === undefined && opts.optional) return;
  if (typeof v !== 'number' || !Number.isInteger(v)) fail(`${path}.${key}`, '정수여야 합니다.');
  if (opts.min !== undefined && v < opts.min) fail(`${path}.${key}`, `${opts.min} 이상이어야 합니다.`);
}

function finite(o: Obj, key: string, path: string, opts: { optional?: boolean; min?: number; max?: number; positive?: boolean } = {}): void {
  const v = o[key];
  if (v === undefined && opts.optional) return;
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > COORD_LIMIT) fail(`${path}.${key}`, '유한한 숫자여야 합니다.');
  if (opts.positive && v <= 0) fail(`${path}.${key}`, '0보다 커야 합니다.');
  if (opts.min !== undefined && v < opts.min) fail(`${path}.${key}`, `${opts.min} 이상이어야 합니다.`);
  if (opts.max !== undefined && v > opts.max) fail(`${path}.${key}`, `${opts.max} 이하여야 합니다.`);
}

function str(o: Obj, key: string, path: string, opts: { optional?: boolean; max?: number; nonEmpty?: boolean } = {}): void {
  const v = o[key];
  if (v === undefined && opts.optional) return;
  if (typeof v !== 'string') fail(`${path}.${key}`, '문자열이어야 합니다.');
  if (opts.nonEmpty && !v.trim()) fail(`${path}.${key}`, '비어 있을 수 없습니다.');
  if (v.length > (opts.max ?? MAX_TEXT)) fail(`${path}.${key}`, `${opts.max ?? MAX_TEXT}자를 넘을 수 없습니다.`);
}

function pages(o: Obj, key: string, path: string, opts: { optional?: boolean; nonEmpty?: boolean } = {}): void {
  const v = o[key];
  if (v === undefined && opts.optional) return;
  if (!Array.isArray(v)) fail(`${path}.${key}`, '페이지 인덱스 배열이어야 합니다.');
  if (opts.nonEmpty && v.length === 0) fail(`${path}.${key}`, '비어 있을 수 없습니다.');
  if (v.length > MAX_PAGES_LIST) fail(`${path}.${key}`, '항목이 너무 많습니다.');
  v.forEach((p, i) => {
    if (typeof p !== 'number' || !Number.isInteger(p) || p < 0) fail(`${path}.${key}[${i}]`, '0 이상의 정수 페이지 인덱스여야 합니다.');
  });
}

function color(o: Obj, key: string, path: string, opts: { nullable?: boolean } = {}): void {
  const v = o[key];
  if (v === undefined || (v === null && opts.nullable)) return;
  const c = obj(v, `${path}.${key}`);
  for (const ch of ['r', 'g', 'b']) finite(c, ch, `${path}.${key}`, { min: 0, max: 1 });
}

function rect(v: unknown, path: string): void {
  const r = obj(v, path);
  finite(r, 'x', path);
  finite(r, 'y', path);
  finite(r, 'width', path, { positive: true });
  finite(r, 'height', path, { positive: true });
}

function oneOf(o: Obj, key: string, path: string, values: readonly unknown[], optional = true): void {
  const v = o[key];
  if (v === undefined && optional) return;
  if (!values.includes(v)) fail(`${path}.${key}`, `${values.map((x) => JSON.stringify(x)).join(', ')} 중 하나여야 합니다.`);
}

/** Checks the base64 alphabet and that the decoded bytes start like a PNG or JPEG. */
function image(o: Obj, key: string, path: string): void {
  const v = o[key];
  if (typeof v !== 'string' || !v) fail(`${path}.${key}`, 'base64 문자열이어야 합니다.');
  if (v.length > MAX_IMAGE_BASE64) fail(`${path}.${key}`, '이미지가 너무 큽니다.');
  const clean = v.replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clean) || clean.length % 4 === 1) fail(`${path}.${key}`, '올바른 base64 데이터가 아닙니다.');
  const head = Buffer.from(clean.slice(0, 16), 'base64');
  const png = head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpeg = head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  if (!png && !jpeg) fail(`${path}.${key}`, 'PNG 또는 JPEG 이미지만 넣을 수 있습니다.');
  if (Buffer.byteLength(clean, 'base64') < 32) fail(`${path}.${key}`, '이미지 데이터가 잘려 있습니다.');
}

function validateOne(raw: unknown, path: string): PdfOperation {
  const o = obj(raw, path);
  if (!OPERATION_TYPES.includes(o.type as PdfOperation['type'])) {
    fail(`${path}.type`, `알 수 없는 작업입니다 (${OPERATION_TYPES.join(', ')} 중 하나).`);
  }
  const op = o as unknown as PdfOperation;
  switch (op.type) {
    case 'rotate':
      pages(o, 'pages', path, { nonEmpty: true });
      oneOf(o, 'degrees', path, [90, 180, 270, -90], false);
      break;
    case 'delete':
    case 'extract':
      pages(o, 'pages', path, { nonEmpty: true });
      break;
    case 'reorder':
      pages(o, 'order', path, { nonEmpty: true });
      break;
    case 'duplicate':
      int(o, 'page', path, { min: 0 });
      break;
    case 'insertBlank':
      int(o, 'after', path, { min: -1 });
      finite(o, 'width', path, { optional: true, positive: true, max: 14_400 });
      finite(o, 'height', path, { optional: true, positive: true, max: 14_400 });
      break;
    case 'watermark':
      str(o, 'text', path, { nonEmpty: true, max: 500 });
      finite(o, 'fontSize', path, { optional: true, positive: true, max: 1000 });
      finite(o, 'opacity', path, { optional: true, min: 0, max: 1 });
      finite(o, 'rotate', path, { optional: true });
      color(o, 'color', path);
      pages(o, 'pages', path, { optional: true });
      break;
    case 'pageNumbers':
      str(o, 'format', path, { optional: true, max: 200 });
      oneOf(o, 'position', path, ['bottom-center', 'bottom-right', 'bottom-left', 'top-center', 'top-right', 'top-left']);
      finite(o, 'fontSize', path, { optional: true, positive: true, max: 200 });
      int(o, 'startAt', path, { optional: true, min: 0 });
      break;
    case 'addText':
      int(o, 'page', path, { min: 0 });
      finite(o, 'x', path);
      finite(o, 'y', path);
      str(o, 'text', path);
      finite(o, 'fontSize', path, { optional: true, positive: true, max: 1000 });
      color(o, 'color', path);
      break;
    case 'addImage':
      int(o, 'page', path, { min: 0 });
      rect(o, path);
      finite(o, 'opacity', path, { optional: true, min: 0, max: 1 });
      image(o, 'imageBase64', path);
      break;
    case 'redact': {
      int(o, 'page', path, { min: 0 });
      if (!Array.isArray(o.areas) || o.areas.length === 0) fail(`${path}.areas`, '영역 배열이 비어 있습니다.');
      if (o.areas.length > 1000) fail(`${path}.areas`, '영역이 너무 많습니다.');
      o.areas.forEach((a, i) => rect(a, `${path}.areas[${i}]`));
      oneOf(o, 'mode', path, ['overlap', 'center']);
      color(o, 'fill', path, { nullable: true });
      color(o, 'coverIfUntouched', path);
      break;
    }
    case 'replaceText': {
      int(o, 'page', path, { min: 0 });
      rect(o.area, `${path}.area`);
      str(o, 'text', path, { max: 2000 });
      finite(o, 'maxWidth', path, { optional: true, positive: true });
      color(o, 'textColor', path);
      color(o, 'coverColor', path);
      if (o.fallbackImage !== undefined) {
        const f = obj(o.fallbackImage, `${path}.fallbackImage`);
        finite(f, 'width', `${path}.fallbackImage`, { positive: true });
        finite(f, 'height', `${path}.fallbackImage`, { positive: true });
        image(f, 'imageBase64', `${path}.fallbackImage`);
      }
      break;
    }
    case 'metadata':
      for (const k of ['title', 'author', 'subject']) str(o, k, path, { optional: true, max: 1000 });
      if (o.keywords !== undefined && (!Array.isArray(o.keywords) || o.keywords.some((k) => typeof k !== 'string'))) {
        fail(`${path}.keywords`, '문자열 배열이어야 합니다.');
      }
      break;
  }
  return op;
}

/** Validates an operations array; throws BadRequestException("operations[i].field: ...") on the first problem. */
export function validateOperations(raw: unknown): PdfOperation[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new BadRequestException('"operations"는 비어 있지 않은 배열이어야 합니다.');
  if (raw.length > MAX_OPERATIONS) throw new BadRequestException(`작업은 한 번에 ${MAX_OPERATIONS}개까지 보낼 수 있습니다.`);
  try {
    return raw.map((op, i) => validateOne(op, `operations[${i}]`));
  } catch (e) {
    if (e instanceof Invalid) throw new BadRequestException(e.message);
    throw e;
  }
}

/** For multipart endpoints where `operations` arrives as a JSON string. */
export function parseOperations(raw: string | undefined): PdfOperation[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw ?? '');
  } catch {
    throw new BadRequestException('"operations"는 JSON 배열 문자열이어야 합니다.');
  }
  return validateOperations(parsed);
}
