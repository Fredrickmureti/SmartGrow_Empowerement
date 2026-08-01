/**
 * Phase C1 regression tests — the canonical client identity resolver.
 *
 * Contract under test (`.lovable/plan.md`, Phase C1):
 *   - one match            → { kind: "resolved" }
 *   - match_count > 1      → { kind: "ambiguous" } (never silently picked)
 *   - zero rows            → { kind: "not_found" } (distinct from error)
 *   - RPC failure (twice)  → { kind: "error" }  — NEVER "not_found"
 *   - transient failure    → retried once, then resolved
 *   - GS1 payload          → resolved on the GTIN, lot/expiry/serial exposed
 *   - identical codes      → single-flight (one RPC) + cached afterwards
 *   - packaging conversion → scanToBaseUnits multiplies by qty_in_base_uom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let rpcCalls: Array<{ name: string; args: any }> = [];
let rpcImpl: (name: string, args: any) => Promise<{ data: any; error: any }> = async () => ({
  data: [],
  error: null,
});

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: (name: string, args: any) => {
      rpcCalls.push({ name, args });
      return rpcImpl(name, args);
    },
  },
}));

import {
  useResolveProductIdentity,
  scanToBaseUnits,
  type ProductIdentity,
} from "@/hooks/inventory/useResolveProductIdentity";

const CASE_ROW = {
  product_id: "p1",
  product_name: "Cola 500ml",
  sku: "COLA-500",
  identifier_id: "i1",
  matched_code: "05012345678900",
  matched_kind: "gtin",
  packaging_id: "pk1",
  packaging_name: "Case of 12",
  qty_in_base_uom: 12,
  is_base_unit: false,
  base_uom_id: "u1",
  match_count: 1,
};

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return React.createElement(QueryClientProvider, { client: qc }, children);
}

function mount() {
  return renderHook(() => useResolveProductIdentity("biz-1", "branch-1"), { wrapper });
}

beforeEach(() => {
  rpcCalls = [];
  rpcImpl = async () => ({ data: [], error: null });
});

describe("useResolveProductIdentity", () => {
  it("resolves a single match and reports the packaging level", async () => {
    rpcImpl = async () => ({ data: [CASE_ROW], error: null });
    const { result } = mount();
    const res = await act(async () => result.current.resolve("05012345678900"));
    expect(res.kind).toBe("resolved");
    if (res.kind !== "resolved") return;
    expect(res.identity.productId).toBe("p1");
    expect(res.identity.packagingId).toBe("pk1");
    expect(res.identity.qtyInBaseUom).toBe(12);
    expect(rpcCalls[0].name).toBe("resolve_product_identity");
    expect(rpcCalls[0].args.p_branch_id).toBe("branch-1");
  });

  it("flags an ambiguous code instead of silently choosing", async () => {
    rpcImpl = async () => ({ data: [{ ...CASE_ROW, match_count: 3 }], error: null });
    const { result } = mount();
    const res = await act(async () => result.current.resolve("DUPE"));
    expect(res.kind).toBe("ambiguous");
    if (res.kind === "ambiguous") expect(res.matchCount).toBe(3);
  });

  it("distinguishes not_found from error", async () => {
    rpcImpl = async () => ({ data: [], error: null });
    const { result } = mount();
    const miss = await act(async () => result.current.resolve("NOPE-1"));
    expect(miss.kind).toBe("not_found");

    rpcImpl = async () => ({ data: null, error: { message: "network down" } });
    const err = await act(async () => result.current.resolve("NOPE-2"));
    expect(err.kind).toBe("error");
  });

  it("retries once on a transient failure before giving up", async () => {
    let n = 0;
    rpcImpl = async () => {
      n += 1;
      return n === 1 ? { data: null, error: { message: "blip" } } : { data: [CASE_ROW], error: null };
    };
    const { result } = mount();
    const res = await act(async () => result.current.resolve("05012345678900"));
    expect(res.kind).toBe("resolved");
    expect(n).toBe(2);
  });

  it("resolves a GS1 payload on its GTIN and exposes lot/expiry", async () => {
    rpcImpl = async () => ({ data: [CASE_ROW], error: null });
    const { result } = mount();
    const gs = "\x1d";
    const res = await act(async () =>
      result.current.resolve("0105012345678900" + "17260731" + "10LOT99" + gs),
    );
    expect(res.kind).toBe("resolved");
    if (res.kind !== "resolved") return;
    expect(rpcCalls[0].args.p_code).toBe("05012345678900");
    expect(res.identity.gs1.isGs1).toBe(true);
    expect(res.identity.gs1.normalized.lot).toBe("LOT99");
    expect(res.identity.gs1.normalized.expiry?.getUTCFullYear()).toBe(2026);
  });

  it("single-flights and then caches repeated codes", async () => {
    rpcImpl = async () => ({ data: [CASE_ROW], error: null });
    const { result } = mount();
    await act(async () => {
      await Promise.all([
        result.current.resolve("05012345678900"),
        result.current.resolve("05012345678900"),
      ]);
    });
    expect(rpcCalls.length).toBe(1);
    await act(async () => result.current.resolve("05012345678900"));
    expect(rpcCalls.length).toBe(1);
  });

  it("converts a level scan into base ledger units", () => {
    const identity = { qtyInBaseUom: 12 } as ProductIdentity;
    expect(scanToBaseUnits(identity, 1)).toBe(12);
    expect(scanToBaseUnits(identity, 2)).toBe(24);
    expect(scanToBaseUnits({ qtyInBaseUom: 1 } as ProductIdentity)).toBe(1);
  });
});
