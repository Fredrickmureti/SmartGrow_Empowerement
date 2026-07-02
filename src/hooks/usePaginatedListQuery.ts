import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { startOfMonth, endOfMonth, subMonths, format } from "date-fns";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useBranch } from "@/contexts/BranchContext";
import { applyBranchFilter } from "@/lib/branchScope";
import { usePaginatedQuery } from "./usePaginatedQuery";

export type DateRangeKey = "all" | "this_month" | "last_month" | "last_3_months" | string;

export interface PaginatedListOptions<T> {
  /** Supabase table name. */
  table: string;
  /** select() expression. */
  select: string;
  /** Column to sort by; defaults to created_at desc. */
  orderBy?: { column: string; ascending?: boolean };
  /** Search term (ilike). */
  search?: string;
  /** Columns to ilike-match the search against. */
  searchColumns?: string[];
  /** Status equality filter (skipped if "all" / undefined). */
  status?: string;
  /** Status column name (default "status"). */
  statusColumn?: string;
  /** Date range key + the column to filter on. */
  dateRange?: DateRangeKey;
  dateColumn?: string;
  /** Apply org/business/branch scoping (default true). */
  applyTenantScope?: boolean;
  /** Apply branch filter (default true). */
  applyBranch?: boolean;
  /** Extra filter callback for ad-hoc clauses. */
  extra?: (q: any) => any;
  /** Stable cache key suffix to differentiate hook instances. */
  cacheKey: string;
  pageSize?: number;
  enabled?: boolean;
}

/**
 * Generic server-side-paginated list query for tenant-scoped tables.
 * Used by transactional list pages (delivery notes, sales orders, bills, etc.)
 * to avoid duplicating ~150 lines of fetcher boilerplate per entity.
 */
export function usePaginatedListQuery<T>(opts: PaginatedListOptions<T>) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranch();
  const organizationId = currentOrg?.id;
  const businessId = currentBusiness?.id;
  const branchId = currentBranch?.id ?? null;

  const applyTenant = opts.applyTenantScope !== false;
  const applyBranchScope = opts.applyBranch !== false;

  const result = usePaginatedQuery<T>({
    queryKey: [
      "paginated-list",
      opts.cacheKey,
      organizationId,
      businessId,
      branchId,
      opts.search ?? null,
      opts.status ?? null,
      opts.dateRange ?? null,
    ],
    queryFn: async ({ from, to }) => {
      if (applyTenant && (!organizationId || !businessId)) {
        return { data: [], count: 0 };
      }

      let q: any = supabase
        .from(opts.table as any)
        .select(opts.select, { count: "exact" });

      if (applyTenant) {
        q = q.eq("organization_id", organizationId).eq("business_id", businessId);
      }
      if (applyBranchScope) {
        q = applyBranchFilter(q, branchId);
      }

      const orderCol = opts.orderBy?.column ?? "created_at";
      q = q.order(orderCol, { ascending: opts.orderBy?.ascending ?? false });

      const statusCol = opts.statusColumn ?? "status";
      if (opts.status && opts.status !== "all") {
        q = q.eq(statusCol, opts.status);
      }

      if (opts.dateRange && opts.dateRange !== "all" && opts.dateColumn) {
        const now = new Date();
        let start: Date | null = null;
        let end: Date | null = null;
        if (opts.dateRange === "this_month") {
          start = startOfMonth(now);
          end = endOfMonth(now);
        } else if (opts.dateRange === "last_month") {
          const lm = subMonths(now, 1);
          start = startOfMonth(lm);
          end = endOfMonth(lm);
        } else if (opts.dateRange === "last_3_months") {
          start = startOfMonth(subMonths(now, 3));
          end = endOfMonth(now);
        }
        if (start && end) {
          q = q
            .gte(opts.dateColumn, format(start, "yyyy-MM-dd"))
            .lte(opts.dateColumn, format(end, "yyyy-MM-dd"));
        }
      }

      if (opts.search && opts.searchColumns && opts.searchColumns.length > 0) {
        const term = opts.search.replace(/,/g, " ");
        const orParts = opts.searchColumns.map((c) => `${c}.ilike.%${term}%`);
        q = q.or(orParts.join(","));
      }

      if (opts.extra) {
        q = opts.extra(q);
      }

      q = q.range(from, to);

      const { data, error, count } = await q;
      if (error) throw error;
      return {
        data: ((data as unknown) as T[]) || [],
        count: count || 0,
      };
    },
    enabled: opts.enabled ?? (!applyTenant || (!!organizationId && !!businessId)),
    pageSize: opts.pageSize ?? 50,
  });

  return result;
}

/**
 * Helper hook: invalidate a paginated-list cache key when an upstream
 * mutation hook (e.g. useSalesOrders) doesn't know about it. Mount once
 * per page after the underlying mutation hook so its `invalidate()` call
 * also refreshes our paginated list.
 */
export function useInvalidatePaginatedList(cacheKey: string) {
  const qc = useQueryClient();
  useEffect(() => {
    // no-op on mount; consumer calls returned function
  }, []);
  return () => qc.invalidateQueries({ queryKey: ["paginated-list", cacheKey] });
}
