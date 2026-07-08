import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";

export type TaxComplianceProvider = "kra_etims" | "ura_efris" | "tza_efd" | "rwa_ebm";

export interface TaxComplianceConfig {
  id: string;
  organization_id: string;
  country_code: string;
  provider: TaxComplianceProvider;
  is_active: boolean;
  is_test_mode: boolean;
  config: {
    tin?: string;
    bhf_id?: string;
    communication_key?: string;
    device_serial?: string;
    server_url?: string;
    [key: string]: any;
  };
  device_serial: string | null;
  last_sync_at: string | null;
  sync_status: string;
  created_at: string;
  updated_at: string;
}

export interface EtimsStandardCode {
  id: string;
  code_type: string;
  code: string;
  name: string;
  name_local: string | null;
  description: string | null;
  parent_code: string | null;
  sort_order: number;
  is_active: boolean;
  fetched_at: string;
}

export interface EtimsTransmissionLog {
  id: string;
  organization_id: string;
  document_type: string;
  document_id: string;
  document_number: string | null;
  api_endpoint: string;
  request_payload: Record<string, any> | null;
  response_payload: Record<string, any> | null;
  response_code: string | null;
  response_message: string | null;
  status: "pending" | "success" | "failed" | "retrying";
  error_message: string | null;
  retry_count: number;
  transmitted_at: string;
  created_at: string;
}

// Countries that support tax compliance integrations
export const SUPPORTED_TAX_COMPLIANCE_COUNTRIES: Record<string, { provider: TaxComplianceProvider; name: string; displayName: string }> = {
  KE: { provider: "kra_etims", name: "Kenya", displayName: "KRA eTIMS" },
  // Future support:
  // UG: { provider: "ura_efris", name: "Uganda", displayName: "URA EFRIS" },
  // TZ: { provider: "tza_efd", name: "Tanzania", displayName: "TRA EFD" },
  // RW: { provider: "rwa_ebm", name: "Rwanda", displayName: "RRA EBM" },
};

