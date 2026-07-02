import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { toast } from "sonner";

export type WorkLocationType = "office" | "remote" | "other";

export interface WorkLocation {
  id: string;
  organization_id: string;
  business_id: string;
  name: string;
  location_type: WorkLocationType;
  address: string | null;
  branch_id: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export function useWorkLocations() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const [locations, setLocations] = useState<WorkLocation[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetch = useCallback(async () => {
    if (!currentOrg?.id || !currentBusiness?.id) {
      setLocations([]);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    try {
      const { data, error } = await (supabase as any)
        .from("work_locations")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .order("name");
      if (error) throw error;
      setLocations((data || []) as WorkLocation[]);
    } catch (err) {
      console.error("useWorkLocations:", err);
      toast.error("Failed to load work locations");
    } finally {
      setIsLoading(false);
    }
  }, [currentOrg?.id, currentBusiness?.id]);

  useEffect(() => {
    fetch();
  }, [fetch]);

  const create = async (input: Partial<WorkLocation>) => {
    if (!currentOrg?.id || !currentBusiness?.id) throw new Error("No active company");
    const { data, error } = await (supabase as any)
      .from("work_locations")
      .insert({
        organization_id: currentOrg.id,
        business_id: currentBusiness.id,
        name: input.name,
        location_type: input.location_type ?? "office",
        address: input.address ?? null,
        branch_id: input.branch_id ?? null,
        is_active: input.is_active ?? true,
      })
      .select()
      .single();
    if (error) throw error;
    toast.success("Work location created");
    await fetch();
    return data as WorkLocation;
  };

  const update = async (id: string, patch: Partial<WorkLocation>) => {
    const { error } = await (supabase as any)
      .from("work_locations")
      .update(patch)
      .eq("id", id);
    if (error) throw error;
    toast.success("Work location updated");
    await fetch();
  };

  const remove = async (id: string) => {
    const { error } = await (supabase as any).from("work_locations").delete().eq("id", id);
    if (error) throw error;
    toast.success("Work location deleted");
    await fetch();
  };

  return {
    locations,
    activeLocations: locations.filter((l) => l.is_active),
    isLoading,
    create,
    update,
    remove,
    refresh: fetch,
  };
}
