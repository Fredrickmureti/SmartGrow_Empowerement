/**
 * Labour — operator roster data access.
 *
 * The operator is a first-class warehouse resource: an `employees` row
 * projected into a warehouse with skills, certifications, equipment
 * classes and a live availability status. HR owns the person; WMS owns
 * warehouse capability.
 *
 * Roster tables (`wms_operators`, `wms_operator_skills`,
 * `wms_operator_certifications`, `wms_task_requirements`) are master
 * data and are written directly through PostgREST under
 * `inventory:write` RLS — exactly like `wms_task_standards`.
 * Operational state (task assignment, operator status) is NEVER written
 * directly; it goes through the sanctioned RPCs in `useLabourQueue`.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { labourErrorMessage } from "./labourErrors";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useOrganization } from "@/hooks/useOrganization";

export type WmsTaskType =
  | "putaway" | "pick" | "pack" | "load"
  | "count" | "replenish" | "move" | "qc";

export const WMS_TASK_TYPES: WmsTaskType[] = [
  "putaway", "pick", "pack", "load", "count", "replenish", "move", "qc",
];

export type OperatorStatus = "off_shift" | "on_shift" | "break" | "executing";

export const OPERATOR_STATUSES: OperatorStatus[] = [
  "off_shift", "on_shift", "break", "executing",
];

export const OPERATOR_STATUS_LABELS: Record<OperatorStatus, string> = {
  off_shift: "Off shift",
  on_shift: "On shift",
  break: "On break",
  executing: "Executing",
};

export interface OperatorBoardRow {
  operator_id: string;
  business_id: string;
  warehouse_id: string;
  user_id: string | null;
  employee_id: string | null;
  operator_code: string | null;
  status: OperatorStatus;
  status_changed_at: string;
  row_version: number;
  is_active: boolean;
  home_zone_id: string | null;
  equipment_classes: string[] | null;
  max_concurrent_tasks: number;
  operator_name: string | null;
  employee_number: string | null;
  open_tasks: number;
  earned_seconds_today: number;
  actual_seconds_today: number;
}

export interface OperatorSkill {
  id: string;
  operator_id: string;
  task_type: WmsTaskType;
  proficiency: number;
}

export interface OperatorCertification {
  id: string;
  operator_id: string;
  code: string;
  label: string | null;
  issued_on: string | null;
  expires_on: string | null;
}

export interface OperatorUpsert {
  id?: string;
  warehouse_id: string;
  employee_id: string | null;
  user_id: string | null;
  operator_code: string | null;
  equipment_classes: string[];
  max_concurrent_tasks: number;
  is_active: boolean;
  notes: string | null;
}

export const LABOUR_KEYS = {
  board: ["wms-operator-board"] as const,
  skills: ["wms-operator-skills"] as const,
  certs: ["wms-operator-certifications"] as const,
  requirements: ["wms-task-requirements"] as const,
  queue: ["wms-labour-queue-view"] as const,
  utilisation: ["wms-operator-utilisation"] as const,
  standards: ["wms-task-standards"] as const,
};

export function useOperatorBoard(warehouseId?: string) {
  const { currentBusiness } = useBusinesses();
  return useQuery({
    queryKey: [...LABOUR_KEYS.board, currentBusiness?.id, warehouseId ?? "all"],
    enabled: !!currentBusiness?.id,
    queryFn: async () => {
      let q = supabase
        .from("wms_operator_board_view")
        .select("*")
        .eq("business_id", currentBusiness!.id);
      if (warehouseId && warehouseId !== "all") q = q.eq("warehouse_id", warehouseId);
      const { data, error } = await q;
      if (error) throw error;
      return ((data ?? []) as unknown as OperatorBoardRow[]).sort((a, b) =>
        (a.operator_name ?? "").localeCompare(b.operator_name ?? ""),
      );
    },
  });
}

export function useOperatorSkills() {
  const { currentBusiness } = useBusinesses();
  return useQuery({
    queryKey: [...LABOUR_KEYS.skills, currentBusiness?.id],
    enabled: !!currentBusiness?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_operator_skills")
        .select("id,operator_id,task_type,proficiency")
        .eq("business_id", currentBusiness!.id);
      if (error) throw error;
      return (data ?? []) as unknown as OperatorSkill[];
    },
  });
}

export function useOperatorCertifications() {
  const { currentBusiness } = useBusinesses();
  return useQuery({
    queryKey: [...LABOUR_KEYS.certs, currentBusiness?.id],
    enabled: !!currentBusiness?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_operator_certifications")
        .select("id,operator_id,code,label,issued_on,expires_on")
        .eq("business_id", currentBusiness!.id);
      if (error) throw error;
      return (data ?? []) as unknown as OperatorCertification[];
    },
  });
}

/** Employees available to be enrolled as warehouse operators. */
export function useEnrollableEmployees() {
  const { currentBusiness } = useBusinesses();
  return useQuery({
    queryKey: ["wms-enrollable-employees", currentBusiness?.id],
    enabled: !!currentBusiness?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("employees")
        .select("id,user_id,first_name,last_name,employee_number")
        .eq("business_id", currentBusiness!.id)
        .limit(500);
      if (error) throw error;
      return (data ?? []) as Array<{
        id: string;
        user_id: string | null;
        first_name: string | null;
        last_name: string | null;
        employee_number: string | null;
      }>;
    },
  });
}

