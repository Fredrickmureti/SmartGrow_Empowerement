/**
 * Purchase requisition hooks — P3-UI (Requisitions Workbench).
 *
 * Reads canonical `purchase_requisitions` with requester profile and
 * item rollups. State transitions go exclusively through the lifecycle
 * RPCs in `requisitionRpcs.ts`.
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
  | "cancelled"
  | "closed";

export type RequisitionPriority = "low" | "normal" | "high" | "urgent";

export interface RequisitionRow {
  id: string;
  organization_id: string;
  business_id: string;
  requisition_number: string;
  requester_id: string;
  cost_center: string | null;
  need_by_date: string | null;
  justification: string | null;
  status: RequisitionStatus | string;
  priority: RequisitionPriority | string;
  currency: string;
  estimated_total: number;
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
        "*, requester:profiles!purchase_requisitions_requester_id_fkey(id, full_name, email), items:purchase_requisition_items(id)",
      )
      .eq("organization_id", currentOrg.id)
      .eq("business_id", currentBusiness.id)
      .order("updated_at", { ascending: false });
    if (err) setError(err.message);
    else {
      const shaped = (data ?? []).map((r: any) => ({
        ...r,
        item_count: Array.isArray(r.items) ? r.items.length : 0,
      })) as RequisitionRow[];
      setRows(shaped);
    }
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
  actor?: { id: string; full_name: string | null; email: string | null } | null;
}

export interface RequisitionRecord extends RequisitionRow {
  items: RequisitionItem[];
  approvals: RequisitionApproval[];
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
        .select(
          "*, requester:profiles!purchase_requisitions_requester_id_fkey(id, full_name, email)",
        )
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
          .select(
            "*, actor:profiles!purchase_requisition_approvals_actor_user_id_fkey(id, full_name, email)",
          )
          .eq("requisition_id", id)
          .order("step_order"),
      ]);

      const items = (itemsRes.data ?? []) as RequisitionItem[];
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

      setRecord({
        ...(core as RequisitionRow),
        items,
        approvals: (apprRes.data ?? []) as RequisitionApproval[],
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
