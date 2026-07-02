/**
 * useMyExitClearance — read-only self-service view at /me/exit.
 *
 * Lists the signed-in employee's own `employee_exit_clearance` rows plus
 * their items. RLS (`exit_clearance_select` / `exit_clearance_items_select`)
 * already permits the employee to read their own clearance via
 * `employees.user_id = auth.uid()`. Item sign-off remains an HR/department
 * action — the employee only watches progress.
 */
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentEmployee } from "@/hooks/useCurrentEmployee";

export interface MyExitClearanceItem {
  id: string;
  department: string;
  task: string;
  status: string;
  is_blocking: boolean;
  notes: string | null;
  signed_at: string | null;
  sort_order: number;
}

export interface MyExitClearance {
  id: string;
  status: string;
  exit_type: string;
  reason: string | null;
  last_working_day: string;
  initiated_at: string;
  completed_at: string | null;
  certificate_url: string | null;
  items: MyExitClearanceItem[];
}

export function useMyExitClearance() {
  const { currentEmployee, isLoading: empLoading } = useCurrentEmployee();
  const [clearances, setClearances] = useState<MyExitClearance[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetch = useCallback(async () => {
    if (!currentEmployee?.id) {
      setClearances([]);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    const { data, error } = await supabase
      .from("employee_exit_clearance")
      .select(
        "id, status, exit_type, reason, last_working_day, initiated_at, completed_at, certificate_url, employee_exit_clearance_items(id, department, task, status, is_blocking, notes, signed_at, sort_order)",
      )
      .eq("employee_id", currentEmployee.id)
      .order("initiated_at", { ascending: false });

    if (error) {
      console.error("[useMyExitClearance] fetch failed", error);
      setClearances([]);
    } else {
      const rows = (data ?? []).map((row: any) => ({
        ...row,
        items: (row.employee_exit_clearance_items ?? []).sort(
          (a: MyExitClearanceItem, b: MyExitClearanceItem) => a.sort_order - b.sort_order,
        ),
      })) as MyExitClearance[];
      setClearances(rows);
    }
    setIsLoading(false);
  }, [currentEmployee?.id]);

  useEffect(() => {
    if (!empLoading) fetch();
  }, [empLoading, fetch]);

  return {
    clearances,
    isLoading: empLoading || isLoading,
    refresh: fetch,
  };
}