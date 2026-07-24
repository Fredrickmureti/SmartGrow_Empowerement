/**
 * useLegalRecipients — Phase 1 client seam for the enterprise
 * Legal Recipient master-data aggregate.
 *
 * A "recipient" is a court, agency, creditor, bank, SACCO, or other
 * third party that receives money on behalf of an employee via a legal
 * order. This is the single vendor identity across all garnishments —
 * one row per (org, contact, type, jurisdiction), enforced by a unique
 * index in the database. Do NOT round-trip recipient identity through
 * the legacy `payee_*` snapshot columns; those are kept only for API
 * backward compatibility.
 *
 * The hook reads through the base table (RLS-scoped) rather than the
 * `legal_orders` view because callers here need writeable recipient
 * rows, not the joined legal-order projection.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";

export interface LegalRecipientType {
  id: string;
  organization_id: string | null;
  code: string;
  label: string;
  description: string | null;
  is_government: boolean;
  default_always_first: boolean;
  default_cap_exempt: boolean;
  default_statement_cadence:
    | "per_payment" | "monthly" | "quarterly" | "annual" | "on_request" | null;
  is_active: boolean;
}

export interface LegalRecipient {
  id: string;
  organization_id: string;
  contact_id: string | null;
  recipient_type_code: string;
  authority_id: string | null;
  display_name: string;
  jurisdiction_country: string | null;
  jurisdiction_region: string | null;
  tax_id: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  address: string | null;
  default_payee_bank: string | null;
  default_payee_account: string | null;
  default_payee_reference_template: string | null;
  default_payment_method_id: string | null;
  remittance_schedule_ref: string | null;
  statement_cadence:
    | "per_payment" | "monthly" | "quarterly" | "annual" | "on_request" | null;
  always_first: boolean;
  aggregate_cap_exempt: boolean;
  is_active: boolean;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

const RECIPIENTS_KEY = ["legal-recipients"] as const;
const TYPES_KEY = ["legal-recipient-types"] as const;

export function useLegalRecipientTypes() {
  return useQuery<LegalRecipientType[]>({
    queryKey: TYPES_KEY,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("legal_recipient_types")
        .select("*")
        .eq("is_active", true)
        .order("label", { ascending: true });
      if (error) throw error;
      return (data ?? []) as LegalRecipientType[];
    },
    staleTime: 5 * 60 * 1000,
  });
}

export function useLegalRecipients(opts: { includeInactive?: boolean } = {}) {
  const { currentOrg } = useOrganization();
  const orgId = currentOrg?.id ?? null;
  return useQuery<LegalRecipient[]>({
    queryKey: [...RECIPIENTS_KEY, orgId, !!opts.includeInactive],
    enabled: !!orgId,
    queryFn: async () => {
      let q = (supabase as any)
        .from("legal_recipients")
        .select("*")
        .eq("organization_id", orgId!)
        .order("display_name", { ascending: true });
      if (!opts.includeInactive) q = q.eq("is_active", true);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as LegalRecipient[];
    },
  });
}

type CreateRecipientInput = Omit<
  LegalRecipient,
  "id" | "organization_id" | "created_at" | "updated_at" | "is_active" | "metadata"
> & { is_active?: boolean };

export function useCreateLegalRecipient() {
  const qc = useQueryClient();
  const { currentOrg } = useOrganization();
  return useMutation({
    mutationFn: async (input: CreateRecipientInput) => {
      if (!currentOrg?.id) throw new Error("No organization selected");
      const { data, error } = await (supabase as any)
        .from("legal_recipients")
        .insert({ ...input, organization_id: currentOrg.id })
        .select()
        .single();
      if (error) throw error;
      return data as LegalRecipient;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: RECIPIENTS_KEY });
      toast.success("Recipient created");
    },
    onError: (e: any) => toast.error(e?.message ?? "Failed to create recipient"),
  });
}

export function useUpdateLegalRecipient() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { id: string; patch: Partial<LegalRecipient> }) => {
      const { data, error } = await (supabase as any)
        .from("legal_recipients")
        .update(args.patch)
        .eq("id", args.id)
        .select()
        .single();
      if (error) throw error;
      return data as LegalRecipient;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: RECIPIENTS_KEY });
      toast.success("Recipient updated");
    },
    onError: (e: any) => toast.error(e?.message ?? "Failed to update recipient"),
  });
}

/**
 * Merge a duplicate recipient into a surviving one. All legal orders
 * on the source move to the target atomically inside the RPC; source is
 * soft-deleted (is_active=false, metadata.merged_into set).
 */
export function useMergeLegalRecipients() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { sourceId: string; targetId: string }) => {
      const { data, error } = await (supabase as any).rpc("legal_recipient_merge", {
        p_source_id: args.sourceId,
        p_target_id: args.targetId,
      });
      if (error) throw error;
      return data as {
        source_id: string;
        target_id: string;
        orders_moved: number;
        source_deactivated: boolean;
      };
    },
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: RECIPIENTS_KEY });
      qc.invalidateQueries({ queryKey: ["legal-orders"] });
      qc.invalidateQueries({ queryKey: ["garnishments"] });
      toast.success(`Merged: ${res.orders_moved} order(s) moved`);
    },
    onError: (e: any) => toast.error(e?.message ?? "Merge failed"),
  });
}

// ═══════════════════════════════════════════════════════════════════════
// Phase 3 — Financial continuity: outstanding balances & statements.
// Reads only. Writers stay in the payroll payment builder.
// ═══════════════════════════════════════════════════════════════════════

export interface LegalRecipientOutstanding {
  recipient_id: string;
  organization_id: string;
  display_name: string;
  recipient_type_code: string;
  contact_id: string | null;
  jurisdiction_country: string | null;
  jurisdiction_region: string | null;
  is_active: boolean;
  accrued_total: number;
  paid_total: number;
  outstanding_balance: number;
  oldest_accrual_date: string | null;
  latest_accrual_date: string | null;
  last_remittance_date: string | null;
  employee_count: number;
  order_count: number;
  is_linked_to_contact: boolean;
}

export function useLegalRecipientOutstanding() {
  const { currentOrg } = useOrganization();
  const orgId = currentOrg?.id ?? null;
  return useQuery<LegalRecipientOutstanding[]>({
    queryKey: ["legal-recipient-outstanding", orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("legal_recipient_outstanding")
        .select("*")
        .eq("organization_id", orgId!)
        .order("outstanding_balance", { ascending: false });
      if (error) throw error;
      return (data ?? []) as LegalRecipientOutstanding[];
    },
  });
}

export interface LegalRecipientStatementRow {
  entry_date: string;
  entry_kind: "accrual" | "remittance";
  garnishment_id: string;
  employee_id: string;
  amount: number;
  reference: string | null;
  payroll_run_id: string | null;
  payment_id: string | null;
}

export function useLegalRecipientStatement(args: {
  recipientId: string | null;
  from: string;
  to: string;
}) {
  return useQuery<LegalRecipientStatementRow[]>({
    queryKey: ["legal-recipient-statement", args.recipientId, args.from, args.to],
    enabled: !!args.recipientId,
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc("legal_recipient_statement", {
        p_recipient_id: args.recipientId!,
        p_from: args.from,
        p_to: args.to,
      });
      if (error) throw error;
      return (data ?? []) as LegalRecipientStatementRow[];
    },
  });
}

