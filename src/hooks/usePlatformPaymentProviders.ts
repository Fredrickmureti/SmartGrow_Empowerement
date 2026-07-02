import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";

export type PlatformPaymentProvider = "stripe" | "paypal" | "pesapal" | "mpesa";

export interface PlatformPaymentProviderConfig {
  id: string;
  provider: PlatformPaymentProvider;
  display_name: string;
  is_enabled: boolean;
  is_test_mode: boolean;
  credentials: Record<string, any>;
  webhook_url: string | null;
  callback_url: string | null;
  last_tested_at: string | null;
  test_status: "success" | "failed" | "pending" | null;
  test_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProviderCredentialField {
  key: string;
  label: string;
  type: "text" | "password";
  required: boolean;
  placeholder?: string;
}

// Define credential requirements for each provider
export const PROVIDER_CREDENTIAL_FIELDS: Record<PlatformPaymentProvider, ProviderCredentialField[]> = {
  stripe: [
    { key: "publishable_key", label: "Publishable Key", type: "text", required: true, placeholder: "pk_live_..." },
    { key: "secret_key", label: "Secret Key", type: "password", required: true, placeholder: "sk_live_..." },
    { key: "webhook_secret", label: "Webhook Secret", type: "password", required: false, placeholder: "whsec_..." },
  ],
  paypal: [
    { key: "client_id", label: "Client ID", type: "text", required: true, placeholder: "Your PayPal Client ID" },
    { key: "client_secret", label: "Client Secret", type: "password", required: true, placeholder: "Your PayPal Client Secret" },
    { key: "webhook_id", label: "Webhook ID", type: "text", required: false, placeholder: "Webhook ID (optional)" },
  ],
  pesapal: [
    { key: "consumer_key", label: "Consumer Key", type: "text", required: true, placeholder: "Your PesaPal Consumer Key" },
    { key: "consumer_secret", label: "Consumer Secret", type: "password", required: true, placeholder: "Your PesaPal Consumer Secret" },
    { key: "ipn_id", label: "IPN ID", type: "text", required: false, placeholder: "Registered IPN ID" },
  ],
  mpesa: [
    { key: "consumer_key", label: "Consumer Key", type: "text", required: true, placeholder: "Your M-Pesa Consumer Key" },
    { key: "consumer_secret", label: "Consumer Secret", type: "password", required: true, placeholder: "Your M-Pesa Consumer Secret" },
    { key: "business_short_code", label: "Business Short Code", type: "text", required: true, placeholder: "174379" },
    { key: "passkey", label: "Passkey", type: "password", required: true, placeholder: "Your M-Pesa Passkey" },
    { key: "account_reference", label: "Account Reference", type: "text", required: false, placeholder: "AccrualFlow" },
  ],
};

export function usePlatformPaymentProviders() {
  const { toast } = useToast();
  const [providers, setProviders] = useState<PlatformPaymentProviderConfig[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState<PlatformPaymentProvider | null>(null);

  const fetchProviders = useCallback(async () => {
    setIsLoading(true);
    try {
      // First try the full table (platform admins get credentials via RLS)
      const { data: fullData, error: fullError } = await supabase
        .from("platform_payment_providers")
        .select("*")
        .order("display_name");

      if (!fullError && fullData && fullData.length > 0) {
        // Admin path — full access including credentials
        const mappedProviders: PlatformPaymentProviderConfig[] = fullData.map((p) => ({
          id: p.id,
          provider: p.provider as PlatformPaymentProvider,
          display_name: p.display_name,
          is_enabled: p.is_enabled,
          is_test_mode: p.is_test_mode,
          credentials: (typeof p.credentials === 'object' && p.credentials !== null && !Array.isArray(p.credentials)) 
            ? (p.credentials as Record<string, any>) 
            : {},
          webhook_url: p.webhook_url,
          callback_url: p.callback_url,
          last_tested_at: p.last_tested_at,
          test_status: p.test_status as "success" | "failed" | "pending" | null,
          test_error: p.test_error,
          created_at: p.created_at,
          updated_at: p.updated_at,
        }));
        setProviders(mappedProviders);
      } else {
        // Non-admin path — use the secure public view (no credentials column)
        const { data: publicData, error: publicError } = await supabase
          .from("public_payment_providers" as any)
          .select("*")
          .order("display_name");

        if (publicError) throw publicError;

        const mappedProviders: PlatformPaymentProviderConfig[] = ((publicData as any[]) || []).map((p: any) => ({
          id: p.id,
          provider: p.provider as PlatformPaymentProvider,
          display_name: p.display_name,
          is_enabled: p.is_enabled,
          is_test_mode: p.is_test_mode,
          credentials: {}, // Non-admins never see credentials
          webhook_url: p.webhook_url,
          callback_url: p.callback_url,
          last_tested_at: p.last_tested_at,
          test_status: p.test_status as "success" | "failed" | "pending" | null,
          test_error: p.test_error,
          created_at: p.created_at,
          updated_at: p.updated_at,
        }));
        setProviders(mappedProviders);
      }
    } catch (error) {
      console.error("Error fetching payment providers:", error);
      toast({
        title: "Error",
        description: "Failed to load payment providers",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    fetchProviders();
  }, [fetchProviders]);

  const getProvider = (provider: PlatformPaymentProvider): PlatformPaymentProviderConfig | null => {
    return providers.find((p) => p.provider === provider) || null;
  };

  const enabledProviders = providers.filter((p) => p.is_enabled);

  const hasRequiredCredentials = (provider: PlatformPaymentProvider, credentials: Record<string, any>): boolean => {
    const fields = PROVIDER_CREDENTIAL_FIELDS[provider];
    return fields.filter((f) => f.required).every((f) => credentials[f.key]?.trim());
  };

  /**
   * Run the credential validation edge function for a provider.
   * Returns { success, error } and persists test_status to the row.
   * Does NOT toast — caller decides messaging context.
   */
  const runTest = async (
    provider: PlatformPaymentProvider
  ): Promise<{ success: boolean; error?: string }> => {
    const response = await supabase.functions.invoke("provider-test", {
      body: { kind: "platform_payment", provider },
    });
    if (response.error) {
      return { success: false, error: response.error.message || "Test request failed" };
    }
    const success = Boolean(response.data?.success);
    const errMsg = success ? null : (response.data?.error || "Invalid credentials");
    await supabase
      .from("platform_payment_providers")
      .update({
        last_tested_at: new Date().toISOString(),
        test_status: success ? "success" : "failed",
        test_error: errMsg,
      })
      .eq("provider", provider);
    return { success, error: errMsg ?? undefined };
  };

  const saveCredentials = async (
    provider: PlatformPaymentProvider,
    credentials: Record<string, any>,
    isTestMode: boolean = true
  ) => {
    setIsSaving(true);
    try {
      const { error } = await supabase
        .from("platform_payment_providers")
        .update({
          credentials,
          is_test_mode: isTestMode,
          updated_at: new Date().toISOString(),
        })
        .eq("provider", provider);

      if (error) throw error;

      // Auto-validate the credentials immediately so the admin doesn't
      // need a second click. If they're valid, also auto-enable the
      // provider — that's the "smooth flow" the operator expects.
      setIsTesting(provider);
      const result = await runTest(provider);
      setIsTesting(null);

      if (result.success) {
        // Auto-enable on first successful validation
        await supabase
          .from("platform_payment_providers")
          .update({ is_enabled: true, updated_at: new Date().toISOString() })
          .eq("provider", provider);

        toast({
          title: "Credentials Verified",
          description: `${provider.toUpperCase()} credentials are valid. Provider is now live.`,
        });
      } else {
        toast({
          title: "Credentials Saved but Invalid",
          description: result.error || "Could not validate credentials. Provider remains disabled.",
          variant: "destructive",
        });
      }

      await fetchProviders();
    } catch (error: any) {
      toast({
        title: "Error",
        description: normalizeError(error).message || "Failed to save credentials",
        variant: "destructive",
      });
      throw error;
    } finally {
      setIsSaving(false);
      setIsTesting(null);
    }
  };

  const toggleProvider = async (provider: PlatformPaymentProvider, isEnabled: boolean) => {
    const config = getProvider(provider);
    if (!config) return;

    // Disabling is always allowed.
    if (!isEnabled) {
      try {
        const { error } = await supabase
          .from("platform_payment_providers")
          .update({ is_enabled: false, updated_at: new Date().toISOString() })
          .eq("provider", provider);
        if (error) throw error;
        toast({ title: "Provider Disabled", description: `${config.display_name} has been disabled.` });
        await fetchProviders();
      } catch (error: any) {
        toast({ title: "Error", description: normalizeError(error).message || "Failed to disable provider", variant: "destructive" });
      }
      return;
    }

    // Enabling — block if credentials are missing.
    if (!hasRequiredCredentials(provider, config.credentials)) {
      toast({
        title: "Cannot Enable Provider",
        description: "Please configure the required credentials first.",
        variant: "destructive",
      });
      return;
    }

    // Validate-before-enable: never let a provider go live with bad creds.
    setIsTesting(provider);
    const result = await runTest(provider);
    setIsTesting(null);

    if (!result.success) {
      await fetchProviders();
      toast({
        title: "Cannot Enable Provider",
        description: `${config.display_name} credentials failed validation: ${result.error || "unknown error"}. Fix the credentials and try again.`,
        variant: "destructive",
      });
      return;
    }

    try {
      const { error } = await supabase
        .from("platform_payment_providers")
        .update({ is_enabled: true, updated_at: new Date().toISOString() })
        .eq("provider", provider);
      if (error) throw error;
      toast({
        title: "Provider Enabled",
        description: `${config.display_name} credentials verified — provider is live.`,
      });
      await fetchProviders();
    } catch (error: any) {
      toast({
        title: "Error",
        description: normalizeError(error).message || "Failed to update provider status",
        variant: "destructive",
      });
    }
  };

  const testConnection = async (provider: PlatformPaymentProvider): Promise<boolean> => {
    const config = getProvider(provider);
    if (!config) return false;

    setIsTesting(provider);
    try {
      const response = await supabase.functions.invoke("provider-test", {
        body: { kind: "platform_payment", provider },
      });

      if (response.error) throw response.error;

      const success = response.data?.success;

      // Update test result in database
      await supabase
        .from("platform_payment_providers")
        .update({
          last_tested_at: new Date().toISOString(),
          test_status: success ? "success" : "failed",
          test_error: success ? null : response.data?.error,
        })
        .eq("provider", provider);

      await fetchProviders();

      if (success) {
        toast({
          title: "Connection Successful",
          description: `${config.display_name} credentials are valid.`,
        });
      } else {
        toast({
          title: "Connection Failed",
          description: response.data?.error || "Invalid credentials",
          variant: "destructive",
        });
      }

      return success;
    } catch (error: any) {
      toast({
        title: "Test Failed",
        description: normalizeError(error).message || "Failed to test connection",
        variant: "destructive",
      });
      return false;
    } finally {
      setIsTesting(null);
    }
  };

  return {
    providers,
    enabledProviders,
    isLoading,
    isSaving,
    isTesting,
    getProvider,
    hasRequiredCredentials,
    saveCredentials,
    toggleProvider,
    testConnection,
    refreshProviders: fetchProviders,
  };
}
