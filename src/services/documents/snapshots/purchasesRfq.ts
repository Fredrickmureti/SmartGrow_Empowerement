/**
 * Request for Quotation snapshot builder (`document_kinds.code = 'purchases.rfq'`).
 *
 * WHAT AN RFQ IS
 * --------------
 * A solicitation. The buyer states WHAT is required, in what quantity, to
 * what specification and by when; the supplier replies with price, lead
 * time and terms. Money therefore flows in the OPPOSITE direction to a
 * commercial document: nothing in this snapshot may carry a price.
 *
 * This builder previously emitted the sales-invoice shape with
 * `unit_price`/`tax_amount`/`line_total`/`subtotal`/`total` zero-filled,
 * which made the renderer draw an invoice with an empty money ladder. The
 * fields are now ABSENT, not zero: a zero price on a solicitation reads to
 * a supplier as "we expect this for free", and an absent one is the only
 * honest statement. The paired layout is
 * `_shared/pdf/layouts/procurement.ts::generateSolicitationPdf`.
 *
 * `rfq_items.target_price` is the buyer's internal ceiling used for bid
 * scoring. It is deliberately excluded — a frozen record is what gets
 * emailed, so anything present here reaches the supplier.
 *
 * The SQL twin of this builder is `public.rfq_ensure_document_record`,
 * used by the outbox dispatcher when it freezes the RFQ for invitation
 * emails. Keep the two shapes in step.
 *
 * SNAPSHOT IDENTITY: an RFQ is revisable (`rfqs.version`). Each revision is
 * a distinct solicitation with its own frozen record — `revision` is part
 * of the snapshot and of the document number shown on the page, so a
 * supplier can never be left quoting against a superseded requirement.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SnapshotBlob } from "./index";

export interface PurchasesRfqItemRow {
  description: string | null;
  quantity: number | null;
  sort_order?: number | null;
  specification?: string | null;
  need_by_date?: string | null;
  product?: { sku: string | null } | null;
  uom?: { code: string | null } | null;
}

export interface PurchasesRfqHeaderRow {
  id: string;
  rfq_number: string;
  status: string;
  version?: number | null;
  created_at: string;
  released_at: string | null;
  deadline: string | null;
  required_by_date?: string | null;
  currency: string | null;
  notes: string | null;
  organization_id: string;
  business_id: string | null;
  branch_id: string | null;
  business?: { name?: string | null; base_currency?: string | null } | null;
  deliver_to_branch?: { name?: string | null; address?: string | null } | null;
  deliver_to_warehouse?: { name?: string | null; address?: string | null } | null;
  items?: PurchasesRfqItemRow[] | null;
}

/** The supplier this particular frozen copy is addressed to, if any. */
export interface PurchasesRfqSupplier {
  name: string | null;
  email?: string | null;
  phone?: string | null;
  address_line1?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  country?: string | null;
}

export interface BuildPurchasesRfqSnapshotOptions {
  supplier?: PurchasesRfqSupplier | null;
  buyerContactName?: string | null;
  buyerContactEmail?: string | null;
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
  revision: number;
}

const RFQ_FORBIDDEN_KEYS = new Set([
  "target_price", "price", "unit_price", "tax", "tax_rate", "tax_amount",
  "amount", "line_amount", "line_total", "subtotal", "total", "amount_due",
  "balance_due", "payment_instructions",
]);

export function assertPurchasesRfqSnapshot(snapshot: SnapshotBlob): void {
  const inspect = (value: unknown, path: string): void => {
    if (!value || typeof value !== "object") return;
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (RFQ_FORBIDDEN_KEYS.has(key.toLowerCase())) {
        throw new Error(`RFQ snapshot contains forbidden monetary field ${path}${key}`);
      }
      inspect(nested, `${path}${key}.`);
    }
  };
  inspect(snapshot, "");
}

function deliveryLocation(rfq: PurchasesRfqHeaderRow): string | null {
  const target = rfq.deliver_to_warehouse ?? rfq.deliver_to_branch ?? null;
  if (!target) return null;
  return [target.name, target.address].filter(Boolean).join("\n") || null;
}

