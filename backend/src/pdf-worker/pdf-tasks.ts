// Pure task runner shared by the worker thread and the in-process fallback.
// Must not import Nest or anything with side effects: it is loaded inside worker threads.
import { applyOperations, getPdfInfo, mergePdfs, PdfInfo, PdfOperation } from '@pdfhandler/core';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

/** A PDF either already in memory or on local disk (read inside the worker, off the main thread). */
export type PdfInput = { path: string } | { bytes: Uint8Array };

export type PdfTask =
  | { kind: 'info'; input: PdfInput }
  | { kind: 'apply'; input: PdfInput; operations: PdfOperation[] }
  | { kind: 'merge'; inputs: PdfInput[] };

export interface InfoResult {
  info: PdfInfo;
  sha256: string;
  size: number;
}

export interface BytesResult {
  bytes: Uint8Array;
  pageCount: number;
  sha256: string;
}

export type TaskResult<T extends PdfTask> = T['kind'] extends 'info' ? InfoResult : BytesResult;

async function load(input: PdfInput): Promise<Uint8Array> {
  return 'bytes' in input ? input.bytes : new Uint8Array(await readFile(input.path));
}

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

async function describe(bytes: Uint8Array): Promise<BytesResult> {
  const info = await getPdfInfo(bytes);
  return { bytes, pageCount: info.pageCount, sha256: sha256(bytes) };
}

export async function runPdfTask(task: PdfTask, font?: Uint8Array): Promise<InfoResult | BytesResult> {
  switch (task.kind) {
    case 'info': {
      const bytes = await load(task.input);
      return { info: await getPdfInfo(bytes), sha256: sha256(bytes), size: bytes.byteLength };
    }
    case 'apply': {
      const out = await applyOperations(await load(task.input), task.operations, { font });
      return describe(out);
    }
    case 'merge': {
      const inputs: Uint8Array[] = [];
      for (const input of task.inputs) inputs.push(await load(input));
      return describe(await mergePdfs(inputs));
    }
  }
}

/** Errors cross the thread boundary as plain objects. */
export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
}

export function serializeError(e: unknown): SerializedError {
  const err = e instanceof Error ? e : new Error(String(e));
  return { name: err.name, message: err.message, stack: err.stack };
}
