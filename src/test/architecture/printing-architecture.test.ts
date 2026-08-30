/**
 * THE printing architecture guard.
 *
 * AccrualFlow has exactly one printing architecture. Every printable
 * business artifact — invoices, POS receipts, kitchen tickets, purchase
 * orders, delivery notes, inventory labels, HR letters, payslips, and
 * whatever module ships next — travels the same layers:
 *
 *   Business Event
 *     → PrintService
 *     → print_jobs (ledger)
 *     → render
 *     → resolve device
 *     → dispatch.toDevice
 *     → execForIntent
 *     → hardwareClient.execAssignment
 *     → Agent → Printer
 *     → update job status
 *
 * This file is the executable statement of that architecture. It fails
 * when a second pipeline, a second dispatcher, a second ledger writer, a
 * second renderer, or a legacy fallback re-appears. Read the failure
 * message as "you have started building the second printing system" and
 * route the new caller through PrintService instead of relaxing the rule.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';

const SRC = resolve(__dirname, '../..');

function read(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'test' || entry === '__tests__') continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const APP_FILES = walk(SRC).filter((f) => !f.includes(`${'/'}integrations${'/'}supabase${'/'}types.ts`));

function filesMatching(pattern: RegExp, exclude: string[] = []): string[] {
  return APP_FILES.filter((f) => {
    const rel = f.slice(SRC.length + 1);
    if (exclude.some((e) => rel === e)) return false;
    return pattern.test(readFileSync(f, 'utf8'));
  }).map((f) => f.slice(SRC.length + 1));
}


/** Source with type-only imports stripped — types are not architecture. */
function valueSource(file: string): string {
  return readFileSync(file, 'utf8').replace(
    /import\s+type\s[\s\S]*?from\s*['"][^'"]+['"];?/g,
    '',
  );
}

function filesImporting(pattern: RegExp, exclude: string[] = []): string[] {
  return APP_FILES.filter((f) => {
    const rel = f.slice(SRC.length + 1);
    if (exclude.includes(rel)) return false;
    return pattern.test(valueSource(f));
  }).map((f) => f.slice(SRC.length + 1));
}

// ────────────────────────────────────────────────────────────────────
// 1. The legacy architectures are gone — not deprecated, gone.
// ────────────────────────────────────────────────────────────────────