export function useTaxCompliance() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { toast } = useToast();
  const [config, setConfig] = useState<TaxComplianceConfig | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isInitializing, setIsInitializing] = useState(false);
  
  // Platform-level settings
  const [isPlatformEtimsEnabled, setIsPlatformEtimsEnabled] = useState(true);
  const [platformEnvironment, setPlatformEnvironment] = useState<"sandbox" | "production">("sandbox");

  // Get the country code from the current business, or fall back to organization country
  const businessCountry = currentBusiness?.country || "";
  const complianceInfo = SUPPORTED_TAX_COMPLIANCE_COUNTRIES[businessCountry];
  const isComplianceAvailable = !!complianceInfo;
  const provider = complianceInfo?.provider;

  // Fetch platform settings
  useEffect(() => {
    const fetchPlatformSettings = async () => {
      try {
        const { data, error } = await supabase
          // SCOPE-EXEMPT: `platform_settings` is workspace-wide (no business_id column)
          .from("platform_settings")
          .select("setting_key, setting_value")
          .in("setting_key", ["etims_enabled", "etims_environment"]);

        if (error) throw error;

        const settings = data || [];
        const enabledSetting = settings.find(s => s.setting_key === "etims_enabled");
        const envSetting = settings.find(s => s.setting_key === "etims_environment");

        setIsPlatformEtimsEnabled(enabledSetting?.setting_value !== "false");
        setPlatformEnvironment((envSetting?.setting_value as "sandbox" | "production") || "sandbox");
      } catch (error) {
        console.error("Error fetching platform eTIMS settings:", error);
      }
    };

    fetchPlatformSettings();
  }, []);

  const fetchConfig = useCallback(async () => {
    if (!currentOrg || !currentBusiness?.id || !provider) {
      setConfig(null);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    try {
      const { data, error } = await supabase
        .from("tax_compliance_configs")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("country_code", businessCountry)
        .eq("provider", provider)
        .maybeSingle();

      if (error) throw error;
      setConfig(data as TaxComplianceConfig | null);
    } catch (error) {
      console.error("Error fetching tax compliance config:", error);
    } finally {
      setIsLoading(false);
    }
  }, [currentOrg, currentBusiness?.id, businessCountry, provider]);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  const saveConfig = async (configData: {
    tin: string;
    bhfId: string;
  }) => {
    if (!currentOrg || !provider) return;

    setIsSaving(true);
    try {
      // Use platform environment setting instead of per-org setting
      const payload = {
        organization_id: currentOrg.id,
        business_id: currentBusiness.id,
        country_code: businessCountry,
        provider,
        is_test_mode: platformEnvironment === "sandbox",
        is_active: false,
        config: {
          tin: configData.tin,
          bhf_id: configData.bhfId,
          communication_key: config?.config?.communication_key || null,
        },
        updated_at: new Date().toISOString(),
      };

      if (config) {
        const { error } = await supabase
          .from("tax_compliance_configs")
          .update(payload)
          .eq("id", config.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("tax_compliance_configs")
          .insert(payload);
        if (error) throw error;
      }

      toast({
        title: "Credentials saved",
        description: `Your KRA credentials have been saved.`,
      });

      await fetchConfig();
    } catch (error: any) {
      toast({
        title: "Error",
        description: normalizeError(error).message || "Failed to save configuration",
        variant: "destructive",
      });
      throw error;
    } finally {
      setIsSaving(false);
    }
  };

  const initializeDevice = async () => {
    if (!currentOrg || !config) return null;

    setIsInitializing(true);
    try {
      const response = await supabase.functions.invoke("etims-transmit", {
        body: {
          action: "init",
          organizationId: currentOrg.id,
          configId: config.id,
        },
      });

      if (response.error) throw response.error;

      if (response.data?.success) {
        toast({
          title: "Device initialized",
          description: "eTIMS device initialized. Syncing standard codes...",
        });
        
        // AUTO-SYNC: Immediately sync standard codes after successful initialization
        // This ensures tax codes, item classifications, and other KRA codes are available
        try {
          const syncResponse = await supabase.functions.invoke("etims-transmit", {
            body: {
              action: "sync_codes",
              organizationId: currentOrg.id,
              configId: config.id,
            },
          });
          
          if (syncResponse.data?.success) {
            toast({
              title: "Codes synchronized",
              description: `${syncResponse.data.totalCodes} eTIMS standard codes synced successfully.`,
            });
          } else {
            console.warn("Auto-sync completed with issues:", syncResponse.data?.errors);
          }
        } catch (syncError) {
          console.error("Auto-sync failed:", syncError);
          toast({
            title: "Warning",
            description: "Device initialized but code sync failed. Please sync codes manually.",
            variant: "destructive",
          });
        }
        
        await fetchConfig();
        return response.data;
      } else {
        throw new Error(response.data?.error || "Device initialization failed");
      }
    } catch (error: any) {
      toast({
        title: "Initialization failed",
        description: normalizeError(error).message || "Failed to initialize eTIMS device",
        variant: "destructive",
      });
      return null;
    } finally {
      setIsInitializing(false);
    }
  };

  const toggleActive = async (isActive: boolean) => {
    if (!config) return;

    try {
      const { error } = await supabase
        .from("tax_compliance_configs")
        .update({ is_active: isActive, updated_at: new Date().toISOString() })
        .eq("id", config.id);

      if (error) throw error;

      toast({
        title: isActive ? "eTIMS enabled" : "eTIMS disabled",
        description: `${complianceInfo?.displayName} has been ${isActive ? "enabled" : "disabled"}.`,
      });

      await fetchConfig();
    } catch (error: any) {
      toast({
        title: "Error",
        description: normalizeError(error).message || "Failed to update status",
        variant: "destructive",
      });
    }
  };

  const syncStandardCodes = async () => {
    if (!currentOrg || !config) return false;

    try {
      const response = await supabase.functions.invoke("etims-transmit", {
        body: {
          action: "sync_codes",
          organizationId: currentOrg.id,
          configId: config.id,
        },
      });

      if (response.error) throw response.error;

      if (response.data?.success) {
        toast({
          title: "Codes synchronized",
          description: "eTIMS standard codes have been updated.",
        });
        await fetchConfig();
        return true;
      } else {
        throw new Error(response.data?.error || "Sync failed");
      }
    } catch (error: any) {
      toast({
        title: "Sync failed",
        description: normalizeError(error).message || "Failed to sync standard codes",
        variant: "destructive",
      });
      return false;
    }
  };

  return {
    config,
    isLoading,
    isSaving,
    isInitializing,
    isComplianceAvailable,
    complianceInfo,
    businessCountry,
    isPlatformEtimsEnabled,
    platformEnvironment,
    saveConfig,
    initializeDevice,
    toggleActive,
    syncStandardCodes,
    refreshConfig: fetchConfig,
  };
}

export function useEtimsStandardCodes(codeType?: string) {
  const [codes, setCodes] = useState<EtimsStandardCode[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const fetchCodes = async () => {
      setIsLoading(true);
      try {
        let query = supabase
          // SCOPE-EXEMPT: `etims_standard_codes` is workspace-wide (no business_id column)
          .from("etims_standard_codes")
          .select("*")
          .eq("is_active", true)
          .order("sort_order", { ascending: true });

        if (codeType) {
          query = query.eq("code_type", codeType);
        }

        const { data, error } = await query;
        if (error) throw error;
        setCodes((data as EtimsStandardCode[]) || []);
      } catch (error) {
        console.error("Error fetching eTIMS codes:", error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchCodes();
  }, [codeType]);

  const getCodesByType = (type: string) => codes.filter((c) => c.code_type === type);
  const getCodeByValue = (type: string, code: string) => 
    codes.find((c) => c.code_type === type && c.code === code);

  return {
    codes,
    isLoading,
    getCodesByType,
    getCodeByValue,
  };
}

export function useEtimsTransmissionLogs(documentType?: string, documentId?: string) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const [logs, setLogs] = useState<EtimsTransmissionLog[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchLogs = useCallback(async () => {
    if (!currentOrg || !currentBusiness?.id) {
      setLogs([]);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    try {
      let query = supabase
        .from("etims_transmission_logs")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .order("transmitted_at", { ascending: false })
        .limit(100);

      if (documentType) {
        query = query.eq("document_type", documentType);
      }
      if (documentId) {
        query = query.eq("document_id", documentId);
      }

      const { data, error } = await query;
      if (error) throw error;
      setLogs((data as EtimsTransmissionLog[]) || []);
    } catch (error) {
      console.error("Error fetching transmission logs:", error);
    } finally {
      setIsLoading(false);
    }
  }, [currentOrg, currentBusiness?.id, documentType, documentId]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  return {
    logs,
    isLoading,
    refreshLogs: fetchLogs,
  };
}

export function useEtimsTransmission() {
  const { currentOrg } = useOrganization();
  const { toast } = useToast();
  const [isTransmitting, setIsTransmitting] = useState(false);

  /**
   * Fiscalization is now event-driven. Invoice/credit-note issuance emits a
   * `fiscal.receipt_required` event via a DB trigger; the FiscalComplianceSaga
   * dispatches to the pack-registered provider adapter with retry, backoff,
   * and circuit breaker. The frontend just requeues on manual retry and
   * observes `fiscal_transmissions` for state.
   */
  const requeueFromSource = async (sourceType: "invoices" | "credit_notes", sourceId: string, label: string) => {
    if (!currentOrg) return null;
    setIsTransmitting(true);
    try {
      const { data: tx } = await supabase
        .from("fiscal_transmissions")
        .select("id")
        .eq("source_doc_type", sourceType)
        .eq("source_doc_id", sourceId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!tx?.id) {
        toast({
          title: "Queued",
          description: `${label} is queued for transmission.`,
        });
        return { queued: true };
      }
      const { error } = await supabase.rpc("fiscal_transmission_resend" as never, { p_transmission_id: tx.id } as never);
      if (error) throw error;
      toast({ title: "Re-queued", description: `${label} re-queued for KRA transmission.` });
      return { requeued: true };
    } catch (error: any) {
      toast({
        title: "Requeue failed",
        description: normalizeError(error).message || "Failed to requeue fiscal transmission",
        variant: "destructive",
      });
      return null;
    } finally {
      setIsTransmitting(false);
    }
  };

  const transmitInvoice = (invoiceId: string) => requeueFromSource("invoices", invoiceId, "Invoice");
  const transmitCreditNote = (creditNoteId: string) => requeueFromSource("credit_notes", creditNoteId, "Credit note");

  const registerItem = async (productId: string) => {
    if (!currentOrg) return null;
    try {
      const response = await supabase.functions.invoke("etims-transmit", {
        body: { action: "register_item", organizationId: currentOrg.id, productId },
      });
      if (response.error) throw response.error;
      if (response.data?.success) {
        toast({ title: "Item registered", description: `Item has been registered with eTIMS.` });
        return response.data;
      }
      throw new Error(response.data?.error || "Registration failed");
    } catch (error: any) {
      toast({
        title: "Registration failed",
        description: normalizeError(error).message || "Failed to register item with eTIMS",
        variant: "destructive",
      });
      return null;
    }
  };

  return {
    isTransmitting,
    transmitInvoice,
    transmitCreditNote,
    registerItem,
  };
}
