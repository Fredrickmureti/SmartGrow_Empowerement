import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";

export type PaymentProvider = "mpesa" | "mpesa_c2b" | "stripe" | "flutterwave" | "paystack";

export interface PaymentProviderConfig {
  id: string;
  organization_id: string;
  provider: PaymentProvider;
  display_name: string | null;
  config: Record<string, any>;
  is_active: boolean;
  is_test_mode: boolean;
  callback_url: string | null;
  last_tested_at: string | null;
  test_result: string | null;
  test_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface MpesaConfig {
  consumer_key: string;
  consumer_secret: string;
  business_short_code: string;
  passkey: string;
  account_reference?: string;
  transaction_type: "CustomerPayBillOnline" | "CustomerBuyGoodsOnline";
}

export interface StripeConfig {
  publishable_key: string;
  secret_key: string;
  webhook_secret?: string;
}

/**
 * Cache key. Provider configs are scoped to (organization_id, business_id),
 * so the key MUST include both — otherwise switching the active company
 * leaves the previous company's gateway config in cache and the POS dialog
 * silently keeps the old credentials available.
 */
const providerConfigsKey = (orgId?: string, businessId?: string) =>
  ["payment-provider-configs", orgId ?? null, businessId ?? null] as const;

export function usePaymentProviders() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const orgId = currentOrg?.id;
  const businessId = currentBusiness?.id;

  const { data: configs = [], isLoading } = useQuery({
    queryKey: providerConfigsKey(orgId, businessId),
    enabled: !!orgId && !!businessId,
    staleTime: 30_000,
    queryFn: async (): Promise<PaymentProviderConfig[]> => {
      const { data, error } = await supabase
        .from("payment_provider_configs")
        .select("*")
        .eq("organization_id", orgId!)
        .eq("business_id", businessId!);
      if (error) throw error;
      return (data as PaymentProviderConfig[]) ?? [];
    },
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: providerConfigsKey(orgId, businessId) });

  const getProviderConfig = (provider: PaymentProvider): PaymentProviderConfig | null => {
    return configs.find((c) => c.provider === provider) ?? null;
  };

  const requireScope = (): { orgId: string; businessId: string } => {
    if (!orgId || !businessId) {
      const message = "Select a company before configuring payment providers.";
      toast({ title: "No company selected", description: message, variant: "destructive" });
      throw new Error(message);
    }
    return { orgId, businessId };
  };

  const saveMutation = useMutation({
    mutationFn: async (args: {
      provider: PaymentProvider;
      config: Record<string, any>;
      options?: { displayName?: string; isTestMode?: boolean; isActive?: boolean };
    }) => {
      const { orgId: o, businessId: b } = requireScope();
      const existing = getProviderConfig(args.provider);
      const callbackUrl =
        args.provider === "mpesa"
          ? `https://xwxqunklduknceoryrha.supabase.co/functions/v1/mpesa-callback`
          : null;

      const payload = {
        organization_id: o,
        business_id: b,
        provider: args.provider,
        display_name: args.options?.displayName || args.provider.toUpperCase(),
        config: args.config,
        is_test_mode: args.options?.isTestMode ?? false,
        is_active: args.options?.isActive ?? false,
        callback_url: callbackUrl,
        updated_at: new Date().toISOString(),
      };

      if (existing) {
        const { error } = await supabase
          .from("payment_provider_configs")
          .update(payload)
          .eq("id", existing.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("payment_provider_configs").insert(payload);
        if (error) throw error;
      }
    },
    onSuccess: (_d, vars) => {
      toast({
        title: "Configuration saved",
        description: `${vars.provider.toUpperCase()} configuration has been saved.`,
      });
      invalidate();
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: normalizeError(err).message, variant: "destructive" });
    },
  });

  const toggleMutation = useMutation({
    mutationFn: async (args: { provider: PaymentProvider; isActive: boolean }) => {
      requireScope();
      const config = getProviderConfig(args.provider);
      if (!config) throw new Error("Provider not configured yet.");
      const { error } = await supabase
        .from("payment_provider_configs")
        .update({ is_active: args.isActive, updated_at: new Date().toISOString() })
        .eq("id", config.id);
      if (error) throw error;
    },
    onSuccess: (_d, vars) => {
      toast({
        title: vars.isActive ? "Provider enabled" : "Provider disabled",
        description: `${vars.provider.toUpperCase()} has been ${vars.isActive ? "enabled" : "disabled"}.`,
      });
      invalidate();
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: normalizeError(err).message, variant: "destructive" });
    },
  });

  const testMutation = useMutation({
    mutationFn: async (provider: PaymentProvider): Promise<boolean> => {
      const { orgId: o } = requireScope();
      const config = getProviderConfig(provider);
      if (!config) throw new Error("Provider not configured yet.");

      const response = await supabase.functions.invoke("provider-test", {
        body: { kind: "payment", provider, organizationId: o },
      });
      if (response.error) throw response.error;
      const success = !!response.data?.success;

      await supabase
        .from("payment_provider_configs")
        .update({
          last_tested_at: new Date().toISOString(),
          test_result: success ? "success" : "failed",
          test_error: success ? null : response.data?.error,
        })
        .eq("id", config.id);
      return success;
    },
    onSuccess: (success, provider) => {
      if (success) {
        toast({
          title: "Connection successful",
          description: `${provider.toUpperCase()} credentials are valid.`,
        });
      } else {
        toast({
          title: "Connection failed",
          description: "Invalid credentials",
          variant: "destructive",
        });
      }
      invalidate();
    },
    onError: (err: Error) => {
      toast({ title: "Test failed", description: normalizeError(err).message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (provider: PaymentProvider) => {
      requireScope();
      const config = getProviderConfig(provider);
      if (!config) return;
      const { error } = await supabase
        .from("payment_provider_configs")
        .delete()
        .eq("id", config.id);
      if (error) throw error;
    },
    onSuccess: (_d, provider) => {
      toast({
        title: "Configuration removed",
        description: `${provider.toUpperCase()} configuration has been deleted.`,
      });
      invalidate();
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: normalizeError(err).message, variant: "destructive" });
    },
  });

  return {
    configs,
    isLoading,
    isSaving: saveMutation.isPending,
    getProviderConfig,
    saveProviderConfig: (
      provider: PaymentProvider,
      config: Record<string, any>,
      options: { displayName?: string; isTestMode?: boolean; isActive?: boolean } = {},
    ) => saveMutation.mutateAsync({ provider, config, options }),
    toggleProviderActive: (provider: PaymentProvider, isActive: boolean) =>
      toggleMutation.mutateAsync({ provider, isActive }),
    testProviderConnection: (provider: PaymentProvider) => testMutation.mutateAsync(provider),
    deleteProviderConfig: (provider: PaymentProvider) => deleteMutation.mutateAsync(provider),
    refreshConfigs: invalidate,
  };
}
