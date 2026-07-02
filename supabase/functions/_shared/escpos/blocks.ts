/**
 * Stage R3b — receipt block model (contract layer).
 *
 * The ESC/POS receipt is conceptually a list of typed BLOCKS. Today the
 * builder still emits these procedurally inside `buildDocumentEscPos`, but
 * the SAME named block sequence is now exported here so that:
 *
 *  1. Future per-tenant section reordering (R3c) reads the canonical list.
 *  2. Future fiscal extension blocks (R3f) extend a typed enum, not a
 *     hand-edited switch deep inside the builder.
 *  3. Future block-list snapshot (R3i) serializes a known-shape array.
 *  4. Tests can lock the default order so the procedural→dispatch refactor
 *     in R3b.2 is provably byte-equal.
 *
 * This file is pure types + constants. No Deno or browser imports.
 */

import type { ReceiptSettingsInput } from "./builder.ts";

/** Every section the renderer can emit. New regulators add a new type here. */
export type BlockType =
  | "custom_header"        // rs.receipt_header free text above org block
  | "org_header"           // store name / address / phone / email / tax id
  | "title_meta"           // "RECEIPT" + No / Date / Due / Status
  | "cashier_register"     // cashier + register lines
  | "recipient"            // Bill To: customer block
  | "items"                // line items (single-line | two-lines | tabular)
  | "totals"               // subtotal / discount / tax buckets
  | "refund_banner"        // big REFUND banner when total < 0
  | "grand_total"          // bold TOTAL row
  | "savings"              // "You saved …"
  | "payments"             // tender breakdown
  | "tendered_change"      // cash tendered + change due
  | "notes"                // doc.notes
  | "terms"                // doc.terms
  | "footer_text"          // rs.receipt_footer / opts.footerNote
  | "return_policy"        // rs.return_policy_text
  | "fiscal_etims_ke"      // KRA eTIMS CU + QR (will become one of many)
  | "barcode"              // generic CODE128 of doc.document_number
  | "qr_code";             // generic QR of doc.document_number

/**
 * Default section order. Matches the procedural emit order in
 * `buildDocumentEscPos` exactly — proven by `blocks_test.ts`. Do NOT reorder
 * without updating the builder AND the golden-byte test in the same commit.
 */
export const DEFAULT_BLOCK_ORDER: readonly BlockType[] = [
  "custom_header",
  "org_header",
  "title_meta",
  "cashier_register",
  "recipient",
  "items",
  "totals",
  "refund_banner",
  "grand_total",
  "savings",
  "payments",
  "tendered_change",
  "notes",
  "terms",
  "footer_text",
  "return_policy",
  "fiscal_etims_ke",
  "barcode",
  "qr_code",
] as const;

/**
 * Block metadata. `pinned` blocks cannot be moved past payments by the
 * tenant (prevents a UI from putting TOTAL above ITEMS).
 */
export interface BlockMeta {
  type: BlockType;
  pinned: boolean;
  /** Human-friendly label for the eventual reorder UI (R3c). */
  label: string;
}

export const BLOCK_REGISTRY: Record<BlockType, BlockMeta> = {
  custom_header:    { type: "custom_header",    pinned: false, label: "Custom Header" },
  org_header:       { type: "org_header",       pinned: true,  label: "Store Header" },
  title_meta:       { type: "title_meta",       pinned: true,  label: "Title + Meta" },
  cashier_register: { type: "cashier_register", pinned: false, label: "Cashier / Register" },
  recipient:        { type: "recipient",        pinned: false, label: "Customer" },
  items:            { type: "items",            pinned: true,  label: "Line Items" },
  totals:           { type: "totals",           pinned: true,  label: "Totals (Subtotal/Tax)" },
  refund_banner:    { type: "refund_banner",    pinned: true,  label: "Refund Banner" },
  grand_total:      { type: "grand_total",      pinned: true,  label: "TOTAL Row" },
  savings:          { type: "savings",          pinned: false, label: "Savings Line" },
  payments:         { type: "payments",         pinned: false, label: "Payment Methods" },
  tendered_change:  { type: "tendered_change",  pinned: false, label: "Tendered / Change" },
  notes:            { type: "notes",            pinned: false, label: "Notes" },
  terms:            { type: "terms",            pinned: false, label: "Terms" },
  footer_text:      { type: "footer_text",      pinned: false, label: "Footer Text" },
  return_policy:    { type: "return_policy",    pinned: false, label: "Return Policy" },
  fiscal_etims_ke:  { type: "fiscal_etims_ke",  pinned: false, label: "Fiscal: eTIMS (KE)" },
  barcode:          { type: "barcode",          pinned: false, label: "Document Barcode" },
  qr_code:          { type: "qr_code",          pinned: false, label: "Document QR" },
};

