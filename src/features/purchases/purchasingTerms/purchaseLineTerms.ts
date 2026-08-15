/**
 * Phase 3 — Purchases consumption of supplier purchasing terms.
 *
 * Purchasing policy (MOQ, order increment, lead time, purchase UoM) is owned by
 * `supplier_item_terms` and resolved / enforced server-side (ADR 0141). This
 * module is the Purchases-side adapter over the single client seam
 * `@/features/products/purchasing/supplierPurchasingTerms`; it adds no
 * arithmetic of its own — every verdict comes back from
 * `validate_supplier_order_quantity`.
 *
 * The supplier identifier may be the purchasing party (`contacts.id`, what a PO
 * carries as `vendor_id`, ADR-0079) or the supplier role record; the server
 * resolves the party -> role hop.
 */
import {
  describeOrderQuantityVerdict,
  fetchSupplierPurchasingTerms,
  validateSupplierOrderQuantity,
  type OrderQuantityVerdict,
  type SupplierPurchasingTerms,
} from "@/features/products/purchasing/supplierPurchasingTerms";

export interface PurchaseLineForTerms {
  /** Index in the caller's line array — used to report the refusal back. */
  index: number;
  productId?: string | null;
  /** Supplier party (contacts.id) or supplier role id. */
  supplierId?: string | null;
  quantity: number;
  productName?: string | null;
}

export interface PurchaseLineRefusal {
  index: number;
  message: string;
  verdict: OrderQuantityVerdict;
}

/**
 * Validate every line that names a product against its supplier's purchasing
 * terms. Lines without a product (free-text) carry no supplier policy and are
 * skipped. Returns one operator-facing refusal per offending line.
 */
export async function validatePurchaseLinesAgainstTerms(args: {
  businessId?: string | null;
  supplierId?: string | null;
  lines: PurchaseLineForTerms[];
  onDate?: string | null;
}): Promise<PurchaseLineRefusal[]> {
  const { businessId, supplierId, lines, onDate } = args;
  if (!businessId) return [];

  const candidates = lines.filter(
    (l) => !!l.productId && Number.isFinite(l.quantity),
  );
  if (candidates.length === 0) return [];

  const verdicts = await Promise.all(
    candidates.map(async (line) => {
      const verdict = await validateSupplierOrderQuantity({
        businessId,
        productId: line.productId as string,
        supplierId: line.supplierId ?? supplierId ?? null,
        quantity: Number(line.quantity),
        onDate: onDate ?? null,
      });
      return { line, verdict };
    }),
  );

  const refusals: PurchaseLineRefusal[] = [];
  for (const { line, verdict } of verdicts) {
    if (!verdict || verdict.is_valid) continue;
    const message = describeOrderQuantityVerdict(verdict, line.productName);
    if (!message) continue;
    refusals.push({ index: line.index, message, verdict });
  }
  return refusals;
}

/** Single-line convenience used by line editors as the user types. */
export async function validatePurchaseLineQuantity(args: {
  businessId?: string | null;
  supplierId?: string | null;
  productId?: string | null;
  quantity: number;
  productName?: string | null;
  onDate?: string | null;
}): Promise<PurchaseLineRefusal | null> {
  const [refusal] = await validatePurchaseLinesAgainstTerms({
    businessId: args.businessId,
    supplierId: args.supplierId,
    onDate: args.onDate,
    lines: [
      {
        index: 0,
        productId: args.productId,
        quantity: args.quantity,
        productName: args.productName,
      },
    ],
  });
  return refusal ?? null;
}

export interface PurchaseLineTermDefaults {
  quantity: number;
  displayUomId: string | null;
  leadTimeDays: number | null;
  unitPrice: number | null;
  currencyCode: string | null;
  terms: SupplierPurchasingTerms;
}

/**
 * Defaults for a freshly picked product on a purchasing line: the supplier's
 * minimum order quantity and purchase unit. Nothing is computed here — the
 * resolver already applied supplier -> product -> system precedence.
 */
export async function resolvePurchaseLineDefaults(args: {
  businessId?: string | null;
  productId?: string | null;
  supplierId?: string | null;
  onDate?: string | null;
}): Promise<PurchaseLineTermDefaults | null> {
  if (!args.businessId || !args.productId) return null;
  const terms = await fetchSupplierPurchasingTerms({
    businessId: args.businessId,
    productId: args.productId,
    supplierId: args.supplierId ?? null,
    onDate: args.onDate ?? null,
  });
  if (!terms) return null;
  return {
    quantity: Number(terms.min_order_qty ?? 1),
    displayUomId: terms.purchase_uom_id ?? null,
    leadTimeDays: terms.lead_time_days ?? null,
    unitPrice: terms.unit_price ?? null,
    currencyCode: terms.currency_code ?? null,
    terms,
  };
}

/** One place authors the blocking toast copy for a batch of refusals. */
export function summarisePurchaseLineRefusals(
  refusals: PurchaseLineRefusal[],
): string {
  return refusals
    .map((r) => `Line ${r.index + 1}: ${r.message}`)
    .join("\n");
}
