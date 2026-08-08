/**
 * useResolveBarcode — server-indexed scanner resolution with LRU cache,
 * single-flight dedupe, and tagged result envelope.
 *
 * Wraps the `pos_resolve_scan` RPC (ADR-0110). POS no longer owns an
 * identity envelope of its own: `pos_resolve_scan` delegates matching to
 * `resolve_product_identity` and layers price/tax/packaging on top, so the
 * DECISION (`status`) that every other capture surface sees is the same
 * one the cashier sees. Operator copy comes from the shared taxonomy in
 * `@/features/products/identity/identityOutcome` — this hook never writes
 * its own failure wording.
 *
 * Track H-Scan (ADR-0014) — fixes the intermittent "barcode invalid /
 * not found" flicker reported on the web POS phone scanner:
 *
 *   1. **Tagged result** — `resolve()` now returns one of:
 *        - `{ kind: 'hit', row }` — RPC returned a product row.
 *        - `{ kind: 'miss' }`     — RPC returned no rows (truly unknown).
 *        - `{ kind: 'error', err }` — RPC failed / network blip.
 *      Callers can distinguish a real "unknown barcode" from a transient
 *      network error and surface the right feedback to the cashier.
 *   2. **Single-flight** — concurrent resolves of the same code share one
 *      in-flight RPC, so two near-simultaneous scans of the same barcode
 *      don't hammer Supabase or race the cache.
 *   3. **Bounded retry** — one jittered retry on `error` (the RPC is
 *      idempotent and safe to retry). A single packet drop no longer
 *      surfaces as "Unknown barcode".
 *   4. **Cache semantics**:
 *        - hits cached indefinitely (busted by `pos-products` invalidation)
 *        - misses cached for 5s only (so a just-created product becomes
 *          scannable as soon as realtime fires `pos-products` invalidate
 *          OR within 5s, whichever comes first)
 *        - errors never cached
 */

import { useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { IdentityStatus } from "@/features/products/identity/identityOutcome";

export interface ResolvedScan {
  productId: string;
  name: string;
  sku: string | null;
  sellingPrice: number;
  costPrice: number | null;
  taxRate: number | null;
  taxRateId: string | null;
  taxRateName: string | null;
  etimsTaxCode: string | null;
  categoryId: string | null;
  categoryName: string | null;
  branchOnHand: number;
  matchedKind: "gtin" | "sku" | "pack" | "supplier" | "internal" | "plu" | "alias";
  matchedCode: string;
  matchedRuleKind: "weighted_price" | "weighted_qty" | "plu" | null;
  scanQuantity: number;
  scanWeight: number | null;
  embeddedPrice: number | null;
  isWeighted: boolean;
  /** Packaging row that produced scanQuantity (null when the scan was a bare unit). */
  packagingId: string | null;
  /** Product's base UoM — the unit `quantity` is denominated in on the ledger. */
  baseUomId: string | null;
}

export type ResolveResult =
  | { kind: "hit"; row: ResolvedScan }
  | { kind: "miss"; status: Exclude<IdentityStatus, "resolved" | "error">; code: string; matchCount: number; productName: string | null }
  | { kind: "error"; err: Error; code?: string };

const MAX_CACHE = 256;
const MISS_TTL_MS = 5_000;

interface CacheEntry {
  result: Extract<ResolveResult, { kind: "hit" } | { kind: "miss" }>;
  cachedAt: number;
}

function lruGet(cache: Map<string, CacheEntry>, key: string, now: number): CacheEntry | undefined {
  const v = cache.get(key);
  if (v === undefined) return undefined;
  // Expire misses past their TTL — a just-created product should become
  // scannable without waiting for a realtime invalidate.
  if (v.result.kind === "miss" && now - v.cachedAt > MISS_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  // Touch for LRU recency.
  cache.delete(key);
  cache.set(key, v);
  return v;
}

function lruSet(cache: Map<string, CacheEntry>, key: string, value: CacheEntry) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > MAX_CACHE) {
    const first = cache.keys().next().value;
    if (first === undefined) break;
    cache.delete(first);
  }
}

function rowToResolved(row: Record<string, unknown>): ResolvedScan {
  return {
    productId: row.product_id as string,
    name: row.name as string,
    sku: (row.sku as string | null) ?? null,
    sellingPrice: Number(row.selling_price) || 0,
    costPrice: row.cost_price !== null && row.cost_price !== undefined ? Number(row.cost_price) : null,
    taxRate: row.tax_rate !== null && row.tax_rate !== undefined ? Number(row.tax_rate) : null,
    taxRateId: (row.tax_rate_id as string | null) ?? null,
    taxRateName: (row.tax_rate_name as string | null) ?? null,
    etimsTaxCode: (row.etims_tax_code as string | null) ?? null,
    categoryId: (row.category_id as string | null) ?? null,
    categoryName: (row.category_name as string | null) ?? null,
    branchOnHand: Number(row.branch_on_hand) || 0,
    matchedKind: row.matched_kind as ResolvedScan["matchedKind"],
    matchedCode: row.matched_code as string,
    matchedRuleKind: (row.matched_rule_kind as ResolvedScan["matchedRuleKind"]) ?? null,
    scanQuantity: Number(row.scan_quantity) || 1,
    scanWeight: row.scan_weight !== null && row.scan_weight !== undefined ? Number(row.scan_weight) : null,
    embeddedPrice: row.embedded_price !== null && row.embedded_price !== undefined ? Number(row.embedded_price) : null,
    isWeighted: !!row.is_weighted,
    packagingId: (row.packaging_id as string | null) ?? null,
    baseUomId: (row.base_uom_id as string | null) ?? null,
  };
}

