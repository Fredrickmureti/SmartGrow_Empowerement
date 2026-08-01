/**
 * PDF Utility Functions
 * 
 * Replaces all window.print() usage with server-side PDF generation.
 * Following Odoo's model: Print = generate PDF server-side → open/download.
 */

import { supabase } from "@/integrations/supabase/client";

/**
 * Open a PDF blob in a new browser tab for printing.
 * The browser's native PDF viewer provides its own print button.
 */
export function openPdfInNewTab(blob: Blob, title?: string): void {
  const url = URL.createObjectURL(blob);
  const win = window.open(url, "_blank");
  if (!win) {
    // Popup blocked — fall back to download
    downloadPdfBlob(blob, `${title || "document"}.pdf`);
  }
  // Revoke after a delay to allow the tab to load
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Print a PDF blob in-page using a hidden iframe.
 * Triggers the browser's native print dialog without navigating away.
 * This matches Odoo's behavior where print stays on the current page.
 *
 * ADR-0015 (Electron document preview audit):
 *   - In Electron, route through the main-process handler instead of an
 *     in-renderer hidden iframe. The renderer iframe approach is fragile
 *     under file:// + CSP and races with React unmount cleanup, producing
 *     `TypeError: Object has been destroyed` when the user closes the
 *     dialog while the print job is still queued.
 *   - In the browser, wait for `load` instead of an arbitrary 1 s
 *     timeout, guard `isConnected` before `removeChild`, and revoke the
 *     blob URL only after `afterprint` (or a safety timeout) so the
 *     native print dialog still sees the source.
 */
export async function printPdfInPage(blob: Blob): Promise<void> {
  // Wave B3 (Plan P1) — global FIFO queue for the PDF/iframe transport.
  //
  // Prior behaviour: two overlapping printPdfInPage calls each spawned
  // their own hidden iframe + native print dialog. In practice the
  // second dialog either stacked on top of the first (blocking the
  // page) or, more commonly, callers guarded the button with a local
  // `isPrinting` boolean that discarded the second click at the DOM
  // level — so rapid Print-Invoice clicks silently lost jobs 2..N.
  //
  // Fix: chain every call onto a module-scoped promise so the second
  // call's iframe/print dialog does not open until the first resolves
  // (via `afterprint` or the 60 s safety timeout). Different documents
  // share the queue because a browser can only host one native print
  // dialog at a time; per-document keys would not help. This mirrors
  // the label path's per-endpoint FIFO in `agent/src/routes/print.ts`
  // and `AgentClient._withEndpointLock`.
  const next = pdfPrintQueue
    .catch(() => undefined)
    .then(() => runPrintPdfInPage(blob));
  pdfPrintQueue = next;
  return next;
}

// Module-scoped FIFO tail. Never rejects — errors from an individual
// job are caught before being chained, so a failing job never poisons
// the queue for subsequent jobs.
let pdfPrintQueue: Promise<void> = Promise.resolve();

async function runPrintPdfInPage(blob: Blob): Promise<void> {
  // Electron path — defer to the main-process lifecycle-supervised
  // hidden window so renderer unmount can never race the print job.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bridge: any = typeof window !== "undefined" ? (window as any).pos : undefined;
  if (bridge?.isElectron && bridge.print?.pdfBytes) {
    const buf = new Uint8Array(await blob.arrayBuffer());
    const res = await bridge.print.pdfBytes(buf, { silent: false });
    if (!res?.success) {
      throw new Error(res?.error || "Electron print failed");
    }
    return;
  }

  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const iframe = document.createElement("iframe");
    iframe.style.position = "fixed";
    iframe.style.top = "-10000px";
    iframe.style.left = "-10000px";
    iframe.style.width = "1px";
    iframe.style.height = "1px";
    iframe.style.opacity = "0";
    document.body.appendChild(iframe);

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      try {
        if (iframe.isConnected) iframe.parentNode?.removeChild(iframe);
      } catch (_e) {
        /* iframe was already detached — ignore */
      }
      try { URL.revokeObjectURL(url); } catch { /* ignore */ }
      resolve();
    };

    iframe.onload = () => {
      try {
        const cw = iframe.contentWindow;
        if (!cw) {
          cleanup();
          return;
        }
        const onAfterPrint = () => {
          try { cw.removeEventListener("afterprint", onAfterPrint); } catch { /* ignore */ }
          cleanup();
        };
        try { cw.addEventListener("afterprint", onAfterPrint); } catch { /* ignore */ }

        cw.focus();
        cw.print();
      } catch (e) {
        console.error("In-page print failed:", e);
        cleanup();
        return;
      }
      // Safety: if afterprint never fires (Chromium PDF viewer often
      // doesn't), clean up after 60 s. Matches openPdfInNewTab's TTL.
      setTimeout(cleanup, 60_000);
    };

    iframe.onerror = () => cleanup();
    iframe.src = url;
  });
}

