// @ts-nocheck
import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "../useOrganization";
import { useBusinesses } from "../useBusinesses";
import { toast } from "sonner";

export interface CRMStage {
  id: string;
  organization_id: string;
  name: string;
  sequence: number;
  is_won: boolean | null;
  is_lost: boolean | null;
  probability: number | null;
  fold: boolean | null;
  requirements: string | null;
  is_active: boolean | null;
  color: string | null;
  created_at: string;
  updated_at: string;
}

export function useCRMStages() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const [stages, setStages] = useState<CRMStage[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchStages = useCallback(async () => {
    if (!currentOrg || !currentBusiness) {
      setStages([]);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);

    try {
      const { data, error } = await supabase
        .from("crm_stages")
        .select("*")
        .match({ organization_id: currentOrg.id, business_id: currentBusiness.id, is_active: true })
        .order("sequence");

      if (error) throw error;
      setStages((data || []) as CRMStage[]);
    } catch (error) {
      console.error("Error fetching CRM stages:", error);
      toast.error("Failed to fetch pipeline stages");
    } finally {
      setIsLoading(false);
    }
  }, [currentOrg?.id, currentBusiness?.id]);

  useEffect(() => {
    fetchStages();
  }, [fetchStages]);

  const createStage = async (stage: Partial<CRMStage>) => {
    if (!currentOrg || !currentBusiness) throw new Error("No organization or business selected");

    const insertData = {
      name: stage.name || "New Stage",
      organization_id: currentOrg.id,
      business_id: currentBusiness.id,
      sequence: stage.sequence || 0,
      is_won: stage.is_won || false,
      is_lost: stage.is_lost || false,
      probability: stage.probability || null,
      fold: stage.fold || false,
      requirements: stage.requirements || null,
      color: stage.color || null,
      is_active: true,
    };

    const { data, error } = await supabase
      .from("crm_stages")
      .insert(insertData)
      .select()
      .single();

    if (error) throw error;

    toast.success("Stage created");
    await fetchStages();
    return data;
  };

  const updateStage = async (id: string, updates: Partial<CRMStage>) => {
    const { error } = await supabase
      .from("crm_stages")
      .update(updates)
      .eq("id", id);

    if (error) throw error;

    toast.success("Stage updated");
    await fetchStages();
  };

  /**
   * Deactivating a stage is guarded server-side
   * (`_crm_stage_deactivation_guard`): a stage still holding open
   * opportunities cannot be removed, otherwise those leads silently drop off
   * the board while still counting towards pipeline totals.
   */
  const deleteStage = async (id: string) => {
    const { error } = await supabase
      .from("crm_stages")
      .update({ is_active: false })
      .eq("id", id);

    if (error) {
      toast.error(error.message);
      throw error;
    }

    toast.success("Stage deleted");
    await fetchStages();
  };


  return {
    stages,
    isLoading,
    createStage,
    updateStage,
    deleteStage,
    refreshStages: fetchStages,
  };
}
