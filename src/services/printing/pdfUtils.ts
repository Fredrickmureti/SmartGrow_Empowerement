/**
 * PDF presentation utilities.
 *
 * Blob-in, browser-out. This module knows how to *show* or *save* bytes
 * that somebody else produced — it never talks to a render endpoint.
 * Rendering has exactly one seam: `@/services/printing/render`.
 */

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
