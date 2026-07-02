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
vi.mock("@/hooks/useBranches", () => ({
  useBranches: () => ({ currentBranch: null }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { supabase } from "@/integrations/supabase/client";
import { usePayrollGlReadiness } from "@/hooks/payroll/usePayrollGlReadiness";

const wrapper = ({ children }: { children: ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return React.createElement(QueryClientProvider, { client: qc }, children);
};

describe("usePayrollGlReadiness", () => {
  beforeEach(() => vi.clearAllMocks());

  it("groups missing rows and only includes mapped suggestions in suggestedPairs", async () => {
    (supabase.rpc as any).mockResolvedValueOnce({
      data: [
        { setting_key: "salary_expense", label: "Salary Expense", rule_code: null, kind: "core",
          required_account_type: "expense", is_mapped: true,
          suggested_account_id: "acct-1", suggested_account_label: "Salary Expense" },
        { setting_key: "paye_payable", label: "PAYE Payable", rule_code: "PAYE", kind: "employee_payable",
          required_account_type: "liability", is_mapped: false,
          suggested_account_id: "acct-2", suggested_account_label: "PAYE Liability" },
        { setting_key: "nita_employer_expense", label: "NITA Employer Expense", rule_code: "NITA",
          kind: "employer_expense", required_account_type: "expense", is_mapped: false,
          suggested_account_id: null, suggested_account_label: null },
      ],
      error: null,
    });

    const { result } = renderHook(() => usePayrollGlReadiness(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.rows).toHaveLength(3);
    expect(result.current.missing.map((m) => m.setting_key)).toEqual([
      "paye_payable",
      "nita_employer_expense",
    ]);
    expect(result.current.suggestedPairs).toEqual([
      { setting_key: "paye_payable", account_id: "acct-2" },
    ]);
    expect(result.current.isReady).toBe(false);
  });

  it("isReady is true when nothing is missing", async () => {
    (supabase.rpc as any).mockResolvedValueOnce({
      data: [
        { setting_key: "salary_expense", label: "Salary Expense", rule_code: null, kind: "core",
          required_account_type: "expense", is_mapped: true,
          suggested_account_id: "acct-1", suggested_account_label: "Salary Expense" },
      ],
      error: null,
    });
    const { result } = renderHook(() => usePayrollGlReadiness(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isReady).toBe(true);
    expect(result.current.missing).toEqual([]);
  });
});
