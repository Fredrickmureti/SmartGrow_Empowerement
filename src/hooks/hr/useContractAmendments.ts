/**
 * useContractAmendments — reads `contract_amendments` (org/business-scoped,
 * joined against `v_employees_canonical`) and exposes thin write wrappers
 * over the existing `renew_contract` / `amend_contract` RPCs.
 *
 * Powers the Renewals, Amendments, and Audit surfaces in the Contracts
 * sub-app.
 */
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useHrScope } from "./useHrScope";

export type ContractAmendmentKind =
  | "renewal"
  | "salary_revision"
  | "position_change"
  | "location_change"
  | "schedule_change"
  | "allowance_change"
  | "end_date_change"
  | "other";

export interface ContractAmendment {
  id: string;
  organization_id: string;
  business_id: string;
  contract_id: string;
  employee_id: string;
  kind: ContractAmendmentKind;
  effective_on: string;
  actor_user_id: string | null;
  summary: string | null;
  before_snapshot: Record<string, unknown> | null;
  after_snapshot: Record<string, unknown> | null;
  successor_contract_id: string | null;
  created_at: string;
  // denormalised
  employee_name: string | null;
  employee_number: string | null;
  contract_reference: string | null;
}

export interface UseContractAmendmentsOptions {
  contractId?: string;
  employeeId?: string;
  kind?: ContractAmendmentKind | ContractAmendmentKind[];
  sinceDays?: number;
  limit?: number;
}

export function useContractAmendments(opts: UseContractAmendmentsOptions = {}) {
  const { orgId, businessId, isReady } = useHrScope();
  const { contractId, employeeId, kind, sinceDays, limit = 300 } = opts;

  const kindKey = Array.isArray(kind) ? kind.slice().sort().join(",") : kind ?? "any";

  const query = useQuery({
    queryKey: [
      "hr-contract-amendments",
      orgId,
      businessId,
      contractId ?? "all",
      employeeId ?? "all",
      kindKey,
      sinceDays ?? "all",
      limit,
    ],
    enabled: isReady && !!orgId && !!businessId,
    staleTime: 30_000,
    queryFn: async (): Promise<ContractAmendment[]> => {
      let q = supabase
        .from("contract_amendments")
        .select(
          "id, organization_id, business_id, contract_id, employee_id, kind, effective_on, actor_user_id, summary, before_snapshot, after_snapshot, successor_contract_id, created_at",
        )
        .eq("organization_id", orgId!)
        .eq("business_id", businessId!)
        .order("created_at", { ascending: false })
        .limit(limit);

      if (contractId) q = q.eq("contract_id", contractId);
      if (employeeId) q = q.eq("employee_id", employeeId);
      if (kind) {
        if (Array.isArray(kind)) q = q.in("kind", kind as any);
        else q = q.eq("kind", kind as any);
      }
      if (sinceDays && sinceDays > 0) {
        const since = new Date();
        since.setDate(since.getDate() - sinceDays);
        q = q.gte("created_at", since.toISOString());
      }
      const { data, error } = await q;
      if (error) throw error;
      const rows = (data ?? []) as any[];

      // Employee names + contract references
      const empIds = Array.from(new Set(rows.map((r) => r.employee_id).filter(Boolean)));
      const contractIds = Array.from(new Set(rows.map((r) => r.contract_id).filter(Boolean)));
      const nameMap = new Map<string, { name: string; number: string | null }>();
      const refMap = new Map<string, string | null>();
      if (empIds.length) {
        const { data: emps } = await supabase
          .from("v_employees_canonical")
          .select("id, first_name, last_name, employee_number")
          .in("id", empIds);
        (emps ?? []).forEach((e: any) => {
          nameMap.set(e.id, {
            name: [e.first_name, e.last_name].filter(Boolean).join(" ") || "—",
            number: e.employee_number ?? null,
          });
        });
      }
      if (contractIds.length) {
        const { data: contracts } = await supabase
          .from("employee_contracts")
          .select("id, contract_reference")
          .in("id", contractIds);
        (contracts ?? []).forEach((c: any) => refMap.set(c.id, c.contract_reference ?? null));
      }

      return rows.map((r) => {
        const nm = nameMap.get(r.employee_id);
        return {
          ...r,
          employee_name: nm?.name ?? null,
          employee_number: nm?.number ?? null,
          contract_reference: refMap.get(r.contract_id) ?? null,
        } as ContractAmendment;
      });
    },
  });

  return {
    amendments: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error as Error | null,
    refetch: query.refetch,
  };
}

export const AMENDMENT_KIND_LABELS: Record<ContractAmendmentKind, string> = {
  renewal: "Renewal",
  salary_revision: "Salary revision",
  position_change: "Position change",
  location_change: "Location change",
  schedule_change: "Schedule change",
  allowance_change: "Allowance change",
  end_date_change: "End-date change",
  other: "Other",
};

export function amendmentKindTone(
  k: ContractAmendmentKind,
): "default" | "secondary" | "destructive" | "outline" {
  if (k === "renewal") return "default";
  if (k === "salary_revision" || k === "position_change") return "secondary";
  return "outline";
}

/** Renew a contract via the existing `renew_contract` RPC. */
export function useRenewContract() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      contractId: string;
      newStart: string;
      newEnd?: string | null;
      newWage?: number | null;
    }) => {
      const { data, error } = await supabase.rpc("renew_contract" as any, {
        p_contract_id: input.contractId,
        p_new_start: input.newStart,
        p_new_end: input.newEnd ?? null,
        p_new_wage: input.newWage ?? null,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast.success("Contract renewed");
      qc.invalidateQueries({ queryKey: ["hr-contracts"] });
      qc.invalidateQueries({ queryKey: ["hr-contract-amendments"] });
      qc.invalidateQueries({ queryKey: ["lifecycle-events"] });
      qc.invalidateQueries({ queryKey: ["hr", "contracts", "overview"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Failed to renew contract"),
  });
}

/** Amend a contract via the existing `amend_contract` RPC. */
export function useAmendContract() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      contractId: string;
      kind: ContractAmendmentKind;
      effectiveOn: string;
      changes: Record<string, unknown>;
      summary?: string | null;
    }) => {
      const { data, error } = await supabase.rpc("amend_contract" as any, {
        p_contract_id: input.contractId,
        p_kind: input.kind,
        p_effective_on: input.effectiveOn,
        p_changes: input.changes as any,
        p_summary: input.summary ?? null,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast.success("Contract amended");
      qc.invalidateQueries({ queryKey: ["hr-contracts"] });
      qc.invalidateQueries({ queryKey: ["hr-contract-amendments"] });
      qc.invalidateQueries({ queryKey: ["lifecycle-events"] });
      qc.invalidateQueries({ queryKey: ["hr", "contracts", "overview"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Failed to amend contract"),
  });
}
