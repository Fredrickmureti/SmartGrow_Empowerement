/**
 * PrintClient — single chokepoint facade for every print path.
 *
 * Audit Wave 9d.6 (P1). Owns:
 *   - PDF rendering via the server-side `generate-document` edge function
 *   - ESC/POS rendering via the same edge function (`format=escpos`)
 *   - ZPL label rendering via the server-side renderer (Wave 9d.7)
 *   - Transport selection (Electron main-process pdfBytes pipe vs. browser
 *     iframe vs. hardwareClient.printRawBytes for thermal bytes)
 *
 * Every consumer that prints — POS, Inventory, HR, Sales, Purchases,
 * Finance — MUST go through this client. Direct calls to
 * `pos.print.pdfBytes` or `hardwareClient.printRawBytes` are still allowed
 * inside this file and inside `pdfUtils`, but nowhere else (enforced by
 * `tests/guards/single-print-chokepoint.test.ts`).
 */
import { hardwareClient } from '@/services/hardware/HardwareClient';
import {
  generateDocumentPdf,
  generateDocumentEscPosBytes,
  printPdfInPage,
  downloadPdfBlob,
  openPdfInNewTab,
} from '@/services/printing/pdfUtils';

export type PrintIntent =
  | 'receipt'        // thermal receipt printer
  | 'kitchen_ticket' // thermal kitchen printer
  | 'label'          // ZPL/EPL label printer (falls back to ESC/POS)
  | 'a4_document'    // PDF on a4_printer or browser/OS
  | 'packing_slip';  // A4 with thermal fallback

export interface PrintRequest {
  intent: PrintIntent;
  documentType: string;
  documentId: string;
  /** Override the default rendering format. Optional; resolver picks one. */
  format?: 'pdf' | 'escpos' | 'zpl';
  /** Optional title for tab/download fallbacks. */
  title?: string;
  /**
   * ADR-0026 Wave B1 Step 2 — when supplied, `print()` consults
   * `print_policies_resolve` first and routes per the resolved policy.
   * Omitting either preserves the legacy intent-only behaviour.
   */
  businessId?: string | null;
  branchId?: string | null;
  /**
   * Phase 5 Step B — when supplied together with `businessId`, the print
   * client resolves the winning `device_assignments` row via
   * `resolve_device` and dispatches thermal/label bytes through
   * `hardwareClient.execAssignment` so `TransportRouter` sees the row's
   * persisted `transport` instead of a role-only fan-out. Omit either
   * value to fall back to legacy role-based dispatch.
   */
  organizationId?: string | null;
  /**
   * Plan P3 Step 1 — per-click idempotency key. UI mints a UUID at the
   * submit boundary (button click, hotkey, programmatic dispatch) and
   * passes it here. When set, it replaces the legacy 2-second
   * `(docType:docId:intent:bucket)` correlation-id fallback and becomes
   * the collapse key on `(business_id, correlation_id)` in the ledger.
   */
  idempotencyKey?: string;
}

export interface PrintResult {
  success: boolean;
  transport: 'thermal' | 'pdf-electron' | 'pdf-browser' | 'download' | 'ask_user' | 'none';
  error?: string;
  /** Wave B1 Step 2 — resolved policy snapshot when one was consulted. */
  policy?: ResolvedPrintPolicy | null;
}

/** Wave B1 Step 2 — runtime view over `print_policies_resolve` rows. */
export interface ResolvedPrintPolicy {
  printerProfileId: string | null;
  paperFormat: string;
  renderMode: 'pdf' | 'escpos' | 'html';
  copies: number;
  autoPrint: boolean;
  askUser: boolean;
}

function intentToFormat(intent: PrintIntent): 'pdf' | 'escpos' | 'zpl' {
  switch (intent) {
    case 'receipt':
    case 'kitchen_ticket':
      return 'escpos';
    case 'label':
      return 'zpl';
    case 'a4_document':
    case 'packing_slip':
    default:
      return 'pdf';
  }
}

