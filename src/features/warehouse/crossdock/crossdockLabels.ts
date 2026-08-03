/**
 * Cross-dock routing label (ADR 0107 Phase 6).
 *
 * A flow-through pallet must be visibly different from a put-away pallet
 * on the receiving floor — otherwise the default behaviour (store it)
 * wins and the cross-dock decision is lost. The routing label states the
 * destination lane, the dock, the demand document and the cut-off.
 *
 * Rendering and device routing stay on the enterprise print platform
 * (`printWmsLabel` → `PrintService`); this module owns only the
 * cross-dock variable binding, so token names live in one place.
 */
import { printWmsLabel, WMS_LABEL_KEY } from "@/features/warehouse/labels/wmsLabels";
import type { CrossdockOpportunity } from "./useCrossdock";

const DEMAND_LABEL: Record<string, string> = {
  sales_order: "Sales order",
  transfer: "Transfer",
  replenishment: "Pick-face top-up",
  production: "Production",
};

export function crossdockRoutingVars(
  row: CrossdockOpportunity,
): Record<string, string> {
  const demandKind = DEMAND_LABEL[row.demand_type] ?? row.demand_type;
  return {
    product_name: row.product_name ?? "Unnamed product",
    product_sku: row.product_sku ?? "",
    quantity: String(Number(row.quantity)),
    staging_code: row.staging_code ?? "Awaiting lane",
    dock_code: row.dock_code ?? "Unassigned",
    demand_number: `${demandKind} ${row.demand_number ?? ""}`.trim(),
    customer_name: row.customer_name ?? "",
    cutoff_at: row.expires_at
      ? new Date(row.expires_at).toISOString().slice(0, 16).replace("T", " ")
      : "—",
    // The barcode resolves the opportunity, so a scan at the staging lane
    // lands the operator on the exact plan, not the product.
    opportunity_code: row.id,
  };
}

export function printCrossdockRoutingLabel(opts: {
  orgId: string;
  row: CrossdockOpportunity;
  businessId?: string | null;
  branchId?: string | null;
  copies?: number;
  isReprint?: boolean;
}) {
  return printWmsLabel({
    key: WMS_LABEL_KEY.CROSSDOCK_ROUTING,
    orgId: opts.orgId,
    businessId: opts.businessId ?? null,
    branchId: opts.branchId ?? null,
    sourceDocType: "wms_crossdock_opportunity",
    sourceDocId: opts.row.id,
    copies: opts.copies ?? 1,
    isReprint: opts.isReprint ?? false,
    vars: crossdockRoutingVars(opts.row),
  });
}
