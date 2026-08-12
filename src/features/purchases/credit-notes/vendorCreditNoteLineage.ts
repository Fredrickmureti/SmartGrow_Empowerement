/**
 * vendorCreditNoteLineage — the single description of vendor-credit provenance.
 *
 * ADR 0132: a vendor credit note is never "just a negative bill". It always
 * answers *why* the supplier owes us (origin), *under which code* (reason),
 * *against which upstream document* (return / GRN / PO / bill) and *against
 * which supplier paper* (their credit note number + date).
 *
 * The origin vocabulary mirrors `vendor_credit_notes_origin_chk` exactly —
 * anything not in this list is rejected by the database.
 */
import type { VendorCreditOrigin } from "@/hooks/useVendorCreditNotes";

export interface VendorCreditOriginOption {
  value: VendorCreditOrigin;
  label: string;
  hint: string;
  /** Which upstream reference this origin expects an operator to attach. */
  requires?: "purchase_return" | "goods_receipt" | "bill";
}

export const VENDOR_CREDIT_ORIGINS: VendorCreditOriginOption[] = [
  {
    value: "purchase_return",
    label: "Purchase return",
    hint: "Goods physically went back to the supplier.",
    requires: "purchase_return",
  },
  {
    value: "overbilling",
    label: "Overbilling",
    hint: "The supplier invoiced more than was owed.",
    requires: "bill",
  },
  {
    value: "price_correction",
    label: "Price correction",
    hint: "Agreed price differs from the invoiced price.",
    requires: "bill",
  },
  {
    value: "quantity_discrepancy",
    label: "Quantity discrepancy",
    hint: "Invoiced quantity exceeds what was received.",
    requires: "goods_receipt",
  },
  {
    value: "damaged_goods",
    label: "Damaged goods",
    hint: "Received damaged; credit instead of replacement.",
    requires: "goods_receipt",
  },
  {
    value: "rejected_goods",
    label: "Rejected goods",
    hint: "Failed inspection / quality control.",
    requires: "goods_receipt",
  },
  {
    value: "tax_correction",
    label: "Tax correction",
    hint: "Wrong tax treatment on the original document.",
    requires: "bill",
  },
  { value: "rebate", label: "Rebate", hint: "Volume or contractual rebate." },
  {
    value: "supplier_credit",
    label: "Supplier credit",
    hint: "Goodwill or settlement credit issued by the supplier.",
  },
  {
    value: "adjustment",
    label: "Adjustment",
    hint: "Other agreed adjustment — explain in the notes.",
  },
];

/** Structured reason codes; free text still lives in `notes`. */
export const VENDOR_CREDIT_REASON_CODES = [
  { value: "damaged", label: "Damaged in transit" },
  { value: "defective", label: "Defective / quality reject" },
  { value: "wrong_item", label: "Wrong item supplied" },
  { value: "short_delivery", label: "Short delivery" },
  { value: "over_delivery", label: "Over-delivery" },
  { value: "expired", label: "Expired / short shelf life" },
  { value: "not_ordered", label: "Not ordered" },
  { value: "price_dispute", label: "Price or billing dispute" },
  { value: "tax_error", label: "Tax error" },
  { value: "contractual_rebate", label: "Contractual rebate" },
  { value: "other", label: "Other" },
] as const;

export function originOption(
  origin: string | null | undefined,
): VendorCreditOriginOption | undefined {
  return VENDOR_CREDIT_ORIGINS.find((o) => o.value === origin);
}

export function originLabel(origin: string | null | undefined): string {
  return originOption(origin)?.label ?? prettyToken(origin);
}

export function reasonCodeLabel(code: string | null | undefined): string {
  if (!code) return "—";
  return (
    VENDOR_CREDIT_REASON_CODES.find((r) => r.value === code)?.label ??
    prettyToken(code)
  );
}

export function prettyToken(v: string | null | undefined): string {
  if (!v) return "—";
  const s = v.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Header lineage as the forms hold it (all strings, `""` meaning unset). */
export interface LineageFormState {
  origin: VendorCreditOrigin;
  reason_code: string;
  vendor_document_number: string;
  vendor_document_date: string;
  source_return_id: string;
  goods_receipt_id: string;
  purchase_order_id: string;
}

export const emptyLineage: LineageFormState = {
  origin: "adjustment",
  reason_code: "",
  vendor_document_number: "",
  vendor_document_date: "",
  source_return_id: "",
  goods_receipt_id: "",
  purchase_order_id: "",
};

const orNull = (v: string) => (v && v !== "__none__" ? v : null);

/** Form state → the writer's lineage payload. */
export function toLineagePayload(state: LineageFormState) {
  return {
    origin: state.origin,
    reason_code: orNull(state.reason_code),
    vendor_document_number: orNull(state.vendor_document_number),
    vendor_document_date: orNull(state.vendor_document_date),
    source_return_id: orNull(state.source_return_id),
    goods_receipt_id: orNull(state.goods_receipt_id),
    purchase_order_id: orNull(state.purchase_order_id),
  };
}

/**
 * Governance guard rendered before the writer is called: an origin that
 * claims an upstream document must actually carry one.
 */
export function lineageError(
  state: LineageFormState,
  billId: string | null,
): string | null {
  const req = originOption(state.origin)?.requires;
  if (req === "purchase_return" && !orNull(state.source_return_id)) {
    return "A purchase-return credit must reference the purchase return it settles.";
  }
  if (req === "goods_receipt" && !orNull(state.goods_receipt_id)) {
    return "This origin must reference the goods receipt it disputes.";
  }
  if (req === "bill" && !billId) {
    return "This origin must reference the supplier bill being corrected.";
  }
  return null;
}
