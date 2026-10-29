import { HttpException, HttpStatus, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PdfOperationError } from '@pdfhandler/core';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { AppConfig } from '../config/configuration';
import { PdfFontProvider } from '../common/pdf-font.provider';
import { BytesResult, InfoResult, PdfTask, runPdfTask, SerializedError } from './pdf-tasks';

/** Queue full: the client should retry later (503). */
export class PdfBusyException extends HttpException {
  constructor() {
    super(
      { statusCode: 503, error: 'Service Unavailable', message: '서버가 다른 PDF 작업을 처리하느라 바쁩니다. 잠시 후 다시 시도하세요.' },
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}

/** The task ran longer than PDF_TASK_TIMEOUT_MS and its worker was terminated (503). */
export class PdfTimeoutException extends HttpException {
  constructor(seconds: number) {
    super(
      { statusCode: 503, error: 'Service Unavailable', message: `PDF 작업이 ${seconds}초 안에 끝나지 않아 중단했습니다. 문서를 나눠서 다시 시도하세요.` },
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}

/** Unexpected failure inside a worker (bug or resource exhaustion): stays a 500. */
export class PdfWorkerError extends Error {
  constructor(source: SerializedError) {
    super(source.message);
    this.name = `PdfWorkerError(${source.name})`;
    this.stack = source.stack;
  }
}

interface Job {
  id: number;
  task: PdfTask;
  resolve: (value: InfoResult | BytesResult) => void;
  reject: (reason: Error) => void;
}

interface Slot {
  worker: Worker;
  job?: Job;
  timer?: NodeJS.Timeout;
}

/**
 * Fixed-size worker_threads pool for the CPU-heavy pdf-lib work, so a 400-page operation does not
 * stall the event loop (health checks, downloads, other users). At most `size` tasks run at once,
 * up to `queueMax` wait; beyond that requests get 503 immediately instead of piling up memory.
 *
 * PDF_WORKERS=0 runs tasks in-process (the old behaviour; also used automatically when the compiled
 * worker script is missing, e.g. when running from TypeScript sources).
 */
@Injectable()
export class PdfWorkerPool implements OnModuleDestroy {
  private readonly logger = new Logger(PdfWorkerPool.name);
  private readonly slots: Slot[] = [];
  private readonly queue: Job[] = [];
  private readonly size: number;
  private readonly queueMax: number;
  private readonly timeoutMs: number;
  private readonly script = join(__dirname, 'pdf.worker.js');
  private readonly fontPath?: string;
  private inlineRunning = 0;
  private nextId = 1;
  private closed = false;

  constructor(
    config: ConfigService<AppConfig, true>,
    private readonly fonts: PdfFontProvider,
  ) {
    const opts = config.get('workers', { infer: true });
    this.queueMax = Math.max(0, opts.queueMax);
    this.timeoutMs = opts.taskTimeoutMs;
    this.fontPath = config.get('pdfFontPath', { infer: true });
    let size = Math.max(0, Math.floor(opts.size));
    if (size > 0 && !existsSync(this.script)) {
      this.logger.warn(`Worker script ${this.script} not found (running from sources?); PDF work runs in-process.`);
      size = 0;
    }
    this.size = size;
    for (let i = 0; i < size; i++) this.slots.push(this.spawn());
    this.logger.log(size ? `PDF worker pool: ${size} threads, queue ${this.queueMax}, timeout ${this.timeoutMs} ms` : 'PDF work runs in-process (PDF_WORKERS=0)');
  }

  get stats() {
    return { threads: this.size, busy: this.size ? this.slots.filter((s) => s.job).length : this.inlineRunning, queued: this.queue.length };
  }

  run(task: Extract<PdfTask, { kind: 'info' }>): Promise<InfoResult>;
  run(task: Exclude<PdfTask, { kind: 'info' }>): Promise<BytesResult>;
  run(task: PdfTask): Promise<InfoResult | BytesResult> {
    if (this.size === 0) return this.runInline(task);
    if (this.closed) return Promise.reject(new PdfBusyException());
    return new Promise((resolve, reject) => {
      const job: Job = { id: this.nextId++, task, resolve, reject };
      const idle = this.slots.find((s) => !s.job);
      if (idle) return this.dispatch(idle, job);
      if (this.queue.length >= this.queueMax) return reject(new PdfBusyException());
      this.queue.push(job);
    });
  }

  private async runInline(task: PdfTask): Promise<InfoResult | BytesResult> {
    // Same admission control as the pool, so PDF_WORKERS=0 still sheds load.
    if (this.inlineRunning >= 1 + this.queueMax) throw new PdfBusyException();
    this.inlineRunning++;
    try {
      return await runPdfTask(task, this.fonts.font);
    } finally {
      this.inlineRunning--;
    }
  }

  private spawn(): Slot {
    const slot: Slot = { worker: new Worker(this.script, { workerData: { fontPath: this.fontPath } }) };
    slot.worker.on('message', (msg: { id: number; ok: boolean; result?: InfoResult | BytesResult; error?: SerializedError }) => {
      const job = slot.job;
      if (!job || job.id !== msg.id) return;
      this.finish(slot);
      if (msg.ok) job.resolve(msg.result!);
      else job.reject(reviveError(msg.error!));
    });
    slot.worker.on('error', (e) => {
      this.logger.error(`PDF worker crashed: ${e.message}`, e.stack);
      this.replace(slot, new PdfWorkerError({ name: e.name, message: e.message, stack: e.stack }));
    });
    slot.worker.on('exit', (code) => {
      if (this.closed || !this.slots.includes(slot)) return;
      this.logger.error(`PDF worker exited unexpectedly (code ${code})`);
      this.replace(slot, new PdfWorkerError({ name: 'WorkerExit', message: `worker exited with code ${code}` }));
    });
    return slot;
  }

  private dispatch(slot: Slot, job: Job): void {
    slot.job = job;
    slot.timer = setTimeout(() => {
      this.logger.warn(`PDF task ${job.task.kind} exceeded ${this.timeoutMs} ms; terminating its worker`);
      this.replace(slot, new PdfTimeoutException(Math.round(this.timeoutMs / 1000)));
    }, this.timeoutMs);
    slot.worker.postMessage({ id: job.id, task: job.task });
  }

  /** Frees the slot and hands it the next queued job. */
  private finish(slot: Slot): void {
    clearTimeout(slot.timer);
    slot.job = undefined;
    slot.timer = undefined;
    const next = this.queue.shift();
    if (next) this.dispatch(slot, next);
  }

  /** Kills a stuck/crashed worker, fails its job, and puts a fresh worker in its place. */
  private replace(slot: Slot, reason: Error): void {
    const index = this.slots.indexOf(slot);
    if (index < 0) return;
    clearTimeout(slot.timer);
    const job = slot.job;
    slot.job = undefined;
    this.slots.splice(index, 1);
    void slot.worker.terminate();
    job?.reject(reason);
    if (this.closed) return;
    const fresh = this.spawn();
    this.slots.push(fresh);
    const next = this.queue.shift();
    if (next) this.dispatch(fresh, next);
  }

  async onModuleDestroy(): Promise<void> {
    this.closed = true;
    for (const job of this.queue.splice(0)) job.reject(new PdfBusyException());
    await Promise.all(this.slots.map((s) => s.worker.terminate()));
  }
}

function reviveError(e: SerializedError): Error {
  // Input problems detected by the engine stay client errors (400 via PdfExceptionFilter).
  if (e.name === 'PdfOperationError') return new PdfOperationError(e.message);
  return new PdfWorkerError(e);
}