/**
 * Test-only. Returns a promise that resolves when the current PDF
 * print queue is fully drained. Do NOT rely on this in production
 * code — it is exposed so architecture tests can assert FIFO
 * behaviour without racing the queue.
 */
export function __printPdfInPageQueueDrained(): Promise<void> {
  return pdfPrintQueue.catch(() => undefined);
}


/**
 * Download a PDF blob as a file.
 */
export function downloadPdfBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  setTimeout(() => {
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, 100);
}

/**
 * Optional paper-format override accepted at every document-render entry
 * point. Kept here (not in a hook) so the printing service is the single
 * source of truth for the shape of the request body.
 */
export type PaperFormatOption =
  | "a4" | "letter" | "a5" | "80mm" | "58mm" | "40mm"
  | { widthMm: number; heightMm: number | "auto" };

/**
 * What the server decided about paper and render mode for this document.
 * The renderer reports it back on every call so preview surfaces can show
 * the operator *why* a document came out thermal or A4 without having to
 * re-derive policy on the client.
 */
export interface DocumentRenderPolicyInfo {
  source: string;
  paper: string;
  renderMode: string;
  /** Thermal character columns; null for PDF renders. */
  columns: number | null;
  font: string | null;
  /** `media_profiles.id` the policy resolved to, when one applied. */
  profileId: string | null;
  /** True when the server overrode the requested paper/render mode. */
  coerced: boolean;
}

export interface DocumentRenderResponse {
  blob: Blob;
  policy: DocumentRenderPolicyInfo | null;
}

/**
 * The ONE transport to the server document renderer.
 *
 * Raw `fetch` rather than `supabase.functions.invoke` because the renderer
 * reports its policy decision in `X-Print-Policy-*` response headers, and
 * `invoke` discards headers. Every caller — PDF, ESC/POS, preview, test
 * print — comes through here, so there is exactly one place that knows the
 * endpoint, the auth shape, the policy headers, and the error contract.
 */
