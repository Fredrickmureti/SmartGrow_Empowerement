# ADR-0015 — Electron-safe document preview

## Status
Accepted — 2026-05-20

## Context
Document preview (invoices, bills, POs, sales orders, delivery notes,
credit notes, returns, statements, payroll runs, POS receipts, reports
— ~30 surfaces) is funnelled through `PrintPreviewDialog`, which
fetches a server-rendered PDF blob from `generate-document` and binds it
to an `<iframe src={blob:…}>`. Chromium's built-in PDF viewer handles
the rendering.

This works in browsers/PWA but produced **blank white preview windows**
plus intermittent `TypeError: Object has been destroyed` errors in the
packaged Electron desktop build.

## Root causes
1. **Chromium PDF plugin disabled by default.** Electron's
   `BrowserWindow.webPreferences.plugins` defaults to `false`, so
   `<iframe src="blob:…pdf">` cannot render — the iframe shows a
   permanently blank document.
2. **CSP `frame-src` omitted `blob:`.** The production CSP installed in
   `electron/main.ts` did not include `blob:` in `frame-src` /
   `object-src`, so Chromium silently refused to commit the iframe to
   the blob URL even when the plugin was enabled.
3. **Hidden print BrowserWindows with unsafe lifecycle.** The
   `print:html`, `print:silent`, and `print:to-pdf` IPC handlers used
   arbitrary `setTimeout` sleeps, called `printWindow.close()` from
   inside the print callback (racing the webContents teardown), and had
   no error/cleanup path — leaking windows and surfacing
   `Object has been destroyed`.
4. **Renderer hidden-iframe print racing React unmount.** Closing the
   preview dialog while a print job was still queued removed the
   iframe and revoked its blob URL, producing the same destroyed-object
   error from the renderer side.

## Decision
- Enable `plugins: true` and admit `blob:` to `frame-src` / `object-src`
  in the main window's CSP.
- Centralise hidden-window lifecycle behind a single
  `runInHiddenPrintWindow` helper (await `loadURL`/`loadFile` properly,
  guard with `isDestroyed`, defer destroy with `setImmediate`, reject
  on `render-process-gone`).
- Add an Electron-native preview path
  (`preview:open-pdf` IPC + `window.pos.preview.openPdf`) that writes
  the PDF to `userData/preview-cache` and opens it in a dedicated
  BrowserWindow with `plugins: true`. Exposed in the UI as
  "Open in window" — both an enhancement and an escape hatch.
- Add a lifecycle-safe `print:pdf-bytes` IPC and route
  `printPdfInPage` through it when running under Electron. Browser
  iframe path retained for web/PWA with `afterprint`-driven cleanup
  and `isConnected` guards.

## Consequences
- Web/PWA behaviour unchanged — iframe-blob path still primary.
- Electron preview reliably renders without blank windows.
- `Object has been destroyed` from preview/print paths is eliminated.
- Temp PDF files are written to `userData/preview-cache`; cleaned on
  window close, plus a 24 h sweep at startup.
- Future document surfaces must funnel through `PrintPreviewDialog` (or
  `previewSurface` for non-dialog use cases) — no ad-hoc blob iframes.