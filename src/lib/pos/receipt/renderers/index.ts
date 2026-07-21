/**
 * POS receipt renderers barrel.
 *
 * Milestone B — POS receipt renderer demotion:
 *   The legacy `ThermalPrintRenderer` / `PdfRenderer` client wrappers
 *   were folded into `printClient` (see
 *   `printClient.printReceiptThermal` / `printClient.renderReceiptPdfBlob`).
 *
 * Wave 4 — PreviewRenderer removal:
 *   The old HTML/Tailwind `PreviewRenderer` component was retired in
 *   favour of the unified monospace pipeline
 *   (`buildReceiptLines` + `MonospacePreview`), which shares its row
 *   metadata with the server-side ESC/POS and thermal-PDF renderers.
 *   This barrel now only re-exports the customer-display renderer and
 *   the `ReceiptPaperWidth` type alias that a few POS surfaces still
 *   use to describe the active thermal width.
 */
export { showSuccessOnCustomerDisplay, type UpdateDisplayFn } from "./CustomerDisplayRenderer";

/**
 * Thermal paper widths supported by the unified receipt engine. Kept on
 * the renderer barrel for backwards-compatible imports from POS surfaces
 * (e.g. `PostPaymentSurface`). The canonical enum lives in the shared
 * engine (`_shared/receipt/engine/PrinterProfile.ts` + its client mirror
 * `src/lib/receipt/engine/PrinterProfile.ts` as `PaperWidth`).
 */
export type ReceiptPaperWidth = "40mm" | "58mm" | "80mm";
