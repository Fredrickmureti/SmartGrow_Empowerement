/**
 * useBillsPaginated — server-side paged read model for the Bills list.
 *
 * Why a separate hook: `useBills` is the *write* surface (create, confirm,
 * submit, approve, pay) and loads every bill for the company so those actions
 * can operate on the full set. That is fine for a form, fatal for a list —
 * an AP ledger grows without bound. This hook does the reading only, with
 * `.range()` + `count: "exact"`, and pushes search / status / date filters to
 * the server so page N is genuinely page N of the filtered set.
 *
 * Two rules it must respect:
 *  - Branch isolation goes through `applyBranchFilter` (active branch OR
 *    legacy NULL), same as every other scoped read.
 *  - `overdue` is NOT a stored status (AP Step 2b). Filtering for it means
 *    "posted or partly paid, past due, still owing" — expressed in SQL here
 *    so it matches `deriveBillStatus` on the client exactly.
 */
import { useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useBranch } from "@/contexts/BranchContext";
import { usePaginatedQuery } from "./usePaginatedQuery";
import { applyBranchFilter } from "@/lib/branchScope";
import { assertCompanyScoped, assertBranchScoped } from "@/lib/purchases/scopingAssertions";
import type { Bill } from "./useBills";

export interface BillFilters {
  /** Matches bill number or supplier name. */
  search?: string;
  /** Lifecycle status, `"overdue"` (derived) or `"all"`. */
  status?: string;
  /** Bill-date lower bound, inclusive (yyyy-mm-dd). */
  dateFrom?: string;
  /** Bill-date upper bound, inclusive (yyyy-mm-dd). */
  dateTo?: string;
}

/** Local calendar day, so "past due" matches what the user sees. */
function todayISO(): string {
  const now = new Date();
  const m = `${now.getMonth() + 1}`.padStart(2, "0");
  const d = `${now.getDate()}`.padStart(2, "0");
  return `${now.getFullYear()}-${m}-${d}`;
}

export function useBillsPaginated(filters?: BillFilters) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranch();

  const organizationId = currentOrg?.id;
  const businessId = currentBusiness?.id;
  const branchId = currentBranch?.id ?? null;

  const key = useMemo(
    () => ({
      search: filters?.search?.trim() || "",
      status: filters?.status || "all",
      dateFrom: filters?.dateFrom || "",
      dateTo: filters?.dateTo || "",
    }),
    [filters?.search, filters?.status, filters?.dateFrom, filters?.dateTo],
  );

  const result = usePaginatedQuery<Bill>({
    queryKey: ["bills-paginated", organizationId, businessId, branchId, key],
    enabled: Boolean(organizationId && businessId),
    queryFn: async ({ from, to }) => {
      if (!organizationId || !businessId) return { data: [], count: 0 };

      // Supplier-name search needs the contact ids first — PostgREST cannot
      // filter a parent by an embedded resource without an inner join.
      let vendorIds: string[] = [];
      if (key.search) {
        const { data: matches } = await supabase
          .from("contacts")
          .select("id")
          .eq("organization_id", organizationId)
          .eq("business_id", businessId)
          .ilike("name", `%${key.search}%`)
          .limit(100);
        vendorIds = (matches ?? []).map((c) => c.id);
      }

      let query = supabase
        .from("bills")
        .select(
          `
          *,
          vendor:contacts(name, email),
          items:bill_items(*)
        `,
          { count: "exact" },
        )
        .eq("organization_id", organizationId)
        .eq("business_id", businessId)
        .order("bill_date", { ascending: false });

      query = applyBranchFilter(query, branchId);

      if (key.status === "overdue") {
        // Derived condition — must mirror `isBillOverdue`.
        query = query
          .in("status", ["received", "partial"])
          .lt("due_date", todayISO());
      } else if (key.status && key.status !== "all") {
        query = query.eq("status", key.status as Bill["status"]);
      }

      if (key.dateFrom) query = query.gte("bill_date", key.dateFrom);
      if (key.dateTo) query = query.lte("bill_date", key.dateTo);

      if (key.search) {
        query = vendorIds.length
          ? query.or(
              `bill_number.ilike.%${key.search}%,vendor_invoice_number.ilike.%${key.search}%,vendor_id.in.(${vendorIds.join(",")})`,
            )
          : query.or(
              `bill_number.ilike.%${key.search}%,vendor_invoice_number.ilike.%${key.search}%`,
            );
      }

      const { data, error, count } = await query.range(from, to);
      if (error) throw error;

      let rows = (data as unknown as Bill[]) ?? [];
      // The overdue filter cannot express "balance still owing" in PostgREST
      // (no column-to-column comparison), so settle that last, on the page.
      if (key.status === "overdue") {
        rows = rows.filter(
          (b) => Math.round((Number(b.total) - Number(b.amount_paid ?? 0)) * 100) > 0,
        );
      }

      // Dev-only contamination guards — RLS gates the company, these catch
      // branch leaks and bad joins before they reach the screen.
      assertCompanyScoped(rows, businessId, "useBillsPaginated");
      assertBranchScoped(rows, branchId, "useBillsPaginated");

      return { data: rows, count: count ?? 0 };
    },
  });

  return { bills: result.data, ...result };
}