describe('printing architecture — no legacy pipelines survive', () => {
  const REMOVED = [
    // The old god-object print facade.
    'services/printing/PrintClient.ts',
    // The old preview-or-print fork that let callers skip the ledger.
    'hooks/usePrintOrPreview.ts',
    // The browser worker that drained hardware_command_queue as a
    // *transport*. Recovery now lives in services/printing/recovery.ts
    // and operates on print_jobs, the single ledger.
    'services/hardware/SharedCommandQueueWorker.ts',
  ];

  for (const rel of REMOVED) {
    it(`${rel} no longer exists`, () => {
      expect(existsSync(join(SRC, rel))).toBe(false);
    });
  }

  it('nothing imports a removed module', () => {
    expect(
      filesMatching(/from\s+["']@\/(services\/printing\/PrintClient|hooks\/usePrintOrPreview|services\/hardware\/SharedCommandQueueWorker)["']/),
    ).toEqual([]);
  });

  it('no code enqueues onto the retired hardware command queue', () => {
    // hardware_command_queue was the second transport. Printing state
    // lives in print_jobs; hardware commands are executed synchronously.
    expect(filesMatching(/enqueue_hardware_command|claim_next_hardware_command/)).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────
// 2. One dispatcher. One device resolution. One agent call.
// ────────────────────────────────────────────────────────────────────

describe('printing architecture — one hardware dispatch implementation', () => {
  it('only dispatch.ts calls execForIntent', () => {
    expect(filesMatching(/\bexecForIntent\s*\(/, ['services/hardware/execForIntent.ts'])).toEqual([
      'services/printing/dispatch.ts',
    ]);
  });

  it('only execForIntent calls hardwareClient.execAssignment', () => {
    const callers = filesMatching(/hardwareClient\.execAssignment\s*\(/, [
      'services/hardware/HardwareClient.ts',
    ]);
    // `useHardwareProxy` is the raw hardware console seam (test prints,
    // drawer kicks, device diagnostics) — it never renders or ledgers a
    // business document. Document printing has exactly one caller.
    expect(callers.sort()).toEqual(
      ['hooks/hardware/useHardwareProxy.ts', 'services/hardware/execForIntent.ts'].sort(),
    );
  });

  it('dispatch.ts is the only module that decides pdf/thermal/download transport', () => {
    const dispatch = read('services/printing/dispatch.ts');
    expect(dispatch).toMatch(/export async function toDevice/);
    expect(dispatch).toMatch(/export (async )?function toPage/);
    expect(dispatch).toMatch(/export (async )?function toDownload/);
  });

  it('device resolution stays inside execForIntent', () => {
    // A caller that resolves `device_assignments` itself and then talks to
    // the agent has forked the resolution path.
    const rogue = filesMatching(/from\(['"]device_assignments['"]\)/, [
      'services/hardware/execForIntent.ts',
      'services/hardware/HardwareClient.ts',
    ]).filter((f) => /execAssignment\s*\(/.test(read(f)));
    expect(rogue).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────
// 3. One ledger writer.
// ────────────────────────────────────────────────────────────────────

describe('printing architecture — one print ledger', () => {
  it('only jobs.ts calls the print_job_* RPCs', () => {
    expect(filesMatching(/rpc\(\s*['"]print_job_/, [])).toEqual(['services/printing/jobs.ts']);
  });

  it('only PrintService and the operator workspace open or claim ledger rows', () => {
    // Value imports only — a shared `PrintTransport` type is not a writer.
    const importers = filesImporting(
      /from\s+['"](\.\/jobs|@\/services\/printing\/jobs)['"]/,
    );
    // PrintService owns the ledger lifecycle and is now the only writer —
    // the hardware operator console was removed with the platform/hardware
    // surface. Recovery selects rows and delegates dispatch, so it needs the
    // row type only — never the writers.
    expect(importers.sort()).toEqual(['services/printing/PrintService.ts']);
  });

  it('only jobs.ts calls the requeue RPC', () => {
    expect(filesMatching(/requeue_print_job/, [])).toEqual(['services/printing/jobs.ts']);
  });


  it('nothing outside the printing service writes print_jobs directly', () => {
    const writers = filesMatching(/from\(['"]print_jobs['"]\)[\s\S]{0,80}\.(insert|update|upsert|delete)\(/);
    expect(writers).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────
// 4. One rendering pipeline.
// ────────────────────────────────────────────────────────────────────

describe('printing architecture — one rendering pipeline', () => {
  it('the legacy generate-document renderers have no callers left', () => {
    // The `generate-document` render backend is retired: every printable
    // artifact is frozen into a `document_records` row (bridged by
    // `services/documents/resolveSourceDocumentRecord.ts` for legacy
    // (type, id) pairs) and rendered by `render-document`. A caller
    // reappearing here means a second rendering path was reintroduced.
    const callers = filesMatching(/generateDocumentPdf\s*\(|generateDocumentEscPosBytes\s*\(/, [
      'services/printing/pdfUtils.ts',
    ]);
    expect(callers).toEqual([]);
  });


  it('only render.ts invokes the render-document function', () => {
    const callers = filesMatching(/functions\.invoke\(\s*['"]render-document['"]/);
    expect(callers).toEqual(['services/printing/render.ts']);
  });

  it('label rendering produces a payload and does not dispatch', () => {
    const label = read('services/printing/labelDispatch.ts');
    expect(label).toMatch(/export async function renderLabelPayload/);
    expect(label).not.toMatch(/execForIntent|hardwareClient/);
  });
});

// ────────────────────────────────────────────────────────────────────
// 5. One entry point — no surface may bypass PrintService.
// ────────────────────────────────────────────────────────────────────

describe('printing architecture — PrintService is the only entry point', () => {
  const PIPELINE_INTERNALS = [
    'services/printing/PrintService.ts',
    'services/printing/recovery.ts',
    'services/printing/dispatch.ts',
    'services/printing/render.ts',
    'services/printing/jobs.ts',
    'services/printing/labelDispatch.ts',
    'services/printing/policy.ts',
    'services/printing/reprintClient.ts',
  ];

  it('feature code never imports pipeline internals directly', () => {
    // `import type` is allowed — a shared type is not a second pipeline.
    const leaks = filesImporting(
      /from\s+['"]@\/services\/printing\/(dispatch|render|labelDispatch|policy)['"]/,
      PIPELINE_INTERNALS,
    ).filter((f) => !f.startsWith('services/printing/'));
    // One sanctioned use, which is not a second print pipeline:
    // documentExport renders `csv`/`xlsx` mediums of the SAME frozen
    // snapshot through the render seam, so an extract cannot disagree with
    // the printed copy. It touches no policy, job or device code.
    expect(leaks).toEqual(['services/exports/documentExport.ts']);
  });

  it('document intents are enqueued only by PrintService', () => {
    const callers = filesMatching(/enqueueDocumentIntent\s*\(/, [
      'services/documents/submitIntent.ts',
    ]);
    expect(callers).toEqual(['services/printing/PrintService.ts']);
  });

  it('submitDocumentIntent is not resurrected as a public entry point', () => {
    expect(filesMatching(/\bsubmitDocumentIntent\b/)).toEqual([]);
  });

  it('exactly one document preview dialog exists', () => {
    // Reports preview through `components/reports/ReportPreviewDialog.tsx`
    // (render-report: no document record, no print policy, no device
    // routing). Documents preview through
    // `components/common/PrintPreviewDialog.tsx`. A second component named
    // `PrintPreviewDialog` would mean two document preview surfaces — that
    // is the drift this guard forbids.
    const defs = filesMatching(/export function PrintPreviewDialog\b/);
    expect(defs).toEqual(['components/common/PrintPreviewDialog.tsx']);
  });

  it('no feature code drives the browser print dialog itself', () => {
    const rogue = filesMatching(/^(?![^\n]*(\/\/|\*)).*(window\.print\(\)|contentWindow\?\.print\(\))/m, [
      'services/printing/dispatch.ts',
      'components/common/PrintPreviewDialog.tsx',
    ]);
    expect(rogue).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────
// 6. The spool is infrastructure, never a transport.
// ────────────────────────────────────────────────────────────────────

describe('printing architecture — the spool never becomes the transport', () => {
  it('PrintService dispatches intents in the foreground', () => {
    const svc = read('services/printing/PrintService.ts');
    // Enqueue, then immediately drain the rows this session created.
    expect(svc).toMatch(/enqueueDocumentIntent\(/);
    expect(svc).toMatch(/loadJobs\(/);
    expect(svc).toMatch(/dispatchQueuedJob\(/);
  });

  it('recovery re-uses the canonical dispatcher rather than its own', () => {
    const rec = read('services/printing/recovery.ts');
    expect(rec).toMatch(/import \{ dispatchQueuedJob[\s\S]*?from '\.\/PrintService'/);
    expect(rec).not.toMatch(/execForIntent|hardwareClient|renderDocumentRecord|generateDocument/);
  });

  it('recovery only touches jobs the owning session abandoned', () => {
    const rec = read('services/printing/recovery.ts');
    // An age cutoff is what separates "recovery" from "transport".
    expect(rec).toMatch(/ABANDON_AFTER_MS/);
    expect(rec).toMatch(/\.lt\('created_at', cutoff\)/);
  });

  it('the recovery sweeper is started once, by the saga mount', () => {
    expect(filesMatching(/startPrintRecoverySweeper\(/, ['services/printing/recovery.ts'])).toEqual([
      'components/events/BusinessSagaMount.tsx',
    ]);
  });
});
