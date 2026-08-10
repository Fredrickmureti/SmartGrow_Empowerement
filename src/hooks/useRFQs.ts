/**
 * useRFQs — the RFQ (sourcing event) domain client.
 *
 * Architecture contract:
 *  - Every lifecycle transition (submit, approve, release, quote, revise,
 *    award, convert, cancel, expire) goes through a SECURITY DEFINER RPC.
 *    The browser never writes `rfqs.status`, never decides an award and
 *    never builds a purchase order.
 *  - Suppliers are represented by `rfq_invitations`; their offers by the
 *    immutable, versioned `rfq_quotations` + `rfq_quotation_items`.
 *  - Awards (`rfq_awards` + `rfq_award_items`) support split / partial
 *    awards across several suppliers, and each award converts to exactly
 *    one purchase order that carries `rfq_id` + `rfq_award_id` for
 *    reverse traceability.
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranch } from "@/contexts/BranchContext";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";
import { applyBranchFilter } from "@/lib/branchScope";
import { normalizeError } from "@/services/resilience";

const db = supabase as any;

export const RFQ_OPEN_STATUSES = [
  "draft",
  "pending_approval",
  "approved",
  "sent",
  "responses_received",
  "under_evaluation",
] as const;

export const RFQ_TERMINAL_STATUSES = [
  "converted",
  "closed",
  "cancelled",
  "expired",
] as const;

export interface RFQ {
  id: string;
  organization_id: string;
  business_id: string | null;
  branch_id: string | null;
  rfq_number: string;
  status: string;
  version: number;
  currency: string | null;
  deadline: string | null;
  expires_at: string | null;
  required_by_date: string | null;
  deliver_to_warehouse_id: string | null;
  project_id: string | null;
  requisition_id: string | null;
  notes: string | null;
  award_justification: string | null;
  approved_at: string | null;
  released_at: string | null;
  awarded_at: string | null;
  converted_at: string | null;
  submitted_by: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface RFQItem {
  id?: string;
  rfq_id?: string;
  product_id: string | null;
  description: string;
  quantity: number;
  uom_id?: string | null;
  target_price: number | null;
  need_by_date?: string | null;
  requisition_item_id?: string | null;
  sort_order: number;
}

export interface RFQInvitation {
  id: string;
  rfq_id: string;
  rfq_version: number;
  supplier_id: string;
  contact_email: string | null;
  channel: string;
  invitation_state: string;
  delivery_state: string;
  sent_at: string | null;
  response_deadline: string | null;
  reminder_count: number;
  supplier?: { id: string; name: string; email: string | null } | null;
}

export interface RFQQuotationItem {
  id: string;
  quotation_id: string;
  rfq_item_id: string;
  product_id: string | null;
  alternate_product_id: string | null;
  is_alternate: boolean;
  description: string | null;
  quoted_quantity: number;
  quoted_uom_id: string | null;
  unit_price: number;
  discount_percent: number;
  tax_rate: number;
  tax_amount: number;
  line_total: number;
  delivery_date: string | null;
  notes: string | null;
}

export interface RFQQuotation {
  id: string;
  rfq_id: string;
  invitation_id: string;
  supplier_id: string;
  rfq_version: number;
  quotation_version: number;
  state: string;
  currency: string;
  subtotal: number;
  tax_total: number;
  freight_amount: number;
  total: number;
  lead_time_days: number | null;
  incoterms: string | null;
  payment_terms: string | null;
  valid_until: string | null;
  notes: string | null;
  submitted_at: string;
  is_late: boolean;
  items?: RFQQuotationItem[];
  supplier?: { id: string; name: string } | null;
}

export interface RFQAward {
  id: string;
  rfq_id: string;
  supplier_id: string;
  quotation_id: string;
  currency: string;
  awarded_value: number;
  award_reason: string | null;
  purchase_order_id: string | null;
  converted_at: string | null;
  awarded_at: string;
  items?: {
    id: string;
    rfq_item_id: string;
    quotation_item_id: string;
    awarded_quantity: number;
    unit_price: number;
    line_total: number;
  }[];
  supplier?: { id: string; name: string } | null;
}

export type RFQWithRelations = RFQ & {
  items?: RFQItem[];
  invitations?: RFQInvitation[];
  quotations?: RFQQuotation[];
  awards?: RFQAward[];
};

/** Award payload: one entry per winning supplier, each with its own lines. */
export interface AwardInput {
  quotation_id: string;
  reason?: string | null;
  lines: { quotation_item_id: string; awarded_quantity: number }[];
}

