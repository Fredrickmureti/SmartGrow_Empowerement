/**
 * useLeads.convertToProject — RPC contract.
 *
 * Pins that the hook calls the SECURITY DEFINER RPC
 * `convert_lead_to_project(p_lead_id, p_sales_order_id)`, threads the
 * optional SO id, returns the unwrapped row, and surfaces errors.
 *
 * This is the runtime contract behind the architecture guard
 * `crm-no-client-conversion.test.ts` (which forbids client-side inserts
 * into projects/sales_orders/estimates with source_lead_id outside
 * useLeads.ts).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

// ---- Mocks -----------------------------------------------------------------
const rpcMock = vi.fn();
const fromMock = vi.fn();

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
    from: (...args: unknown[]) => fromMock(...args),
  },
}));

vi.mock("@/hooks/useOrganization", () => ({
  useOrganization: () => ({ currentOrg: { id: "org-1", name: "Test" } }),
}));
vi.mock("@/hooks/useBusinesses", () => ({
  useBusinesses: () => ({ currentBusiness: { id: "biz-1", name: "Co" } }),
}));
vi.mock("@/contexts/BranchContext", () => ({
  useBranch: () => ({ currentBranch: null }),
}));
vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ user: { id: "user-1" } }),
}));
vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

import { useLeads } from "@/hooks/crm/useLeads";

// ---- Helpers ---------------------------------------------------------------

function stubInitialFetch(rows: any[] = []) {
  // useLeads runs an initial select on mount; we just need it to resolve.
  fromMock.mockImplementation(() => {
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      order: () => Promise.resolve({ data: rows, error: null }),
    };
    return chain;
  });
}

function rpcSingleResolved(value: { data: any; error: any }) {
  // supabase.rpc(...).single() chain.
  rpcMock.mockImplementation(() => ({
    single: () => Promise.resolve(value),
  }));
}

// ---- Tests -----------------------------------------------------------------

describe("useLeads.convertToProject", () => {
  beforeEach(() => {
    rpcMock.mockReset();
    fromMock.mockReset();
    stubInitialFetch([]);
  });

  it("calls convert_lead_to_project with NULL sales-order id by default", async () => {
    rpcSingleResolved({
      data: { id: "p-1", project_number: "PRJ-0001", was_existing: false },
      error: null,
    });

    const { result } = renderHook(() => useLeads());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let out: any;
    await act(async () => {
      out = await result.current.convertToProject("lead-1");
    });

    expect(rpcMock).toHaveBeenCalledWith("convert_lead_to_project", {
      p_lead_id: "lead-1",
      p_sales_order_id: null,
    });
    expect(out).toEqual({ id: "p-1", project_number: "PRJ-0001" });
  });

  it("threads the sales-order id through when provided (cross-link branch)", async () => {
    rpcSingleResolved({
      data: { id: "p-2", project_number: "PRJ-0002", was_existing: true },
      error: null,
    });

    const { result } = renderHook(() => useLeads());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.convertToProject("lead-2", "so-99");
    });

    expect(rpcMock).toHaveBeenCalledWith("convert_lead_to_project", {
      p_lead_id: "lead-2",
      p_sales_order_id: "so-99",
    });
  });

  it("propagates RPC errors to the caller", async () => {
    rpcSingleResolved({ data: null, error: { message: "boom" } });

    const { result } = renderHook(() => useLeads());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await expect(
      act(async () => {
        await result.current.convertToProject("lead-x");
      }),
    ).rejects.toBeTruthy();
  });
});