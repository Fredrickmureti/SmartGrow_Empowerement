import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useToast } from "./use-toast";
import { normalizeError } from "@/services/resilience";

export type TaxType = "percentage" | "fixed" | "compound_group";

export interface TaxRate {
  id: string;
  organization_id: string;
  business_id: string | null;
  name: string;
  rate: number;
  description: string | null;
  is_compound: boolean;
  is_inclusive: boolean;
  is_default: boolean;
  is_active: boolean;
  etims_tax_code: string | null;
  tax_type: TaxType;
  fixed_amount: number;
  effective_from: string;
  effective_to: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaxGroup {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  is_active: boolean;
  created_at: string;
  items?: TaxGroupItem[];
}

export interface TaxGroupItem {
  id: string;
  tax_group_id: string;
  tax_rate_id: string;
  sort_order: number;
  tax_rate?: TaxRate;
}

export function useTaxRates() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { toast } = useToast();
  const [taxRates, setTaxRates] = useState<TaxRate[]>([]);
  const [taxGroups, setTaxGroups] = useState<TaxGroup[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  
  // Prevent refetching on tab focus
  const lastOrgIdRef = useRef<string | null>(null);
  const lastBusinessIdRef = useRef<string | null>(null);
  const hasFetchedRef = useRef(false);

  const fetchTaxRates = useCallback(async () => {
    if (!currentOrg || !currentBusiness) {
      setTaxRates([]);
      return;
    }

    try {
      const today = new Date().toISOString().split("T")[0];
      const { data, error } = await supabase
        .from("tax_rates")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .lte("effective_from", today)
        .or(`effective_to.is.null,effective_to.gte.${today}`)
        .order("name");

      if (error) throw error;
      setTaxRates((data || []) as unknown as TaxRate[]);
    } catch (error: any) {
      console.error("Error fetching tax rates:", error);
      toast({
        title: "Error loading tax rates",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    }
  }, [currentOrg?.id, currentBusiness?.id, toast]);

  const fetchTaxGroups = useCallback(async () => {
    if (!currentOrg || !currentBusiness) {
      setTaxGroups([]);
      return;
    }

    try {
      const { data, error } = await supabase
        .from("tax_groups")
        .select(`
          *,
          items:tax_group_items(
            *,
            tax_rate:tax_rates!inner(*)
          )
        `)
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .order("name");

      if (error) throw error;

      setTaxGroups((data as unknown as TaxGroup[]) || []);
    } catch (error: any) {
      console.error("Error fetching tax groups:", error);
    }
  }, [currentOrg?.id, currentBusiness?.id]);

  useEffect(() => {
    const orgId = currentOrg?.id ?? null;
    
    if (!currentOrg) {
      setTaxRates([]);
      setTaxGroups([]);
      setIsLoading(false);
      lastOrgIdRef.current = null;
      hasFetchedRef.current = false;
      return;
    }
    
    // Only fetch if org changed or we haven't fetched yet
    if (lastOrgIdRef.current !== orgId || !hasFetchedRef.current) {
      lastOrgIdRef.current = orgId;
      hasFetchedRef.current = true;
      
      const load = async () => {
        setIsLoading(true);
        await Promise.all([fetchTaxRates(), fetchTaxGroups()]);
        setIsLoading(false);
      };
      load();
    }
  }, [currentOrg, fetchTaxRates, fetchTaxGroups]);

  const createTaxRate = async (
    data: Omit<TaxRate, "id" | "organization_id" | "business_id" | "created_at" | "updated_at">
  ) => {
    if (!currentOrg || !currentBusiness) throw new Error("No organization or business selected");

    const { data: created, error } = await supabase
      .from("tax_rates")
      .insert({
        ...data,
        organization_id: currentOrg.id,
        business_id: currentBusiness.id,
      })
      .select()
      .single();

    if (error) throw error;
    await fetchTaxRates();
    return created;
  };

  const updateTaxRate = async (id: string, updates: Partial<TaxRate>) => {
    const { error } = await supabase
      .from("tax_rates")
      .update(updates)
      .eq("id", id);

    if (error) throw error;
    await fetchTaxRates();
  };

  const deleteTaxRate = async (id: string) => {
    const { error } = await supabase.from("tax_rates").delete().eq("id", id);
    if (error) throw error;
    await fetchTaxRates();
  };

  const createTaxGroup = async (
    name: string,
    description: string | null,
    taxRateIds: string[]
  ) => {
    if (!currentOrg) throw new Error("No organization selected");
    if (!currentBusiness) throw new Error("Select a Company before creating a tax group");

    const { data: group, error: groupError } = await supabase
      .from("tax_groups")
      .insert({
        organization_id: currentOrg.id,
        business_id: currentBusiness.id,
        name,
        description,
      })
      .select()
      .single();

    if (groupError) throw groupError;

    // Add tax rates to the group
    if (taxRateIds.length > 0) {
      const items = taxRateIds.map((taxRateId, index) => ({
        tax_group_id: group.id,
        tax_rate_id: taxRateId,
        sort_order: index,
      }));

      const { error: itemsError } = await supabase
        .from("tax_group_items")
        .insert(items);

      if (itemsError) throw itemsError;
    }

    await fetchTaxGroups();
    return group;
  };

  const calculateTax = (
    amount: number,
    taxRateId?: string,
    isInclusive?: boolean,
    quantity?: number
  ): { taxAmount: number; netAmount: number } => {
    if (!taxRateId) return { taxAmount: 0, netAmount: amount };

    const taxRate = taxRates.find((t) => t.id === taxRateId);
    if (!taxRate) return { taxAmount: 0, netAmount: amount };

    const inclusive = isInclusive ?? taxRate.is_inclusive;

    // Fixed amount tax (e.g., excise per unit)
    if (taxRate.tax_type === "fixed") {
      const taxAmount = taxRate.fixed_amount * (quantity ?? 1);
      return { taxAmount, netAmount: amount };
    }

    // Compound group tax — calculate cascading taxes from group items
    if (taxRate.tax_type === "compound_group") {
      const group = taxGroups.find(g => g.name === taxRate.name || g.items?.some(i => i.tax_rate_id === taxRate.id));
      if (group?.items && group.items.length > 0) {
        let runningBase = amount;
        let totalTax = 0;
        for (const item of group.items.sort((a, b) => a.sort_order - b.sort_order)) {
          const childRate = item.tax_rate;
          if (!childRate || !childRate.is_active) continue;
          const childResult = calculateTax(runningBase, childRate.id, false, quantity);
          totalTax += childResult.taxAmount;
          // For compound taxes, each subsequent tax is calculated on base + previous taxes
          if (childRate.is_compound) {
            runningBase += childResult.taxAmount;
          }
        }
        return { taxAmount: totalTax, netAmount: amount };
      }
    }

    // Percentage tax (default)
    const rate = taxRate.rate / 100;
    if (inclusive) {
      const netAmount = amount / (1 + rate);
      const taxAmount = amount - netAmount;
      return { taxAmount, netAmount };
    } else {
      const taxAmount = amount * rate;
      return { taxAmount, netAmount: amount };
    }
  };

  const getDefaultTaxRate = (): TaxRate | undefined => {
    return taxRates.find((t) => t.is_default && t.is_active);
  };

  return {
    taxRates,
    taxGroups,
    activeTaxRates: taxRates.filter((t) => t.is_active),
    isLoading,
    createTaxRate,
    updateTaxRate,
    deleteTaxRate,
    createTaxGroup,
    calculateTax,
    getDefaultTaxRate,
    refreshTaxRates: fetchTaxRates,
  };
}
