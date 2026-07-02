import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { toast } from "sonner";

export interface JobPosition {
  id: string;
  organization_id: string;
  business_id: string;
  name: string;
  code: string | null;
  department_id: string | null;
  description: string | null;
  target_headcount: number | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  department_name?: string | null;
  headcount?: number;
}

export function useJobPositions() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const [positions, setPositions] = useState<JobPosition[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetch = useCallback(async () => {
    if (!currentOrg?.id || !currentBusiness?.id) {
      setPositions([]);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    try {
      const { data, error } = await (supabase as any)
        .from("job_positions")
        .select("*, departments:department_id(id,name)")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .order("name");
      if (error) throw error;

      // Headcount per position
      const ids = (data || []).map((p: any) => p.id);
      let counts: Record<string, number> = {};
      if (ids.length) {
        const { data: emps } = await supabase
          .from("v_employees_canonical")
          .select("job_position_id")
          .eq("organization_id", currentOrg.id)
          .eq("business_id", currentBusiness.id)
          .eq("is_operationally_active", true)
          .in("job_position_id", ids);
        for (const e of emps || []) {
          const k = (e as any).job_position_id;
          if (k) counts[k] = (counts[k] || 0) + 1;
        }
      }

      setPositions(
        (data || []).map((p: any) => ({
          ...p,
          department_name: p.departments?.name ?? null,
          headcount: counts[p.id] || 0,
          departments: undefined,
        }))
      );
    } catch (err: any) {
      console.error("useJobPositions:", err);
      toast.error("Failed to load job positions");
    } finally {
      setIsLoading(false);
    }
  }, [currentOrg?.id, currentBusiness?.id]);

  useEffect(() => {
    fetch();
  }, [fetch]);

  const create = async (input: Partial<JobPosition>) => {
    if (!currentOrg?.id || !currentBusiness?.id) throw new Error("No active company");
    const { data, error } = await (supabase as any)
      .from("job_positions")
      .insert({
        organization_id: currentOrg.id,
        business_id: currentBusiness.id,
        name: input.name,
        code: input.code ?? null,
        department_id: input.department_id ?? null,
        description: input.description ?? null,
        target_headcount: input.target_headcount ?? null,
        is_active: input.is_active ?? true,
      })
      .select()
      .single();
    if (error) throw error;
    toast.success("Job position created");
    await fetch();
    return data as JobPosition;
  };

  const update = async (id: string, patch: Partial<JobPosition>) => {
    const { error } = await (supabase as any)
      .from("job_positions")
      .update(patch)
      .eq("id", id);
    if (error) throw error;
    toast.success("Job position updated");
    await fetch();
  };

  const remove = async (id: string) => {
    const { error } = await (supabase as any).from("job_positions").delete().eq("id", id);
    if (error) throw error;
    toast.success("Job position deleted");
    await fetch();
  };

  return {
    positions,
    activePositions: positions.filter((p) => p.is_active),
    isLoading,
    create,
    update,
    remove,
    refresh: fetch,
  };
}
