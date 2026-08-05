/**
 * useResolveProductIdentity — Phase C1 of the product identification
 * architecture (see `.lovable/plan.md`, ADR-0017 / ADR-0071).
 *
 * ONE client contract over the canonical `resolve_product_identity` RPC for
 * every non-POS capture surface (WMS receiving, put-away, picking, counts,
 * purchasing receipt, label printing).
 *
 * Why a second hook next to `useResolveBarcode`:
 *   `useResolveBarcode` wraps `pos_resolve_barcode`, which layers selling
 *   price, tax, weighted-barcode rules and branch on-hand on top of identity.
 *   Inventory surfaces need *identity + packaging conversion* only, and they
 *   must be able to distinguish an ambiguous code from an unknown one, which
 *   the POS envelope cannot express.
 *
 * Contract — `resolve()` returns exactly one of:
 *   { kind: "resolved",  identity }   — one identifier matched (match_count 1)
 *   { kind: "ambiguous", identity, matchCount } — >1 identifier matched; the
 *       best candidate is still returned (exact code > primary > oldest) but
 *       callers MUST require operator confirmation before posting stock.
 *   { kind: "not_found", code }       — no identifier and no SKU match.
 *   { kind: "error", err }            — RPC/network failure. Never treated as
 *       "unknown code": callers must block the line, not invent a product.
 *
 * Every scan is first run through the GS1 interpreter (ADR-0071) so a
 * GS1-128 / DataMatrix payload resolves on its GTIN while lot / expiry /
 * serial / quantity ride along on the result for the caller to pre-fill.
 *
 * Caching: LRU (256) with hits cached until `product-identifiers` /
 * `products` query invalidation, misses cached 5s, errors never cached.
 * Concurrent resolves of the same code share one in-flight RPC.
 */
import { useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { interpretScan, type Gs1ScanInterpretation } from "@/lib/gs1/useGs1Scanner";
import {
  describeIdentityOutcome,
  type IdentityStatus,
} from "@/features/products/identity/identityOutcome";

export interface ProductIdentity {
  productId: string;
  productName: string;
  sku: string | null;
  identifierId: string | null;
  matchedCode: string;
  matchedKind: string;
  /** Packaging level the code denotes (null for a bare base-unit/SKU match). */
  packagingId: string | null;
  packagingName: string | null;
  /** Base units contained in ONE scan of this level. Always >= 1. */
  qtyInBaseUom: number;
  isBaseUnit: boolean;
  baseUomId: string | null;
  /** GS1 payload when the scan was a GS1 label, else an empty envelope. */
  gs1: Gs1ScanInterpretation;
}

/**
 * The resolver returns a DECISION. Every non-resolved outcome names WHY the
 * code did not become a product, so surfaces can offer a remediation instead
 * of a generic "unknown barcode". Copy lives in
 * `@/features/products/identity/identityOutcome`.
 */
export type IdentityResolution =
  | { kind: "resolved"; identity: ProductIdentity }
  | { kind: "ambiguous"; identity: ProductIdentity; matchCount: number }
  | { kind: "not_found"; code: string }
  | { kind: "inactive"; code: string; identity: ProductIdentity | null }
  | { kind: "archived"; code: string; identity: ProductIdentity | null }
  | { kind: "expired"; code: string; identity: ProductIdentity | null }
  | { kind: "foreign_tenant"; code: string }
  | { kind: "unauthorized"; code: string }
  | { kind: "error"; err: Error };

/** Map a resolution onto the shared operator copy taxonomy. */
export function identityStatusOf(r: IdentityResolution): IdentityStatus {
  return r.kind as IdentityStatus;
}

/** Shared operator copy for any resolution outcome. */
export function describeResolution(r: IdentityResolution, rawCode: string) {
  return describeIdentityOutcome({
    status: identityStatusOf(r),
    code: rawCode,
    matchCount: r.kind === "ambiguous" ? r.matchCount : undefined,
    productName: "identity" in r && r.identity ? r.identity.productName : undefined,
  });
}

const MAX_CACHE = 256;
const MISS_TTL_MS = 5_000;

type CacheableResolution = Exclude<IdentityResolution, { kind: "error" }>;

interface CacheEntry {
  result: CacheableResolution;
  cachedAt: number;
}

function lruGet(cache: Map<string, CacheEntry>, key: string, now: number): CacheEntry | undefined {
  const v = cache.get(key);
  if (!v) return undefined;
  if (v.result.kind === "not_found" && now - v.cachedAt > MISS_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  cache.delete(key);
  cache.set(key, v);
  return v;
}

function lruSet(cache: Map<string, CacheEntry>, key: string, entry: CacheEntry) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, entry);
  while (cache.size > MAX_CACHE) {
    const first = cache.keys().next().value;
    if (first === undefined) break;
    cache.delete(first);
  }
}

function rowToIdentity(row: Record<string, unknown>, gs1: Gs1ScanInterpretation): ProductIdentity {
  const qty = Number(row.qty_in_base_uom);
  return {
    productId: row.product_id as string,
    productName: (row.product_name as string) ?? "",
    sku: (row.sku as string | null) ?? null,
    identifierId: (row.identifier_id as string | null) ?? null,
    matchedCode: (row.matched_code as string) ?? gs1.resolveCode,
    matchedKind: (row.matched_kind as string) ?? "gtin",
    packagingId: (row.packaging_id as string | null) ?? null,
    packagingName: (row.packaging_name as string | null) ?? null,
    qtyInBaseUom: Number.isFinite(qty) && qty > 0 ? qty : 1,
    isBaseUnit: row.is_base_unit === undefined ? true : !!row.is_base_unit,
    baseUomId: (row.base_uom_id as string | null) ?? null,
    gs1,
  };
}

