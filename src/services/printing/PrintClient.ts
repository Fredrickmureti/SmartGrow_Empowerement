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
    try {
      if (fmt === 'pdf') {
        // Receipt intent rendering to PDF means no thermal printer is
        // bound (or the policy explicitly asked for PDF). The document
        // shape must follow the destination device: hand Chrome's native
        // print dialog an A4/Letter sheet, never a tall thermal strip.
        const paperOverride = req.intent === 'receipt' || req.intent === 'kitchen_ticket'
          ? ('a4' as const)
          : undefined;
        const blob = await generateDocumentPdf(req.documentType, req.documentId, paperOverride ? { paperFormat: paperOverride } : undefined);
        for (let i = 0; i < copies; i++) {
          await printPdfInPage(blob);
        }
        const electron = typeof window !== 'undefined' && Boolean((window as unknown as { pos?: { isElectron?: boolean } }).pos?.isElectron);
        return { success: true, transport: electron ? 'pdf-electron' : 'pdf-browser', policy };
      }
      if (fmt === 'escpos') {
        const bytes = await generateDocumentEscPosBytes(req.documentType, req.documentId);
        for (let i = 0; i < copies; i++) {
          await hardwareClient.printRawBytes(bytes);
        }
        return { success: true, transport: 'thermal', policy };
      }
      if (fmt === 'zpl') {
        const bytes = await this.renderLabelBytes(req.documentType, req.documentId);
        for (let i = 0; i < copies; i++) {
          await hardwareClient.printLabelBytes(bytes);
        }
        return { success: true, transport: 'thermal', policy };
      }
      return { success: false, transport: 'none', error: `Unsupported format ${fmt}`, policy };
    } catch (err) {
      return { success: false, transport: 'none', error: (err as Error).message, policy };
    }
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
      await hardwareClient.printRawBytes(bytes);
      return { success: true, transport: 'thermal' };
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

  /** Save the document as a PDF to the user's downloads folder. */
  async download(req: PrintRequest, filename: string): Promise<PrintResult> {
    try {
      const blob = await generateDocumentPdf(req.documentType, req.documentId);
      downloadPdfBlob(blob, filename.endsWith('.pdf') ? filename : `${filename}.pdf`);
      return { success: true, transport: 'download' };
    } catch (err) {
      return { success: false, transport: 'none', error: (err as Error).message };
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
}

export const printClient = new PrintClient();
