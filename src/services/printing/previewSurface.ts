/**
 * previewSurface — single Electron-safe entry-point for opening a
 * generated PDF in a dedicated viewer window.
 *
 * Audit reference: ADR-0015 (Electron document preview).
 *
 * In a normal browser / PWA the existing iframe-blob flow inside
 * `PrintPreviewDialog` is the right primitive. In Electron, that flow
 * additionally requires:
 *   1. `webPreferences.plugins = true` on the main window (so the
 *      bundled Chromium PDF viewer registers), and
 *   2. `frame-src 'self' blob:` in the CSP (so the iframe is actually
 *      allowed to commit to a blob: URL).
 * Both are fixed in `electron/main.ts`. This module is the escape hatch
 * for the "still won't render" case (corporate CSP overrides, Chromium
 * regression, etc.) and the canonical surface for any code that wants
 * to *open the PDF in its own window* instead of an in-dialog iframe.
 *
 * Contract:
 *   - `isElectron()` — feature-detect once.
 *   - `openPdfPreview(blob, opts)` — open the PDF in a dedicated
 *     BrowserWindow (Electron) or a new tab (web). Returns a disposer
 *     the caller can ignore in most cases; the underlying window owns
 *     its own lifecycle.
 */

import { openPdfInNewTab } from "@/services/printing/pdfUtils";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pos = (): any =>
  typeof window !== "undefined" ? (window as any).pos : undefined;

export function isElectron(): boolean {
  return !!pos()?.isElectron;
}


export interface OpenPdfPreviewOptions {
  title?: string;
  filename?: string;
}

export async function openPdfPreview(
  blob: Blob,
  opts: OpenPdfPreviewOptions = {},
): Promise<{ ok: boolean; error?: string }> {
  const bridge = pos();
  if (isElectron() && bridge?.preview?.openPdf) {
    try {
      const buf = new Uint8Array(await blob.arrayBuffer());
      const res = await bridge.preview.openPdf(buf, {
        title: opts.title,
        filename: opts.filename,
      });

      if (!res?.success) {
        return { ok: false, error: res?.error || "Electron preview failed" };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
  // Web/PWA fallback — open in a new browser tab.
  openPdfInNewTab(blob, opts.title);
  return { ok: true };
}

/**
 * Print an existing PDF blob through the Electron-safe main-process
 * handler. In a browser, falls back to the hidden-iframe print flow.
 */
export async function printPdfBlob(
  blob: Blob,
  opts: { silent?: boolean; deviceName?: string } = {},
): Promise<{ ok: boolean; error?: string }> {
  const bridge = pos();
  if (isElectron() && bridge?.print?.pdfBytes) {
    try {
      const buf = new Uint8Array(await blob.arrayBuffer());
      const res = await bridge.print.pdfBytes(buf, opts);

      if (!res?.success) {
        return { ok: false, error: res?.error || "Electron print failed" };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
  const { printPdfInPage } = await import("@/services/printing/pdfUtils");
  await printPdfInPage(blob);
  return { ok: true };
}