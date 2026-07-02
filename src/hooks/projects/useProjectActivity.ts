/**
 * useProjectActivity — unified activity feed for a project.
 *
 * Reads from `project_activity_log`, populated by DB triggers on
 * project_tasks, project_milestones, project_updates and task_comments.
 * Supports realtime updates and an optional event-type filter.
 */
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface ProjectActivityEvent {
  id: string;
  project_id: string;
  task_id: string | null;
  milestone_id: string | null;
  actor_id: string | null;
  event_type: string;
  summary: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export function useProjectActivity(
  projectId: string | null | undefined,
  opts: { limit?: number; types?: string[] } = {},
) {
  const { limit = 100, types } = opts;
  const [events, setEvents] = useState<ProjectActivityEvent[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    setIsLoading(true);
    try {
      let q = supabase
        .from("project_activity_log")
        .select("id, project_id, task_id, milestone_id, actor_id, event_type, summary, payload, created_at")
        .eq("project_id", projectId)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (types && types.length) q = q.in("event_type", types);
      const { data, error } = await q;
      if (error) throw error;
      setEvents((data ?? []) as unknown as ProjectActivityEvent[]);
    } catch (e) {
      console.error("useProjectActivity.refresh", e);
    } finally {
      setIsLoading(false);
    }
  }, [projectId, limit, types?.join(",")]);

  useEffect(() => {
    void refresh();
    if (!projectId) return;
    const ch = supabase
      .channel(`project_activity_${projectId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "project_activity_log", filter: `project_id=eq.${projectId}` },
        () => { void refresh(); },
      )
      .subscribe();
    return () => { void supabase.removeChannel(ch); };
  }, [projectId, refresh]);

  return { events, isLoading, refresh };
}
