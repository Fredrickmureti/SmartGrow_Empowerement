/**
 * Request for Quotation snapshot builder (`document_kinds.code = 'purchases.rfq'`).
 *
 * An RFQ is a supplier-facing solicitation: it states WHAT is wanted and by
 * when, never what the buyer is prepared to pay. `rfq_items.target_price` is
 * an internal ceiling used for bid scoring and is deliberately excluded from
 * the snapshot — a frozen record is what gets emailed, so anything present
 * here reaches the supplier.
 *
 * The SQL twin of this builder is `public.rfq_ensure_document_record`, used by
 * the outbox dispatcher when it freezes the RFQ for invitation emails. Keep
 * the two shapes in step.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SnapshotBlob } from "./index";

export interface PurchasesRfqItemRow {
  description: string | null;
  quantity: number | null;
  sort_order?: number | null;
  specification?: string | null;
  product?: { sku: string | null } | null;
  uom?: { code: string | null } | null;
}

export interface PurchasesRfqHeaderRow {
  id: string;
  rfq_number: string;
  status: string;
  created_at: string;
  released_at: string | null;
  deadline: string | null;
  currency: string | null;
  notes: string | null;
  organization_id: string;
  business_id: string | null;
  branch_id: string | null;
  business?: { base_currency?: string | null } | null;
  items?: PurchasesRfqItemRow[] | null;
}

export interface BuildPurchasesRfqSnapshotResult {
  snapshot: SnapshotBlob;
  documentNumber: string;
  documentDate: string;
  organizationId: string;
  businessId: string | null;
  branchId: string | null;
  currency: string;
  sourceDocId: string;
}

export function buildPurchasesRfqSnapshot(
  rfq: PurchasesRfqHeaderRow,
): BuildPurchasesRfqSnapshotResult {
  if (!rfq.id) throw new Error("buildPurchasesRfqSnapshot: rfq.id required");
  if (!rfq.rfq_number) throw new Error("buildPurchasesRfqSnapshot: rfq_number required");

  const issueDate = (rfq.released_at ?? rfq.created_at).slice(0, 10);
  const currency = rfq.currency || rfq.business?.base_currency || "USD";

  const items = [...(rfq.items ?? [])]
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    .map((item) => ({
      description: item.specification
        ? `${item.description ?? ""}\n${item.specification}`.trim()
        : item.description,
      quantity: Number(item.quantity ?? 0),
      // Pricing is what the supplier is being asked to supply — zeroed, never
      // sourced from the buyer's target price.
      unit_price: 0,
      tax_rate: 0,
      tax_amount: 0,
      line_total: 0,
      sku: item.product?.sku ?? null,
      unit_of_measure: item.uom?.code ?? null,
    }));

  const snapshot: SnapshotBlob = {
    document_type: "rfq",
    document_type_label: "REQUEST FOR QUOTATION",
    document_number: rfq.rfq_number,
    status: rfq.status,
    issue_date: issueDate,
    due_date: rfq.deadline ? rfq.deadline.slice(0, 10) : null,
    subtotal: 0,
    tax_amount: 0,
    discount_amount: 0,
    total: 0,
    currency,
    notes: rfq.notes ?? null,
    terms: null,
    contact: null,
    business_id: rfq.business_id,
    organization_id: rfq.organization_id,
    branch_id: rfq.branch_id,
    items,
  };

  return {
    snapshot,
    documentNumber: rfq.rfq_number,
    documentDate: issueDate,
    organizationId: rfq.organization_id,
    businessId: rfq.business_id,
    branchId: rfq.branch_id,
    currency,
    sourceDocId: rfq.id,
  };
}

export async function fetchAndBuildPurchasesRfqSnapshot(
  supabase: SupabaseClient,
  rfqId: string,
): Promise<BuildPurchasesRfqSnapshotResult> {
  const { data, error } = await supabase
    .from("rfqs")
    .select(
      `
      id, rfq_number, status, created_at, released_at, deadline, currency, notes,
      organization_id, business_id, branch_id,
      business:businesses(base_currency),
      items:rfq_items(
        description, quantity, sort_order, specification,
        product:products(sku),
        uom:units_of_measure!uom_id(code)
      )
      `,
    )
    .eq("id", rfqId)
    .single();

  if (error || !data) {
    throw new Error(
      `fetchAndBuildPurchasesRfqSnapshot: rfq ${rfqId} not found: ${error?.message ?? "no row"}`,
    );
  }
  return buildPurchasesRfqSnapshot(data as unknown as PurchasesRfqHeaderRow);
}
