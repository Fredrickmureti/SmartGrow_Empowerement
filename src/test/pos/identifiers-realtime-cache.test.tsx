/**
 * Stage 4 regression: a `product_identifiers` invalidation must clear the
 * in-process LRU cache inside useResolveBarcode so a newly added barcode
 * becomes immediately resolvable on the next scan without a page refresh.
 *
 * We don't exercise the realtime channel itself here (that's an integration
 * test). Instead we exercise the contract `useResolveBarcode` relies on:
 * when the query cache emits an invalidation for the `product-identifiers`
 * key, the resolver's LRU is dropped.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// Mock the supabase client so the resolver hits a stub instead of network.
const rpcMock = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
  },
}));

import { useResolveBarcode } from "@/hooks/pos/useResolveBarcode";

function wrapper(client: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children);
}

describe("useResolveBarcode cache coherence with product_identifiers", () => {
  beforeEach(() => {
    rpcMock.mockReset();
  });

  it("invalidating product-identifiers clears the LRU", async () => {
    const client = new QueryClient();
    rpcMock.mockResolvedValueOnce({
      data: [{
        product_id: "p1", name: "X", sku: null, selling_price: 1, cost_price: null,
        tax_rate: null, tax_rate_id: null, tax_rate_name: null, etims_tax_code: null,
        category_id: null, category_name: null, branch_on_hand: 0,
        matched_kind: "gtin", matched_code: "123", matched_rule_kind: null,
        scan_quantity: 1, scan_weight: null, embedded_price: null, is_weighted: false,
      }],
      error: null,
    });

    const { result } = renderHook(() => useResolveBarcode("biz-1", null), {
      wrapper: wrapper(client),
    });

    // Seed a placeholder query under the product-identifiers key so that
    // invalidateQueries actually emits a cache event the resolver listens to.
    client.setQueryData(["product-identifiers", "biz-1"], []);

    // First scan — populates LRU.
    await act(async () => { await result.current.resolve("123"); });
    expect(rpcMock).toHaveBeenCalledTimes(1);

    // Second scan — served from LRU, no new RPC.
    await act(async () => { await result.current.resolve("123"); });
    expect(rpcMock).toHaveBeenCalledTimes(1);

    // Simulate a product_identifiers invalidation (what the realtime hook fires).
    rpcMock.mockResolvedValueOnce({ data: [], error: null });
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["product-identifiers"] });
    });

    // Next scan must hit the RPC again because the LRU was busted.
    await act(async () => { await result.current.resolve("123"); });
    expect(rpcMock).toHaveBeenCalledTimes(2);
  });
});

