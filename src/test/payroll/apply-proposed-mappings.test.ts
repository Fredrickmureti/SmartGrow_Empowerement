/**
 * Contract tests for the Apply-All-Suggested writer path.
 *
 * Verifies that `usePayrollGlReadiness.applyAll` calls
 * `payroll_apply_proposed_mappings` with the canonical 4-argument shape
 * (org / business / accept / branch). Regression test for the
 * "no unique or exclusion constraint matching the ON CONFLICT specification"
 * bug where the writer RPC and the table's unique constraint had drifted
 * (table had branch_id in its uniqueness key, RPC did not).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import React from "react";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: vi.fn() },
}));
vi.mock("@/hooks/useOrganization", () => ({
  useOrganization: () => ({ currentOrg: { id: "org-1" } }),
}));
vi.mock("@/hooks/useBusinesses", () => ({
  useBusinesses: () => ({ currentBusiness: { id: "biz-1" } }),
}));
const branchMock = { value: { currentBranch: null as { id: string } | null } };
vi.mock("@/hooks/useBranches", () => ({
  useBranches: () => branchMock.value,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { supabase } from "@/integrations/supabase/client";
import { usePayrollGlReadiness } from "@/hooks/payroll/usePayrollGlReadiness";

const wrapper = ({ children }: { children: ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return React.createElement(QueryClientProvider, { client: qc }, children);
};

const emptyReadinessOnce = () =>
  (supabase.rpc as any).mockResolvedValueOnce({ data: [], error: null });

const callsTo = (fn: string) =>
  (supabase.rpc as any).mock.calls.filter((c: any[]) => c[0] === fn);

describe("usePayrollGlReadiness.applyAll → payroll_apply_proposed_mappings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    branchMock.value = { currentBranch: null };
    // Stub readiness so all incidental refetches resolve cleanly.
    (supabase.rpc as any).mockImplementation((fn: string) => {
      if (fn === "payroll_gl_readiness") return Promise.resolve({ data: [], error: null });
      return Promise.resolve({ data: 0, error: null });
    });
  });

  it("calls the RPC with org, business, accept list, and branch_id=null at company scope", async () => {
    const { result } = renderHook(() => usePayrollGlReadiness(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const pairs = [
      { setting_key: "salary_expense", account_id: "acct-1" },
      { setting_key: "net_salary_payable", account_id: "acct-2" },
    ];
    await result.current.applyAll.mutateAsync(pairs);

    const applyCalls = callsTo("payroll_apply_proposed_mappings");
    expect(applyCalls).toHaveLength(1);
    expect(applyCalls[0][1]).toEqual({
      _org_id: "org-1",
      _business_id: "biz-1",
      _accept: pairs,
      _branch_id: null,
    });
  });

  it("forwards currentBranch.id when a branch is selected (per-branch override)", async () => {
    branchMock.value = { currentBranch: { id: "branch-7" } };

    const { result } = renderHook(() => usePayrollGlReadiness(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await result.current.applyAll.mutateAsync([
      { setting_key: "paye_payable", account_id: "acct-9" },
    ]);

    const applyCalls = callsTo("payroll_apply_proposed_mappings");
    expect(applyCalls[0][1]).toMatchObject({ _branch_id: "branch-7" });
  });

  it("createAndMap forwards _branch_id and _setting_key", async () => {
    branchMock.value = { currentBranch: { id: "branch-2" } };
    (supabase.rpc as any).mockImplementation((fn: string) => {
      if (fn === "payroll_gl_readiness") return Promise.resolve({ data: [], error: null });
      if (fn === "payroll_create_and_map_account")
        return Promise.resolve({ data: "new-acct-id", error: null });
      return Promise.resolve({ data: 0, error: null });
    });

    const { result } = renderHook(() => usePayrollGlReadiness(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await result.current.createAndMap.mutateAsync({
      setting_key: "nita_employer_expense",
      name: "NITA Employer Expense",
      account_type: "expense",
    });

    const createCalls = callsTo("payroll_create_and_map_account");
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0][1]).toEqual({
      _org_id: "org-1",
      _business_id: "biz-1",
      _setting_key: "nita_employer_expense",
      _name: "NITA Employer Expense",
      _account_type: "expense",
      _branch_id: "branch-2",
    });
  });

  it("surfaces RPC errors instead of swallowing them (regression for ON CONFLICT 42P10)", async () => {
    (supabase.rpc as any).mockImplementation((fn: string) => {
      if (fn === "payroll_gl_readiness") return Promise.resolve({ data: [], error: null });
      return Promise.resolve({
        data: null,
        error: { message: "there is no unique or exclusion constraint matching the ON CONFLICT specification" },
      });
    });

    const { result } = renderHook(() => usePayrollGlReadiness(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await expect(
      result.current.applyAll.mutateAsync([
        { setting_key: "salary_expense", account_id: "acct-1" },
      ]),
    ).rejects.toMatchObject({ message: expect.stringMatching(/ON CONFLICT/i) });
  });
});
