import { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import type { Json } from "@/integrations/supabase/types";

export interface BankProvider {
  id: string;
  provider_code: string;
  provider_name: string;
  description: string | null;
  logo_url: string | null;
  api_base_url: string | null;
  api_key_encrypted: string | null;
  api_secret_encrypted: string | null;
  merchant_code: string | null;
  public_key: string | null;
  private_key_encrypted: string | null;
  is_enabled: boolean;
  is_sandbox: boolean;
  supported_countries: string[];
  config: Json;
  created_at: string;
  updated_at: string;
}

// Public view type (without sensitive fields)
export interface BankProviderPublic {
  id: string;
  provider_code: string;
  provider_name: string;
  description: string | null;
  logo_url: string | null;
  is_enabled: boolean;
  is_sandbox: boolean;
  supported_countries: string[];
  created_at: string;
  updated_at: string;
}

export interface BankProviderUpdateData {
  api_key_encrypted?: string | null;
  api_secret_encrypted?: string | null;
  merchant_code?: string | null;
  public_key?: string | null;
  private_key_encrypted?: string | null;
  is_enabled?: boolean;
  is_sandbox?: boolean;
  config?: Json;
  logo_url?: string | null;
}

export function useBankProviders() {
  const [providers, setProviders] = useState<BankProvider[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  
  // Prevent refetching on tab focus
  const hasFetchedRef = useRef(false);

  const fetchProviders = useCallback(async () => {
    try {
      setIsLoading(true);
      
      // Single-institution deployment: providers are read through RLS with
      // the caller's own privileges; there is no platform-admin persona.
      const { data, error } = await supabase
        .from("platform_bank_providers")
        .select("*")
        .order("provider_name");

      if (error) throw error;
      setProviders((data as BankProvider[]) || []);
    } catch (error: unknown) {
      console.error("Error fetching bank providers:", error);
      toast.error("Failed to load bank providers");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (hasFetchedRef.current) return;
    hasFetchedRef.current = true;
    fetchProviders();
  }, [fetchProviders]);

  const updateProvider = async (id: string, data: BankProviderUpdateData) => {
    try {
      setIsSaving(true);
      const { error } = await supabase
        .from("platform_bank_providers")
        .update({
          ...data,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id);

      if (error) throw error;
      
      toast.success("Bank provider updated successfully");
      await fetchProviders();
    } catch (error: unknown) {
      console.error("Error updating bank provider:", error);
      toast.error("Failed to update bank provider");
      throw error;
    } finally {
      setIsSaving(false);
    }
  };

  const toggleProvider = async (id: string, isEnabled: boolean) => {
    try {
      setIsSaving(true);
      const { error } = await supabase
        .from("platform_bank_providers")
        .update({ is_enabled: isEnabled, updated_at: new Date().toISOString() })
        .eq("id", id);

      if (error) throw error;
      
      toast.success(`Bank provider ${isEnabled ? "enabled" : "disabled"}`);
      await fetchProviders();
    } catch (error: unknown) {
      console.error("Error toggling bank provider:", error);
      toast.error("Failed to toggle bank provider");
    } finally {
      setIsSaving(false);
    }
  };

  const testConnection = async (providerId: string): Promise<boolean> => {
    try {
      // Call edge function to test the bank connection
      const { data, error } = await supabase.functions.invoke("provider-test", {
        body: { kind: "bank", provider_id: providerId },
      });

      if (error) throw error;
      
      if (data?.success) {
        toast.success("Connection test successful!");
        return true;
      } else {
        toast.error(data?.message || "Connection test failed");
        return false;
      }
    } catch (error: unknown) {
      console.error("Error testing bank connection:", error);
      toast.error("Failed to test connection");
      return false;
    }
  };

  return {
    providers,
    isLoading,
    isSaving,
    fetchProviders,
    updateProvider,
    toggleProvider,
    testConnection,
  };
}