export const RFQ_SELECT = [
  "*",
  "items:rfq_items(*)",
  "invitations:rfq_invitations(*, supplier:contacts!supplier_id(id, name, email))",
  "quotations:rfq_quotations(*, items:rfq_quotation_items(*), supplier:contacts!supplier_id(id, name))",
  "awards:rfq_awards(*, items:rfq_award_items(*), supplier:contacts!supplier_id(id, name))",
].join(",");

/** Estimated value uses the buyer's internal target price — never supplier-facing. */
export function rfqEstimatedValue(rfq: Pick<RFQWithRelations, "items">) {
  return (rfq.items ?? []).reduce(
    (sum, i) => sum + (i.target_price ?? 0) * (i.quantity ?? 0),
    0,
  );
}

/** Awarded value is the authoritative commercial number once an award exists. */
export function rfqAwardedValue(rfq: Pick<RFQWithRelations, "awards">) {
  return (rfq.awards ?? []).reduce((sum, a) => sum + (a.awarded_value ?? 0), 0);
}

export function useRFQs() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranch();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const organizationId = currentOrg?.id;
  const businessId = currentBusiness?.id;
  const branchId = currentBranch?.id ?? null;

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["rfqs"] });
    queryClient.invalidateQueries({ queryKey: ["rfq"] });
  };

  const { data: rfqs = [], isLoading } = useQuery({
    queryKey: ["rfqs", organizationId, businessId, branchId],
    queryFn: async () => {
      if (!organizationId || !businessId) return [];

      // Expiry is a server-side derivation persisted on read — no cron job.
      await db.rpc("rfq_expire_due", { _business_id: businessId });

      let q = db
        .from("rfqs")
        .select(RFQ_SELECT)
        .eq("organization_id", organizationId)
        .eq("business_id", businessId)
        .order("created_at", { ascending: false });
      q = applyBranchFilter(q, branchId);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as RFQWithRelations[];
    },
    enabled: !!organizationId && !!businessId,
  });

  const getNextRFQNumber = async (): Promise<string> => {
    if (!organizationId) throw new Error("No organization");
    const { data, error } = await supabase.rpc("get_next_rfq_number", { _org_id: organizationId });
    if (error) throw error;
    return data as unknown as string;
  };

  interface RFQHeaderInput {
    deadline: string | null;
    notes: string | null;
    currency?: string | null;
    required_by_date?: string | null;
    deliver_to_warehouse_id?: string | null;
    project_id?: string | null;
    requisition_id?: string | null;
  }

  const writeLinesAndInvitations = async (
    rfqId: string,
    version: number,
    items: Omit<RFQItem, "id" | "rfq_id">[],
    supplierIds: string[],
  ) => {
    if (items.length > 0) {
      const { error } = await db.from("rfq_items").insert(
        items.map((item, idx) => ({
          rfq_id: rfqId,
          product_id: item.product_id,
          description: item.description,
          quantity: item.quantity,
          uom_id: item.uom_id ?? null,
          target_price: item.target_price,
          need_by_date: item.need_by_date ?? null,
          requisition_item_id: item.requisition_item_id ?? null,
          sort_order: idx,
        })),
      );
      if (error) throw error;
    }

    if (supplierIds.length > 0) {
      const { error } = await db.from("rfq_invitations").insert(
        supplierIds.map((sid) => ({
          rfq_id: rfqId,
          rfq_version: version,
          supplier_id: sid,
          invitation_state: "pending",
          delivery_state: "not_sent",
          created_by: user?.id ?? null,
        })),
      );
      if (error) throw error;
    }
  };

  const createRFQMutation = useMutation({
    mutationFn: async ({
      rfq,
      items,
      vendorIds,
    }: {
      rfq: RFQHeaderInput;
      items: Omit<RFQItem, "id" | "rfq_id">[];
      vendorIds: string[];
    }) => {
      if (!organizationId || !businessId || !user) {
        throw new Error("Missing org, business, or user");
      }

      const rfqNumber = await getNextRFQNumber();
      const { data: created, error } = await db
        .from("rfqs")
        .insert({
          organization_id: organizationId,
          business_id: businessId,
          branch_id: branchId,
          rfq_number: rfqNumber,
          status: "draft",
          version: 1,
          currency: rfq.currency || null,
          deadline: rfq.deadline || null,
          expires_at: rfq.deadline ? `${rfq.deadline}T23:59:59Z` : null,
          required_by_date: rfq.required_by_date || null,
          deliver_to_warehouse_id: rfq.deliver_to_warehouse_id || null,
          project_id: rfq.project_id || null,
          requisition_id: rfq.requisition_id || null,
          notes: rfq.notes || null,
          created_by: user.id,
        })
        .select()
        .single();
      if (error) throw error;

      await writeLinesAndInvitations(created.id, 1, items, vendorIds);
      return created as RFQ;
    },
    onSuccess: () => {
      invalidate();
      toast.success("RFQ created");
    },
    onError: (error: Error) => {
      toast.error(`Failed to create RFQ: ${normalizeError(error).message}`);
    },
  });

  /**
   * Draft-only edit. Once an RFQ is approved or released, changing it is a
   * revision (`rfq_revise`) — never a silent overwrite that would destroy
   * supplier offers.
   */
  const updateRFQMutation = useMutation({
    mutationFn: async ({
      id,
      rfq,
      items,
      vendorIds,
    }: {
      id: string;
      rfq: RFQHeaderInput;
      items: Omit<RFQItem, "id" | "rfq_id">[];
      vendorIds: string[];
    }) => {
      const { data: existing, error: readErr } = await db
        .from("rfqs")
        .select("status, version")
        .eq("id", id)
        .maybeSingle();
      if (readErr) throw readErr;
      if (!existing) throw new Error("RFQ not found");
      if (existing.status !== "draft") {
        throw new Error("Only draft RFQs can be edited — use Revise instead");
      }

      const { error: updErr } = await db
        .from("rfqs")
        .update({
          deadline: rfq.deadline || null,
          expires_at: rfq.deadline ? `${rfq.deadline}T23:59:59Z` : null,
          notes: rfq.notes || null,
          currency: rfq.currency || null,
          required_by_date: rfq.required_by_date || null,
          deliver_to_warehouse_id: rfq.deliver_to_warehouse_id || null,
          project_id: rfq.project_id || null,
          requisition_id: rfq.requisition_id || null,
        })
        .eq("id", id);
      if (updErr) throw updErr;

      await db.from("rfq_items").delete().eq("rfq_id", id);
      await db.from("rfq_invitations").delete().eq("rfq_id", id).eq("rfq_version", existing.version);
      await writeLinesAndInvitations(id, existing.version, items, vendorIds);
      return { id };
    },
    onSuccess: () => {
      invalidate();
      toast.success("RFQ updated");
    },
    onError: (error: Error) => {
      toast.error(`Failed to update RFQ: ${normalizeError(error).message}`);
    },
  });

  /** Thin wrapper: every lifecycle move is one RPC call, one toast. */
  const lifecycle = <TArgs>(
    fn: string,
    args: (input: TArgs) => Record<string, unknown>,
    success: string | ((data: any) => string),
  ) =>
    useMutation({
      mutationFn: async (input: TArgs) => {
        const { data, error } = await db.rpc(fn, args(input));
        if (error) throw error;
        return data;
      },
      onSuccess: (data) => {
        invalidate();
        queryClient.invalidateQueries({ queryKey: ["purchase-orders"] });
        toast.success(typeof success === "function" ? success(data) : success);
      },
      onError: (error: Error) => {
        toast.error(normalizeError(error).message);
      },
    });

  const submitMutation = lifecycle<string>(
    "rfq_submit_for_approval",
    (id) => ({ _rfq_id: id }),
    "RFQ submitted for approval",
  );

  const approveMutation = lifecycle<string>(
    "rfq_approve",
    (id) => ({ _rfq_id: id }),
    "RFQ approved",
  );

  const releaseMutation = lifecycle<string>(
    "rfq_release",
    (id) => ({ _rfq_id: id }),
    (d) => `Invitations queued for ${d?.invitations_requested ?? 0} supplier(s)`,
  );

  const reviseMutation = lifecycle<{ id: string; reason: string }>(
    "rfq_revise",
    ({ id, reason }) => ({ _rfq_id: id, _reason: reason }),
    (d) => `RFQ revised to version ${d?.version ?? ""} — suppliers must re-quote`,
  );

  const recordQuotationMutation = lifecycle<{
    invitationId: string;
    header: Record<string, unknown>;
    lines: Record<string, unknown>[];
    allowLate?: boolean;
  }>(
    "rfq_record_quotation",
    ({ invitationId, header, lines, allowLate }) => ({
      _invitation_id: invitationId,
      _header: header,
      _lines: lines,
      _allow_late: allowLate ?? false,
    }),
    "Quotation recorded",
  );

  const withdrawQuotationMutation = lifecycle<{ quotationId: string; reason?: string }>(
    "rfq_withdraw_quotation",
    ({ quotationId, reason }) => ({ _quotation_id: quotationId, _reason: reason ?? null }),
    "Quotation withdrawn",
  );

  const awardMutation = lifecycle<{ rfqId: string; awards: AwardInput[]; justification: string }>(
    "rfq_award",
    ({ rfqId, awards, justification }) => ({
      _rfq_id: rfqId,
      _awards: awards,
      _justification: justification,
    }),
    (d) =>
      d?.fully_awarded ? "RFQ awarded" : "RFQ partially awarded — some lines remain unsourced",
  );

  const convertMutation = lifecycle<string>(
    "rfq_convert_awards_to_po",
    (rfqId) => ({ _rfq_id: rfqId }),
    (d) => {
      const pos = (d?.purchase_orders ?? []) as { po_number: string }[];
      return pos.length
        ? `Created ${pos.length} purchase order(s): ${pos.map((p) => p.po_number).join(", ")}`
        : "Already converted";
    },
  );

  const cancelMutation = lifecycle<{ id: string; reason?: string }>(
    "rfq_cancel",
    ({ id, reason }) => ({ _rfq_id: id, _reason: reason ?? null }),
    "RFQ cancelled",
  );

  const deleteRFQMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await db.from("rfqs").delete().eq("id", id).eq("status", "draft");
      if (error) throw error;
    },
    onSuccess: () => {
      invalidate();
      toast.success("RFQ deleted");
    },
    onError: (error: Error) => {
      toast.error(`Failed to delete: ${normalizeError(error).message}`);
    },
  });

  return {
    rfqs,
    isLoading,

    createRFQ: createRFQMutation.mutate,
    createRFQAsync: createRFQMutation.mutateAsync,
    updateRFQ: updateRFQMutation.mutate,
    updateRFQAsync: updateRFQMutation.mutateAsync,
    deleteRFQ: deleteRFQMutation.mutate,

    submitForApproval: submitMutation.mutate,
    approveRFQ: approveMutation.mutate,
    releaseRFQ: releaseMutation.mutate,
    reviseRFQ: reviseMutation.mutate,
    recordQuotation: recordQuotationMutation.mutate,
    recordQuotationAsync: recordQuotationMutation.mutateAsync,
    withdrawQuotation: withdrawQuotationMutation.mutate,
    awardRFQ: awardMutation.mutate,
    awardRFQAsync: awardMutation.mutateAsync,
    convertToPurchaseOrders: convertMutation.mutate,
    cancelRFQ: cancelMutation.mutate,

    isCreating: createRFQMutation.isPending,
    isUpdating: updateRFQMutation.isPending,
    isAwarding: awardMutation.isPending,
    isConverting: convertMutation.isPending,
  };
}
