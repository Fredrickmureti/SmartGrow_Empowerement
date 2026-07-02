/**
 * Hook for managing report field configurations in Studio.
 */
import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { toast } from "sonner";

export interface ReportFieldConfig {
  id: string;
  organization_id: string;
  entity_type: string;
  report_type: string;
  included_core_fields: string[];
  included_custom_fields: string[];
  field_order: string[];
  header_fields: string[];
  footer_fields: string[];
  is_default: boolean;
  config_name: string;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

export function useReportFieldConfigs(entityType?: string) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const [configs, setConfigs] = useState<ReportFieldConfig[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchConfigs = useCallback(async () => {
    if (!currentOrg) return;
    setIsLoading(true);
    try {
      let query = supabase
        .from("report_field_configs")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .order("created_at", { ascending: false });

      if (entityType) {
        query = query.eq("entity_type", entityType);
      }

      const { data, error } = await query;
      if (error) throw error;
      setConfigs((data || []) as unknown as ReportFieldConfig[]);
    } catch (error) {
      console.error("Error fetching report field configs:", error);
    } finally {
      setIsLoading(false);
    }
  }, [currentOrg?.id, entityType]);

  useEffect(() => {
    fetchConfigs();
  }, [fetchConfigs]);

  const createConfig = async (config: Partial<ReportFieldConfig>) => {
    if (!currentOrg) throw new Error("No organization");

    const { data, error } = await supabase
      .from("report_field_configs")
      .insert({
        organization_id: currentOrg.id,
        business_id: currentBusiness.id,
        entity_type: config.entity_type || "",
        report_type: config.report_type || "pdf",
        included_core_fields: config.included_core_fields || [],
        included_custom_fields: config.included_custom_fields || [],
        field_order: config.field_order || [],
        header_fields: config.header_fields || [],
        footer_fields: config.footer_fields || [],
        is_default: config.is_default ?? false,
        config_name: config.config_name || "Default",
      } as any)
      .select()
      .single();

    if (error) throw error;
    toast.success("Report field config created");
    await fetchConfigs();
    return data as unknown as ReportFieldConfig;
  };

  const updateConfig = async (id: string, updates: Partial<ReportFieldConfig>) => {
    const { error } = await supabase
      .from("report_field_configs")
      .update(updates as any)
      .eq("id", id);

    if (error) throw error;
    toast.success("Report field config updated");
    await fetchConfigs();
  };

  const deleteConfig = async (id: string) => {
    const { error } = await supabase
      .from("report_field_configs")
      .delete()
      .eq("id", id);

    if (error) throw error;
    toast.success("Report field config deleted");
    await fetchConfigs();
  };

  const getDefaultConfig = (entityType: string): ReportFieldConfig | undefined => {
    return configs.find(c => c.entity_type === entityType && c.is_default);
  };

  return {
    configs,
    isLoading,
    createConfig,
    updateConfig,
    deleteConfig,
    getDefaultConfig,
    refetch: fetchConfigs,
  };
}
