import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";

export interface AuditLog {
  id: string;
  organization_id: string;
  user_id: string | null;
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

export function useAuditLogs(filters?: AuditLogFilters) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const organizationId = currentOrg?.id;
  const businessId = currentBusiness?.id;

  const { data: auditLogs = [], isLoading } = useQuery({
    queryKey: ["audit-logs", organizationId, businessId, filters],
    queryFn: async () => {
      if (!organizationId) return [];
      
      let query = supabase
        .from("audit_logs")
        .select("*")
        .eq("organization_id", organizationId)
        .order("created_at", { ascending: false })
        .limit(500);

      if (businessId) {
        query = query.eq("business_id", businessId);
      }

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
        query = query.or(`entity_name.ilike.%${filters.search}%,changes_summary.ilike.%${filters.search}%`);
      }

      const { data, error } = await query;

      if (error) throw error;
      return data as AuditLog[];
    },
    enabled: !!organizationId,
  });

  // Get unique entity types for filtering
  const { data: entityTypes = [] } = useQuery({
    queryKey: ["audit-log-entity-types", organizationId, businessId],
    queryFn: async () => {
      if (!organizationId) return [];
      
      let query = supabase
        // SCOPE-EXEMPT: "audit_logs" is workspace-wide (not in BUSINESS_SCOPED_TABLES)
        .from("audit_logs")
        .select("entity_type")
        .eq("organization_id", organizationId);

      if (businessId) {
        query = query.eq("business_id", businessId);
      }

      const { data, error } = await query;
      if (error) throw error;
      
      const unique = [...new Set(data.map(d => d.entity_type))];
      return unique.sort();
    },
    enabled: !!organizationId,
  });

  // Get unique actions for filtering
  const { data: actions = [] } = useQuery({
    queryKey: ["audit-log-actions", organizationId, businessId],
    queryFn: async () => {
      if (!organizationId) return [];
      
      let query = supabase
        .from("audit_logs")
        .select("action")
        .eq("organization_id", organizationId);

      if (businessId) {
        query = query.eq("business_id", businessId);
      }

      const { data, error } = await query;
      if (error) throw error;
      
      const unique = [...new Set(data.map(d => d.action))];
      return unique.sort();
    },
    enabled: !!organizationId,
  });

  return {
    auditLogs,
    entityTypes,
    actions,
    isLoading,
  };
}
