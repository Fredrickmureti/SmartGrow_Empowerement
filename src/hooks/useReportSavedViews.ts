/**
 * Hook for managing report saved views, favorites, and recent reports.
 * Supports: save/load filter configurations, pin favorites, track recently accessed reports.
 */

import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";

export interface ReportSavedView {
  id: string;
  organization_id: string;
  user_id: string;
  report_type: string;
  view_name: string;
  filters_json: Record<string, any>;
  is_favorite: boolean;
  is_default: boolean;
  last_accessed_at: string;
  created_at: string;
  updated_at: string;
}

export interface ReportAccessEntry {
  id: string;
  report_type: string;
  report_path: string;
  accessed_at: string;
}

export function useReportSavedViews(reportType?: string) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { user } = useAuth();
  const [views, setViews] = useState<ReportSavedView[]>([]);
  const [recentReports, setRecentReports] = useState<ReportAccessEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchViews = useCallback(async () => {
    if (!currentOrg || !currentBusiness || !user) return;
    setIsLoading(true);
    try {
      let query = supabase
        // SCOPE-EXEMPT: "report_saved_views" is workspace-wide (not in BUSINESS_SCOPED_TABLES)
        .from("report_saved_views")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("user_id", user.id)
        .order("is_favorite", { ascending: false })
        .order("last_accessed_at", { ascending: false });

      if (reportType) {
        query = query.eq("report_type", reportType);
      }

      const { data, error } = await query;
      if (error) throw error;
      setViews((data || []) as unknown as ReportSavedView[]);
    } catch (error) {
      console.error("Error fetching report saved views:", error);
    } finally {
      setIsLoading(false);
    }
  }, [currentOrg?.id, user?.id, reportType]);

  const fetchRecentReports = useCallback(async () => {
    if (!currentOrg || !currentBusiness || !user) return;
    try {
      const { data, error } = await supabase
        .from("report_access_log")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .eq("user_id", user.id)
        .order("accessed_at", { ascending: false })
        .limit(10);

      if (error) throw error;
      // Deduplicate by report_path, keeping most recent
      const seen = new Set<string>();
      const unique: ReportAccessEntry[] = [];
      for (const entry of (data || []) as unknown as ReportAccessEntry[]) {
        if (!seen.has(entry.report_path)) {
          seen.add(entry.report_path);
          unique.push(entry);
        }
      }
      setRecentReports(unique);
    } catch (error) {
      console.error("Error fetching recent reports:", error);
    }
  }, [currentOrg?.id, user?.id]);

  useEffect(() => {
    fetchViews();
    fetchRecentReports();
  }, [fetchViews, fetchRecentReports]);

  const saveView = async (
    viewName: string,
    reportTypeStr: string,
    filtersJson: Record<string, any>,
    options?: { isFavorite?: boolean; isDefault?: boolean }
  ) => {
    if (!currentOrg || !user) throw new Error("Not authenticated");

    const { data, error } = await supabase
      .from("report_saved_views")
      .insert({
        organization_id: currentOrg.id,
        business_id: currentBusiness.id,
        user_id: user.id,
        report_type: reportTypeStr,
        view_name: viewName,
        filters_json: filtersJson as any,
        is_favorite: options?.isFavorite ?? false,
        is_default: options?.isDefault ?? false,
      } as any)
      .select()
      .single();

    if (error) throw error;
    toast.success(`View "${viewName}" saved`);
    await fetchViews();
    return data as unknown as ReportSavedView;
  };

  const updateView = async (id: string, updates: Partial<ReportSavedView>) => {
    const { error } = await supabase
      .from("report_saved_views")
      .update(updates as any)
      .eq("id", id);

    if (error) throw error;
    await fetchViews();
  };

  const deleteView = async (id: string) => {
    const { error } = await supabase
      .from("report_saved_views")
      .delete()
      .eq("id", id);

    if (error) throw error;
    toast.success("Saved view deleted");
    await fetchViews();
  };

  const toggleFavorite = async (id: string) => {
    const view = views.find(v => v.id === id);
    if (!view) return;
    await updateView(id, { is_favorite: !view.is_favorite });
  };

  const logReportAccess = async (reportTypeStr: string, reportPath: string) => {
    if (!currentOrg || !currentBusiness || !user) return;
    try {
      await supabase.from("report_access_log").insert({
        organization_id: currentOrg.id,
        business_id: currentBusiness.id,
        user_id: user.id,
        report_type: reportTypeStr,
        report_path: reportPath,
      } as any);
    } catch {
      // Non-critical — don't block navigation
    }
  };

  const favorites = views.filter(v => v.is_favorite);

  return {
    views,
    favorites,
    recentReports,
    isLoading,
    saveView,
    updateView,
    deleteView,
    toggleFavorite,
    logReportAccess,
    refreshViews: fetchViews,
    refreshRecent: fetchRecentReports,
  };
}
