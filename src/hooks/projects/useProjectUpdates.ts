/**
 * useProjectUpdates — Odoo-style "Project Updates" log.
 *
 * Schema (project_updates): status, summary (required), period_start/end,
 * progress_pct (0-100), author_id. status mirrors onto projects.last_update_status
 * via trigger.
 */
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";

export type ProjectUpdateStatus = "on_track" | "at_risk" | "off_track";

export interface ProjectUpdate {
  id: string;
  project_id: string;
  organization_id: string;
  status: ProjectUpdateStatus;
  summary: string;
  progress_pct: number | null;
  period_start: string | null;
  period_end: string | null;
  author_id: string | null;
  created_at: string;
}

export interface CreateProjectUpdateInput {
  status: ProjectUpdateStatus;
  summary: string;
  progress_pct?: number | null;
  period_start?: string | null;
  period_end?: string | null;
}

export function useProjectUpdates(projectId: string | null | undefined) {
  const { currentOrg } = useOrganization();
  const { user } = useAuth();
  const [updates, setUpdates] = useState<ProjectUpdate[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    setIsLoading(true);
    try {
      const { data, error } = await supabase
        .from("project_updates")
        .select("*")
        .eq("project_id", projectId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      setUpdates((data || []) as unknown as ProjectUpdate[]);
    } catch (e) {
      console.error("useProjectUpdates.refresh", e);
    } finally {
      setIsLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = async (input: CreateProjectUpdateInput) => {
    if (!projectId || !currentOrg || !user) throw new Error("Missing context");
    const { error } = await supabase.from("project_updates").insert({
      project_id: projectId,
      organization_id: currentOrg.id,
      status: input.status,
      summary: input.summary.trim(),
      progress_pct: input.progress_pct ?? null,
      period_start: input.period_start || null,
      period_end: input.period_end || null,
      author_id: user.id,
    } as never);
    if (error) {
      toast.error("Failed to post update");
      throw error;
    }
    toast.success("Project update posted");
    await refresh();
  };

  return { updates, isLoading, refresh, create };
}
