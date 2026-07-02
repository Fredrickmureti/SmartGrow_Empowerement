import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { usePaginatedQuery } from "./usePaginatedQuery";

export interface AuditLog {
  id: string;
  organization_id: string;
  user_id: string | null;
  user_name?: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  entity_name: string | null;
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
  changes_summary: string | null;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
}

export interface AuditLogFilters {
  entityType?: string;
  action?: string;
  userId?: string;
  startDate?: string;
  endDate?: string;
  search?: string;
}

export function useAuditLogsPaginated(filters?: AuditLogFilters) {
  const { currentOrg } = useOrganization();
  const organizationId = currentOrg?.id;

  const {
    data: auditLogs,
    isLoading,
    isFetching,
    pagination,
    setPage,
    setPageSize,
    nextPage,
    previousPage,
    refetch,
  } = usePaginatedQuery<AuditLog>({
    queryKey: ["audit-logs-paginated", organizationId, filters],
    queryFn: async ({ from, to }) => {
      if (!organizationId) return { data: [], count: 0 };

      let query = supabase
        // SCOPE-EXEMPT: workspace-wide audit-log surface (admin tooling)
        .from("audit_logs")
        .select("*", { count: "exact" })
        .eq("organization_id", organizationId)
        .order("created_at", { ascending: false });

      // Apply filters
      if (filters?.entityType) {
        query = query.eq("entity_type", filters.entityType);
      }

      if (filters?.action) {
        query = query.eq("action", filters.action);
      }

      if (filters?.userId) {
        query = query.eq("user_id", filters.userId);
      }

      if (filters?.startDate) {
        query = query.gte("created_at", filters.startDate);
      }

      if (filters?.endDate) {
        query = query.lte("created_at", filters.endDate);
      }

      if (filters?.search) {
        query = query.or(
          `entity_name.ilike.%${filters.search}%,changes_summary.ilike.%${filters.search}%`
        );
      }

      // Apply pagination range
      query = query.range(from, to);

      const { data, error, count } = await query;

      if (error) throw error;

      return {
        data: (data as AuditLog[]) || [],
        count: count || 0,
      };
    },
    enabled: !!organizationId,
    pageSize: 100,
  });

  // Get unique entity types for filtering (cached separately)
  const { data: entityTypes = [] } = useQuery({
    queryKey: ["audit-log-entity-types", organizationId],
    queryFn: async () => {
      if (!organizationId) return [];

      const { data, error } = await supabase
        // SCOPE-EXEMPT: workspace-wide audit-log entity types facet
        .from("audit_logs")
        .select("entity_type")
        .eq("organization_id", organizationId);

      if (error) throw error;

      const unique = [...new Set(data.map((d) => d.entity_type))];
      return unique.sort();
    },
    enabled: !!organizationId,
    staleTime: 60000, // Cache for 1 minute
  });

  // Get unique actions for filtering (cached separately)
  const { data: actions = [] } = useQuery({
    queryKey: ["audit-log-actions", organizationId],
    queryFn: async () => {
      if (!organizationId) return [];

      const { data, error } = await supabase
        // SCOPE-EXEMPT: workspace-wide audit-log actions facet
        .from("audit_logs")
        .select("action")
        .eq("organization_id", organizationId);

      if (error) throw error;

      const unique = [...new Set(data.map((d) => d.action))];
      return unique.sort();
    },
    enabled: !!organizationId,
    staleTime: 60000, // Cache for 1 minute
  });

  return {
    auditLogs,
    entityTypes,
    actions,
    isLoading,
    isFetching,
    pagination,
    setPage,
    setPageSize,
    nextPage,
    previousPage,
    refetch,
  };
}
