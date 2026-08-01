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

export type IdentityResolution =
  | { kind: "resolved"; identity: ProductIdentity }
  | { kind: "ambiguous"; identity: ProductIdentity; matchCount: number }
  | { kind: "not_found"; code: string }
  | { kind: "error"; err: Error };

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
): Promise<IdentityResolution> {
  const { data, error } = await supabase.rpc("resolve_product_identity" as never, {
    p_business_id: businessId,
    p_code: code,
    p_branch_id: branchId ?? undefined,
  } as never);
  if (error) return { kind: "error", err: new Error(error.message || "RPC error") };
  const rows = (data as unknown) as Array<Record<string, unknown>> | null;
  const row = rows && rows.length > 0 ? rows[0] : null;
  if (!row) return { kind: "not_found", code };
  const identity = rowToIdentity(row, gs1);
  const matchCount = Number(row.match_count) || 1;
  if (matchCount > 1) return { kind: "ambiguous", identity, matchCount };
  return { kind: "resolved", identity };
}

async function rpcWithRetry(
  businessId: string,
  branchId: string | null,
  code: string,
  gs1: Gs1ScanInterpretation,
): Promise<IdentityResolution> {
  const first = await rpcOnce(businessId, branchId, code, gs1);
  if (first.kind !== "error") return first;
  // The resolver is a pure read — one jittered retry absorbs a packet drop
  // without ever surfacing it as "unknown barcode".
  await new Promise((r) => setTimeout(r, 200 + Math.floor(Math.random() * 300)));
  return rpcOnce(businessId, branchId, code, gs1);
}

/**
 * Convert a scan of a packaging level into base ledger units.
 * Single source of truth for "scanned 2 cases of 12" → 24 base units.
 */
export function scanToBaseUnits(identity: ProductIdentity, scans = 1): number {
  const packs = Number.isFinite(scans) && scans > 0 ? scans : 1;
  return packs * identity.qtyInBaseUom;
}

export function useResolveProductIdentity(
  businessId: string | undefined,
  branchId: string | null = null,
) {
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

      const cacheKey = `${businessId}|${branchId ?? ""}|${code.toUpperCase()}`;
      const cached = lruGet(cacheRef.current, cacheKey, Date.now());
      if (cached) {
        // Re-attach the GS1 envelope of THIS scan — lot/serial differ per
        // scan even when the GTIN (and therefore the cached identity) does.
        if (cached.result.kind === "not_found") return cached.result;
        return { ...cached.result, identity: { ...cached.result.identity, gs1 } };
      }

      const existing = inflightRef.current.get(cacheKey);
      if (existing) {
        const shared = await existing;
        if (shared.kind === "resolved" || shared.kind === "ambiguous") {
          return { ...shared, identity: { ...shared.identity, gs1 } };
        }
        return shared;
      }

      const promise = rpcWithRetry(businessId, branchId, code, gs1)
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
    [businessId, branchId],
  );

  const invalidate = useCallback(() => cacheRef.current.clear(), []);

  return { resolve, invalidate };
}
