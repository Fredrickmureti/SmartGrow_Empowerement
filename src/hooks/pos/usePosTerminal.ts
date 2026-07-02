import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";

export type TerminalProvider = "stripe_terminal" | "adyen" | "verifone" | "square_terminal";
export type TerminalMode = "test" | "live";

export interface TerminalConfigMasked {
  id: string;
  organization_id: string;
  business_id: string;
  branch_id: string | null;
  provider: TerminalProvider;
  provider_mode: TerminalMode;
  display_name: string | null;
  is_enabled: boolean;
  location_id: string | null;
  merchant_account: string | null;
  poi_terminal_id: string | null;
  api_key_masked: string | null;
  has_secret: boolean;
  last_test_at: string | null;
  last_test_status: string | null;
  last_test_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface SaveTerminalConfigInput {
  provider: TerminalProvider;
  provider_mode: TerminalMode;
  display_name?: string;
  api_key: string;
  location_id?: string | null;
  merchant_account?: string | null;
  poi_terminal_id?: string | null;
  is_enabled?: boolean;
}

export interface StartTerminalPaymentResult {
  paymentRequestId: string;
  intentId: string | null;
  status: string;
}

/**
 * Tenant-owned POS payment terminal hook.
 *
 * Same shape as `usePaymentRequests` / `useSmsConfig`:
 *   • Masked reads via `get_terminal_config_masked`
 *   • Writes via `set_terminal_provider_config` / `delete_terminal_provider_config`
 *   • Side-effects (health, payment intents) via the `terminal-outbound` edge fn
 *   • Live status updates via realtime channel on `payment_requests`
 */
export function usePosTerminal() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { toast } = useToast();
  const orgId = currentOrg?.id ?? null;
  const businessId = currentBusiness?.id ?? null;

  const [configs, setConfigs] = useState<TerminalConfigMasked[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);

  const lastKeyRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    if (!orgId) { setConfigs([]); return; }
    setIsLoading(true);
    const { data, error } = await (supabase as any).rpc("get_terminal_config_masked", {
      p_organization_id: orgId,
      p_business_id: businessId,
    });
    setIsLoading(false);
    if (error) {
      console.error("[usePosTerminal] fetch failed", error);
      setConfigs([]);
      return;
    }
    setConfigs((data ?? []) as TerminalConfigMasked[]);
  }, [orgId, businessId]);

  useEffect(() => {
    const key = orgId && businessId ? `${orgId}::${businessId}` : null;
    if (!key) { setConfigs([]); lastKeyRef.current = null; return; }
    if (lastKeyRef.current !== key) {
      lastKeyRef.current = key;
      refresh();
    }
  }, [orgId, businessId, refresh]);

  const saveConfig = useCallback(async (input: SaveTerminalConfigInput) => {
    if (!orgId || !businessId) {
      toast({ title: "Select a Company first", variant: "destructive" });
      return null;
    }
    setIsSaving(true);
    const { data, error } = await (supabase as any).rpc("set_terminal_provider_config", {
      p_organization_id: orgId,
      p_business_id: businessId,
      p_provider: input.provider,
      p_provider_mode: input.provider_mode,
      p_display_name: input.display_name ?? null,
      p_api_key: input.api_key,
      p_location_id: input.location_id ?? null,
      p_merchant_account: input.merchant_account ?? null,
      p_poi_terminal_id: input.poi_terminal_id ?? null,
      p_branch_id: null,
      p_is_enabled: input.is_enabled ?? true,
    });
    setIsSaving(false);
    if (error) {
      toast({ title: "Could not save terminal configuration", description: normalizeError(error).message, variant: "destructive" });
      return null;
    }
    toast({ title: "Terminal configuration saved" });
    await refresh();
    return data as string;
  }, [orgId, businessId, toast, refresh]);

  const deleteConfig = useCallback(async (configId: string) => {
    const { error } = await (supabase as any).rpc("delete_terminal_provider_config", {
      p_config_id: configId,
    });
    if (error) {
      toast({ title: "Could not delete configuration", description: normalizeError(error).message, variant: "destructive" });
      return false;
    }
    toast({ title: "Terminal configuration removed" });
    await refresh();
    return true;
  }, [toast, refresh]);

  const testConnection = useCallback(async (configId: string) => {
    setIsTesting(true);
    const { data, error } = await supabase.functions.invoke("terminal-outbound", {
      body: { action: "health", configId },
    });
    setIsTesting(false);
    if (error) {
      toast({ title: "Test failed", description: normalizeError(error).message, variant: "destructive" });
      await refresh();
      return false;
    }
    const ok = !!(data as any)?.success;
    toast({
      title: ok ? "Terminal reachable" : "Terminal test failed",
      description: ok ? undefined : (data as any)?.error,
      variant: ok ? "default" : "destructive",
    });
    await refresh();
    return ok;
  }, [toast, refresh]);

  const startPayment = useCallback(async (params: {
    configId: string;
    amount: number;
    currency?: string;
    posTransactionId?: string;
  }): Promise<StartTerminalPaymentResult | null> => {
    setIsProcessing(true);
    const { data, error } = await supabase.functions.invoke("terminal-outbound", {
      body: { action: "create_intent", ...params },
    });
    setIsProcessing(false);
    if (error || !(data as any)?.success) {
      toast({
        title: "Could not start terminal payment",
        description: normalizeError(error).message ?? (data as any)?.error,
        variant: "destructive",
      });
      return null;
    }
    const pr = (data as any).paymentRequest;
    return { paymentRequestId: pr.id, intentId: pr.provider_reference ?? null, status: pr.status };
  }, [toast]);

  const captureOrCancel = useCallback(async (
    action: "capture" | "cancel" | "refund" | "query",
    paymentRequestId: string,
    extra?: { amount?: number },
  ) => {
    const { data, error } = await supabase.functions.invoke("terminal-outbound", {
      body: { action, paymentRequestId, ...extra },
    });
    if (error || !(data as any)?.success) {
      toast({ title: `Terminal ${action} failed`, description: normalizeError(error).message ?? (data as any)?.error, variant: "destructive" });
      return null;
    }
    return data;
  }, [toast]);

  const enabledByProvider = useMemo(() => {
    const m: Partial<Record<TerminalProvider, TerminalConfigMasked>> = {};
    for (const c of configs) if (c.is_enabled) m[c.provider] = c;
    return m;
  }, [configs]);

  return {
    configs,
    enabledByProvider,
    isLoading, isSaving, isTesting, isProcessing,
    refresh,
    saveConfig,
    deleteConfig,
    testConnection,
    startPayment,
    capture: (id: string) => captureOrCancel("capture", id),
    cancel:  (id: string) => captureOrCancel("cancel",  id),
    refund:  (id: string, amount?: number) => captureOrCancel("refund", id, { amount }),
    query:   (id: string) => captureOrCancel("query",   id),
  };
}