async function rpcOnce(
  businessId: string,
  branchId: string | null,
  code: string,
  gs1: Gs1ScanInterpretation,
  allowSkuFallback: boolean,
): Promise<IdentityResolution> {
  const { data, error } = await supabase.rpc("resolve_product_identity" as never, {
    p_business_id: businessId,
    p_code: code,
    p_branch_id: branchId ?? undefined,
    p_allow_sku_fallback: allowSkuFallback,
  } as never);
  if (error) return { kind: "error", err: new Error(error.message || "RPC error") };
  const rows = (data as unknown) as Array<Record<string, unknown>> | null;
  const row = rows && rows.length > 0 ? rows[0] : null;
  if (!row) return { kind: "not_found", code };
  const matchCount = Number(row.match_count) || 1;
  // Older resolver shapes returned only rows + match_count; derive the
  // decision so a legacy response can never read as an unqualified match.
  const status = String(row.status ?? (matchCount > 1 ? "ambiguous" : "resolved"));
  const identity = row.product_id ? rowToIdentity(row, gs1) : null;
  switch (status) {
    case "resolved":
      return identity ? { kind: "resolved", identity } : { kind: "not_found", code };
    case "ambiguous":
      return identity
        ? { kind: "ambiguous", identity, matchCount: matchCount > 1 ? matchCount : 2 }
        : { kind: "not_found", code };
    case "inactive":
    case "archived":
    case "expired":
      return { kind: status as "inactive" | "archived" | "expired", code, identity };
    case "foreign_tenant":
      return { kind: "foreign_tenant", code };
    case "unauthorized":
      return { kind: "unauthorized", code };
    default:
      return { kind: "not_found", code };
  }
}

async function rpcWithRetry(
  businessId: string,
  branchId: string | null,
  code: string,
  gs1: Gs1ScanInterpretation,
  allowSkuFallback: boolean,
): Promise<IdentityResolution> {
  const first = await rpcOnce(businessId, branchId, code, gs1, allowSkuFallback);
  if (first.kind !== "error") return first;
  // The resolver is a pure read — one jittered retry absorbs a packet drop
  // without ever surfacing it as "unknown barcode".
  await new Promise((r) => setTimeout(r, 200 + Math.floor(Math.random() * 300)));
  return rpcOnce(businessId, branchId, code, gs1, allowSkuFallback);
}

/**
 * Convert a scan of a packaging level into base ledger units.
 * Single source of truth for "scanned 2 cases of 12" → 24 base units.
 */
export function scanToBaseUnits(identity: ProductIdentity, scans = 1): number {
  const packs = Number.isFinite(scans) && scans > 0 ? scans : 1;
  return packs * identity.qtyInBaseUom;
}

export interface ResolveIdentityOptions {
  /**
   * Intent switch (ADR-0110): typing / search paths may fall back to a
   * literal SKU match; scanning paths (WMS, POS, labels) must NOT — a
   * scanner emits an identifier, never a SKU.
   */
  allowSkuFallback?: boolean;
}

export function useResolveProductIdentity(
  businessId: string | undefined,
  branchId: string | null = null,
  options: ResolveIdentityOptions = {},
) {
  const allowSkuFallback = options.allowSkuFallback ?? false;
  const cacheRef = useRef<Map<string, CacheEntry>>(new Map());
  const inflightRef = useRef<Map<string, Promise<IdentityResolution>>>(new Map());
  const queryClient = useQueryClient();

  useEffect(() => {
    const unsub = queryClient.getQueryCache().subscribe((event) => {
      const key = (event.query.queryKey?.[0] as string) || "";
      if (key === "product-identifiers" || key === "products" || key === "pos-products") {
        cacheRef.current.clear();
      }
    });
    return () => unsub();
  }, [queryClient]);

  const resolve = useCallback(
    async (raw: string): Promise<IdentityResolution> => {
      const gs1 = interpretScan(raw ?? "");
      const code = gs1.resolveCode;
      if (!code) return { kind: "not_found", code: "" };
      if (!businessId) {
        return { kind: "error", err: new Error("No business context for identity resolution") };
      }

      const cacheKey = `${businessId}|${branchId ?? ""}|${allowSkuFallback ? "sku" : "strict"}|${code.toUpperCase()}`;
      const cached = lruGet(cacheRef.current, cacheKey, Date.now());
      if (cached) {
        // Re-attach the GS1 envelope of THIS scan — lot/serial differ per
        // scan even when the GTIN (and therefore the cached identity) does.
        const r = cached.result;
        if (r.kind === "resolved" || r.kind === "ambiguous") {
          return { ...r, identity: { ...r.identity, gs1 } };
        }
        return r;
      }

      const existing = inflightRef.current.get(cacheKey);
      if (existing) {
        const shared = await existing;
        if (shared.kind === "resolved" || shared.kind === "ambiguous") {
          return { ...shared, identity: { ...shared.identity, gs1 } };
        }
        return shared;
      }

      const promise = rpcWithRetry(businessId, branchId, code, gs1, allowSkuFallback)
        .then((result) => {
          if (result.kind !== "error") {
            lruSet(cacheRef.current, cacheKey, { result, cachedAt: Date.now() });
          }
          return result;
        })
        .finally(() => {
          inflightRef.current.delete(cacheKey);
        });
      inflightRef.current.set(cacheKey, promise);
      return promise;
    },
    [businessId, branchId, allowSkuFallback],
  );

  const invalidate = useCallback(() => cacheRef.current.clear(), []);

  return { resolve, invalidate };
}
