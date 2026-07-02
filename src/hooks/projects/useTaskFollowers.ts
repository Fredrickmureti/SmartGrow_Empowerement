/**
 * useTaskFollowers — manage subscribers on a task.
 *
 * Backed by `task_followers` (RLS: only members of the task's project can see
 * rows; users can only insert/delete rows for themselves). Notifications for
 * task comments fan out to all followers via DB trigger.
 */
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";

export interface TaskFollower {
  id: string;
  task_id: string;
  user_id: string;
  created_at: string;
}

export function useTaskFollowers(taskId: string | null | undefined) {
  const { user } = useAuth();
  const [followers, setFollowers] = useState<TaskFollower[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!taskId) return;
    setIsLoading(true);
    try {
      const { data, error } = await supabase
        .from("task_followers")
        .select("id, task_id, user_id, created_at")
        .eq("task_id", taskId);
      if (error) throw error;
      setFollowers((data ?? []) as TaskFollower[]);
    } finally {
      setIsLoading(false);
    }
  }, [taskId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const isFollowing = !!(user && followers.find((f) => f.user_id === user.id));

  const follow = async () => {
    if (!taskId || !user) return;
    const { error } = await supabase
      .from("task_followers")
      .insert({ task_id: taskId, user_id: user.id } as never);
    if (error) {
      toast.error("Could not follow task");
      return;
    }
    toast.success("Following task");
    await refresh();
  };

  const unfollow = async () => {
    if (!taskId || !user) return;
    const { error } = await supabase
      .from("task_followers")
      .delete()
      .eq("task_id", taskId)
      .eq("user_id", user.id);
    if (error) {
      toast.error("Could not unfollow task");
      return;
    }
    toast.success("Unfollowed task");
    await refresh();
  };

  return { followers, isLoading, isFollowing, follow, unfollow, refresh };
}
