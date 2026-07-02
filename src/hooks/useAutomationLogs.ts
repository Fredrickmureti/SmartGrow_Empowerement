/**
 * Automation Execution Logs Hook
 * 
 * Fetches execution logs and tracker data for the automation system,
 * including circuit breaker status.
 */

import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";

export interface AutomationLog {
  id: string;
  action_id: string;
  organization_id: string;
  trigger_type: string;
  target_model: string;
  target_record_id: string | null;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  steps_executed: any;
  error_message: string | null;
  error_details: any;
  retry_count: number | null;
  created_at: string;
}

export function useAutomationLogs(automationId?: string) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const [logs, setLogs] = useState<AutomationLog[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchLogs = useCallback(async () => {
    if (!currentOrg) return;
    setIsLoading(true);
    try {
      let query = supabase
        .from("automated_action_logs")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .order("created_at", { ascending: false })
        .limit(100);

      if (automationId) {
        query = query.eq("action_id", automationId);
      }

      const { data, error } = await query;
      if (error) throw error;
      setLogs((data || []) as AutomationLog[]);
    } catch (error) {
      console.error("Error fetching automation logs:", error);
    } finally {
      setIsLoading(false);
    }
  }, [currentOrg?.id, automationId]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  const resetCircuitBreaker = useCallback(async (automationId: string) => {
    const { error } = await supabase
      .from("automated_actions")
      .update({
        is_circuit_broken: false,
        circuit_broken_at: null,
        circuit_broken_reason: null,
      } as any)
      .eq("id", automationId);

    if (error) throw error;
  }, []);

  return {
    logs,
    isLoading,
    refetch: fetchLogs,
    resetCircuitBreaker,
  };
}