const MISS_STATUSES: ReadonlyArray<Exclude<IdentityStatus, "resolved" | "error">> = [
  "ambiguous",
  "not_found",
  "inactive",
  "archived",
  "expired",
  "foreign_tenant",
  "unauthorized",
];

function missStatus(raw: unknown): Exclude<IdentityStatus, "resolved" | "error"> {
  return MISS_STATUSES.includes(raw as never)
    ? (raw as Exclude<IdentityStatus, "resolved" | "error">)
    : "not_found";
}

async function rpcOnce(
  businessId: string,
  branchId: string | null,
  code: string,
): Promise<ResolveResult> {
  const { data, error } = await supabase.rpc("pos_resolve_scan" as never, {
    p_business_id: businessId,
    p_branch_id: branchId,
    p_code: code,
  } as never);
  if (error) {
    // Carry the real cause. Collapsing this into "an unexpected error"
    // made every scanner failure unactionable for operators AND for
    // support: the code, details and hint are the whole diagnosis.
    const e = error as { message?: string; details?: string; hint?: string; code?: string };
    const detail = [e.message, e.details, e.hint].filter(Boolean).join(" — ");
    return {
      kind: "error",
      err: new Error(detail || "Scanner lookup RPC failed"),
      code: e.code,
    };
  }
  // Tolerate the legacy row-set shape while the wrapper still exists.
  const raw = data as unknown;
  const payload = (Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null)) as
    | Record<string, unknown>
    | null;
  if (!payload) {
    return { kind: "miss", status: "not_found", code, matchCount: 0, productName: null };
  }
  if (payload.status === "resolved" || (payload.status === undefined && payload.product_id)) {
    return { kind: "hit", row: rowToResolved(payload) };
  }
  return {
    kind: "miss",
    status: missStatus(payload.status),
    code,
    matchCount: Number(payload.match_count) || 0,
    productName: (payload.product_name as string | null) ?? null,
  };
}

async function rpcWithRetry(
  businessId: string,
  branchId: string | null,
  code: string,
): Promise<ResolveResult> {
  const first = await rpcOnce(businessId, branchId, code);
  if (first.kind !== "error") return first;
  // 200–500 ms jittered backoff, single retry. `pos_resolve_barcode` is
  // a pure read — safe to re-issue.
  const delay = 200 + Math.floor(Math.random() * 300);
  await new Promise((r) => setTimeout(r, delay));
  return rpcOnce(businessId, branchId, code);
}

export function useResolveBarcode(businessId: string | undefined, branchId: string | null) {
  const cacheRef = useRef<Map<string, CacheEntry>>(new Map());
  const inflightRef = useRef<Map<string, Promise<ResolveResult>>>(new Map());
  const queryClient = useQueryClient();

  // Bust the cache whenever the pos product list invalidates (product/price
  // edits, identifier edits, stock change).
  useEffect(() => {
    const unsub = queryClient.getQueryCache().subscribe((event) => {
      const key = (event.query.queryKey?.[0] as string) || "";
      if (key === "pos-products" || key === "product-identifiers") {
        cacheRef.current.clear();
      }
    });
    return () => {
      unsub();
    };
  }, [queryClient]);

  /**
   * Modern API — returns a tagged ResolveResult. Callers should branch on
   * `kind` to surface the right feedback ("unknown" vs "retrying").
   */
  const resolveTagged = useCallback(
    async (code: string): Promise<ResolveResult> => {
      if (!businessId) return {
          kind: "error",
          err: new Error("No active business selected — scanner cannot resolve codes"),
          code: "no_business_context",
        };
      const norm = code.trim();
      if (!norm) return { kind: "miss", status: "not_found", code, matchCount: 0, productName: null };
      const cacheKey = `${businessId}|${branchId ?? ""}|${norm.toLowerCase()}`;

      // Cache hit / unexpired miss.
      const cached = lruGet(cacheRef.current, cacheKey, Date.now());
      if (cached) return cached.result;

      // Single-flight: collapse concurrent identical requests.
      const existing = inflightRef.current.get(cacheKey);
      if (existing) return existing;

      const promise = rpcWithRetry(businessId, branchId, norm)
        .then((result) => {
          if (result.kind !== "error") {
            lruSet(cacheRef.current, cacheKey, { result, cachedAt: Date.now() });
          } else {
            // Never cache errors; surface them so callers can show a
            // distinct "retrying" / "network blip" state.
            console.warn(
              "[useResolveBarcode] RPC failed after retry:",
              result.code ?? "no-code",
              result.err.message,
            );
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

  /**
   * Back-compat shim. Existing call sites that expected a `ResolvedScan |
   * null` keep working — but they collapse `miss` and `error` into the
   * same `null`, which is the bug Track H-Scan fixes. Prefer
   * `resolveTagged` for new code.
   */
  const resolve = useCallback(
    async (code: string): Promise<ResolvedScan | null> => {
      const result = await resolveTagged(code);
      return result.kind === "hit" ? result.row : null;
    },
    [resolveTagged],
  );

  const invalidate = useCallback(() => cacheRef.current.clear(), []);

  return { resolve, resolveTagged, invalidate };
}
