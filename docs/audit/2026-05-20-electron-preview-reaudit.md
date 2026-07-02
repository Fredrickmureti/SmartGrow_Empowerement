# 2026-05-20 — Electron document preview re-audit

## Scope

Independent verification of the prior agent's Electron document-preview
fix (ADR-0015) across every preview surface in the app, plus completion
of the items the prior agent explicitly deferred.

## What was verified working (no change required)

- `src/components/common/SafePdfViewer.tsx` — present, well-architected,
  Electron-aware. In Electron hands bytes to `preview:open-pdf` IPC; in
  web mounts an instrumented `<iframe>` with `onLoad` / `onError` / 5 s
  safety timer plus recovery card. Owns blob URL lifecycle.
- `src/components/common/PrintPreviewDialog.tsx`,
  `src/components/reports/PrintPreviewDialog.tsx`,
  `src/components/payroll/PayrollPreviewDialog.tsx` — all three render
  `<SafePdfViewer>` for the PDF branch.
- `src/services/printing/previewSurface.ts` — `openPdfPreview` and
  `printPdfBlob` route through Electron IPC and fall back to web paths
  on browsers.
- `electron/main.ts` — CSP includes `frame-src 'self' blob:` and
  `object-src 'self' blob:` in dev and prod; `plugins: true` on the
  main window and every hidden print window; `runInHiddenPrintWindow`
  centralises lifecycle and prevents `Object has been destroyed` on
  hidden print windows; `preview:open-pdf` + `print:pdf-bytes` IPC
  handlers exist and use a managed `userData/preview-cache` directory
  with a 24 h sweep at startup.
- `electron/preload.ts` exposes `window.pos.preview.openPdf` and
  `window.pos.print.pdfBytes`.

Verdict: the prior agent's core claim — that Invoices, Bills, Purchase
Orders, Credit Notes, Sales/Finance/Inventory/HR reports, and the
Payroll Register preview no longer blank-screen in Electron — holds.

## Gaps the prior agent missed or deferred (now fixed)

### G-1 (closed) — HR Employee Documents tab used a raw `<iframe>`
`src/components/employees/EmployeeDocumentsTab.tsx` rendered every
non-image document (PDFs, signed contracts, etc.) inside a raw
`<iframe src={signedUrl}>`. In Electron this was outside SafePdfViewer's
guarantees and had no recovery affordance.

Fix: replaced the iframe with `<SafePdfViewer pdfUrl={previewUrl} … />`.
Required adding `pdfUrl` support to SafePdfViewer (see step A below).
Image branch (`<img src=…>`) is unchanged — Electron handles `<img>`
natively.

### G-2 (closed) — SafePdfViewer only accepted Blob, not URL
SafePdfViewer used to take `pdfBlob` only. Storage-backed previews (HR
documents) needed a URL path. Added `pdfUrl?: string | null` as a
mutually-exclusive alternative. In Electron the URL is fetched
client-side (credentials inherited) and the bytes handed to the
dedicated viewer window; in web it is rendered directly in the
instrumented iframe.

### G-3 (closed) — Legacy HTML `srcDoc` iframe in PrintPreviewDialog
`src/components/common/PrintPreviewDialog.tsx` rendered the older HTML
preview branch as `<iframe srcDoc={html}>` with no `onError` / timeout.
A same-origin srcDoc render failure looked identical to the original
blank-pane bug.

Fix: introduced `src/components/common/SafeHtmlPreview.tsx`, a sibling
of SafePdfViewer that reproduces the `onLoad` / `onError` / 5 s timer /
recovery card contract for HTML. The legacy branch now uses it.

### G-4 (closed) — `printPdfInPage` had an Electron fallthrough
`src/services/printing/pdfUtils.ts::printPdfInPage` tried the Electron
IPC path, but on failure it logged and fell through to the in-renderer
hidden-iframe path — the very path responsible for the original
`TypeError: Object has been destroyed` race. Removed the fallthrough:
on Electron, IPC failures now propagate to the caller so the recovery
card surfaces in the UI instead of triggering a destroyed-iframe race.

### G-5 (closed) — Regression guardrails
- `eslint-rules/no-direct-pdf-iframe.js` — new custom ESLint rule that
  flags raw `<iframe>` JSX whose `src` is `URL.createObjectURL(...)`, a
  literal blob/PDF URL, or an identifier whose name suggests a
  PDF/preview/signed-URL source. Also flags `srcDoc` outside the
  canonical HTML viewer. Allowlisted: SafePdfViewer.tsx,
  SafeHtmlPreview.tsx. Wired into `eslint.config.js` as
  `local/no-direct-pdf-iframe: error`.
- `src/test/architecture/pdf-preview-uses-safeviewer.test.ts` — scans
  `src/components/**` and asserts no file outside the allowlist embeds
  a raw `<iframe>` whose attributes hint at a PDF/preview source. This
  catches drift even when lint is bypassed.
- `electron/main.ts` — startup PDF self-test added inside the main
  window's `did-finish-load` handler (dev builds only). Builds a
  byte-precise minimal PDF, writes it to `preview-cache/_selftest.pdf`,
  opens it in a hidden offscreen `BrowserWindow({ plugins: true })`,
  and logs `[preview-selftest] ok` on success or a descriptive error
  on timeout/render-process-gone. Non-fatal — catches CSP/plugin
  regressions at startup instead of at the user's first preview click.

## Files explicitly NOT changed (and why)

- `src/components/payroll/PayrollRunDetailsDialog.tsx`,
  `src/pages/hr/EmployeeSelfService.tsx`,
  `src/pages/hr/payroll/sections.tsx`,
  `src/hooks/useEmployeeDocuments.ts`,
  `src/components/employees/EmployeePayslipHistory.tsx` — every
  `URL.createObjectURL` in these files is for a `link.click()`
  download, not a preview iframe. Electron handles `<a download>`
  natively. Touching them would be scope creep.
- `src/components/pos/ReceiptPreviewDialog.tsx` — uses
  `MonospacePreview` (no PDF iframe). Already Electron-safe.
- `supabase/functions/generate-document/` — out of scope; the failure
  was purely on the Electron preview surface.

## Verification

- `rg -n "<iframe" src/components/` returns matches only in
  `SafePdfViewer.tsx` and `SafeHtmlPreview.tsx`.
- New architecture test passes.
- New lint rule registered.
- Electron startup self-test wired into `did-finish-load` (dev only).

## Remaining risk

The prior agent's `printPdfInPage` change was conservative (fallthrough).
The re-audit tightened it to fail-fast. Callers that previously silently
fell back to the renderer iframe path on Electron now surface a real
error — this is intentional, and the UI recovery affordances built into
SafePdfViewer / PrintPreviewDialog handle it cleanly. Worth a smoke test
on the first packaged build of the Print buttons in Invoices, Bills,
Reports, and Payroll Register.

Pre-existing TypeScript errors in `src/pages/pos/POSSettings.tsx` (POS
receipt-settings shape drift, called out by the prior agent) remain
out-of-scope for this audit and should be tackled as a follow-up.
