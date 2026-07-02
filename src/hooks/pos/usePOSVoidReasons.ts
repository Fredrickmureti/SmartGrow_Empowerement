import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";

export interface POSVoidReason {
  id: string;
  code: string;
  label: string;
  requires_note: boolean;
  sort_order: number;
  is_active: boolean;
}

/**
 * Stage 5: canonical list of POS void reasons. Global table managed by
 * platform_admin / admin (RLS enforced). Reads are open to authenticated
 * users so the void dialog can render the picker for any cashier.
 */
export function usePOSVoidReasons(opts: { includeInactive?: boolean } = {}) {
  const queryClient = useQueryClient();

  const list = useQuery({
    queryKey: ["pos-void-reasons", opts.includeInactive ?? false],
    queryFn: async (): Promise<POSVoidReason[]> => {
      let q = supabase
        .from("pos_void_reasons")
        .select("id, code, label, requires_note, sort_order, is_active")
        .order("sort_order", { ascending: true });
      if (!opts.includeInactive) q = q.eq("is_active", true);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as POSVoidReason[];
    },
    staleTime: 5 * 60 * 1000,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["pos-void-reasons"] });
  };

  const create = useMutation({
    mutationFn: async (input: Omit<POSVoidReason, "id">) => {
      const { data, error } = await supabase
        .from("pos_void_reasons")
        .insert(input)
        .select()
        .single();
      if (error) throw error;
      return data as POSVoidReason;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Void reason created");
    },
    onError: (e: Error) => toast.error(normalizeError(e).message),
  });

  const update = useMutation({
    mutationFn: async (input: Partial<POSVoidReason> & { id: string }) => {
      const { id, ...rest } = input;
      const { error } = await supabase
        .from("pos_void_reasons")
        .update(rest)
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Void reason updated");
    },
    onError: (e: Error) => toast.error(normalizeError(e).message),
  });

  return { ...list, create, update };
}