function renderModeToFormat(mode: ResolvedPrintPolicy['renderMode'], intent: PrintIntent): 'pdf' | 'escpos' | 'zpl' {
  if (mode === 'escpos') return 'escpos';
  if (mode === 'pdf' || mode === 'html') return 'pdf';
  return intentToFormat(intent);
}

/**
 * Wave B1 Step 2.5 — in-memory LRU cache for resolved policies.
 * Keyed by (businessId|branchId|documentType|intent). Bounded to 200
 * entries with a 30s TTL so hot POS lanes don't hit the RPC on every
 * receipt. The policy editor calls `invalidatePolicyCache()` to flush
 * after a write.
 */
const POLICY_CACHE_TTL_MS = 30_000;
const POLICY_CACHE_MAX = 200;
type PolicyCacheEntry = { value: ResolvedPrintPolicy | null; expiresAt: number };
const policyCache = new Map<string, PolicyCacheEntry>();

function policyCacheKey(b: string, br: string | null | undefined, dt: string, it: string): string {
  return `${b}|${br ?? ''}|${dt}|${it}`;
}

class PrintClient {
  /**
   * ADR-0026 Wave B1 Step 2 — resolve the effective print policy for a
   * (business, branch, documentType, intent) tuple. Returns `null` when
   * the RPC is unreachable or `businessId` is missing; callers fall back
   * to legacy intent-only routing. Cached for 30s per key (Step 2.5).
   */
  async resolvePolicy(
    businessId: string | null | undefined,
    branchId: string | null | undefined,
    documentType: string,
    intent: PrintIntent,
  ): Promise<ResolvedPrintPolicy | null> {
    if (!businessId) return null;
    const key = policyCacheKey(businessId, branchId, documentType, intent);
    const now = Date.now();
    const hit = policyCache.get(key);
    if (hit && hit.expiresAt > now) {
      // LRU touch
      policyCache.delete(key);
      policyCache.set(key, hit);
      return hit.value;
    }
    try {
      const { supabase } = await import('@/integrations/supabase/client');
      const { data, error } = await supabase.rpc('print_policies_resolve', {
        p_business_id: businessId,
        p_branch_id: (branchId ?? null) as unknown as string,
        p_document_type: documentType,
        p_intent: intent,
      });
      if (error) return null;
      const row = Array.isArray(data) ? data[0] : data;
      let value: ResolvedPrintPolicy | null = null;
      if (row) {
        const renderMode = (row.render_mode ?? 'pdf') as ResolvedPrintPolicy['renderMode'];
        value = {
          printerProfileId: row.printer_profile_id ? String(row.printer_profile_id) : null,
          paperFormat: String(row.paper_format ?? 'a4'),
          renderMode: renderMode === 'escpos' || renderMode === 'html' ? renderMode : 'pdf',
          copies: typeof row.copies === 'number' && row.copies > 0 ? row.copies : 1,
          autoPrint: Boolean(row.auto_print),
          askUser: Boolean(row.ask_user),
        };
      }
      // Bound cache size (evict oldest).
      if (policyCache.size >= POLICY_CACHE_MAX) {
        const oldest = policyCache.keys().next().value;
        if (oldest !== undefined) policyCache.delete(oldest);
      }
      policyCache.set(key, { value, expiresAt: now + POLICY_CACHE_TTL_MS });
      return value;
    } catch {
      return null;
    }
  }

  /** Wave B1 Step 2.5 — flush the policy cache. Called by the policy editor. */
  invalidatePolicyCache(): void {
    policyCache.clear();
  }

