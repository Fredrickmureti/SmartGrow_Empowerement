import { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";

export interface PaymentGateway {
  id: string;
  organization_id: string;
  provider: string;
  display_name: string | null;
  publishable_key: string | null;
  is_active: boolean;
  is_test_mode: boolean;
  created_at: string;
  updated_at: string;
}

export function usePaymentGateway() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { toast } = useToast();
  const [gateway, setGateway] = useState<PaymentGateway | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  // Prevent refetching on tab focus
  const lastKeyRef = useRef<string | null>(null);
  const hasFetchedRef = useRef(false);

  const fetchGateway = useCallback(async () => {
    if (!currentOrg || !currentBusiness?.id) return;

    setIsLoading(true);
    try {
      const { data, error } = await supabase
        .from("organization_payment_gateways")
        .select("id, organization_id, provider, display_name, publishable_key, is_active, is_test_mode, created_at, updated_at")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("provider", "stripe")
        .maybeSingle();

      if (error) throw error;
      setGateway(data);
    } catch (error) {
      console.error("Error fetching payment gateway:", error);
    } finally {
      setIsLoading(false);
    }
  }, [currentOrg, currentBusiness?.id]);

  useEffect(() => {
    const key = currentOrg && currentBusiness?.id
      ? `${currentOrg.id}::${currentBusiness.id}`
      : null;

    if (!key) {
      setGateway(null);
      setIsLoading(false);
      lastKeyRef.current = null;
      hasFetchedRef.current = false;
      return;
    }

    if (lastKeyRef.current !== key || !hasFetchedRef.current) {
      lastKeyRef.current = key;
      hasFetchedRef.current = true;
      fetchGateway();
    }
  }, [currentOrg, currentBusiness?.id, fetchGateway]);

  const saveGateway = async (data: {
    publishableKey: string;
    secretKey: string;
    isTestMode: boolean;
    displayName?: string;
  }) => {
    if (!currentOrg) return;
    if (!currentBusiness?.id) {
      toast({
        title: "Select a Company first",
        description: "Payment gateway credentials are bound to a legal entity (Company), not a Workspace.",
        variant: "destructive",
      });
      return;
    }

    setIsSaving(true);
    try {
      // Persist via SECURITY DEFINER RPC that stores the secret in Supabase
      // Vault (vault.secrets) and writes only the vault id back to
      // `organization_payment_gateways.vault_secret_id`. The raw secret
      // never lives in a regular table column. Authorization (owner/admin/
      // super_admin of the org) is enforced inside the function.
      const { error: rpcError } = await (supabase as any).rpc(
        "set_payment_gateway_secret",
        {
          p_organization_id: currentOrg.id,
          p_business_id: currentBusiness.id,
          p_provider: "stripe",
          p_display_name: data.displayName || "Stripe",
          p_publishable_key: data.publishableKey,
          p_secret_key: data.secretKey,
          p_is_test_mode: data.isTestMode,
        },
      );

      if (rpcError) throw rpcError;

      toast({
        title: "Payment gateway saved",
        description: "Your Stripe credentials have been securely stored.",
      });

      await fetchGateway();
    } catch (error: any) {
      toast({
        title: "Error",
        description: normalizeError(error).message || "Failed to save payment gateway",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const toggleActive = async (isActive: boolean) => {
    if (!gateway) return;

    try {
      const { error } = await supabase
        .from("organization_payment_gateways")
        .update({ is_active: isActive, updated_at: new Date().toISOString() })
        .eq("id", gateway.id);

      if (error) throw error;

      toast({
        title: isActive ? "Payment gateway enabled" : "Payment gateway disabled",
        description: isActive
          ? "Customers can now pay invoices online."
          : "Online payments are now disabled.",
      });

      await fetchGateway();
    } catch (error: any) {
      toast({
        title: "Error",
        description: normalizeError(error).message || "Failed to update gateway status",
        variant: "destructive",
      });
    }
  };

  const deleteGateway = async () => {
    if (!gateway) return;

    try {
      // Use the SECURITY DEFINER RPC so the row AND its vault.secrets entry
      // are removed atomically. A direct table .delete() leaves an orphaned
      // vault secret if vault_secret_id is populated.
      const { error } = await (supabase as any).rpc(
        "delete_payment_gateway_secret",
        { p_gateway_id: gateway.id },
      );

      if (error) throw error;

      toast({
        title: "Payment gateway removed",
        description: "Your Stripe credentials have been deleted.",
      });

      setGateway(null);
    } catch (error: any) {
      toast({
        title: "Error",
        description: normalizeError(error).message || "Failed to delete gateway",
        variant: "destructive",
      });
    }
  };

  return {
    gateway,
    isLoading,
    isSaving,
    saveGateway,
    toggleActive,
    deleteGateway,
    refreshGateway: fetchGateway,
  };
}
