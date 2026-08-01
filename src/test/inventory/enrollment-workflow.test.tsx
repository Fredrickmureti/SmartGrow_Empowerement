/**
 * Barcode Enrollment workflow reducer/orchestrator tests.
 *
 * Architecture contract under test (ADR 0013 + .lovable/plan.md):
 *   - SCAN while validating is ignored (single-flight per code).
 *   - SCAN_OK advances the queue and remembers the outcome (undo target).
 *   - SCAN_DUPLICATE warns without consuming the cursor.
 *   - SKIP defers the head to the tail (FIFO continuity preserved).
 *   - UNDO restores the last successful enrollment, decrementing doneCount.
 *   - Stale RPC responses (seq mismatch after SKIP/UNDO) are dropped.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// Controllable supabase.rpc mock — flag()/undo() in the orchestrator call
// supabase.rpc directly. Default to a successful flag; individual tests
// override via `rpcImpl`.
let rpcImpl: (name: string, args: any) => Promise<{ data: any; error: any }> =
  async (name) =>
    name === "flag_product_for_review"
      ? { data: { status: "ok" }, error: null }
      : { data: { status: "ok" }, error: null };
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: (name: string, args: any) => rpcImpl(name, args),
  },
}));

import {
  useEnrollmentWorkflow,
  type EnrollRpcResult,
} from "@/hooks/inventory/useEnrollmentWorkflow";
import type { IdentificationTarget } from "@/hooks/inventory/useIdentificationQueue";

/**
 * Queue entries are level-aware `IdentificationTarget`s (one per missing
 * packaging level), as produced by `useIdentificationQueue`.
 */
const P = (
  id: string,
  name = id,
  level?: { packagingId: string | null; levelName: string; qtyInBaseUom: number },
): IdentificationTarget => ({
  key: `${id}:${level?.packagingId ?? "base"}`,
  id,
  name,
  sku: null,
  unit_price: 0,
  image_url: null,
  category_id: null,
  packagingId: level?.packagingId ?? null,
  levelName: level?.levelName ?? "Base unit",
  qtyInBaseUom: level?.qtyInBaseUom ?? 1,
  ladder: [],
});


