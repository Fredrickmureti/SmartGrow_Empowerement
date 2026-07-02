/**
 * useTaskComments — thread of comments for a project task.
 *
 * Backed by `task_comments` (RLS scoped via can_access_project) with the
 * comment-count trigger maintaining `project_tasks.comment_count`.
 */
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";

export interface TaskComment {
  id: string;
  task_id: string;
  body: string;
  author_id: string | null;
  created_at: string;
  updated_at: string;
}

export function useTaskComments(taskId: string | null | undefined) {
  const { currentOrg } = useOrganization();
  const { user } = useAuth();
  const [comments, setComments] = useState<TaskComment[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!taskId) return;
    setIsLoading(true);
    try {
      const { data, error } = await supabase
        .from("task_comments")
        .select("*")
        .eq("task_id", taskId)
        .order("created_at", { ascending: true });
      if (error) throw error;
      setComments((data || []) as TaskComment[]);
    } catch (e) {
      console.error("useTaskComments.refresh", e);
    } finally {
      setIsLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const addComment = async (body: string) => {
    if (!taskId || !currentOrg || !user) return;
    const trimmed = body.trim();
    if (!trimmed) return;
    const { error } = await supabase.from("task_comments").insert({
      task_id: taskId,
      organization_id: currentOrg.id,
      body: trimmed,
      author_id: user.id,
    } as never);
    if (error) {
      toast.error("Failed to add comment");
      throw error;
    }
    await refresh();
  };

  const deleteComment = async (id: string) => {
    const { error } = await supabase.from("task_comments").delete().eq("id", id);
    if (error) {
      toast.error("Failed to delete comment");
      return;
    }
    await refresh();
  };

  return { comments, isLoading, refresh, addComment, deleteComment };
}
