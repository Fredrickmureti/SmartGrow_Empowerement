/**
 * Phase B — provider-agnostic fiscal block adapters.
 *
 * The ESC/POS builder consumes a typed `FiscalBlock` (see `_shared/escpos/blocks.ts`).
 * Each fiscal regulator provides a small mapper here that converts its
 * native shape into a FiscalBlock; the builder never grows a switch
 * statement on provider names.
 *
 * Today only KRA eTIMS ships. ZRA / EFRIS / SUNAT etc. drop in here as
 * additional ~30-line adapters with no builder edits required.
 */
import type { FiscalBlock } from "../escpos/blocks.ts";

/**
 * Read the legacy eTIMS fields off a doc payload (set by the snapshot
 * fetcher AND the live fetcher) and produce a typed FiscalBlock.
 *
 * Returns null when the merchant is not fiscalized — caller should then
 * skip the fiscal section entirely.
 */
export function mapEtimsToFiscalBlock(input: {
  cu_number?: string | null;
  qr_data?: string | null;
  signature?: string | null;
  invoice_number?: string | null;
  control_unit_id?: string | null;
}): FiscalBlock | null {
  const cu = (input.cu_number ?? "").trim();
  const qr = (input.qr_data ?? "").trim();
  if (!cu && !qr) return null;

  const fields: FiscalBlock["fields"] = [];
  if (cu) fields.push({ label: "CU No", value: cu });
  if (input.control_unit_id) {
    fields.push({ label: "CU ID", value: String(input.control_unit_id) });
  }
  if (input.invoice_number) {
    fields.push({ label: "Inv No", value: String(input.invoice_number) });
  }

  return {
    provider: "etims",
    heading: "eTIMS",
    fields,
    qr: qr || null,
    signature: (input.signature ?? "").trim() || null,
  };
}
