import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";

export interface AIProvider {
  id: string;
  provider_code: string;
  display_name: string;
  base_url: string;
  is_enabled: boolean;
  priority: number;
  default_model: string | null;
  available_models: string[];
  created_at: string;
  updated_at: string;
}

export interface AIApiKey {
  id: string;
  provider_id: string;
  key_name: string;
  api_key_encrypted: string | null;
  vault_secret_id: string | null;
  is_enabled: boolean;
  priority: number;
  rate_limit_hits: number;
  last_rate_limited_at: string | null;
  last_used_at: string | null;
  total_requests: number;
  created_at: string;
  updated_at: string;
}

export interface AISetting {
  id: string;
  setting_key: string;
  setting_value: string | null;
  setting_type: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface AIUsageLog {
  id: string;
  api_key_id: string | null;
  provider_code: string;
  request_type: string;
  model_used: string | null;
  tokens_used: number | null;
  was_rate_limited: boolean;
  was_fallback: boolean;
  error_message: string | null;
  response_time_ms: number | null;
  created_at: string;
}

export function useAIProviders() {
  const { toast } = useToast();
  const [providers, setProviders] = useState<AIProvider[]>([]);
  const [apiKeys, setApiKeys] = useState<AIApiKey[]>([]);
  const [settings, setSettings] = useState<AISetting[]>([]);
  const [usageLogs, setUsageLogs] = useState<AIUsageLog[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  const fetchProviders = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from("ai_providers")
        .select("*")
        .order("priority");

      if (error) throw error;
      
      const parsed = (data || []).map(p => ({
        ...p,
        available_models: Array.isArray(p.available_models) 
          ? p.available_models as string[]
          : typeof p.available_models === 'string' 
            ? JSON.parse(p.available_models) 
            : []
      }));
      
      setProviders(parsed);
    } catch (error: any) {
      console.error("Error fetching AI providers:", error);
    }
  }, []);

  const fetchApiKeys = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from("ai_api_keys")
        .select("*")
        .order("priority");

      if (error) throw error;
      setApiKeys(data || []);
    } catch (error: any) {
      console.error("Error fetching AI API keys:", error);
    }
  }, []);

  const fetchSettings = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from("ai_settings")
        .select("*")
        .order("setting_key");

      if (error) throw error;
      setSettings(data || []);
    } catch (error: any) {
      console.error("Error fetching AI settings:", error);
    }
  }, []);

  const fetchUsageLogs = useCallback(async (limit = 50) => {
    try {
      const { data, error } = await supabase
        .from("ai_usage_logs")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(limit);

      if (error) throw error;
      setUsageLogs(data || []);
    } catch (error: any) {
      console.error("Error fetching AI usage logs:", error);
    }
  }, []);

  const fetchAll = useCallback(async () => {
    setIsLoading(true);
    await Promise.all([
      fetchProviders(),
      fetchApiKeys(),
      fetchSettings(),
      fetchUsageLogs(),
    ]);
    setIsLoading(false);
  }, [fetchProviders, fetchApiKeys, fetchSettings, fetchUsageLogs]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const getSetting = (key: string): string | null => {
    const setting = settings.find((s) => s.setting_key === key);
    return setting?.setting_value ?? null;
  };

  const getSettingBool = (key: string): boolean => {
    return getSetting(key) === "true";
  };

  const updateProvider = async (id: string, updates: Partial<AIProvider>) => {
    setIsSaving(true);
    try {
      const { error } = await supabase
        .from("ai_providers")
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq("id", id);

      if (error) throw error;

      setProviders((prev) =>
        prev.map((p) => (p.id === id ? { ...p, ...updates } : p))
      );

      toast({
        title: "Provider updated",
        description: "AI provider settings saved successfully.",
      });
    } catch (error: any) {
      console.error("Error updating provider:", error);
      toast({
        title: "Error",
        description: normalizeError(error).message || "Failed to update provider",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const addApiKey = async (providerId: string, keyName: string, apiKey: string) => {
    setIsSaving(true);
    try {
      // Store the secret in Supabase Vault via a SECURITY DEFINER RPC.
      // The plaintext key is never written to a regular table column.
      const { data: newId, error } = await supabase.rpc("store_ai_api_key", {
        p_provider_id: providerId,
        p_key_name: keyName,
        p_api_key: apiKey,
        p_priority: null,
      });

      if (error) throw error;

      // Refresh from DB so the new (vault-backed) row is loaded.
      await fetchApiKeys();

      toast({
        title: "API key added",
        description: `${keyName} has been added successfully.`,
      });

      return { id: newId as string } as AIApiKey;
    } catch (error: any) {
      console.error("Error adding API key:", error);
      toast({
        title: "Error",
        description: normalizeError(error).message || "Failed to add API key",
        variant: "destructive",
      });
      return null;
    } finally {
      setIsSaving(false);
    }
  };

  const updateApiKey = async (id: string, updates: Partial<AIApiKey>) => {
    setIsSaving(true);
    try {
      const { error } = await supabase
        .from("ai_api_keys")
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq("id", id);

      if (error) throw error;

      setApiKeys((prev) =>
        prev.map((k) => (k.id === id ? { ...k, ...updates } : k))
      );

      toast({
        title: "API key updated",
        description: "API key settings saved successfully.",
      });
    } catch (error: any) {
      console.error("Error updating API key:", error);
      toast({
        title: "Error",
        description: normalizeError(error).message || "Failed to update API key",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const deleteApiKey = async (id: string) => {
    setIsSaving(true);
    try {
      // Use SECURITY DEFINER RPC so the Vault secret is removed together with the row.
      const { error } = await supabase.rpc("delete_ai_api_key", { p_id: id });

      if (error) throw error;

      setApiKeys((prev) => prev.filter((k) => k.id !== id));

      toast({
        title: "API key deleted",
        description: "API key has been removed.",
      });
    } catch (error: any) {
      console.error("Error deleting API key:", error);
      toast({
        title: "Error",
        description: normalizeError(error).message || "Failed to delete API key",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const updateSetting = async (key: string, value: string | null) => {
    setIsSaving(true);
    try {
      const { error } = await supabase
        .from("ai_settings")
        .update({ setting_value: value, updated_at: new Date().toISOString() })
        .eq("setting_key", key);

      if (error) throw error;

      setSettings((prev) =>
        prev.map((s) => (s.setting_key === key ? { ...s, setting_value: value } : s))
      );

      toast({
        title: "Setting updated",
        description: `${key} has been updated.`,
      });
    } catch (error: any) {
      console.error("Error updating setting:", error);
      toast({
        title: "Error",
        description: normalizeError(error).message || "Failed to update setting",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const testApiKey = async (providerId: string, apiKey: string): Promise<boolean> => {
    try {
      const provider = providers.find(p => p.id === providerId);
      if (!provider) return false;

      // Simple test request
      const response = await fetch(provider.base_url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: provider.default_model,
          messages: [{ role: "user", content: "test" }],
          max_tokens: 5,
        }),
      });

      return response.ok || response.status === 400; // 400 might be invalid model but key is valid
    } catch {
      return false;
    }
  };

  const getProviderKeys = (providerId: string) => {
    return apiKeys.filter(k => k.provider_id === providerId).sort((a, b) => a.priority - b.priority);
  };

  return {
    providers,
    apiKeys,
    settings,
    usageLogs,
    isLoading,
    isSaving,
    getSetting,
    getSettingBool,
    updateProvider,
    addApiKey,
    updateApiKey,
    deleteApiKey,
    updateSetting,
    testApiKey,
    getProviderKeys,
    refreshAll: fetchAll,
    refreshUsageLogs: fetchUsageLogs,
  };
}