/**
 * Resolve the active block order for a given settings row.
 *
 * Behavior (Phase B):
 *  - When `rs.section_order` is missing/empty/invalid → return DEFAULT_BLOCK_ORDER.
 *  - Pinned blocks (`org_header`, `title_meta`, `items`, `totals`,
 *    `refund_banner`, `grand_total`) ALWAYS keep their default relative
 *    position regardless of what the tenant requests — fiscal compliance
 *    guard. Any pinned entries in the requested order are silently dropped.
 *  - Non-pinned blocks are placed in the order the tenant requests; any
 *    non-pinned blocks the tenant omits are appended in default order so
 *    no section ever silently disappears.
 *
 * The result always contains the full set of known blocks exactly once.
 */
export function resolveBlockOrder(
  rs: Partial<ReceiptSettingsInput> | null | undefined,
): readonly BlockType[] {
  const requested = (rs as { section_order?: unknown } | null | undefined)
    ?.section_order;
  if (!Array.isArray(requested) || requested.length === 0) {
    return DEFAULT_BLOCK_ORDER;
  }

  const known = new Set<string>(DEFAULT_BLOCK_ORDER);
  const isPinned = (t: BlockType) => BLOCK_REGISTRY[t].pinned;

  // Validated non-pinned tenant order (preserves first occurrence).
  const seen = new Set<BlockType>();
  const tenantNonPinned: BlockType[] = [];
  for (const raw of requested) {
    if (typeof raw !== "string" || !known.has(raw)) continue;
    const t = raw as BlockType;
    if (isPinned(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    tenantNonPinned.push(t);
  }
  // Append any non-pinned blocks the tenant did not list, in default order.
  for (const t of DEFAULT_BLOCK_ORDER) {
    if (!isPinned(t) && !seen.has(t)) {
      tenantNonPinned.push(t);
      seen.add(t);
    }
  }

  // Walk the default order; for every non-pinned slot consume the next
  // tenant-ordered non-pinned block, for every pinned slot keep the pinned
  // block in place.
  const result: BlockType[] = [];
  let cursor = 0;
  for (const t of DEFAULT_BLOCK_ORDER) {
    if (isPinned(t)) {
      result.push(t);
    } else {
      result.push(tenantNonPinned[cursor++]);
    }
  }
  return result;
}

/**
 * Provider-agnostic fiscal block contract (Phase B).
 *
 * Replaces the ad-hoc `etims_cu_number` / `etims_qr_data` reads inside the
 * builder. Future regulators (ZRA, EFRIS, SUNAT, …) ship a new adapter that
 * produces a FiscalBlock — never a builder edit.
 */
export type FiscalProvider = "etims" | "zra" | "efris" | "sunat" | "none";

export interface FiscalBlockField {
  label: string;
  value: string;
}

export interface FiscalBlock {
  provider: FiscalProvider;
  /** Display heading. Defaults to provider.toUpperCase() when omitted. */
  heading?: string;
  fields: FiscalBlockField[];
  /** When set and `caps.qr_native`, rendered as native QR; else as text. */
  qr?: string | null;
  signature?: string | null;
}
