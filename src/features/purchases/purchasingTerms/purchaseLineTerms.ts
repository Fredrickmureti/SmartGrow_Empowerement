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
  describePriceSource,
  fetchPurchaseLinePrice,
  fetchSupplierPurchasingTerms,
  validateSupplierOrderQuantity,
  type OrderQuantityVerdict,
  type PurchaseLinePrice,
  type PurchasePriceSource,
  type SupplierPurchasingTerms,
} from "@/features/products/purchasing/supplierPurchasingTerms";

export { describePriceSource };
export type { PurchaseLinePrice, PurchasePriceSource };


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
  /** Which authority produced the price, for the operator and the PO snapshot. */
  priceSource: PurchasePriceSource;
  priceSourceLabel: string;
  supplierTermsId: string | null;
  contractLineId: string | null;
  terms: SupplierPurchasingTerms;
}

/**
 * Defaults for a freshly picked product on a purchasing line: the supplier's
 * minimum order quantity, purchase unit and agreed price. Nothing is computed
 * here — the terms resolver applies supplier -> product -> system precedence,
 * and the price authority applies contract -> tier -> flat -> product default.
 */
export async function resolvePurchaseLineDefaults(args: {
  businessId?: string | null;
  productId?: string | null;
  supplierId?: string | null;
  onDate?: string | null;
  /** Quantity already on the line, if any — drives price-break selection. */
  quantity?: number | null;
  branchId?: string | null;
}): Promise<PurchaseLineTermDefaults | null> {
  if (!args.businessId || !args.productId) return null;
  const terms = await fetchSupplierPurchasingTerms({
    businessId: args.businessId,
    productId: args.productId,
    supplierId: args.supplierId ?? null,
    onDate: args.onDate ?? null,
    quantity: args.quantity ?? null,
    branchId: args.branchId ?? null,
  });
  if (!terms) return null;

  const quantity = Number(args.quantity ?? terms.min_order_qty ?? 1);
  const price = await fetchPurchaseLinePrice({
    businessId: args.businessId,
    productId: args.productId,
    supplierId: args.supplierId ?? null,
    quantity,
    onDate: args.onDate ?? null,
    branchId: args.branchId ?? null,
  });

  const priceSource = (price?.price_source ?? "manual") as PurchasePriceSource;
  return {
    quantity,
    displayUomId: price?.purchase_uom_id ?? terms.purchase_uom_id ?? null,
    leadTimeDays: terms.lead_time_days ?? null,
    unitPrice: price?.unit_price ?? terms.unit_price ?? null,
    currencyCode: price?.currency_code ?? terms.currency_code ?? null,
    priceSource,
    priceSourceLabel: describePriceSource(priceSource),
    supplierTermsId: price?.supplier_terms_id ?? terms.terms_id ?? null,
    contractLineId: price?.contract_line_id ?? null,
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
