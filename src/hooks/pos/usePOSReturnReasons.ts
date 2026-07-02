import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";

export interface POSReturnReason {
  id: string;
  code: string;
  label: string;
  description: string | null;
  requires_note: boolean;
  requires_manager_override: boolean;
  sort_order: number;
  is_active: boolean;
}

/**
 * Stage A: canonical list of POS return reasons. Every return line MUST
 * reference one of these.
 * - `requires_note=true` — cashier must add an explanatory note.
 * - `requires_manager_override=true` — server forces a manager PIN approval
 *   regardless of the refund amount or matrix thresholds.
 * Reads are open to authenticated users so the return dialog can render the
 * picker for any cashier; writes are restricted to platform_admin / admin
 * via RLS.
 */
export function usePOSReturnReasons(opts: { includeInactive?: boolean } = {}) {
  const queryClient = useQueryClient();

  const list = useQuery({
    queryKey: ["pos-return-reasons", opts.includeInactive ?? false],
    queryFn: async (): Promise<POSReturnReason[]> => {
      let q = supabase
        .from("pos_return_reasons" as any)
        .select(
          "id, code, label, description, requires_note, requires_manager_override, sort_order, is_active",
        )
        .order("sort_order", { ascending: true });
      if (!opts.includeInactive) q = q.eq("is_active", true);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as POSReturnReason[];
    },
    staleTime: 5 * 60 * 1000,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["pos-return-reasons"] });
  };

  const create = useMutation({
    mutationFn: async (
      input: Omit<POSReturnReason, "id" | "description"> & { description?: string | null },
    ) => {
      const { data, error } = await supabase
        .from("pos_return_reasons" as any)
        .insert(input as never)
        .select()
        .single();
      if (error) throw error;
      return data as unknown as POSReturnReason;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Return reason created");
    },
    onError: (e: Error) => toast.error(normalizeError(e).message),
  });

  const update = useMutation({
    mutationFn: async (input: Partial<POSReturnReason> & { id: string }) => {
      const { id, ...rest } = input;
      const { error } = await supabase
        .from("pos_return_reasons" as any)
        .update(rest as never)
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Return reason updated");
    },
    onError: (e: Error) => toast.error(normalizeError(e).message),
  });

  return { ...list, create, update };
}