export function buildPurchasesRfqSnapshot(
  rfq: PurchasesRfqHeaderRow,
  options: BuildPurchasesRfqSnapshotOptions = {},
): BuildPurchasesRfqSnapshotResult {
  if (!rfq.id) throw new Error("buildPurchasesRfqSnapshot: rfq.id required");
  if (!rfq.rfq_number) throw new Error("buildPurchasesRfqSnapshot: rfq_number required");

  const issueDate = (rfq.released_at ?? rfq.created_at).slice(0, 10);
  // The currency the supplier is asked to quote IN — not an amount.
  const currency = rfq.currency || rfq.business?.base_currency || "USD";
  const revision = Number(rfq.version ?? 1);

  const items = [...(rfq.items ?? [])]
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    .map((item) => ({
      description: item.description ?? null,
      // Specification is its own column on the page, never appended to the
      // description: buyers scan the description, engineers read the spec.
      specification: item.specification ?? null,
      quantity: Number(item.quantity ?? 0),
      sku: item.product?.sku ?? null,
      unit_of_measure: item.uom?.code ?? null,
      required_by_date: item.need_by_date ?? null,
    }));

  const supplier = options.supplier ?? null;

  const snapshot: SnapshotBlob = {
    document_type: "rfq",
    document_type_label: "REQUEST FOR QUOTATION",
    document_number: rfq.rfq_number,
    revision,
    status: rfq.status,
    issue_date: issueDate,
    response_deadline: rfq.deadline ? rfq.deadline.slice(0, 10) : null,
    required_by_date: rfq.required_by_date ? rfq.required_by_date.slice(0, 10) : null,
    currency,
    supplier: supplier
      ? {
          name: supplier.name ?? null,
          email: supplier.email ?? null,
          phone: supplier.phone ?? null,
          address_line1: supplier.address_line1 ?? null,
          city: supplier.city ?? null,
          state: supplier.state ?? null,
          postal_code: supplier.postal_code ?? null,
          country: supplier.country ?? null,
        }
      : null,
    buyer_contact_name: options.buyerContactName ?? null,
    buyer_contact_email: options.buyerContactEmail ?? null,
    delivery_location: deliveryLocation(rfq),
    response_instructions:
      `Submit your quotation quoting RFQ ${rfq.rfq_number}` +
      (revision > 1 ? ` revision ${revision}` : "") +
      (rfq.deadline ? ` on or before ${rfq.deadline.slice(0, 10)}` : "") +
      `. Quote in ${currency}, stating unit price, lead time, validity period ` +
      `and payment terms for every line.`,
    commercial_requirements: null,
    notes: rfq.notes ?? null,
    terms: null,
    business_name: rfq.business?.name ?? null,
    business_id: rfq.business_id,
    organization_id: rfq.organization_id,
    branch_id: rfq.branch_id,
    items,
  };

  assertPurchasesRfqSnapshot(snapshot);

  return {
    snapshot,
    documentNumber: revision > 1 ? `${rfq.rfq_number}-R${revision}` : rfq.rfq_number,
    documentDate: issueDate,
    organizationId: rfq.organization_id,
    businessId: rfq.business_id,
    branchId: rfq.branch_id,
    currency,
    sourceDocId: rfq.id,
    revision,
  };
}

export async function fetchAndBuildPurchasesRfqSnapshot(
  supabase: SupabaseClient,
  rfqId: string,
  options: BuildPurchasesRfqSnapshotOptions = {},
): Promise<BuildPurchasesRfqSnapshotResult> {
  const { data, error } = await supabase
    .from("rfqs")
    .select(
      `
      id, rfq_number, status, version, created_at, released_at, deadline,
      required_by_date, currency, notes,
      organization_id, business_id, branch_id,
      business:businesses(name, base_currency),
      deliver_to_branch:branches!deliver_to_branch_id(name, address),
      deliver_to_warehouse:warehouses!deliver_to_warehouse_id(name, address),
      items:rfq_items(
        description, quantity, sort_order, specification, need_by_date,
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
  return buildPurchasesRfqSnapshot(data as unknown as PurchasesRfqHeaderRow, options);
}
