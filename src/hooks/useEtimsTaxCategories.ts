import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useToast } from "./use-toast";
import { normalizeError } from "@/services/resilience";

export interface EtimsTaxCategory {
  id: string;
  organization_id: string;
  code: string;
  name: string;
  rate: number;
  description: string | null;
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export type EtimsTaxCategoryInput = Omit<
  EtimsTaxCategory,
  "id" | "organization_id" | "created_at" | "updated_at"
>;

export function useEtimsTaxCategories() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const queryKey = ["etims-tax-categories", currentOrg?.id];

  const { data: categories, isLoading } = useQuery({
    queryKey,
    queryFn: async () => {
      if (!currentOrg) return [];

      const { data, error } = await supabase
        .from("etims_tax_categories")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .order("sort_order", { ascending: true });

      if (error) {
        console.error("Error fetching eTIMS tax categories:", error);
        throw error;
      }

      return data as EtimsTaxCategory[];
    },
    enabled: !!currentOrg,
  });

  const createCategory = useMutation({
    mutationFn: async (input: EtimsTaxCategoryInput) => {
      if (!currentOrg) throw new Error("No organization selected");

      const { data, error } = await supabase
        .from("etims_tax_categories")
        .insert({
          ...input,
          organization_id: currentOrg.id,
        business_id: currentBusiness.id,
        })
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      toast({ title: "eTIMS tax category created" });
    },
    onError: (error: Error) => {
      toast({
        title: "Error creating category",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    },
  });

  const updateCategory = useMutation({
    mutationFn: async ({
      id,
      ...updates
    }: Partial<EtimsTaxCategory> & { id: string }) => {
      const { data, error } = await supabase
        .from("etims_tax_categories")
        .update(updates)
        .eq("id", id)
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      toast({ title: "eTIMS tax category updated" });
    },
    onError: (error: Error) => {
      toast({
        title: "Error updating category",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    },
  });

  const deleteCategory = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("etims_tax_categories")
        .delete()
        .eq("id", id);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      toast({ title: "eTIMS tax category deleted" });
    },
    onError: (error: Error) => {
      toast({
        title: "Error deleting category",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    },
  });

  // Initialize default categories for a new organization
  const initializeDefaults = useMutation({
    mutationFn: async () => {
      if (!currentOrg) throw new Error("No organization selected");

      const defaults = [
        { code: "A", name: "VAT 16%", rate: 16, description: "Standard VAT rate for taxable goods and services", sort_order: 1 },
        { code: "B", name: "VAT 0%", rate: 0, description: "Zero-rated supplies (exports, basic food, etc.)", sort_order: 2 },
        { code: "C", name: "Exempt", rate: 0, description: "VAT exempt supplies (education, health, etc.)", sort_order: 3 },
        { code: "D", name: "VAT 8%", rate: 8, description: "Reduced rate for petroleum products", sort_order: 4 },
        { code: "E", name: "Tourism Levy", rate: 2, description: "Tourism levy on applicable services", sort_order: 5 },
      ];

      const { data, error } = await supabase
        .from("etims_tax_categories")
        .insert(
          defaults.map((d) => ({
            ...d,
            organization_id: currentOrg.id,
        business_id: currentBusiness.id,
            is_active: true,
          }))
        )
        .select();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      toast({ title: "Default eTIMS categories initialized" });
    },
    onError: (error: Error) => {
      toast({
        title: "Error initializing defaults",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    },
  });

  // Helper to get category by code
  const getCategoryByCode = (code: string): EtimsTaxCategory | undefined => {
    return categories?.find((c) => c.code === code);
  };

  // Get label for display
  const getCategoryLabel = (code: string): string => {
    const category = getCategoryByCode(code);
    return category ? `${category.code} - ${category.name} (${category.rate}%)` : code;
  };

  return {
    categories: categories || [],
    activeCategories: (categories || []).filter((c) => c.is_active),
    isLoading,
    createCategory: createCategory.mutate,
    updateCategory: updateCategory.mutate,
    deleteCategory: deleteCategory.mutate,
    initializeDefaults: initializeDefaults.mutate,
    isCreating: createCategory.isPending,
    isUpdating: updateCategory.isPending,
    isDeleting: deleteCategory.isPending,
    getCategoryByCode,
    getCategoryLabel,
  };
}
