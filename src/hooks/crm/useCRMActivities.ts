// @ts-nocheck
import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "../useOrganization";
import { useBusinesses } from "../useBusinesses";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";

export interface CRMActivity {
  id: string;
  organization_id: string;
  lead_id: string;
  activity_type: string | null;
  activity_type_id: string | null;
  summary: string;
  description: string | null;
  due_date: string | null;
  due_time: string | null;
  duration: number | null;
  assigned_to: string | null;
  is_done: boolean | null;
  completed_at: string | null;
  completed_by: string | null;
  outcome: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export function useCRMActivities(leadId?: string) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { user } = useAuth();
  const [activities, setActivities] = useState<CRMActivity[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchActivities = useCallback(async () => {
    if (!currentOrg || !currentBusiness) {
      setActivities([]);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);

    try {
      const filters = {
        organization_id: currentOrg.id,
        business_id: currentBusiness.id,
        ...(leadId ? { lead_id: leadId } : {}),
      };

      const { data, error } = await supabase
        .from("crm_activities")
        .select("*")
        .match(filters)
        .order("due_date");
      if (error) throw error;
      setActivities((data || []) as CRMActivity[]);
    } catch (error) {
      console.error("Error fetching CRM activities:", error);
      toast.error("Failed to fetch activities");
    } finally {
      setIsLoading(false);
    }
  }, [currentOrg?.id, currentBusiness?.id, leadId]);

  useEffect(() => {
    fetchActivities();
  }, [fetchActivities]);

  const createActivity = async (activity: Partial<CRMActivity>) => {
    if (!currentOrg || !currentBusiness || !user) throw new Error("No organization or business selected");

    const insertData = {
      lead_id: activity.lead_id!,
      organization_id: currentOrg.id,
      business_id: currentBusiness.id,
      summary: activity.summary || "New Activity",
      activity_type: activity.activity_type || null,
      activity_type_id: activity.activity_type_id || null,
      description: activity.description || null,
      due_date: activity.due_date || null,
      due_time: activity.due_time || null,
      duration: activity.duration || null,
      assigned_to: activity.assigned_to || null,
      is_done: false,
      created_by: user.id,
    };

    const { data, error } = await supabase
      .from("crm_activities")
      .insert(insertData)
      .select()
      .single();

    if (error) throw error;

    toast.success("Activity scheduled");
    await fetchActivities();
    return data;
  };

  const updateActivity = async (id: string, updates: Partial<CRMActivity>) => {
    const { error } = await supabase
      .from("crm_activities")
      .update(updates)
      .eq("id", id);

    if (error) throw error;
    toast.success("Activity updated");
    await fetchActivities();
  };

  const markAsDone = async (id: string, outcome?: string) => {
    if (!user) throw new Error("Not authenticated");

    const { error } = await supabase
      .from("crm_activities")
      .update({
        is_done: true,
        completed_at: new Date().toISOString(),
        completed_by: user.id,
        outcome: outcome || null,
      })
      .eq("id", id);

    if (error) throw error;
    toast.success("Activity completed");
    await fetchActivities();
  };

  const deleteActivity = async (id: string) => {
    const { error } = await supabase
      .from("crm_activities")
      .delete()
      .eq("id", id);

    if (error) throw error;
    toast.success("Activity deleted");
    await fetchActivities();
  };

  return {
    activities,
    isLoading,
    createActivity,
    updateActivity,
    markAsDone,
    deleteActivity,
    refreshActivities: fetchActivities,
  };
}
