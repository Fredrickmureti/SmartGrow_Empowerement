import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { toast } from "sonner";

export interface POSEtimsSettings {
  etims_enabled: boolean;
  etims_auto_transmit: boolean;
  customer_tin_required: boolean;
}

const DEFAULT_ETIMS_SETTINGS: POSEtimsSettings = {
  etims_enabled: false,
  etims_auto_transmit: true,
  customer_tin_required: false,
};

export function usePOSEtims(registerId?: string) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const queryClient = useQueryClient();
  const organizationId = currentOrg?.id;
  const businessId = currentBusiness?.id;

  // Fetch eTIMS settings from pos_settings table
  const { data: etimsSettings, isLoading } = useQuery({
    queryKey: ["pos-etims-settings", organizationId, registerId],
    queryFn: async () => {
      if (!organizationId || !businessId) return DEFAULT_ETIMS_SETTINGS;

      // First check if eTIMS is enabled at org level
      const { data: orgConfig } = await supabase
        .from("tax_compliance_configs")
        .select("is_active")
        .eq("organization_id", organizationId)
        .eq("business_id", businessId)
        .eq("provider", "kra_etims")
        .maybeSingle();

      // If no eTIMS config exists at org level, return disabled
      if (!orgConfig?.is_active) {
        return { ...DEFAULT_ETIMS_SETTINGS, etims_enabled: false };
      }

      // Fetch POS-specific eTIMS settings
      let query = supabase
        .from("pos_settings")
        .select("setting_key, setting_value")
        .eq("organization_id", organizationId)
        .eq("business_id", businessId)
        .in("setting_key", ["etims_enabled", "etims_auto_transmit", "customer_tin_required"]);

      if (registerId) {
        query = query.or(`register_id.eq.${registerId},register_id.is.null`);
      } else {
        query = query.is("register_id", null);
      }

      const { data, error } = await query;
      if (error) {
        console.error("Error fetching eTIMS settings:", error);
        return DEFAULT_ETIMS_SETTINGS;
      }

      const settings: POSEtimsSettings = { ...DEFAULT_ETIMS_SETTINGS };
      data?.forEach((setting) => {
        if (setting.setting_key === "etims_enabled") {
          settings.etims_enabled = setting.setting_value === true || setting.setting_value === "true";
        }
        if (setting.setting_key === "etims_auto_transmit") {
          settings.etims_auto_transmit = setting.setting_value === true || setting.setting_value === "true";
        }
        if (setting.setting_key === "customer_tin_required") {
          settings.customer_tin_required = setting.setting_value === true || setting.setting_value === "true";
        }
      });

      return settings;
    },
    enabled: !!organizationId && !!businessId,
  });

  // Update eTIMS settings
  const updateEtimsSettings = useMutation({
    mutationFn: async (newSettings: Partial<POSEtimsSettings>) => {
      if (!organizationId) throw new Error("No organization");
      if (!businessId) throw new Error("Select a Company before configuring eTIMS settings");

      const updates = Object.entries(newSettings).map(async ([key, value]) => {
        let query = supabase
          .from("pos_settings")
          .select("id")
          .eq("organization_id", organizationId)
          .eq("business_id", businessId)
          .eq("setting_key", key);
        
        if (registerId) {
          query = query.eq("register_id", registerId);
        } else {
          query = query.is("register_id", null);
        }
        
        const { data: existing } = await query.maybeSingle();

        if (existing) {
          return supabase
            .from("pos_settings")
            .update({ 
              setting_value: value as boolean,
              updated_at: new Date().toISOString()
            })
            .eq("id", existing.id);
        } else {
          return supabase
            .from("pos_settings")
            .insert({
              organization_id: organizationId,
              business_id: businessId,
              register_id: registerId || null,
              setting_key: key,
              setting_value: value,
            });
        }
      });

      await Promise.all(updates);
      return newSettings;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-etims-settings"] });
      toast.success("eTIMS settings saved");
    },
    onError: (error) => {
      toast.error("Failed to save eTIMS settings");
      console.error(error);
    },
  });

  // Transmit POS transaction to eTIMS
  const transmitToEtims = useMutation({
    mutationFn: async (params: {
      transactionId: string;
      transactionNumber: string;
      customerTin?: string;
      customerName?: string;
      items: Array<{
        product_id: string;
        name: string;
        quantity: number;
        unit_price: number;
        tax_amount: number;
        line_total: number;
      }>;
      subtotal: number;
      taxAmount: number;
      discountAmount: number;
      total: number;
    }) => {
      if (!organizationId) throw new Error("No organization");

      const { data, error } = await supabase.functions.invoke("etims-transmit", {
        body: {
          doc_type: "pos",
          organizationId,
          transactionId: params.transactionId,
          transactionNumber: params.transactionNumber,
          customerTin: params.customerTin,
          customerName: params.customerName,
          items: params.items,
          subtotal: params.subtotal,
          taxAmount: params.taxAmount,
          discountAmount: params.discountAmount,
          total: params.total,
        },
      });

      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      if (data?.success) {
        toast.success("Transaction transmitted to KRA eTIMS");
      }
    },
    onError: (error) => {
      console.error("eTIMS transmission error:", error);
      // Don't show error toast - we'll queue for retry
    },
  });

  // Retry failed eTIMS transmission
  const retryEtimsTransmission = useMutation({
    mutationFn: async (transactionId: string) => {
      // Fetch the transaction details
      const { data: transaction, error } = await supabase
        .from("pos_transactions")
        .select(`
          *,
          items:pos_transaction_items(*)
        `)
        .eq("id", transactionId)
        .single();

      if (error || !transaction) throw new Error("Transaction not found");

      // Re-transmit
      return transmitToEtims.mutateAsync({
        transactionId: transaction.id,
        transactionNumber: transaction.transaction_number,
        customerTin: (transaction as any).customer_tin,
        customerName: (transaction as any).customer_name,
        items: (transaction as any).items.map((item: any) => ({
          product_id: item.product_id,
          name: item.description,
          quantity: item.quantity,
          unit_price: item.unit_price,
          tax_amount: item.tax_amount || 0,
          line_total: item.line_total,
        })),
        subtotal: transaction.subtotal,
        taxAmount: transaction.tax_amount,
        discountAmount: transaction.discount_amount,
        total: transaction.total,
      });
    },
  });

  return {
    etimsSettings: etimsSettings || DEFAULT_ETIMS_SETTINGS,
    isLoading,
    updateEtimsSettings,
    transmitToEtims,
    retryEtimsTransmission,
    isEtimsEnabled: etimsSettings?.etims_enabled ?? false,
  };
}
