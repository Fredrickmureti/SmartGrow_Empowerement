import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useBranch } from "@/contexts/BranchContext";
import { usePaginatedQuery } from "./usePaginatedQuery";
import { applyBranchFilter } from "@/lib/branchScope";
import { startOfMonth, endOfMonth, subMonths, format } from "date-fns";
import type { DeliveryNote } from "./useDeliveryNotes";

export interface DeliveryNoteFilters {
  search?: string;
  status?: string;
  /** "all" | "this_month" | "last_month" | "last_3_months" */
  dateRange?: string;
}

export function useDeliveryNotesPaginated(filters?: DeliveryNoteFilters) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranch();

  const organizationId = currentOrg?.id;
  const businessId = currentBusiness?.id;
  const branchId = currentBranch?.id ?? null;

  const {
    data: deliveryNotes,
    isLoading,
    isFetching,
    pagination,
    setPage,
    setPageSize,
    nextPage,
    previousPage,
    refetch,
  } = usePaginatedQuery<DeliveryNote>({
    queryKey: ["delivery-notes-paginated", organizationId, businessId, branchId, filters],
    queryFn: async ({ from, to }) => {
      if (!organizationId || !businessId) return { data: [], count: 0 };

      // If searching, also resolve matching customer / SO ids so the search
      // covers customer name + SO number, not just delivery_number.
      let matchingContactIds: string[] = [];
      let matchingSoIds: string[] = [];
      if (filters?.search) {
        const term = filters.search;
        const [{ data: contacts }, { data: sos }] = await Promise.all([
          supabase
            .from("contacts")
            .select("id")
            .eq("organization_id", organizationId)
            .eq("business_id", businessId)
            .ilike("name", `%${term}%`)
            .limit(100),
          supabase
            .from("sales_orders")
            .select("id")
            .eq("organization_id", organizationId)
            .eq("business_id", businessId)
            .ilike("so_number", `%${term}%`)
            .limit(100),
        ]);
        matchingContactIds = contacts?.map((c) => c.id) || [];
        matchingSoIds = sos?.map((s) => s.id) || [];
      }

      let query = supabase
        .from("delivery_notes")
        .select(
          `
          *,
          contact:contacts!contact_id(name, email, phone),
          sales_order:sales_orders(so_number)
        `,
          { count: "exact" }
        )
        .eq("organization_id", organizationId)
        .eq("business_id", businessId)
        .order("created_at", { ascending: false });

      query = applyBranchFilter(query, branchId);

      if (filters?.status && filters.status !== "all") {
        query = query.eq("status", filters.status);
      }

      if (filters?.dateRange && filters.dateRange !== "all") {
        const now = new Date();
        let start: Date | null = null;
        let end: Date | null = null;
        if (filters.dateRange === "this_month") {
          start = startOfMonth(now);
          end = endOfMonth(now);
        } else if (filters.dateRange === "last_month") {
          const lm = subMonths(now, 1);
          start = startOfMonth(lm);
          end = endOfMonth(lm);
        } else if (filters.dateRange === "last_3_months") {
          start = startOfMonth(subMonths(now, 3));
          end = endOfMonth(now);
        }
        if (start && end) {
          query = query
            .gte("delivery_date", format(start, "yyyy-MM-dd"))
            .lte("delivery_date", format(end, "yyyy-MM-dd"));
        }
      }

      if (filters?.search) {
        const term = filters.search;
        const orParts = [`delivery_number.ilike.%${term}%`];
        if (matchingContactIds.length > 0) {
          orParts.push(`contact_id.in.(${matchingContactIds.join(",")})`);
        }
        if (matchingSoIds.length > 0) {
          orParts.push(`sales_order_id.in.(${matchingSoIds.join(",")})`);
        }
        query = query.or(orParts.join(","));
      }

      query = query.range(from, to);

      const { data, error, count } = await query;
      if (error) throw error;

      return {
        data: (data as DeliveryNote[]) || [],
        count: count || 0,
      };
    },
    enabled: !!organizationId && !!businessId,
    pageSize: 50,
  });

  // Aggregate stats (status counts) — separate lightweight query so cards
  // stay accurate across pages and filters.
  const [stats, setStats] = useState({
    total: 0,
    pending: 0,
    inTransit: 0,
    delivered: 0,
  });

  const fetchStats = useCallback(async () => {
    if (!organizationId || !businessId) return;
    let q = supabase
      .from("delivery_notes")
      .select("status", { count: "exact", head: false })
      .eq("organization_id", organizationId)
      .eq("business_id", businessId);
    q = applyBranchFilter(q, branchId);
    const { data, error, count } = await q;
    if (error) {
      console.error("Error fetching delivery note stats:", error);
      return;
    }
    const rows = data || [];
    setStats({
      total: count ?? rows.length,
      pending: rows.filter((r: any) => r.status === "pending").length,
      inTransit: rows.filter((r: any) => r.status === "in_transit").length,
      delivered: rows.filter((r: any) => r.status === "delivered").length,
    });
  }, [organizationId, businessId, branchId]);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  return {
    deliveryNotes,
    isLoading,
    isFetching,
    pagination,
    setPage,
    setPageSize,
    nextPage,
    previousPage,
    refetch,
    stats,
    refreshStats: fetchStats,
  };
}
