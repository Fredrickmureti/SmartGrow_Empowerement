/**
 * useEmployeeDocuments — org/business-scoped read over `employee_documents`
 * joined to `v_employees_canonical`, with derived compliance state
 * (`expired` / `expiring_30` / `expiring_60` / `expiring_90` / `current` /
 * `no_expiry`) computed from `expiry_date`.
 *
 * The single source of truth for the HR Document Compliance sub-app
 * operational queues (Expiring / Expired / Unverified / All).
 *
 * Verification writes go through `verify_employee_document` if it exists,
 * else a direct update — but the queues themselves are read-only; verify
 * lives on the employee profile.
 */
import { useQuery } from "@tanstack/react-query";
import { differenceInDays, parseISO } from "date-fns";
import { supabase } from "@/integrations/supabase/client";
import { useHrScope } from "./useHrScope";

export type DocumentComplianceBucket =
  | "expired"
  | "expiring_30"
  | "expiring_60"
  | "expiring_90"
  | "current"
  | "no_expiry";

export interface EmployeeDocument {
  id: string;
  organization_id: string;
  business_id: string | null;
  branch_id: string | null;
  employee_id: string;
  document_type: string | null;
  name: string | null;
  description: string | null;
  file_name: string | null;
  file_path: string | null;
  mime_type: string | null;
  expiry_date: string | null;
  is_verified: boolean | null;
  verified_at: string | null;
  uploaded_by: string | null;
  created_at: string;
  updated_at: string;
  // Denormalised
  employee_name: string | null;
  employee_number: string | null;
  /** Days until expiry_date; null if no expiry. Negative once expired. */
  days_to_expiry: number | null;
  compliance_bucket: DocumentComplianceBucket;
}

export interface UseEmployeeDocumentsOptions {
  /** Show only docs expiring within N days (positive days_to_expiry). */
  expiringWithinDays?: number;
  /** Show only expired docs (days_to_expiry < 0). */
  onlyExpired?: boolean;
  /** Show only unverified docs. */
  onlyUnverified?: boolean;
  /** Filter by document_type. */
  documentType?: string;
  /** Free-text search over employee name / doc name / type. */
  search?: string;
  limit?: number;
}

function bucketFor(days: number | null): DocumentComplianceBucket {
  if (days === null) return "no_expiry";
  if (days < 0) return "expired";
  if (days <= 30) return "expiring_30";
  if (days <= 60) return "expiring_60";
  if (days <= 90) return "expiring_90";
  return "current";
}

export function useEmployeeDocuments(opts: UseEmployeeDocumentsOptions = {}) {
  const {
    expiringWithinDays,
    onlyExpired,
    onlyUnverified,
    documentType,
    search,
    limit = 1000,
  } = opts;
  const { orgId, businessId, branchIds, isBranchRestricted, isReady } = useHrScope();

  const branchKey = isBranchRestricted ? branchIds.slice().sort().join(",") : "*";

  const query = useQuery({
    queryKey: [
      "hr-employee-documents",
      orgId,
      businessId,
      expiringWithinDays ?? null,
      onlyExpired ?? false,
      onlyUnverified ?? false,
      documentType ?? null,
      branchKey,
      limit,
    ],
    enabled: isReady && !!orgId,
    staleTime: 30_000,
    queryFn: async (): Promise<EmployeeDocument[]> => {
      let q = supabase
        .from("employee_documents")
        .select(
          "id, organization_id, business_id, branch_id, employee_id, document_type, name, description, file_name, file_path, mime_type, expiry_date, is_verified, verified_at, uploaded_by, created_at, updated_at",
        )
        .eq("organization_id", orgId!)
        .order("expiry_date", { ascending: true, nullsFirst: false })
        .limit(limit);

      if (businessId) q = q.eq("business_id", businessId);
      if (documentType) q = q.eq("document_type", documentType);
      if (onlyUnverified) q = q.eq("is_verified", false);
      if (isBranchRestricted && branchIds.length > 0) {
        q = q.in("branch_id", branchIds);
      }

      const { data, error } = await q;
      if (error) throw error;
      let rows = (data ?? []) as any[];

      // Employee names (join to v_employees_canonical)
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

      const today = new Date();
      let out: EmployeeDocument[] = rows.map((r) => {
        const days = r.expiry_date
          ? differenceInDays(parseISO(r.expiry_date), today)
          : null;
        const nm = nameMap.get(r.employee_id);
        return {
          ...r,
          employee_name: nm?.name ?? null,
          employee_number: nm?.number ?? null,
          days_to_expiry: days,
          compliance_bucket: bucketFor(days),
        } as EmployeeDocument;
      });

      if (expiringWithinDays && expiringWithinDays > 0) {
        out = out.filter(
          (d) =>
            d.days_to_expiry !== null &&
            d.days_to_expiry >= 0 &&
            d.days_to_expiry <= expiringWithinDays,
        );
      }
      if (onlyExpired) {
        out = out.filter(
          (d) => d.days_to_expiry !== null && d.days_to_expiry < 0,
        );
      }
      if (search && search.trim().length > 0) {
        const s = search.trim().toLowerCase();
        out = out.filter(
          (d) =>
            (d.employee_name?.toLowerCase().includes(s) ?? false) ||
            (d.name?.toLowerCase().includes(s) ?? false) ||
            (d.document_type?.toLowerCase().includes(s) ?? false) ||
            (d.file_name?.toLowerCase().includes(s) ?? false),
        );
      }

      return out;
    },
  });

  return {
    documents: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error as Error | null,
    refetch: query.refetch,
  };
}

export function documentBucketLabel(b: DocumentComplianceBucket): string {
  switch (b) {
    case "expired": return "Expired";
    case "expiring_30": return "≤ 30 days";
    case "expiring_60": return "31–60 days";
    case "expiring_90": return "61–90 days";
    case "current": return "Current";
    case "no_expiry": return "No expiry";
  }
}

export function documentBucketTone(
  b: DocumentComplianceBucket,
): "default" | "secondary" | "destructive" | "outline" {
  if (b === "expired") return "destructive";
  if (b === "expiring_30") return "destructive";
  if (b === "expiring_60") return "secondary";
  if (b === "expiring_90") return "secondary";
  if (b === "current") return "default";
  return "outline";
}
