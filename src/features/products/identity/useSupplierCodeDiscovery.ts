/**
 * Supplier identity discovery (ADR-0110, Phase 8).
 *
 * A vendor's own part number is scoped to that vendor: two suppliers may
 * legitimately use the same code for different goods. So an unrecognised code
 * on an inbound dock is not automatically "not registered" — it is very often
 * the supplier's code for an item already on the purchase order.
 *
 * This seam answers "what is the evidence for this code?" via
 * `discover_supplier_identity` and, once an operator confirms, links the code
 * to the chosen product through the ONE identifier write seam
 * (`writeIdentifier`, kind `supplier`, source `asn`). It never posts stock and
 * never writes `product_identifiers` directly.
 */
import { useCallback, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { writeIdentifier } from "./writeIdentifier";

export type IdentityEvidence = "open_po" | "supplier_catalogue" | "other_supplier";

export interface SupplierIdentityCandidate {
  productId: string;
  productName: string;
  sku: string | null;
  evidence: IdentityEvidence;
  supplierId: string | null;
  supplierName: string | null;
  packagingId: string | null;
}

export interface SupplierDiscovery {
  status: "candidates" | "none" | "unauthorized" | "empty" | "error";
  code: string;
  supplierId: string | null;
  candidates: SupplierIdentityCandidate[];
}

const EVIDENCE_COPY: Record<IdentityEvidence, string> = {
  open_po: "expected on an open purchase order for this supplier",
  supplier_catalogue: "in this supplier's price list",
  other_supplier: "already carries this code for another supplier",
};

/** Operator-facing reason a candidate is being suggested. */
export function describeEvidence(evidence: IdentityEvidence): string {
  return EVIDENCE_COPY[evidence] ?? "matched from procurement records";
}

function toCandidate(row: Record<string, unknown>): SupplierIdentityCandidate {
  return {
    productId: String(row.product_id ?? ""),
    productName: String(row.product_name ?? ""),
    sku: (row.sku as string | null) ?? null,
    evidence: (row.evidence as IdentityEvidence) ?? "open_po",
    supplierId: (row.supplier_id as string | null) ?? null,
    supplierName: (row.supplier_name as string | null) ?? null,
    packagingId: (row.packaging_id as string | null) ?? null,
  };
}

export interface DiscoverInput {
  businessId: string;
  code: string;
  supplierId?: string | null;
  purchaseOrderId?: string | null;
}

export async function discoverSupplierIdentity(input: DiscoverInput): Promise<SupplierDiscovery> {
  const code = (input.code || "").trim();
  const empty: SupplierDiscovery = { status: "none", code, supplierId: input.supplierId ?? null, candidates: [] };
  if (!code || !input.businessId) return { ...empty, status: "empty" };
  const { data, error } = await supabase.rpc("discover_supplier_identity" as never, {
    p_business_id: input.businessId,
    p_code: code,
    p_supplier_id: input.supplierId ?? undefined,
    p_purchase_order_id: input.purchaseOrderId ?? undefined,
  } as never);
  if (error) return { ...empty, status: "error" };
  const env = (data ?? null) as {
    status?: string;
    code?: string;
    supplier_id?: string | null;
    candidates?: Record<string, unknown>[];
  } | null;
  if (!env) return empty;
  return {
    status: (env.status as SupplierDiscovery["status"]) ?? "none",
    code: env.code ?? code,
    supplierId: env.supplier_id ?? input.supplierId ?? null,
    candidates: (env.candidates ?? []).map(toCandidate).filter((c) => c.productId),
  };
}

/**
 * Link a supplier's code to a product. Returns `null` on success or an
 * operator-facing sentence on failure — infrastructure detail never leaks.
 */
export async function linkSupplierCode(input: {
  businessId: string;
  productId: string;
  code: string;
  supplierId: string;
  packagingId?: string | null;
}): Promise<string | null> {
  if (!input.supplierId) return "Choose the supplier before linking their code.";
  return writeIdentifier({
    businessId: input.businessId,
    productId: input.productId,
    code: input.code,
    kind: "supplier",
    supplierId: input.supplierId,
    packagingId: input.packagingId ?? null,
    source: "asn",
    isPrimary: false,
  });
}

/** Stateful wrapper for capture surfaces: discover → confirm → link. */
export function useSupplierCodeDiscovery(businessId: string | undefined) {
  const [discovery, setDiscovery] = useState<SupplierDiscovery | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const discover = useCallback(
    async (code: string, ctx: { supplierId?: string | null; purchaseOrderId?: string | null } = {}) => {
      if (!businessId) return null;
      setBusy(true);
      setError(null);
      try {
        const result = await discoverSupplierIdentity({ businessId, code, ...ctx });
        setDiscovery(result);
        return result;
      } finally {
        setBusy(false);
      }
    },
    [businessId],
  );

  const link = useCallback(
    async (candidate: SupplierIdentityCandidate, supplierId: string | null) => {
      if (!businessId || !discovery) return "Nothing to link.";
      const vendor = supplierId ?? discovery.supplierId;
      if (!vendor) {
        const msg = "This code can only be linked while receiving against a supplier's order.";
        setError(msg);
        return msg;
      }
      setBusy(true);
      try {
        const failure = await linkSupplierCode({
          businessId,
          productId: candidate.productId,
          code: discovery.code,
          supplierId: vendor,
          packagingId: candidate.packagingId,
        });
        setError(failure);
        if (!failure) setDiscovery(null);
        return failure;
      } finally {
        setBusy(false);
      }
    },
    [businessId, discovery],
  );

  const dismiss = useCallback(() => {
    setDiscovery(null);
    setError(null);
  }, []);

  return { discovery, discover, link, dismiss, busy, error };
}
