// @ts-nocheck
import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "../useOrganization";
import { useBusinesses } from "../useBusinesses";
import { toast } from "sonner";

export interface CRMLostReason {
  id: string;
  organization_id: string;
  business_id: string | null;
  name: string;
  is_active: boolean | null;
  created_at: string;
}

const DEFAULT_LOST_REASONS = [
  "Too Expensive",
  "Chose Competitor",
  "No Budget",
  "No Response",
  "Not a Good Fit",
  "Timing Not Right",
  "Project Cancelled",
  "Other",
];

export function useCRMLostReasons() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const [lostReasons, setLostReasons] = useState<CRMLostReason[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchLostReasons = useCallback(async () => {
    if (!currentOrg || !currentBusiness) {
      setLostReasons([]);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);

    try {
      const { data, error } = await supabase
        .from("crm_lost_reasons")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("is_active", true)
        .order("name", { ascending: true });

      if (error) throw error;
      setLostReasons((data || []) as CRMLostReason[]);
    } catch (error) {
      console.error("Error fetching lost reasons:", error);
    } finally {
      setIsLoading(false);
    }
  }, [currentOrg?.id, currentBusiness?.id]);

  useEffect(() => {
    fetchLostReasons();
  }, [fetchLostReasons]);

  const initializeDefaultReasons = async () => {
    if (!currentOrg || !currentBusiness) {
      throw new Error("Select a Company before initializing lost reasons");
    }

    try {
      const inserts = DEFAULT_LOST_REASONS.map((name) => ({
        organization_id: currentOrg.id,
        business_id: currentBusiness.id,
        name,
        is_active: true,
      }));

      const { error } = await supabase.from("crm_lost_reasons").insert(inserts);

      if (error) throw error;
      toast.success("Default lost reasons created");
      await fetchLostReasons();
    } catch (error) {
      console.error("Error creating default reasons:", error);
      toast.error("Failed to create default reasons");
    }
  };

  const createLostReason = async (name: string) => {
    if (!currentOrg || !currentBusiness) {
      throw new Error("Select a Company before adding a lost reason");
    }

    const { data, error } = await supabase
      .from("crm_lost_reasons")
      .insert({
        organization_id: currentOrg.id,
        business_id: currentBusiness.id,
        name,
        is_active: true,
      })
      .select()
      .single();

    if (error) throw error;
    toast.success("Lost reason created");
    await fetchLostReasons();
    return data;
  };

  const deleteLostReason = async (id: string) => {
    const { error } = await supabase
      .from("crm_lost_reasons")
      .update({ is_active: false })
      .eq("id", id);

    if (error) throw error;
    toast.success("Lost reason deleted");
    await fetchLostReasons();
  };

  return {
    lostReasons,
    isLoading,
    createLostReason,
    deleteLostReason,
    initializeDefaultReasons,
    refreshLostReasons: fetchLostReasons,
  };
}