export function useOperatorMutations() {
  const qc = useQueryClient();
  const { currentBusiness } = useBusinesses();
  const { currentOrg: currentOrganization } = useOrganization();

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: LABOUR_KEYS.board });
    qc.invalidateQueries({ queryKey: LABOUR_KEYS.skills });
    qc.invalidateQueries({ queryKey: LABOUR_KEYS.certs });
  };

  const saveOperator = useMutation({
    mutationFn: async (input: OperatorUpsert & { skills: Array<{ task_type: WmsTaskType; proficiency: number }>; certifications: Array<{ code: string; label?: string | null; expires_on?: string | null }> }) => {
      if (!currentBusiness?.id) throw new Error("No active business");
      const base = {
        business_id: currentBusiness.id,
        organization_id: currentOrganization?.id ?? null,
        warehouse_id: input.warehouse_id,
        employee_id: input.employee_id,
        user_id: input.user_id,
        operator_code: input.operator_code,
        equipment_classes: input.equipment_classes,
        max_concurrent_tasks: input.max_concurrent_tasks,
        is_active: input.is_active,
        notes: input.notes,
      };

      let operatorId = input.id;
      if (operatorId) {
        const { error } = await supabase
          .from("wms_operators")
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .update(base as any)
          .eq("id", operatorId);
        if (error) throw error;
      } else {
        const { data, error } = await supabase
          .from("wms_operators")
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .insert(base as any)
          .select("id")
          .single();
        if (error) throw error;
        operatorId = (data as { id: string }).id;
      }

      // Skills + certifications are replaced wholesale — the dialog owns
      // the full set, so a removal must actually remove.
      await supabase.from("wms_operator_skills").delete().eq("operator_id", operatorId!);
      if (input.skills.length > 0) {
        const { error } = await supabase.from("wms_operator_skills").insert(
          input.skills.map((s) => ({
            business_id: currentBusiness.id,
            operator_id: operatorId!,
            task_type: s.task_type,
            proficiency: s.proficiency,
          })) as never,
        );
        if (error) throw error;
      }

      await supabase.from("wms_operator_certifications").delete().eq("operator_id", operatorId!);
      if (input.certifications.length > 0) {
        const { error } = await supabase.from("wms_operator_certifications").insert(
          input.certifications.map((c) => ({
            business_id: currentBusiness.id,
            operator_id: operatorId!,
            code: c.code,
            label: c.label ?? null,
            expires_on: c.expires_on ?? null,
          })) as never,
        );
        if (error) throw error;
      }

      return operatorId!;
    },
    onSuccess: () => {
      toast.success("Operator saved");
      invalidate();
    },
    onError: (e: Error) => toast.error(labourErrorMessage(e)),
  });

  const removeOperator = useMutation({
    mutationFn: async (operatorId: string) => {
      const { error } = await supabase.from("wms_operators").delete().eq("id", operatorId);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Operator removed from the roster");
      invalidate();
    },
    onError: (e: Error) => toast.error(labourErrorMessage(e)),
  });

  /** Availability is operational state — RPC only, never a direct UPDATE. */
  const setStatus = useMutation({
    mutationFn: async ({
      operatorId,
      status,
      rowVersion,
    }: { operatorId: string; status: OperatorStatus; rowVersion: number }) => {
      const { error } = await supabase.rpc("wms_set_operator_status", {
        p_operator_id: operatorId,
        p_status: status,
        p_row_version: rowVersion,
      });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: LABOUR_KEYS.board }),
    onError: (e: Error) => toast.error(labourErrorMessage(e)),
  });

  return { saveOperator, removeOperator, setStatus };
}