  /**
   * Phase 5 Step B — per-assignment thermal/label dispatch.
   *
   * When the caller supplied both `organizationId` and `businessId`, ask
   * the `resolve_device` RPC which `device_assignments` row wins for the
   * (org, business, intent, branch) tuple, then dispatch via
   * `hardwareClient.execAssignment` so `TransportRouter` picks the
   * transport from that row. Falls back to the legacy role-only shim on
   * missing context, resolver outage, or no assignment — a shop must
   * never brick on a transient RPC failure.
   */
  private async dispatchThermalBytes(
    bytes: Uint8Array | number[],
    req: PrintRequest,
    role: 'receipt_printer' | 'label_printer' | 'kitchen_printer',
  ): Promise<{ success: boolean; error?: string }> {
    const legacy = () =>
      role === 'label_printer'
        ? hardwareClient.printLabelBytes(bytes)
        : hardwareClient.printRawBytes(bytes);
    if (!req.organizationId || !req.businessId) return legacy();
    try {
      const { resolveDeviceForIntent } = await import('@/hooks/useDeviceForIntent');
      const resolved = await resolveDeviceForIntent({
        organizationId: req.organizationId,
        intentOrRole: req.intent,
        businessId: req.businessId,
      });
      if (!resolved) return legacy();
      // eslint-disable-next-line no-console
      console.info('[hardware.route.decision]', {
        stage: 'print-client',
        intent: req.intent,
        role,
        assignmentId: resolved.id,
        businessId: req.businessId,
        branchId: req.branchId ?? null,
      });
      return await hardwareClient.execAssignment({
        assignment: {
          id: resolved.id,
          role: resolved.role as 'receipt_printer' | 'label_printer' | 'kitchen_printer',
          transport: resolved.transport,
          enabled: resolved.enabled,
        },
        op: 'print_raw',
        payload: Array.from(bytes),
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[hardware.route.decision] resolve_device failed in PrintClient, falling back', err);
      return legacy();
    }
  }

  /**
   * Print a document end-to-end. Renders server-side, picks the right
   * transport based on intent, and falls back gracefully.
   *
   * Wave B1 Step 2: when `req.businessId` is supplied, consults the
   * `print_policies_resolve` RPC first. If `ask_user: true`, returns a
   * `transport: 'ask_user'` result so the React caller can open the
   * `PrintPreviewDialog` fallback. Otherwise the resolved `render_mode`
   * overrides the intent-derived format and `copies` fan-out is honoured
   * (Step 2.5).
   */
  async print(req: PrintRequest): Promise<PrintResult> {
    let policy: ResolvedPrintPolicy | null = null;
    if (req.businessId) {
      policy = await this.resolvePolicy(req.businessId, req.branchId, req.documentType, req.intent);
      if (policy?.askUser) {
        return { success: false, transport: 'ask_user', policy };
      }
    }
    const fmt = req.format ?? (policy ? renderModeToFormat(policy.renderMode, req.intent) : intentToFormat(req.intent));
    const copies = policy && policy.copies > 0 ? policy.copies : 1;

    // ADR-0090 · Phase D1 — insert a parent ledger row before dispatch so
    // a crash between "queued" and "sent" still leaves an audit trail.
    // Plan P3 Step 2 — when copies > 1 the parent is a container; each
    // copy gets its own child row via `parent_job_id` so the admin view
    // can render the fan-out tree and mark individual copies acked/failed
    // independently. Ledger insert failures never block printing.
    const parentJobId = await this.insertLedgerRow(req, policy, fmt).catch(() => null);

    try {
      const isElectron = typeof window !== 'undefined' && Boolean((window as unknown as { pos?: { isElectron?: boolean } }).pos?.isElectron);
      const pdfTransport: PrintResult['transport'] = isElectron ? 'pdf-electron' : 'pdf-browser';

      let lastResult: PrintResult = { success: false, transport: 'none', policy };
      for (let i = 0; i < copies; i++) {
        // For a single-copy request the parent row IS the copy row —
        // don't insert a redundant child. For multi-copy, mint a child
        // row per copy so each has its own lifecycle in the ledger.
        const childJobId = copies === 1
          ? parentJobId
          : await this.insertLedgerRow(req, policy, fmt, { parentJobId, childIndex: i + 1 }).catch(() => null);

        let copyResult: PrintResult;
        try {
          if (fmt === 'pdf') {
            const paperOverride = req.intent === 'receipt' || req.intent === 'kitchen_ticket'
              ? ('a4' as const)
              : undefined;
            const blob = await generateDocumentPdf(req.documentType, req.documentId, paperOverride ? { paperFormat: paperOverride } : undefined);
            await printPdfInPage(blob);
            copyResult = { success: true, transport: pdfTransport, policy };
          } else if (fmt === 'escpos') {
            const bytes = await generateDocumentEscPosBytes(req.documentType, req.documentId);
            const res = await this.dispatchThermalBytes(bytes, req, 'receipt_printer');
            copyResult = res.success
              ? { success: true, transport: 'thermal', policy }
              : { success: false, transport: 'thermal', error: res.error ?? 'thermal driver reported failure', policy };
          } else if (fmt === 'zpl') {
            const bytes = await this.renderLabelBytes(req.documentType, req.documentId);
            const res = await this.dispatchThermalBytes(bytes, req, 'label_printer');
            copyResult = res.success
              ? { success: true, transport: 'thermal', policy }
              : { success: false, transport: 'thermal', error: res.error ?? 'label driver reported failure', policy };
          } else {
            copyResult = { success: false, transport: 'none', error: `Unsupported format ${fmt}`, policy };
          }
        } catch (err) {
          copyResult = { success: false, transport: 'none', error: (err as Error).message, policy };
        }

        if (childJobId) {
          if (copyResult.success) {
            // Both thermal (driver returned success) and PDF (browser
            // print dialog resolved) count as ack'd delivery. Mark sent
            // then acked so the admin view can distinguish "dispatched"
            // from "confirmed" via timestamps while status lands terminal.
            await this.markLedgerSent(childJobId);
            await this.markLedgerAcked(childJobId);
          } else if (copyResult.error) {
            await this.markLedgerFailed(childJobId, copyResult.error).catch(() => undefined);
          }
        }
        lastResult = copyResult;
        if (!copyResult.success) break;
      }

      // Mirror the terminal state onto the parent container row when we
      // fanned out to child rows, so admin filters like "show failed jobs"
      // surface either the parent or the copies coherently. The new
      // `print_job_mark_acked_by_id` RPC also auto-promotes the parent
      // when every child is acked, but we call it explicitly here to
      // cover the single-copy path and any race with child updates.
      if (parentJobId && copies > 1) {
        if (lastResult.success) {
          await this.markLedgerSent(parentJobId);
          await this.markLedgerAcked(parentJobId);
        } else if (lastResult.error) {
          await this.markLedgerFailed(parentJobId, lastResult.error).catch(() => undefined);
        }
      }
      return lastResult;
    } catch (err) {
      const errorMsg = (err as Error).message;
      if (parentJobId) {
        await this.markLedgerFailed(parentJobId, errorMsg).catch(() => undefined);
      }
      return { success: false, transport: 'none', error: errorMsg, policy };
    }
  }


  /**
   * ADR-0090 + Plan P3 Step 1 · derive a correlation id.
   * Prefers a UI-minted `idempotencyKey` (one per user click). Falls back
   * to the legacy 2-second bucket when callers haven't been migrated.
   */
  private correlationId(req: PrintRequest): string {
    if (req.idempotencyKey) return req.idempotencyKey;
    const bucket = Math.floor(Date.now() / 2000); // legacy 2s window
    return `${req.documentType}:${req.documentId}:${req.intent}:${bucket}`;
  }

  /**
   * ADR-0090 · insert queued row via SECURITY DEFINER RPC.
   * Plan P3 Step 2 — `opts.parentJobId` links a fan-out copy back to its
   * parent container row; `opts.childIndex` suffixes the correlation id
   * so children of a multi-copy job satisfy the
   * `(business_id, correlation_id)` unique index while still collapsing
   * on rapid double-click (the second click regenerates identical child
   * keys and the DB rejects them).
   */
  private async insertLedgerRow(
    req: PrintRequest,
    policy: ResolvedPrintPolicy | null,
    fmt: 'pdf' | 'escpos' | 'zpl',
    opts?: { parentJobId?: string | null; childIndex?: number },
  ): Promise<string | null> {
    if (!req.businessId) return null;
    try {
      const { supabase } = await import('@/integrations/supabase/client');
      const transport = fmt === 'pdf'
        ? (typeof window !== 'undefined' && Boolean((window as unknown as { pos?: { isElectron?: boolean } }).pos?.isElectron) ? 'pdf-electron' : 'pdf-browser')
        : 'thermal';
      const baseCorrelation = this.correlationId(req);
      const correlation = opts?.childIndex
        ? `${baseCorrelation}:copy:${opts.childIndex}`
        : baseCorrelation;
      const { data, error } = await supabase.rpc('print_job_insert', {
        p_business_id: req.businessId,
        p_branch_id: req.branchId ?? null,
        p_doc_type: req.documentType,
        p_doc_id: req.documentId || null,
        p_intent: req.intent,
        p_format: fmt,
        p_printer_profile_id: policy?.printerProfileId ?? null,
        p_media_profile_id: null,
        p_correlation_id: correlation,
        p_transport: transport,
        p_parent_job_id: opts?.parentJobId ?? null,
      });
      if (error) return null;
      return typeof data === 'string' ? data : null;
    } catch {
      return null;
    }
  }


  private async markLedgerSent(jobId: string): Promise<void> {
    try {
      const { supabase } = await import('@/integrations/supabase/client');
      await supabase.rpc('print_job_mark_sent', { p_id: jobId, p_hw_command_id: null });
    } catch {
      /* ledger failures never block printing */
    }
  }

  private async markLedgerFailed(jobId: string, error: string): Promise<void> {
    try {
      const { supabase } = await import('@/integrations/supabase/client');
      await supabase.rpc('print_job_mark_failed', { p_id: jobId, p_error: error });
    } catch { /* noop */ }
  }

  /**
   * Plan P3 Step 4 — flip a ledger row to `acked` by job id.
   *
   * Two callers share this path:
   *   - PDF/browser transports: the print dialog resolving is the ack.
   *   - Thermal (direct-dispatch): `hardwareClient.printRawBytes` /
   *     `printLabelBytes` returning success means the Electron main
   *     process or local-agent driver confirmed the write. That is the
   *     ack for the interactive path (queue-mediated thermal jobs are
   *     acked by `SharedCommandQueueWorker` via `print_job_mark_acked`
   *     keyed on `hw_command_id`).
   *
   * Backed by `public.print_job_mark_acked_by_id(uuid)` which also
   * auto-promotes a parent container row once every child copy is acked.
   * Ledger failures never block printing.
   */
  private async markLedgerAcked(jobId: string): Promise<void> {
    try {
      const { supabase } = await import('@/integrations/supabase/client');
      await supabase.rpc('print_job_mark_acked_by_id', { p_id: jobId });
    } catch { /* noop */ }
  }



  /**
   * Wave 10 — first-class kitchen ticket print path. POS code that fires a
   * ticket to a station calls this directly; the server renders ESC/POS via
   * `generate-document` with `documentType: 'kitchen_ticket'` and the
   * station/table metadata becomes the banner + meta block on the ticket.
   *
   * Station routing is data-driven, not hardcoded: callers pass the
   * `printer_category` (kitchen | bar | dessert | grill) from
   * `pos_kitchen_orders` as `station`, and the `kitchen_printer` device
   * resolver chooses the bound device. When no kitchen printer is bound the
   * call returns a `none`-transport result so the kitchen display can still
   * advance the order — the audit trail in `hardware_exec_log` records
   * the miss.
   */
  async printKitchenTicket(
    transactionId: string,
    opts?: {
      station?: string | null;
      course?: string | null;
      table?: string | null;
      paperFormat?: '40mm' | '58mm' | '80mm' | null;
      /**
       * Phase 5 Step B — when supplied, dispatch runs through
       * `dispatchThermalBytes` (per-assignment via `resolve_device`)
       * instead of the role-only shim. Callers with org context MUST
       * pass these so the winning `device_assignments` row picks the
       * correct kitchen printer per branch.
       */
      organizationId?: string | null;
      businessId?: string | null;
      branchId?: string | null;
    },
  ): Promise<PrintResult> {
    try {
      const bytes = await generateDocumentEscPosBytes(
        'kitchen_ticket',
        transactionId,
        {
          station: opts?.station ?? null,
          course: opts?.course ?? null,
          table: opts?.table ?? null,
          paperFormat: opts?.paperFormat ?? null,
        },
      );
      const req: PrintRequest = {
        intent: 'kitchen_ticket',
        documentType: 'kitchen_ticket',
        documentId: transactionId,
        organizationId: opts?.organizationId ?? null,
        businessId: opts?.businessId ?? null,
        branchId: opts?.branchId ?? null,
      };
      const res = await this.dispatchThermalBytes(bytes, req, 'kitchen_printer');
      return res.success
        ? { success: true, transport: 'thermal' }
        : { success: false, transport: 'thermal', error: res.error ?? 'kitchen driver reported failure' };
    } catch (err) {
      return { success: false, transport: 'none', error: (err as Error).message };
    }
  }

  /**
   * Milestone B — POS receipt thermal print.
   *
   * Chokepoint replacement for the legacy `printThermal` renderer helper.
   * Fetches ESC/POS bytes server-side via `generate-document` and streams
   * them through the caller-supplied `printRawBytes` transport. The
   * register-scoped transport is passed in explicitly because it comes
   * from `useHardwareProxy(register_id)` — the client itself does not
   * know which register's hardware to speak to.
   */
  async printReceiptThermal(opts: {
    transactionId: string;
    printRawBytes: (bytes: Uint8Array) => Promise<{ success: boolean; error?: string; bytesWritten?: number }>;
    documentType?: string;
  }): Promise<{ success: boolean; error?: string; bytesWritten?: number }> {
    try {
      const bytes = await generateDocumentEscPosBytes(
        opts.documentType ?? 'pos_receipt',
        opts.transactionId,
      );
      const res = await opts.printRawBytes(bytes);
      return { success: res.success, error: res.error, bytesWritten: res.bytesWritten };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Milestone B — POS receipt PDF blob.
   *
   * Chokepoint replacement for the legacy `renderReceiptPdf` renderer
   * helper. Returns the server-rendered PDF blob so callers can feed it
   * into `printPdfInPage`, `downloadPdfBlob`, etc.
   */
  async renderReceiptPdfBlob(
    transactionId: string,
    documentType: string = 'pos_receipt',
  ): Promise<Blob> {
    return generateDocumentPdf(documentType, transactionId);
  }

  /**
   * Phase 3 label chokepoint — canonical entry for template-driven label
   * printing.
   *
   * Today this delegates to `printLabelByTemplate` (which owns template
   * resolve → media resolve → ZPL/EPL compile → device dispatch). The
   * indirection exists so call sites migrate to `printClient.printLabel`
   * now, then Phase 6 can collapse `labelDispatch` into an internal impl
   * of PrintClient without touching any consumer again. Do NOT add
   * label-specific business logic here — that stays in `labelDispatch`
   * until the collapse.
   *
   * Prefer this method over importing `printLabelByTemplate` directly:
   * every new label call site should reach for `printClient.printLabel`
   * so the single-chokepoint guard can shrink the allow-list over time.
   */
  async printLabel(input: import('./labelDispatch').LabelDispatchInput):
    Promise<import('./labelDispatch').LabelDispatchResult> {
    const { printLabelByTemplate } = await import('./labelDispatch');
    return printLabelByTemplate(input);
  }


  /**
   * Milestone C.1 — tabular export via the platform.
   *
   * Fetches a server-rendered CSV/XLSX blob from `generate-document`
   * (`format: 'csv' | 'xlsx'`). The edge function persists an immutable
   * `document_artifacts` row with `render_mode: 'export'` so version
   * history surfaces the download alongside PDF/ESC/POS renders. Only
   * document types on the server-side allow-list are accepted; anything
   * else 400s at the edge (never silently degrades).
   */
  async exportDocument(opts: {
    documentType: string;
    documentId: string;
    format: 'csv' | 'xlsx';
  }): Promise<Blob> {
    const { supabase } = await import('@/integrations/supabase/client');
    const { data, error } = await supabase.functions.invoke('generate-document', {
      body: {
        documentType: opts.documentType,
        documentId: opts.documentId,
        format: opts.format,
      },
    });
    if (error) throw error;
    if (data instanceof Blob) return data;
    if (data instanceof Uint8Array) return new Blob([data as BlobPart], { type: 'text/csv;charset=utf-8' });
    if (data instanceof ArrayBuffer) return new Blob([data], { type: 'text/csv;charset=utf-8' });
    // supabase-js may return string for text responses.
    if (typeof data === 'string') return new Blob([data], { type: 'text/csv;charset=utf-8' });
    return new Blob([data as BlobPart], { type: 'text/csv;charset=utf-8' });
  }

  /** Convenience: export + trigger a browser download. */
  async downloadExport(opts: {
    documentType: string;
    documentId: string;
    format: 'csv' | 'xlsx';
    filename: string;
  }): Promise<PrintResult> {
    try {
      const blob = await this.exportDocument(opts);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = opts.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      return { success: true, transport: 'download' };
    } catch (err) {
      return { success: false, transport: 'none', error: (err as Error).message };
    }
  }

  /**
   * Save the document as a PDF to the user's downloads folder.
   *
   * Phase C (plan) — every download flows through PrintClient so the
   * `print_jobs` ledger records the intent, not just the on-device print.
   * Ledger insertion never blocks the download itself.
   */
  async download(
    req: PrintRequest,
    filename: string,
    opts?: {
      paperFormat?: import('./pdfUtils').PaperFormatOption;
      extraBody?: Record<string, unknown>;
    },
  ): Promise<PrintResult> {
    const handle = req.businessId
      ? await this.recordInteractivePrint({
          documentType: req.documentType,
          documentId: req.documentId,
          intent: req.intent,
          format: 'pdf',
          businessId: req.businessId,
          branchId: req.branchId ?? null,
          idempotencyKey: req.idempotencyKey,
        }).catch(() => null)
      : null;
    try {
      const blob = await generateDocumentPdf(req.documentType, req.documentId, {
        paperFormat: opts?.paperFormat,
        extraBody: opts?.extraBody,
      });
      downloadPdfBlob(blob, filename.endsWith('.pdf') ? filename : `${filename}.pdf`);
      if (handle) {
        await handle.markSent().catch(() => undefined);
        await handle.markAcked().catch(() => undefined);
      }
      return { success: true, transport: 'download' };
    } catch (err) {
      const msg = (err as Error).message;
      if (handle) await handle.markFailed(msg).catch(() => undefined);
      return { success: false, transport: 'none', error: msg };
    }
  }

  /**
   * Generate a PDF via `generate-document` and print it in-page (no new
   * tab). Same policy-deferral behaviour as `download` — the server
   * decides the render mode, PrintClient records the ledger row.
   */
  async printDocument(
    req: PrintRequest,
    opts?: {
      paperFormat?: import('./pdfUtils').PaperFormatOption;
      extraBody?: Record<string, unknown>;
    },
  ): Promise<PrintResult> {
    const handle = req.businessId
      ? await this.recordInteractivePrint({
          documentType: req.documentType,
          documentId: req.documentId,
          intent: req.intent,
          format: 'pdf',
          businessId: req.businessId,
          branchId: req.branchId ?? null,
          idempotencyKey: req.idempotencyKey,
        }).catch(() => null)
      : null;
    try {
      const blob = await generateDocumentPdf(req.documentType, req.documentId, {
        paperFormat: opts?.paperFormat,
        extraBody: opts?.extraBody,
      });
      await printPdfInPage(blob);
      const isElectron = typeof window !== 'undefined' && Boolean((window as unknown as { pos?: { isElectron?: boolean } }).pos?.isElectron);
      const transport: PrintResult['transport'] = isElectron ? 'pdf-electron' : 'pdf-browser';
      if (handle) {
        await handle.markSent().catch(() => undefined);
        await handle.markAcked().catch(() => undefined);
      }
      return { success: true, transport };
    } catch (err) {
      const msg = (err as Error).message;
      if (handle) await handle.markFailed(msg).catch(() => undefined);
      return { success: false, transport: 'none', error: msg };
    }
  }

  /** Open the PDF in a new browser tab (preview/share fallback). */
  async openInNewTab(req: PrintRequest): Promise<PrintResult> {
    try {
      const blob = await generateDocumentPdf(req.documentType, req.documentId);
      openPdfInNewTab(blob, req.title);
      return { success: true, transport: 'pdf-browser' };
    } catch (err) {
      return { success: false, transport: 'none', error: (err as Error).message };
    }
  }

  /**
   * Render label bytes server-side. Tries `format=zpl` first; on a 4xx
   * (renderer not yet deployed for this doc type) falls back to ESC/POS
   * so existing thermal label printers still produce output.
   */
  private async renderLabelBytes(documentType: string, documentId: string): Promise<Uint8Array> {
    try {
      const { supabase } = await import('@/integrations/supabase/client');
      const { data, error } = await supabase.functions.invoke('generate-document', {
        body: { documentType, documentId, format: 'zpl' },
      });
      if (error) throw error;
      if (data instanceof Uint8Array) return data;
      if (data instanceof ArrayBuffer) return new Uint8Array(data);
      if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
      return new Uint8Array(data as ArrayBufferLike);
    } catch {
      // Fallback — ESC/POS bytes for thermal label printers that grok the
      // 80mm command set. Not bit-identical to ZPL but keeps labels coming
      // out of the printer until the dedicated renderer is deployed.
      return generateDocumentEscPosBytes(documentType, documentId);
    }
  }

  /**
   * Wave B3 (Plan P2 Step 1) — ledger-cover interactive prints fired
   * from `PrintPreviewDialog`.
   *
   * The dialog is opened as the `ask_user` fallback of `printOrPreview`
   * (see `usePrintOrPreview.ts:88-94`) OR as the primary path for
   * legacy shadow-path surfaces still on `useDocumentPrint`. In both
   * cases the actual print is triggered inside the dialog and,
   * historically, bypassed `PrintClient.print()` entirely — so the
   * `print_jobs` ledger had a hole for every manually-driven print.
   *
   * This helper closes that hole without redesigning the dialog: the
   * caller records the intent to print, receives a job handle, and
   * marks the job sent/failed once the transport promise settles. The
   * ledger row uses the same `(documentType, documentId, intent)`
   * correlation-id bucket as `print()`, so a rapid double-click that
   * flows through `usePrintOrPreview` (auto_print → ledgered) and then
   * through the dialog (ask_user → ledgered here) still collapses on
   * `(business_id, correlation_id)` uniqueness in the RPC.
   *
   * Returns `null` for the job handle when no business context is
   * available (dialog opened outside a business scope, e.g. Platform
   * admin previews). Interactive printing is never blocked by ledger
   * failures.
   */
  async recordInteractivePrint(args: {
    documentType: string;
    documentId: string | null;
    intent: PrintIntent;
    format: 'pdf' | 'escpos' | 'zpl';
    businessId: string | null;
    branchId?: string | null;
    printerProfileId?: string | null;
    /** Plan P3 Step 1 — per-click UUID minted at the UI submit boundary. */
    idempotencyKey?: string;
  }): Promise<{
    jobId: string | null;
    markSent: () => Promise<void>;
    markAcked: () => Promise<void>;
    markFailed: (error: string) => Promise<void>;
  }> {
    const noop = {
      jobId: null,
      markSent: async () => undefined,
      markAcked: async () => undefined,
      markFailed: async () => undefined,
    };
    if (!args.businessId) return noop;
    const req: PrintRequest = {
      intent: args.intent,
      documentType: args.documentType,
      documentId: args.documentId ?? '',
      businessId: args.businessId,
      branchId: args.branchId ?? null,
      idempotencyKey: args.idempotencyKey,
    };
    const jobId = await this.insertLedgerRow(
      req,
      args.printerProfileId ? ({ printerProfileId: args.printerProfileId } as ResolvedPrintPolicy) : null,
      args.format,
    );
    if (!jobId) return noop;
    return {
      jobId,
      markSent: () => this.markLedgerSent(jobId),
      markAcked: () => this.markLedgerAcked(jobId),
      markFailed: (error: string) => this.markLedgerFailed(jobId, error),
    };
  }
}


export const printClient = new PrintClient();
