/**
 * useRequestRecount — the only client path that opens a second count
 * round for a line.
 *
 * `record_count` flags a line `recount_required` when it falls outside
 * the tolerance policy, and `post_count_session` refuses to submit while
 * any flagged line has no newer attempt. Without this action a session
 * that trips tolerance can never be submitted, so the recount round is
 * part of the control plane, not a convenience.
 *
 * `request_count_recount` supersedes the flagged attempt with a fresh
 * uncounted line (same bin, product and lot, assignee carried over) and
 * pulls the session back to `counting`.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export function useRequestRecount(sessionId: string | undefined) {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (v: { line_id: string; reason?: string | null }) => {
      const { data, error } = await supabase.rpc("request_count_recount", {
        p_line_id: v.line_id,
        p_reason: v.reason ?? null,
      });
      if (error) throw error;
      return data as string;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wms-count-lines", sessionId] });
      qc.invalidateQueries({ queryKey: ["wms-count-session", sessionId] });
      toast.success("Recount queued — count that bin again.");
    },
    onError: (e: unknown) =>
      toast.error(e instanceof Error ? e.message : "Could not queue the recount"),
  });
}