async function callDocumentRenderer(
  body: Record<string, unknown>,
): Promise<DocumentRenderResponse> {
  const client = supabase as unknown as {
    functionsUrl?: string;
    supabaseUrl?: string;
    supabaseKey?: string;
  };
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData?.session?.access_token;
  const url = `${client.functionsUrl || `${client.supabaseUrl}/functions/v1`}/generate-document`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token ?? client.supabaseKey ?? ""}`,
      apikey: client.supabaseKey ?? "",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let message = `Document render failed (${res.status})`;
    try {
      message = ((await res.json()) as { error?: string }).error || message;
    } catch {
      /* non-JSON error body — keep the status message */
    }
    throw new Error(message);
  }

  const h = res.headers;
  const source = h.get("X-Print-Policy-Source");
  const paper = h.get("X-Print-Policy-Paper");
  const renderMode = h.get("X-Print-Policy-Render-Mode");
  const columns = h.get("X-Print-Policy-Columns");

  return {
    blob: await res.blob(),
    policy:
      source && paper && renderMode
        ? {
            source,
            paper,
            renderMode,
            columns: columns ? Number(columns) : null,
            font: h.get("X-Print-Policy-Font"),
            profileId: h.get("X-Print-Policy-Profile-Id"),
            coerced: h.get("X-Print-Policy-Coerced") === "1",
          }
        : null,
  };
}

/**
 * Render any document body and return raw bytes plus the resolved policy.
 *
 * This is the seam for non-PDF renders that need the full policy decision —
 * the POS test print, which sends unsaved receipt settings rather than a
 * persisted document id. Callers pass the request body verbatim; nothing
 * here inspects or rewrites it.
 */
export async function renderDocumentBytesWithPolicy(
  body: Record<string, unknown>,
): Promise<{ bytes: Uint8Array; policy: DocumentRenderPolicyInfo | null }> {
  const { blob, policy } = await callDocumentRenderer(body);
  return { bytes: new Uint8Array(await blob.arrayBuffer()), policy };
}


function assertPdf(blob: Blob, header: string): Blob {
  const looksLikePdfType = blob.type === "application/pdf" || blob.type === "";
  const looksLikePdfBytes = header === "%PDF";

  if (!looksLikePdfBytes && !looksLikePdfType) {
    throw new Error(
      `Server did not return a PDF (content-type=${blob.type || "unknown"}). ` +
      `This usually means the print policy coerced the request — try downloading ` +
      `as ESC/POS instead, or change the receipt paper format to A4.`
    );
  }
  if (!looksLikePdfBytes) {
    throw new Error(
      "Server returned a file that is not a valid PDF. Refusing to save a corrupt receipt."
    );
  }
  return blob.type === "application/pdf" ? blob : new Blob([blob], { type: "application/pdf" });
}

/**
 * Generate a document PDF server-side and return the blob plus the policy
 * the server applied.
 */
export async function generateDocumentPdfWithPolicy(
  documentType: string,
  documentId: string,
  opts?: {
    forceRefreshSettings?: boolean;
    /**
     * Override the resolved policy's paper format for this render only.
     * Used by the POS receipt fallback path: when no thermal printer is
     * bound we render the same receipt on a real A4 sheet instead of
     * emitting a tall 80 mm PDF into Chrome's native print dialog.
     */
    paperFormat?: PaperFormatOption;
    /**
     * Extra fields merged into the request body. Used by live-computed
     * statements (recipient/customer/vendor) that need to carry
     * `periodStart` / `periodEnd` / `businessId` alongside the document
     * identity. Never overrides `documentType`, `documentId`, or `format`.
     */
    extraBody?: Record<string, unknown>;
    /** Scope the render to a branch so branch policy overrides apply. */
    branchId?: string | null;
  },
): Promise<DocumentRenderResponse> {
  const { blob, policy } = await callDocumentRenderer({
    ...(opts?.extraBody ?? {}),
    documentType,
    documentId,
    format: "pdf",
    ...(opts?.branchId ? { branchId: opts.branchId } : {}),
    ...(opts?.forceRefreshSettings ? { force_refresh_settings: true } : {}),
    ...(opts?.paperFormat ? { paperFormat: opts.paperFormat } : {}),
  });

  // The server may coerce a request to ESC/POS. Validate that what came
  // back is really a PDF before handing it to a viewer, otherwise the
  // saved file shows "Failed to load PDF document".
  let header = "";
  try {
    header = new TextDecoder().decode(new Uint8Array(await blob.slice(0, 4).arrayBuffer()));
  } catch {
    /* fall through to the type check */
  }

  return { blob: assertPdf(blob, header), policy };
}

/**
 * Generate a document PDF via the server-side renderer and return the blob.
 */
export async function generateDocumentPdf(
  documentType: string,
  documentId: string,
  opts?: {
    forceRefreshSettings?: boolean;
    paperFormat?: PaperFormatOption;
    extraBody?: Record<string, unknown>;
    branchId?: string | null;
  },
): Promise<Blob> {
  return (await generateDocumentPdfWithPolicy(documentType, documentId, opts)).blob;
}


/**
 * Generate a document PDF and open it in a new tab for printing.
 */
export async function printDocumentPdf(
  documentType: string,
  documentId: string,
  title?: string
): Promise<void> {
  const blob = await generateDocumentPdf(documentType, documentId);
  await printPdfInPage(blob);
}

/**
 * Generate a document PDF and download it.
 */
export async function downloadDocumentPdf(
  documentType: string,
  documentId: string,
  filename: string
): Promise<void> {
  const blob = await generateDocumentPdf(documentType, documentId);
  downloadPdfBlob(blob, `${filename}.pdf`);
}

/**
 * Fetch raw ESC/POS bytes from the server document renderer. Used by the
 * receipt/kitchen-ticket paths that stream bytes to a thermal printer.
 *
 * Server resolves paper width from `document_print_policies` (default
 * 80 mm) unless the caller overrides it.
 */
export async function generateDocumentEscPosBytes(
  documentType: string,
  documentId: string,
  opts?: {
    forceRefreshSettings?: boolean;
    /** Kitchen-ticket routing: station banner / course / table. */
    station?: string | null;
    course?: string | null;
    table?: string | null;
    /** Per-call paper override. */
    paperFormat?: "40mm" | "58mm" | "80mm" | null;
    /** Scope the render to a branch so branch policy overrides apply. */
    branchId?: string | null;
    /**
     * Ask the renderer explicitly for thermal output. Needed when the
     * resolved policy is PDF but the operator picked a thermal printer.
     */
    forceRenderMode?: boolean;
  },
): Promise<Uint8Array> {
  const { blob } = await callDocumentRenderer({
    documentType,
    documentId,
    format: "escpos",
    ...(opts?.forceRenderMode ? { renderMode: "escpos" } : {}),
    ...(opts?.branchId ? { branchId: opts.branchId } : {}),
    ...(opts?.forceRefreshSettings ? { force_refresh_settings: true } : {}),
    ...(opts?.station ? { station: opts.station } : {}),
    ...(opts?.course ? { course: opts.course } : {}),
    ...(opts?.table ? { table: opts.table } : {}),
    ...(opts?.paperFormat ? { paperFormat: opts.paperFormat } : {}),
  });
  return new Uint8Array(await blob.arrayBuffer());
}


