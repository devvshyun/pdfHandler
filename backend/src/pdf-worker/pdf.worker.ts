// Worker-thread entry point (compiled to dist/pdf-worker/pdf.worker.js). One task at a time.
import { readFileSync } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import { PdfTask, runPdfTask, serializeError } from './pdf-tasks';

interface Request {
  id: number;
  task: PdfTask;
}

let font: Uint8Array | undefined;
const fontPath = (workerData as { fontPath?: string } | undefined)?.fontPath;
if (fontPath) {
  try {
    font = new Uint8Array(readFileSync(fontPath));
  } catch {
    // The main thread already logs a missing PDF_FONT_PATH; text ops then fall back to Helvetica.
  }
}

parentPort!.on('message', async ({ id, task }: Request) => {
  try {
    const result = await runPdfTask(task, font);
    let transfer: ArrayBuffer[] = [];
    if ('bytes' in result) {
      // Transfer (not copy) the output; copy first if it is a view into a larger buffer.
      const b = result.bytes;
      if (b.byteOffset !== 0 || b.byteLength !== b.buffer.byteLength) result.bytes = b.slice();
      transfer = [result.bytes.buffer as ArrayBuffer];
    }
    parentPort!.postMessage({ id, ok: true, result }, transfer);
  } catch (e) {
    parentPort!.postMessage({ id, ok: false, error: serializeError(e) });
  }
});
