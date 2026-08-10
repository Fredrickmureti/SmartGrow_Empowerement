/**
 * Purchase requisition hooks — P3-UI (Requisitions Workbench).
 *
 * Reads canonical `purchase_requisitions`. Because `requester_id` and
 * `actor_user_id` reference `auth.users` (not `public.profiles`) there
 * is no PostgREST-embeddable FK; we hydrate profiles in a follow-up
 * query. State transitions go exclusively through the lifecycle RPCs
 * in `requisitionRpcs.ts`.
 */
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/contexts/BusinessContext";

export type RequisitionStatus =
  | "draft"
  | "submitted"
  | "approved"
  | "rejected"
  | "sourcing"
  | "partially_procured"
  | "procured"
  | "ordered"
  | "partially_fulfilled"
  | "fulfilled"
  | "cancelled"
  | "closed";

export type RequisitionPriority = "low" | "normal" | "high" | "urgent";

export interface RequisitionRow {
  id: string;
  organization_id: string;
  business_id: string;
  branch_id: string | null;
  requisition_number: string;
  requester_id: string;
  cost_center: string | null;
  analytic_account_id: string | null;
  project_id: string | null;
  destination_branch_id: string | null;
  destination_warehouse_id: string | null;
  need_by_date: string | null;
  justification: string | null;
  status: RequisitionStatus | string;
  priority: RequisitionPriority | string;
  currency: string;
  estimated_total: number;
  version: number;
  approval_request_id: string | null;
  submitted_by: string | null;
  submitted_at: string | null;
  approved_by: string | null;
  approved_at: string | null;
  rejected_by: string | null;
  rejected_at: string | null;
  rejected_reason: string | null;
  cancelled_at: string | null;
  closed_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  requester?: { id: string; full_name: string | null; email: string | null } | null;
  item_count?: number;
  /** Lines still carrying demand nobody has ordered (or short-closed) yet. */
  open_line_count?: number;
  /** Σ(quantity − ordered − short-closed) across the lines. */
  outstanding_quantity?: number;
  /** Σ ordered, Σ received — the procurement/fulfilment progress pair. */
  ordered_quantity?: number;
  received_quantity?: number;
}

type ProfileLite = { id: string; full_name: string | null; email: string | null };

async function hydrateProfiles(userIds: string[]): Promise<Map<string, ProfileLite>> {
  const map = new Map<string, ProfileLite>();
  const ids = Array.from(new Set(userIds.filter(Boolean)));
  if (ids.length === 0) return map;
  const { data } = await (supabase as any)
    .from("profiles")
    .select("id, full_name, email")
    .in("id", ids);
  for (const p of (data ?? []) as ProfileLite[]) map.set(p.id, p);
  return map;
}

