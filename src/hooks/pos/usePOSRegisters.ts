import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranch } from "@/contexts/BranchContext";
import { usePOSOverseer } from "@/hooks/pos/usePOSOverseer";
import { toast } from "sonner";
import { Json } from "@/integrations/supabase/types";
import { normalizeError } from "@/services/resilience";

export interface POSRegister {
  id: string;
  organization_id: string;
  business_id: string;
  branch_id: string;
  register_name: string;
  register_code: string;
  is_active: boolean;
  last_active_at: string | null;
  default_payment_methods: Json;
  receipt_header: string | null;
  receipt_footer: string | null;
  settings: Json;
  created_at: string;
  updated_at: string;
  branch?: {
    id: string;
    name: string;
  } | null;
}

export interface CreateRegisterData {
  register_name: string;
  register_code: string;
  branch_id: string;
  default_payment_methods?: string[];
  receipt_header?: string;
  receipt_footer?: string;
  settings?: Record<string, unknown>;
}

export function usePOSRegisters() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  // Branch isolation (Stage B): when a branch is active, registers belonging
  // to other branches must NOT be returned. HQ / no-branch context falls back
  // to company-wide visibility for overseers; downstream UI is responsible
  // for blocking mutations from that mode.
  const { currentBranch } = useBranch();
  const { canOversee } = usePOSOverseer();
  const queryClient = useQueryClient();

  const { data: registers = [], isLoading } = useQuery({
    queryKey: ["pos-registers", currentOrg?.id, currentBusiness?.id, currentBranch?.id ?? null, canOversee],
    queryFn: async () => {
      // Hard gate: never fall back to org-only — that would leak sister-company
      // registers into the active POS view.
      if (!currentOrg?.id || !currentBusiness?.id) return [];
      // Stage B4: company-wide visibility is reserved for overseers (owner /
      // admin / super_admin). Everyone else in a no-branch context sees
      // nothing instead of leaking foreign-branch registers.
      if (!currentBranch?.id && !canOversee) return [];

      let query = supabase
        .from("pos_registers")
        .select(`
          *,
          branch:branches(id, name)
        `)
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id);

      if (currentBranch?.id) {
        query = query.eq("branch_id", currentBranch.id);
      }

      const { data, error } = await query.order("register_name");

      if (error) throw error;
      return data as POSRegister[];
    },
    enabled: !!currentOrg?.id && !!currentBusiness?.id,
  });

  const createRegister = useMutation({
    mutationFn: async (data: CreateRegisterData) => {
      if (!currentOrg?.id) throw new Error("No organization selected");
      if (!currentBusiness?.id) throw new Error("No company selected — registers belong to a Company");
      if (!data.branch_id) throw new Error("A branch is required for every POS register");

      const { data: result, error } = await supabase
        .from("pos_registers")
        .insert({
          organization_id: currentOrg.id,
          business_id: currentBusiness.id,
          register_name: data.register_name,
          register_code: data.register_code,
          branch_id: data.branch_id,
          default_payment_methods: (data.default_payment_methods || ["cash", "card"]) as unknown as Json,
          receipt_header: data.receipt_header || null,
          receipt_footer: data.receipt_footer || null,
          settings: (data.settings || {}) as unknown as Json,
        })
        .select()
        .single();

      if (error) throw error;
      return result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-registers"] });
      toast.success("Register created successfully");
    },
    onError: (error: Error) => {
      toast.error(`Failed to create register: ${normalizeError(error).message}`);
    },
  });

  const updateRegister = useMutation({
    mutationFn: async ({ id, branch, ...data }: Partial<POSRegister> & { id: string }) => {
      // Remove branch from update data as it's a join field
      const updateData = { ...data };
      
      const { data: result, error } = await supabase
        .from("pos_registers")
        .update(updateData)
        .eq("id", id)
        .select()
        .single();

      if (error) throw error;
      return result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-registers"] });
      toast.success("Register updated successfully");
    },
    onError: (error: Error) => {
      toast.error(`Failed to update register: ${normalizeError(error).message}`);
    },
  });

  const deleteRegister = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("pos_registers")
        .delete()
        .eq("id", id);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-registers"] });
      toast.success("Register deleted successfully");
    },
    onError: (error: Error) => {
      toast.error(`Failed to delete register: ${normalizeError(error).message}`);
    },
  });

  const activeRegisters = registers.filter((r) => r.is_active);

  return {
    registers,
    activeRegisters,
    isLoading,
    createRegister,
    updateRegister,
    deleteRegister,
  };
}