function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("useEnrollmentWorkflow", () => {
  it("SCAN_OK advances the queue and records last enrolled outcome", async () => {
    const enrollFn = async (): Promise<EnrollRpcResult> => ({
      status: "ok",
      identifier_id: "id-1",
    });
    const { result } = renderHook(() =>
      useEnrollmentWorkflow({
        businessId: "biz",
        products: [P("a"), P("b")],
        silent: true,
        enrollFn,
      }),
    );

    expect(result.current.current?.id).toBe("a");
    await act(async () => {
      await result.current.submit("123");
    });
    expect(result.current.current?.id).toBe("b");
    expect(result.current.doneCount).toBe(1);
    expect(result.current.lastEnrolled?.code).toBe("123");
  });

  it("SCAN_DUPLICATE keeps the cursor and surfaces conflict name", async () => {
    const enrollFn = async (): Promise<EnrollRpcResult> => ({
      status: "duplicate",
      conflict_product_id: "x",
      conflict_product_name: "Other product",
    });
    const { result } = renderHook(() =>
      useEnrollmentWorkflow({
        businessId: "biz",
        products: [P("a")],
        silent: true,
        enrollFn,
      }),
    );
    await act(async () => {
      await result.current.submit("123");
    });
    expect(result.current.current?.id).toBe("a");
    expect(result.current.status).toBe("duplicate");
    expect(result.current.lastError?.conflictProductName).toBe("Other product");
  });

  it("SKIP moves the head to the tail (FIFO continuity)", () => {
    const enrollFn = async (): Promise<EnrollRpcResult> => ({
      status: "ok",
      identifier_id: "x",
    });
    const { result } = renderHook(() =>
      useEnrollmentWorkflow({
        businessId: "biz",
        products: [P("a"), P("b"), P("c")],
        silent: true,
        enrollFn,
      }),
    );
    act(() => result.current.skip());
    expect(result.current.queue.map((p) => p.id)).toEqual(["b", "c", "a"]);
  });

  it("single-flight: concurrent submits ignored while validating", async () => {
    const d = deferred<EnrollRpcResult>();
    let calls = 0;
    const enrollFn = async () => {
      calls++;
      return d.promise;
    };
    const { result } = renderHook(() =>
      useEnrollmentWorkflow({
        businessId: "biz",
        products: [P("a")],
        silent: true,
        enrollFn,
      }),
    );

    let p1: Promise<void> = Promise.resolve();
    act(() => {
      p1 = result.current.submit("code-1");
    });
    // second submit while still validating
    await act(async () => {
      await result.current.submit("code-2");
    });
    expect(calls).toBe(1);

    await act(async () => {
      d.resolve({ status: "ok", identifier_id: "id" });
      await p1;
    });
    expect(result.current.doneCount).toBe(1);
  });

  it("stale RPC response (post-SKIP) is dropped via seq guard", async () => {
    const d = deferred<EnrollRpcResult>();
    const enrollFn = async () => d.promise;
    const { result } = renderHook(() =>
      useEnrollmentWorkflow({
        businessId: "biz",
        products: [P("a"), P("b")],
        silent: true,
        enrollFn,
      }),
    );

    let p1: Promise<void> = Promise.resolve();
    act(() => {
      p1 = result.current.submit("123");
    });
    // operator skips before the RPC comes back
    act(() => result.current.skip());
    // RPC now resolves — must be dropped
    await act(async () => {
      d.resolve({ status: "ok", identifier_id: "id" });
      await p1;
    });
    expect(result.current.doneCount).toBe(0);
    // queue still has both items (skip rotated, no enrollment recorded)
    expect(result.current.queue.length).toBe(2);
  });

  it("stale RPC response (post-JUMP) is dropped via seq guard", async () => {
    const d = deferred<EnrollRpcResult>();
    const enrollFn = async () => d.promise;
    const { result } = renderHook(() =>
      useEnrollmentWorkflow({
        businessId: "biz",
        products: [P("a"), P("b"), P("c")],
        silent: true,
        enrollFn,
      }),
    );

    let p1: Promise<void> = Promise.resolve();
    act(() => {
      p1 = result.current.submit("999");
    });
    act(() => result.current.jump(1));
    await act(async () => {
      d.resolve({ status: "ok", identifier_id: "id" });
      await p1;
    });
    expect(result.current.doneCount).toBe(0);
    expect(result.current.queue.length).toBe(3);
  });

  beforeEach(() => {
    rpcImpl = async () => ({ data: { status: "ok" }, error: null });
  });

  it("flag() advances the cursor when the RPC returns ok", async () => {
    const enrollFn = async (): Promise<EnrollRpcResult> => ({
      status: "ok",
      identifier_id: "x",
    });
    const { result } = renderHook(() =>
      useEnrollmentWorkflow({
        businessId: "biz",
        products: [P("a"), P("b"), P("c")],
        silent: true,
        enrollFn,
      }),
    );
    await act(async () => {
      await result.current.flag("needs label");
    });
    expect(result.current.queue.map((p) => p.id)).toEqual(["b", "c", "a"]);
    expect(result.current.doneCount).toBe(0);
    expect(result.current.lastError).toBeNull();
  });

  it("flag() keeps the cursor put when the RPC fails (UI/DB cannot diverge)", async () => {
    rpcImpl = async () => ({
      data: null,
      error: { message: "permission denied" },
    });
    const enrollFn = async (): Promise<EnrollRpcResult> => ({
      status: "ok",
      identifier_id: "x",
    });
    const { result } = renderHook(() =>
      useEnrollmentWorkflow({
        businessId: "biz",
        products: [P("a"), P("b"), P("c")],
        silent: true,
        enrollFn,
      }),
    );
    await act(async () => {
      await result.current.flag("needs label");
    });
    // Head unchanged — operator sees the inline error and can retry / skip.
    expect(result.current.queue.map((p) => p.id)).toEqual(["a", "b", "c"]);
    expect(result.current.lastError?.message).toMatch(/Flag failed/);
  });
});
