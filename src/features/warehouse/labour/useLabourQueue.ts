/**
 * Labour — live queue + supervisor control actions.
 *
 * Every mutation here is an RPC. The supervisor never UPDATEs
 * `wms_tasks` from the client: reassignment must pass the eligibility
 * gate, releases must respect the state machine, and both must bump
 * `row_version` and emit the business event. That logic lives in the
 * database (ADR 0101), so the client only dispatches intent.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { labourErrorMessage } from "./labourErrors";
import { useBusinesses } from "@/hooks/useBusinesses";
import { LABOUR_KEYS, type WmsTaskType } from "./useLabourOperators";

export interface LabourQueueRow {
  task_id: string;
  task_type: WmsTaskType;
  state: string;
  priority: number;
  row_version: number;
  sla_at: string | null;
  sla_breached: boolean | null;
  warehouse_id: string | null;
  assignee_user_id: string | null;
  source_doc_type: string | null;
  quantity: number | null;
  created_at: string | null;
}

export function useLabourQueue(opts: {
  warehouseId?: string;
  taskType?: WmsTaskType | "all";
  onlyUnassigned?: boolean;
}) {
  const { currentBusiness } = useBusinesses();
  const { warehouseId = "all", taskType = "all", onlyUnassigned = false } = opts;

  return useQuery({
    queryKey: [...LABOUR_KEYS.queue, currentBusiness?.id, warehouseId, taskType, onlyUnassigned],
    enabled: !!currentBusiness?.id,
    queryFn: async () => {
      let q = supabase
        .from("wms_labour_queue_view")
        .select(
          "task_id,task_type,state,priority,row_version,sla_at,sla_breached,warehouse_id,assignee_user_id,source_doc_type,quantity,created_at",
        )
        .eq("business_id", currentBusiness!.id)
        .order("sla_breached", { ascending: false })
        .order("priority", { ascending: false })
        .order("sla_at", { ascending: true, nullsFirst: false })
        .limit(300);
      if (warehouseId !== "all") q = q.eq("warehouse_id", warehouseId);
      if (taskType !== "all") q = q.eq("task_type", taskType);
      if (onlyUnassigned) q = q.is("assignee_user_id", null);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as LabourQueueRow[];
    },
  });
}

export function useSupervisorActions() {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: LABOUR_KEYS.queue });
    qc.invalidateQueries({ queryKey: LABOUR_KEYS.board });
  };

  const reassign = useMutation({
    mutationFn: async ({
      taskId,
      userId,
      rowVersion,
      reason,
    }: { taskId: string; userId: string; rowVersion: number; reason?: string }) => {
      const { error } = await supabase.rpc("wms_reassign_task", {
        p_task_id: taskId,
        p_assignee_user_id: userId,
        p_row_version: rowVersion,
        p_reason: reason ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Task reassigned"); invalidate(); },
    onError: (e: Error) => toast.error(labourErrorMessage(e)),
  });

  const release = useMutation({
    mutationFn: async ({ taskId, rowVersion, reason }: { taskId: string; rowVersion: number; reason?: string }) => {
      const { error } = await supabase.rpc("wms_release_task", {
        p_task_id: taskId,
        p_row_version: rowVersion,
        p_reason: reason ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Task returned to the pool"); invalidate(); },
    onError: (e: Error) => toast.error(labourErrorMessage(e)),
  });

  const setPriority = useMutation({
    mutationFn: async ({ taskId, priority, rowVersion }: { taskId: string; priority: number; rowVersion: number }) => {
      const { error } = await supabase.rpc("wms_set_task_priority", {
        p_task_id: taskId,
        p_priority: priority,
        p_row_version: rowVersion,
      });
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Priority updated"); invalidate(); },
    onError: (e: Error) => toast.error(labourErrorMessage(e)),
  });

  return { reassign, release, setPriority };
}

/** True utilisation (direct + indirect + idle) per operator per day. */
export interface UtilisationRow {
  business_id: string;
  warehouse_id: string | null;
  user_id: string;
  day: string;
  tasks_completed: number;
  earned_seconds: number;
  direct_seconds: number;
  indirect_seconds: number;
  idle_seconds: number;
  travel_seconds: number;
  true_utilisation: number | null;
}

export function useUtilisation(warehouseId: string | undefined, sinceDay: string) {
  const { currentBusiness } = useBusinesses();
  return useQuery({
    queryKey: [...LABOUR_KEYS.utilisation, currentBusiness?.id, warehouseId ?? "all", sinceDay],
    enabled: !!currentBusiness?.id,
    queryFn: async () => {
      let q = supabase
        .from("wms_operator_utilisation_view")
        .select("*")
        .eq("business_id", currentBusiness!.id)
        .gte("day", sinceDay)
        .order("day", { ascending: true });
      if (warehouseId && warehouseId !== "all") q = q.eq("warehouse_id", warehouseId);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as UtilisationRow[];
    },
  });
}
