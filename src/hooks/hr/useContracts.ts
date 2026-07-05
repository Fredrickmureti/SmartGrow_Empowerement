/**
 * useContracts — org/business-scoped read over `employee_contracts` joined
 * to `v_employees_canonical` for display names, with derived expiry state
 * computed from `end_date`.
 *
 * The single source of truth for the Contracts sub-app operational queues
 * (Drafts / Pending / Active / Expiring / Renewals / All).
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { differenceInDays, parseISO } from "date-fns";
import { supabase } from "@/integrations/supabase/client";
import { useHrScope } from "./useHrScope";

export type ContractStatus =
  | "draft"
  | "pending_approval"
  | "running"
  | "expired"
  | "terminated"
  | (string & {});

/** Derived expiry bucket for running contracts. */
export type ExpiryBucket = "0-30" | "31-60" | "61-90" | null;

export interface Contract {
  id: string;
  employee_id: string;
  business_id: string;
  organization_id: string;
  contract_reference: string | null;
  name: string | null;
  status: ContractStatus;
  start_date: string | null;
  end_date: string | null;
  probation_end_date: string | null;
  wage: number | null;
  compensation_mode: string | null;
  working_schedule: string | null;
  branch_id: string | null;
  salary_structure_id: string | null;
  approved_at: string | null;
  submitted_at: string | null;
  created_at: string;
  updated_at: string;
  // Denormalised
  employee_name: string | null;
  employee_number: string | null;
  amendments_count: number;
  /** Days until end_date; null if no end_date. Negative once expired. */
  days_to_expiry: number | null;
  expiry_bucket: ExpiryBucket;
}

export interface UseContractsOptions {
  /** Filter to a specific status. Omit for all. */
  status?: ContractStatus | ContractStatus[];
  /** Show only running contracts within N days of end_date (30/60/90). */
  expiringWithinDays?: number;
  /** Include only contracts already past end_date. */
  onlyExpired?: boolean;
  /** Free-text search over employee name / contract reference. */
  search?: string;
  limit?: number;
}

function bucketFor(days: number | null): ExpiryBucket {
  if (days === null) return null;
  if (days <= 30) return "0-30";
  if (days <= 60) return "31-60";
  if (days <= 90) return "61-90";
  return null;
}

export function useContracts(opts: UseContractsOptions = {}) {
  const {
    status,
    expiringWithinDays,
    onlyExpired,
    search,
    limit = 500,
  } = opts;
  const { orgId, businessId, branchIds, isBranchRestricted, isReady } = useHrScope();

  const statusKey = Array.isArray(status)
    ? status.slice().sort().join(",")
    : status ?? "any";

  const branchKey = isBranchRestricted ? branchIds.slice().sort().join(",") : "*";

  const query = useQuery({
    queryKey: [
      "hr-contracts",
      orgId,
      businessId,
      statusKey,
      expiringWithinDays ?? null,
      onlyExpired ?? false,
      branchKey,
      limit,
    ],
    enabled: isReady && !!orgId && !!businessId,
    staleTime: 30_000,
    queryFn: async (): Promise<Contract[]> => {
      let q = supabase
        .from("employee_contracts")
        .select(
          "id, organization_id, business_id, employee_id, contract_reference, name, status, start_date, end_date, probation_end_date, wage, compensation_mode, working_schedule, branch_id, salary_structure_id, approved_at, submitted_at, created_at, updated_at",
        )
        .eq("organization_id", orgId!)
        .eq("business_id", businessId!)
        .order("updated_at", { ascending: false })
        .limit(limit);

      if (status) {
        if (Array.isArray(status)) q = q.in("status", status as any);
        else q = q.eq("status", status as any);
      }
      if (isBranchRestricted && branchIds.length > 0) {
        q = q.in("branch_id", branchIds);
      }

      const { data, error } = await q;
      if (error) throw error;
      let rows = (data ?? []) as any[];

      // Employee names
      const empIds = Array.from(new Set(rows.map((r) => r.employee_id).filter(Boolean)));
      const nameMap = new Map<string, { name: string; number: string | null }>();
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

      // Amendment counts (per contract). One aggregate round-trip.
      const amendMap = new Map<string, number>();
      const contractIds = rows.map((r) => r.id);
      if (contractIds.length) {
        const { data: amendRows } = await supabase
          .from("contract_amendments")
          .select("contract_id")
          .in("contract_id", contractIds);
        (amendRows ?? []).forEach((a: any) => {
          amendMap.set(a.contract_id, (amendMap.get(a.contract_id) ?? 0) + 1);
        });
      }

      const today = new Date();
      let out: Contract[] = rows.map((r) => {
        const days = r.end_date
          ? differenceInDays(parseISO(r.end_date), today)
          : null;
        const nm = nameMap.get(r.employee_id);
        return {
          ...r,
          employee_name: nm?.name ?? null,
          employee_number: nm?.number ?? null,
          amendments_count: amendMap.get(r.id) ?? 0,
          days_to_expiry: days,
          expiry_bucket: bucketFor(days),
        } as Contract;
      });

      if (expiringWithinDays && expiringWithinDays > 0) {
        out = out.filter(
          (c) =>
            c.status === "running" &&
            c.days_to_expiry !== null &&
            c.days_to_expiry >= 0 &&
            c.days_to_expiry <= expiringWithinDays,
        );
      }
      if (onlyExpired) {
        out = out.filter(
          (c) => c.days_to_expiry !== null && c.days_to_expiry < 0,
        );
      }

      if (search && search.trim().length > 0) {
        const s = search.trim().toLowerCase();
        out = out.filter(
          (c) =>
            (c.employee_name?.toLowerCase().includes(s) ?? false) ||
            (c.contract_reference?.toLowerCase().includes(s) ?? false) ||
            (c.name?.toLowerCase().includes(s) ?? false),
        );
      }

      return out;
    },
  });

  return {
    contracts: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error as Error | null,
    refetch: query.refetch,
  };
}

/** Human labels for a status value. */
export function contractStatusLabel(s: ContractStatus): string {
  switch (s) {
    case "draft":
      return "Draft";
    case "pending_approval":
      return "Pending approval";
    case "running":
      return "Active";
    case "expired":
      return "Expired";
    case "terminated":
      return "Terminated";
    default:
      return String(s ?? "—");
  }
}

export function contractStatusTone(
  s: ContractStatus,
): "default" | "secondary" | "destructive" | "outline" {
  if (s === "running") return "default";
  if (s === "pending_approval") return "secondary";
  if (s === "expired" || s === "terminated") return "destructive";
  return "outline";
}

export function useContractStatusCounts() {
  const { contracts, isLoading } = useContracts({ limit: 2000 });
  const counts = useMemo(() => {
    const c = { draft: 0, pending_approval: 0, running: 0, expired: 0, terminated: 0, expiring_30: 0, expiring_60: 0, expiring_90: 0 };
    contracts.forEach((row) => {
      if (row.status in c) (c as any)[row.status]++;
      if (row.status === "running" && row.days_to_expiry !== null && row.days_to_expiry >= 0) {
        if (row.days_to_expiry <= 30) c.expiring_30++;
        else if (row.days_to_expiry <= 60) c.expiring_60++;
        else if (row.days_to_expiry <= 90) c.expiring_90++;
      }
    });
    return c;
  }, [contracts]);
  return { counts, isLoading };
}
