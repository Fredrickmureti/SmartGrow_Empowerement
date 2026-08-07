/**
 * useReversalRegister — reads `public.reversal_register` (ADR 0129, Phase 5.4).
 *
 * The view is the single cross-module reporting surface for reversals. It is a
 * security-invoker view, so RLS on the underlying documents still applies and
 * this hook needs no extra scoping beyond the organization/business filters the
 * operator chose.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface ReversalRegisterEntry {
  organization_id: string;
  business_id: string | null;
  branch_id: string | null;
  module: string;
  document_type: string;
  document_id: string;
  document_number: string | null;
  document_date: string | null;
  reversal_date: string | null;
  amount: number | null;
  currency: string | null;
  reason_code: string | null;
  reason_comment: string | null;
  reversed_by: string | null;
  reversal_kind: string | null;
  action_key: string;
  approval_request_id: string | null;
  approval_status: string | null;
}

export interface ReversalRegisterFilters {
  organizationId?: string | null;
  businessId?: string | null;
  /** Inclusive ISO date bounds on `reversal_date`. */
  from?: string | null;
  to?: string | null;
  module?: string | null;
  documentType?: string | null;
  reasonCode?: string | null;
}

export function useReversalRegister(filters: ReversalRegisterFilters) {
  const {
    organizationId,
    businessId,
    from,
    to,
    module,
    documentType,
    reasonCode,
  } = filters;

  const query = useQuery({
    queryKey: [
      "reversal-register",
      organizationId,
      businessId,
      from,
      to,
      module,
      documentType,
      reasonCode,
    ],
    enabled: !!organizationId,
    queryFn: async (): Promise<ReversalRegisterEntry[]> => {
      let q = supabase
        .from("reversal_register" as any)
        .select("*")
        .eq("organization_id", organizationId!)
        .order("reversal_date", { ascending: false })
        .limit(1000);

      if (businessId) q = q.eq("business_id", businessId);
      if (from) q = q.gte("reversal_date", from);
      if (to) q = q.lte("reversal_date", `${to}T23:59:59.999Z`);
      if (module) q = q.eq("module", module);
      if (documentType) q = q.eq("document_type", documentType);
      if (reasonCode) q = q.eq("reason_code", reasonCode);

      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as ReversalRegisterEntry[];
    },
  });

  return {
    entries: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error as Error | null,
    refetch: query.refetch,
  };
}
