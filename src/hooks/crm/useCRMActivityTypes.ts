// @ts-nocheck
import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "../useOrganization";
import { useBusinesses } from "../useBusinesses";
import { toast } from "sonner";

export interface CRMActivityType {
  id: string;
  organization_id: string;
  business_id: string | null;
  name: string;
  icon: string | null;
  color: string | null;
  default_duration: number | null;
  is_active: boolean | null;
  created_at: string;
}

const DEFAULT_ACTIVITY_TYPES = [
  { name: "Call", icon: "phone", color: "#3b82f6", default_duration: 15 },
  { name: "Email", icon: "mail", color: "#10b981", default_duration: 10 },
  { name: "Meeting", icon: "users", color: "#8b5cf6", default_duration: 60 },
  { name: "Demo", icon: "monitor", color: "#f59e0b", default_duration: 45 },
  { name: "Follow-up", icon: "calendar", color: "#ef4444", default_duration: 15 },
  { name: "Task", icon: "check-square", color: "#6b7280", default_duration: 30 },
];

export function useCRMActivityTypes() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const [activityTypes, setActivityTypes] = useState<CRMActivityType[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchActivityTypes = useCallback(async () => {
    if (!currentOrg || !currentBusiness) {
      setActivityTypes([]);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);

    try {
      const { data, error } = await supabase
        .from("crm_activity_types")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("is_active", true)
        .order("name", { ascending: true });

      if (error) throw error;
      setActivityTypes((data || []) as CRMActivityType[]);
    } catch (error) {
      console.error("Error fetching activity types:", error);
    } finally {
      setIsLoading(false);
    }
  }, [currentOrg?.id, currentBusiness?.id]);

  useEffect(() => {
    fetchActivityTypes();
  }, [fetchActivityTypes]);

  const initializeDefaultTypes = async () => {
    if (!currentOrg || !currentBusiness) {
      throw new Error("Select a Company before initializing activity types");
    }

    try {
      const inserts = DEFAULT_ACTIVITY_TYPES.map((type) => ({
        organization_id: currentOrg.id,
        business_id: currentBusiness.id,
        name: type.name,
        icon: type.icon,
        color: type.color,
        default_duration: type.default_duration,
        is_active: true,
      }));

      const { error } = await supabase.from("crm_activity_types").insert(inserts);

      if (error) throw error;
      toast.success("Default activity types created");
      await fetchActivityTypes();
    } catch (error) {
      console.error("Error creating default types:", error);
      toast.error("Failed to create default types");
    }
  };

  const createActivityType = async (type: Partial<CRMActivityType>) => {
    if (!currentOrg || !currentBusiness) {
      throw new Error("Select a Company before adding an activity type");
    }

    const { data, error } = await supabase
      .from("crm_activity_types")
      .insert({
        organization_id: currentOrg.id,
        business_id: currentBusiness.id,
        name: type.name || "New Activity",
        icon: type.icon || null,
        color: type.color || null,
        default_duration: type.default_duration || 30,
        is_active: true,
      })
      .select()
      .single();

    if (error) throw error;
    toast.success("Activity type created");
    await fetchActivityTypes();
    return data;
  };

  return {
    activityTypes,
    isLoading,
    createActivityType,
    initializeDefaultTypes,
    refreshActivityTypes: fetchActivityTypes,
  };
}