export function useRequisitions() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const [rows, setRows] = useState<RequisitionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchRows = useCallback(async () => {
    if (!currentOrg || !currentBusiness) {
      setRows([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const { data, error: err } = await (supabase as any)
      .from("purchase_requisitions")
      .select(
        "*, items:purchase_requisition_items(id, quantity, quantity_ordered, quantity_received, quantity_cancelled)",
      )
      .eq("organization_id", currentOrg.id)
      .eq("business_id", currentBusiness.id)
      .order("updated_at", { ascending: false });
    if (err) {
      setError(err.message);
      setLoading(false);
      return;
    }
    const base = (data ?? []) as any[];
    const profiles = await hydrateProfiles(base.map((r) => r.requester_id));
    setRows(
      base.map((r) => {
        const items: any[] = Array.isArray(r.items) ? r.items : [];
        // Outstanding demand mirrors the server rule in `_pr_recalc`:
        // qty − ordered − short-closed, floored at zero per line.
        let outstanding = 0;
        let ordered = 0;
        let received = 0;
        let openLines = 0;
        for (const i of items) {
          const rest = Math.max(
            0,
            Number(i.quantity ?? 0) -
              Number(i.quantity_ordered ?? 0) -
              Number(i.quantity_cancelled ?? 0),
          );
          if (rest > 0) openLines += 1;
          outstanding += rest;
          ordered += Number(i.quantity_ordered ?? 0);
          received += Number(i.quantity_received ?? 0);
        }
        return {
          ...r,
          item_count: items.length,
          open_line_count: openLines,
          outstanding_quantity: outstanding,
          ordered_quantity: ordered,
          received_quantity: received,
          requester: profiles.get(r.requester_id) ?? null,
        };
      }) as RequisitionRow[],
    );
    setLoading(false);
  }, [currentOrg?.id, currentBusiness?.id]);

  useEffect(() => {
    fetchRows();
  }, [fetchRows]);

  return { rows, loading, error, refresh: fetchRows };
}

export interface RequisitionItem {
  id: string;
  requisition_id: string;
  product_id: string | null;
  description: string;
  uom_id: string | null;
  quantity: number;
  estimated_unit_price: number;
  estimated_line_total: number | null;
  need_by_date: string | null;
  suggested_supplier_id: string | null;
  contract_line_id: string | null;
  destination_branch_id: string | null;
  destination_warehouse_id: string | null;
  quantity_ordered: number;
  quantity_received: number;
  quantity_cancelled: number;
  is_non_catalog: boolean;
  status: string;
  purchase_order_item_id: string | null;
  sort_order: number;
  notes: string | null;
}

export interface RequisitionApproval {
  id: string;
  requisition_id: string;
  step_order: number;
  actor_user_id: string;
  decision: string;
  comment: string | null;
  created_at: string;
  actor?: ProfileLite | null;
}

/** Sourcing / ordering documents that consumed this requisition's lines. */
export interface RequisitionProcurementLink {
  id: string;
  number: string;
  status: string;
  kind: "rfq" | "purchase_order";
  lines: number;
  quantity: number;
  path: string;
}

export interface RequisitionRecord extends RequisitionRow {
  items: RequisitionItem[];
  approvals: RequisitionApproval[];
  procurement: RequisitionProcurementLink[];
  suggested_suppliers: Array<{
    id: string;
    supplier_code: string | null;
    contact?: { id: string; name: string } | null;
  }>;
}

export function useRequisitionRecord(id: string | undefined) {
  const [record, setRecord] = useState<RequisitionRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchRecord = useCallback(async () => {
    if (!id) {
      setRecord(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const { data: core, error: e1 } = await (supabase as any)
        .from("purchase_requisitions")
        .select("*")
        .eq("id", id)
        .maybeSingle();
      if (e1) throw e1;
      if (!core) {
        setRecord(null);
        setLoading(false);
        return;
      }

      const [itemsRes, apprRes] = await Promise.all([
        (supabase as any)
          .from("purchase_requisition_items")
          .select("*")
          .eq("requisition_id", id)
          .order("sort_order"),
        (supabase as any)
          .from("purchase_requisition_approvals")
          .select("*")
          .eq("requisition_id", id)
          .order("step_order"),
      ]);

      const items = (itemsRes.data ?? []) as RequisitionItem[];
      const approvals = (apprRes.data ?? []) as RequisitionApproval[];

      const supplierIds = Array.from(
        new Set(
          items
            .map((i) => i.suggested_supplier_id)
            .filter((x): x is string => !!x),
        ),
      );
      let suppliers: RequisitionRecord["suggested_suppliers"] = [];
      if (supplierIds.length > 0) {
        const { data: supData } = await (supabase as any)
          .from("suppliers")
          .select("id, supplier_code, contact:contacts(id, name)")
          .in("id", supplierIds);
        suppliers = (supData ?? []) as any;
      }

      // Downstream traceability: which RFQs / POs consumed these lines.
      const itemIds = items.map((i) => i.id);
      const procurement: RequisitionProcurementLink[] = [];
      if (itemIds.length > 0) {
        const [rfqRes, poRes] = await Promise.all([
          (supabase as any)
            .from("rfq_items")
            .select("quantity, rfq:rfqs(id, rfq_number, status)")
            .in("requisition_item_id", itemIds),
          (supabase as any)
            .from("purchase_order_items")
            .select("quantity, purchase_order:purchase_orders(id, po_number, status)")
            .in("requisition_item_id", itemIds),
        ]);
        const roll = new Map<string, RequisitionProcurementLink>();
        for (const r of (rfqRes.data ?? []) as any[]) {
          if (!r.rfq) continue;
          const prev = roll.get(r.rfq.id);
          roll.set(r.rfq.id, {
            id: r.rfq.id,
            number: r.rfq.rfq_number,
            status: r.rfq.status,
            kind: "rfq",
            lines: (prev?.lines ?? 0) + 1,
            quantity: (prev?.quantity ?? 0) + Number(r.quantity ?? 0),
            path: `/purchases/rfqs/${r.rfq.id}`,
          });
        }
        for (const p of (poRes.data ?? []) as any[]) {
          const po = p.purchase_order;
          if (!po) continue;
          const prev = roll.get(po.id);
          roll.set(po.id, {
            id: po.id,
            number: po.po_number,
            status: po.status,
            kind: "purchase_order",
            lines: (prev?.lines ?? 0) + 1,
            quantity: (prev?.quantity ?? 0) + Number(p.quantity ?? 0),
            path: `/purchases/orders/${po.id}`,
          });
        }
        procurement.push(...roll.values());
      }

      const profiles = await hydrateProfiles([
        (core as any).requester_id,
        ...approvals.map((a) => a.actor_user_id),
      ]);

      setRecord({
        ...(core as RequisitionRow),
        requester: profiles.get((core as any).requester_id) ?? null,
        items,
        procurement,
        approvals: approvals.map((a) => ({
          ...a,
          actor: profiles.get(a.actor_user_id) ?? null,
        })),
        suggested_suppliers: suppliers,
      });
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchRecord();
  }, [fetchRecord]);

  return { record, loading, error, refresh: fetchRecord };
}
