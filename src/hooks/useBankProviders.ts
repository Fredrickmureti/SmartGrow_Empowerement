import { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import type { Json } from "@/integrations/supabase/types";
import { usePlatformAdmin } from "./usePlatformAdmin";

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
  const { isPlatformAdmin, isChecking: adminLoading } = usePlatformAdmin();
  
  // Prevent refetching on tab focus
  const hasFetchedRef = useRef(false);
  const lastAdminStatusRef = useRef<boolean | null>(null);

  const fetchProviders = useCallback(async () => {
    try {
      setIsLoading(true);
      
      if (isPlatformAdmin) {
        // Platform admins get full access to all providers (including disabled ones)
        const { data, error } = await supabase
          .from("platform_bank_providers")
          .select("*")
          .order("provider_name");

        if (error) throw error;
        setProviders((data as BankProvider[]) || []);
      } else {
        // Regular users query enabled providers from the base table
        // RLS policy restricts them to only see enabled providers
        const { data, error } = await supabase
          .from("platform_bank_providers")
          .select("id, provider_code, provider_name, description, logo_url, is_enabled, is_sandbox, supported_countries, created_at, updated_at")
          .order("provider_name");

        if (error) throw error;
        
        // Map to full provider interface (missing fields will be null)
        const mappedProviders = ((data as BankProviderPublic[]) || []).map((p) => ({
          ...p,
          api_base_url: null,
          api_key_encrypted: null,
          api_secret_encrypted: null,
          merchant_code: null,
          public_key: null,
          private_key_encrypted: null,
          config: null,
        } as BankProvider));
        
        setProviders(mappedProviders);
      }
    } catch (error: unknown) {
      console.error("Error fetching bank providers:", error);
      toast.error("Failed to load bank providers");
    } finally {
      setIsLoading(false);
    }
  }, [isPlatformAdmin]);

  useEffect(() => {
    // Wait for admin check to complete before fetching
    if (adminLoading) return;
    
    // Only fetch if admin status changed or we haven't fetched yet
    if (lastAdminStatusRef.current !== isPlatformAdmin || !hasFetchedRef.current) {
      lastAdminStatusRef.current = isPlatformAdmin;
      hasFetchedRef.current = true;
      fetchProviders();
    }
  }, [isPlatformAdmin, adminLoading, fetchProviders]);

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
