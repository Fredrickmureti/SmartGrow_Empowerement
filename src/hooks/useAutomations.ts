import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "@/contexts/BusinessContext";
import { toast } from "sonner";
import { EntityType } from "./useEntityFields";

export type TriggerType = 
  | "on_create" 
  | "on_update" 
  | "on_delete" 
  | "time_based" 
  | "field_change" 
  | "webhook" 
  | "manual";

export type ActionType = 
  | "update_record" 
  | "create_record" 
  | "send_email" 
  | "send_notification" 
  | "webhook_call" 
  | "create_activity" 
  | "add_tag" 
  | "run_code";

export type ScheduleType = "interval" | "cron" | "specific_time";

export interface TriggerCondition {
  field: string;
  operator: "=" | "!=" | ">" | "<" | ">=" | "<=" | "contains" | "not_contains" | "is_empty" | "is_not_empty" | "changed_to" | "changed_from";
  value?: string | number | boolean;
}

export interface ScheduleConfig {
  interval_minutes?: number;
  cron?: string;
  time?: string;
  days?: string[];
  timezone?: string;
}

export interface AutomatedAction {
  id: string;
  organization_id: string;
  business_id: string | null;
  name: string;
  description: string | null;
  is_active: boolean;
  trigger_type: TriggerType;
  target_model: EntityType | string;
  trigger_conditions: TriggerCondition[];
  filter_domain: TriggerCondition[];
  watched_fields: string[] | null;
  schedule_type: ScheduleType | null;
  schedule_config: ScheduleConfig | null;
  next_run_at: string | null;
  last_run_at: string | null;
  run_as_user_id: string | null;
  max_retries: number;
  retry_delay_seconds: number;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

export interface ActionConfig {
  // For update_record
  fields?: Array<{ field: string; value: string | number | boolean }>;
  // For send_email
  template_id?: string;
  to?: string;
  subject?: string;
  body?: string;
  // For webhook_call
  url?: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  // For create_activity
  activity_type?: string;
  summary?: string;
  due_in_days?: number;
  // For create_record
  model?: string;
  record_fields?: Record<string, any>;
  // For add_tag
  tag?: string;
}

export interface AutomatedActionStep {
  id: string;
  action_id: string;
  step_order: number;
  step_name: string | null;
  action_type: ActionType;
  action_config: ActionConfig;
  condition: TriggerCondition | null;
  on_error: "continue" | "stop" | "retry";
  created_at: string;
  updated_at: string;
}

export interface AutomatedActionLog {
  id: string;
  organization_id: string;
  action_id: string;
  trigger_type: TriggerType;
  target_model: string;
  target_record_id: string | null;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  started_at: string | null;
  completed_at: string | null;
  steps_executed: Array<{
    step_id: string;
    status: string;
    result?: any;
    error?: string;
  }>;
  error_message: string | null;
  error_details: Record<string, any> | null;
  retry_count: number;
  created_at: string;
}

// Trigger type labels for UI
export const TRIGGER_TYPE_LABELS: Record<TriggerType, string> = {
  on_create: "When Record Created",
  on_update: "When Record Updated",
  on_delete: "When Record Deleted",
  time_based: "On Schedule",
  field_change: "When Field Changes",
  webhook: "When Webhook Received",
  manual: "Manual Trigger",
};

// Action type labels for UI
export const ACTION_TYPE_LABELS: Record<ActionType, string> = {
  update_record: "Update Record",
  create_record: "Create Record",
  send_email: "Send Email",
  send_notification: "Send Notification",
  webhook_call: "Call Webhook",
  create_activity: "Create Activity",
  add_tag: "Add Tag",
  run_code: "Run Custom Code",
};

/**
 * Hook for managing automated actions
 */
export function useAutomations(targetModel?: EntityType | string) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const [automations, setAutomations] = useState<AutomatedAction[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchAutomations = useCallback(async () => {
    if (!currentOrg?.id || !currentBusiness?.id) {
      // Until a company is selected we deliberately show nothing — an automation
      // is a company-scoped object (it acts on that company's books) and we
      // must never blend sister-company automations into the list.
      setAutomations([]);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);

    try {
      let query = supabase
        .from("automated_actions")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .order("created_at", { ascending: false });

      if (targetModel) {
        query = query.eq("target_model", targetModel);
      }

      const { data, error } = await query;

      if (error) throw error;
      setAutomations((data || []) as unknown as AutomatedAction[]);
    } catch (error) {
      console.error("Error fetching automations:", error);
      toast.error("Failed to fetch automations");
    } finally {
      setIsLoading(false);
    }
  }, [currentOrg?.id, currentBusiness?.id, targetModel]);

  useEffect(() => {
    fetchAutomations();
  }, [fetchAutomations]);

  const createAutomation = async (
    automation: Omit<AutomatedAction, "id" | "organization_id" | "created_at" | "updated_at" | "created_by">
  ) => {
    if (!currentOrg) throw new Error("No organization selected");
    if (!currentBusiness?.id) throw new Error("No company selected — automations are company-scoped");

    const { data, error } = await supabase
      .from("automated_actions")
      .insert({
        ...automation,
        organization_id: currentOrg.id,
        business_id: automation.business_id ?? currentBusiness.id,
      } as any)
      .select()
      .single();

    if (error) throw error;
    
    toast.success(`Automation "${automation.name}" created`);
    await fetchAutomations();
    return data as unknown as AutomatedAction;
  };

  const updateAutomation = async (id: string, updates: Partial<AutomatedAction>) => {
    const { error } = await supabase
      .from("automated_actions")
      .update(updates as any)
      .eq("id", id);

    if (error) throw error;
    
    toast.success("Automation updated");
    await fetchAutomations();
  };

  const deleteAutomation = async (id: string) => {
    const { error } = await supabase
      .from("automated_actions")
      .delete()
      .eq("id", id);

    if (error) throw error;
    
    toast.success("Automation deleted");
    await fetchAutomations();
  };

  const toggleAutomation = async (id: string, isActive: boolean) => {
    await updateAutomation(id, { is_active: isActive });
    toast.success(isActive ? "Automation enabled" : "Automation disabled");
  };

  const duplicateAutomation = async (id: string) => {
    const automation = automations.find(a => a.id === id);
    if (!automation) throw new Error("Automation not found");

    const { id: _, created_at, updated_at, created_by, ...rest } = automation;
    
    return createAutomation({
      ...rest,
      name: `${automation.name} (Copy)`,
      is_active: false,
    });
  };

  return {
    automations,
    isLoading,
    createAutomation,
    updateAutomation,
    deleteAutomation,
    toggleAutomation,
    duplicateAutomation,
    refreshAutomations: fetchAutomations,
    activeAutomations: automations.filter(a => a.is_active),
    inactiveAutomations: automations.filter(a => !a.is_active),
  };
}

/**
 * Hook for managing automation steps
 */
export function useAutomationSteps(actionId: string | null) {
  const [steps, setSteps] = useState<AutomatedActionStep[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const fetchSteps = useCallback(async () => {
    if (!actionId) return;
    setIsLoading(true);

    try {
      const { data, error } = await supabase
        .from("automated_action_steps")
        .select("*")
        .eq("action_id", actionId)
        .order("step_order");

      if (error) throw error;
      setSteps((data || []) as unknown as AutomatedActionStep[]);
    } catch (error) {
      console.error("Error fetching automation steps:", error);
    } finally {
      setIsLoading(false);
    }
  }, [actionId]);

  useEffect(() => {
    fetchSteps();
  }, [fetchSteps]);

  const addStep = async (step: Omit<AutomatedActionStep, "id" | "created_at" | "updated_at">) => {
    const { data, error } = await supabase
      .from("automated_action_steps")
      .insert(step as any)
      .select()
      .single();

    if (error) throw error;
    
    await fetchSteps();
    return data as unknown as AutomatedActionStep;
  };

  const updateStep = async (id: string, updates: Partial<AutomatedActionStep>) => {
    const { error } = await supabase
      .from("automated_action_steps")
      .update(updates as any)
      .eq("id", id);

    if (error) throw error;
    await fetchSteps();
  };

  const deleteStep = async (id: string) => {
    const { error } = await supabase
      .from("automated_action_steps")
      .delete()
      .eq("id", id);

    if (error) throw error;
    await fetchSteps();
  };

  const reorderSteps = async (reorderedSteps: AutomatedActionStep[]) => {
    for (let i = 0; i < reorderedSteps.length; i++) {
      await supabase
        // SCOPE-EXEMPT: `automated_action_steps` is workspace-wide (no business_id column)
        .from("automated_action_steps")
        .update({ step_order: i })
        .eq("id", reorderedSteps[i].id);
    }
    await fetchSteps();
  };

  return {
    steps,
    isLoading,
    addStep,
    updateStep,
    deleteStep,
    reorderSteps,
    refreshSteps: fetchSteps,
  };
}

/**
 * Hook for viewing automation execution logs
 */
export function useAutomationLogs(actionId?: string) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const [logs, setLogs] = useState<AutomatedActionLog[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const fetchLogs = useCallback(async () => {
    if (!currentOrg?.id || !currentBusiness?.id) {
      setLogs([]);
      return;
    }
    setIsLoading(true);

    try {
      let query = supabase
        .from("automated_action_logs")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .order("created_at", { ascending: false })
        .limit(100);

      if (actionId) {
        query = query.eq("action_id", actionId);
      }

      const { data, error } = await query;

      if (error) throw error;
      setLogs((data || []) as unknown as AutomatedActionLog[]);
    } catch (error) {
      console.error("Error fetching automation logs:", error);
    } finally {
      setIsLoading(false);
    }
  }, [currentOrg?.id, currentBusiness?.id, actionId]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  return {
    logs,
    isLoading,
    refreshLogs: fetchLogs,
    successfulLogs: logs.filter(l => l.status === "completed"),
    failedLogs: logs.filter(l => l.status === "failed"),
  };
}
