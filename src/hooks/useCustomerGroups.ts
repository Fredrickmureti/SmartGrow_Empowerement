import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useToast } from "./use-toast";
import { useAuditLog } from "./useAuditLog";
import { normalizeError } from "@/services/resilience";

export interface CustomerGroup {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  discount_percent: number;
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export function useCustomerGroups() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { toast } = useToast();
  const { logAction } = useAuditLog();
  const [customerGroups, setCustomerGroups] = useState<CustomerGroup[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchCustomerGroups = useCallback(async () => {
    if (!currentOrg || !currentBusiness) return;

    setIsLoading(true);
    try {
      const { data, error } = await supabase
        .from("customer_groups")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .order("sort_order", { ascending: true });

      if (error) throw error;
      setCustomerGroups(data as CustomerGroup[]);
    } catch (error: any) {
      console.error("Error fetching customer groups:", error);
      // Silently fail if table doesn't exist yet
      if (!error.message.includes("does not exist")) {
        toast({
          title: "Error loading customer groups",
          description: normalizeError(error).message,
          variant: "destructive",
        });
      }
    } finally {
      setIsLoading(false);
    }
  }, [currentOrg?.id, currentBusiness?.id, toast]);

  useEffect(() => {
    fetchCustomerGroups();
  }, [fetchCustomerGroups]);

  const createCustomerGroup = async (
    group: Pick<CustomerGroup, "name"> & Partial<Omit<CustomerGroup, "id" | "organization_id" | "created_at" | "updated_at" | "name">>
  ) => {
    if (!currentOrg) throw new Error("No organization selected");
    if (!currentBusiness) throw new Error("Select a company before creating customer groups");

    const { data, error } = await supabase
      .from("customer_groups")
      .insert({
        ...group,
        organization_id: currentOrg.id,
        business_id: currentBusiness.id,
      })
      .select()
      .single();

    if (error) throw error;

    logAction({
      action: "created",
      entityType: "customer_group",
      entityId: data.id,
      entityName: group.name,
      changesSummary: `Created customer group: ${group.name}`,
    });

    setCustomerGroups((prev) => [...prev, data as CustomerGroup]);
    return data;
  };

  const updateCustomerGroup = async (id: string, updates: Partial<CustomerGroup>) => {
    const group = customerGroups.find((g) => g.id === id);

    // Optimistic update
    setCustomerGroups((prev) =>
      prev.map((g) => (g.id === id ? { ...g, ...updates } : g))
    );

    try {
      const { error } = await supabase
        .from("customer_groups")
        .update(updates)
        .eq("id", id);

      if (error) throw error;

      if (group) {
        logAction({
          action: "updated",
          entityType: "customer_group",
          entityId: id,
          entityName: group.name,
          changesSummary: `Updated customer group: ${group.name}`,
        });
      }
    } catch (error) {
      // Rollback on error
      if (group) {
        setCustomerGroups((prev) =>
          prev.map((g) => (g.id === id ? group : g))
        );
      }
      throw error;
    }
  };

  const deleteCustomerGroup = async (id: string) => {
    const group = customerGroups.find((g) => g.id === id);

    // Optimistic update
    setCustomerGroups((prev) => prev.filter((g) => g.id !== id));

    try {
      const { error } = await supabase
        .from("customer_groups")
        .delete()
        .eq("id", id);

      if (error) throw error;

      if (group) {
        logAction({
          action: "deleted",
          entityType: "customer_group",
          entityId: id,
          entityName: group.name,
          changesSummary: `Deleted customer group: ${group.name}`,
        });
      }
    } catch (error) {
      // Rollback on error
      if (group) {
        setCustomerGroups((prev) => [...prev, group]);
      }
      throw error;
    }
  };

  return {
    customerGroups,
    activeGroups: customerGroups.filter((g) => g.is_active),
    isLoading,
    createCustomerGroup,
    updateCustomerGroup,
    deleteCustomerGroup,
    refreshCustomerGroups: fetchCustomerGroups,
  };
}
