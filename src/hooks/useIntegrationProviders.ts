import { normalizeError } from "@/services/resilience";
/**
 * useIntegrationProviders — generic hook for the
 * platform_integration_* framework. Works for ANY capability_key
 * (exchange_rates, sms, email, payments, …) so the same
 * IntegrationProviderManager UI can manage all of them.
 */
import { useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

export interface IntegrationProvider {
  id: string;
  capability_key: string;
  provider_key: string;
  display_name: string;
  description: string | null;
  docs_url: string | null;
  credential_schema: Record<string, CredentialField>;
  config_schema: Record<string, unknown>;
  is_enabled: boolean;
  sort_order: number;
}

export interface CredentialField {
  type: "string" | "number" | "boolean";
  label: string;
  secret?: boolean;
  required?: boolean;
}

export interface IntegrationConnection {
  id: string;
  capability_key: string;
  provider_id: string;
  display_label: string | null;
  is_active: boolean;
  /**
   * Names of the credential fields that are stored server-side. The secret
   * values themselves are NEVER readable by the browser (column-level grant
   * revoked in the DB) — see ADR 0137.
   */
  credential_keys: string[];
  credentials_set_at: string | null;
  config: Record<string, unknown>;
  auto_refresh_enabled: boolean;
  auto_refresh_interval_hours: number;
  last_test_at: string | null;
  last_test_ok: boolean | null;
  last_test_message: string | null;
  last_run_at: string | null;
  last_run_status: string | null;
  last_run_message: string | null;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface IntegrationRun {
  id: string;
  connection_id: string;
  trigger_kind: "manual" | "scheduled" | "test";
  started_at: string;
  finished_at: string | null;
  status: "running" | "success" | "partial" | "failed";
  message: string | null;
  stats: Record<string, unknown>;
}

export function useIntegrationProviders(capabilityKey: string) {
  const { toast } = useToast();
  const qc = useQueryClient();

  const providersQ = useQuery({
    queryKey: ["integration-providers", capabilityKey],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("platform_integration_providers")
        .select("*")
        .eq("capability_key", capabilityKey)
        .eq("is_enabled", true)
        .order("sort_order", { ascending: true });
      if (error) throw error;
      return (data ?? []) as IntegrationProvider[];
    },
  });

  const connectionsQ = useQuery({
    queryKey: ["integration-connections", capabilityKey],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("platform_integration_connections")
        .select(
          "id, capability_key, provider_id, display_label, is_active, config, " +
            "auto_refresh_enabled, auto_refresh_interval_hours, last_test_at, last_test_ok, " +
            "last_test_message, last_run_at, last_run_status, last_run_message, next_run_at, " +
            "credential_keys, credentials_set_at, created_at, updated_at",
        )
        .eq("capability_key", capabilityKey)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as IntegrationConnection[];
    },
  });

  const runsQ = useQuery({
    queryKey: ["integration-runs", capabilityKey],
    queryFn: async () => {
      const ids = (connectionsQ.data ?? []).map((c) => c.id);
      if (ids.length === 0) return [] as IntegrationRun[];
      const { data, error } = await (supabase as any)
        .from("platform_integration_runs")
        .select("*")
        .in("connection_id", ids)
        .order("started_at", { ascending: false })
        .limit(20);
      if (error) throw error;
      return (data ?? []) as IntegrationRun[];
    },
    enabled: (connectionsQ.data?.length ?? 0) > 0,
  });

  const activeConnection = useMemo(
    () => (connectionsQ.data ?? []).find((c) => c.is_active) ?? null,
    [connectionsQ.data],
  );

  const saveConnection = useMutation({
    mutationFn: async (input: {
      id?: string;
      provider_id: string;
      /** Blank values mean "keep the stored secret" — nothing is ever read back. */
      credentials: Record<string, string>;
      auto_refresh_enabled?: boolean;
      auto_refresh_interval_hours?: number;
      activate?: boolean;
    }) => {
      // Credentials only ever travel one way: browser -> guarded server routine.
      const { data, error } = await (supabase as any).rpc("save_integration_connection", {
        p_capability_key: capabilityKey,
        p_provider_id: input.provider_id,
        p_credentials: input.credentials ?? {},
        p_id: input.id ?? null,
        p_auto_refresh_enabled: input.auto_refresh_enabled ?? false,
        p_auto_refresh_interval_hours: input.auto_refresh_interval_hours ?? 24,
        p_activate: input.activate ?? false,
      });
      if (error) throw error;
      return data as string;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["integration-connections", capabilityKey] });
      toast({ title: "Connection saved" });
    },
    onError: (err: any) =>
      toast({ title: "Failed to save", description: normalizeError(err).message, variant: "destructive" }),
  });

  const deleteConnection = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await (supabase as any).rpc("delete_integration_connection", { p_id: id });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["integration-connections", capabilityKey] });
      qc.invalidateQueries({ queryKey: ["integration-runs", capabilityKey] });
      toast({ title: "Connection removed" });
    },
  });

  const testConnection = useMutation({
    mutationFn: async (connection_id: string) => {
      const { data, error } = await supabase.functions.invoke("provider-test", {
        body: { connection_id },
      });
      if (error) throw error;
      return data as { success: boolean; message: string };
    },
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["integration-connections", capabilityKey] });
      qc.invalidateQueries({ queryKey: ["integration-runs", capabilityKey] });
      toast({
        title: res.success ? "Connection OK" : "Test failed",
        description: res.message,
        variant: res.success ? "default" : "destructive",
      });
    },
    onError: (err: any) =>
      toast({ title: "Test failed", description: normalizeError(err).message, variant: "destructive" }),
  });

  const runConnection = useMutation({
    mutationFn: async (connection_id: string) => {
      const { data, error } = await supabase.functions.invoke("provider-run", {
        body: { connection_id, trigger_kind: "manual" },
      });
      if (error) throw error;
      return data as { success: boolean; message: string; stats?: Record<string, unknown> };
    },
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["integration-connections", capabilityKey] });
      qc.invalidateQueries({ queryKey: ["integration-runs", capabilityKey] });
      qc.invalidateQueries({ queryKey: ["platform-exchange-rates"] });
      toast({
        title: res.success ? "Fetch complete" : "Run failed",
        description: res.message,
        variant: res.success ? "default" : "destructive",
      });
    },
    onError: (err: any) =>
      toast({ title: "Run failed", description: normalizeError(err).message, variant: "destructive" }),
  });

  return {
    providers: providersQ.data ?? [],
    connections: connectionsQ.data ?? [],
    activeConnection,
    runs: runsQ.data ?? [],
    isLoading: providersQ.isLoading || connectionsQ.isLoading,
    saveConnection: saveConnection.mutate,
    isSaving: saveConnection.isPending,
    deleteConnection: deleteConnection.mutate,
    isDeleting: deleteConnection.isPending,
    testConnection: testConnection.mutate,
    isTesting: testConnection.isPending,
    runConnection: runConnection.mutate,
    isRunning: runConnection.isPending,
  };
}
