/**
 * POS receipt renderers barrel.
 *
 * Milestone B — POS receipt renderer demotion:
 *   The legacy `ThermalPrintRenderer` and `PdfRenderer` modules were
 *   removed. Their bytes were already produced server-side by
 *   `generate-document`; the two client wrappers only added a thin
 *   dispatch layer that has now moved into `PrintClient` (see
 *   `printClient.printReceiptThermal` / `printClient.renderReceiptPdfBlob`).
 *   All POS surfaces MUST print through `printClient`, keeping this
 *   barrel scoped to on-screen renderers only.
 */
export { PreviewRenderer, type ReceiptPaperWidth } from "./PreviewRenderer";
export { showSuccessOnCustomerDisplay, type UpdateDisplayFn } from "./CustomerDisplayRenderer";
