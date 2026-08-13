/**
 * Landed cost data hooks.
 *
 * Reads the canonical voucher model (`landed_cost_vouchers` + components +
 * scope + allocations). Nothing here mutates a voucher past `draft`: state
 * transitions live in `landedCostRpcs.ts`.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";

export type LandedCostStatus =
  | "draft"
  | "pending_approval"
  | "allocated"
  | "posted"
  | "reversed"
  | "cancelled";

export type LandedCostBasis = "value" | "quantity" | "weight" | "volume" | "manual";

export interface LandedCostVoucherRow {
  id: string;
  organization_id: string;
  business_id: string;
  voucher_number: string | null;
  status: LandedCostStatus | string;
  voucher_date: string;
  posting_date: string | null;
  shipment_reference: string | null;
  vendor_id: string | null;
  source_bill_id: string | null;
  currency: string;
  exchange_rate: number;
  exchange_rate_date: string | null;
  default_basis: LandedCostBasis | string;
  total_amount: number;
  total_base_amount: number;
  capitalized_amount: number;
  expensed_amount: number;
  journal_entry_id: string | null;
  reversal_journal_entry_id: string | null;
  reversal_reason: string | null;
  reversed_at: string | null;
  posted_at: string | null;
  allocated_at: string | null;
  approval_request_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface LandedCostComponentRow {
  id: string;
  voucher_id: string;
  component_type_id: string | null;
  description: string | null;
  basis: LandedCostBasis | string;
  amount: number;
  base_amount: number;
  is_capitalizable: boolean;
  expense_account_id: string | null;
  sort_order: number;
  component_type?: { id: string; name: string; code: string } | null;
}

export interface LandedCostComponentType {
  id: string;
  code: string;
  name: string;
  description: string | null;
  default_basis: LandedCostBasis | string;
  is_capitalizable: boolean;
  is_active: boolean;
  sort_order: number;
  expense_account_id: string | null;
}

export interface LandedCostScopeRow {
  id: string;
  goods_receipt_id: string;
  goods_receipt?: {
    id: string;
    receipt_number: string;
    receipt_date: string;
    status: string;
    purchase_order_id: string | null;
  } | null;
}

export interface LandedCostAllocationRow {
  id: string;
  component_id: string;
  goods_receipt_id: string;
  goods_receipt_item_id: string;
  product_id: string | null;
  basis: string;
  basis_value: number;
  allocation_ratio: number;
  allocated_amount: number;
  capitalized_amount: number;
  expensed_amount: number;
  is_manual: boolean;
  product?: { id: string; name: string; sku: string | null } | null;
  goods_receipt?: { id: string; receipt_number: string } | null;
}

const VOUCHER_COLUMNS =
  "id, organization_id, business_id, voucher_number, status, voucher_date, posting_date, shipment_reference, vendor_id, source_bill_id, currency, exchange_rate, exchange_rate_date, default_basis, total_amount, total_base_amount, capitalized_amount, expensed_amount, journal_entry_id, reversal_journal_entry_id, reversal_reason, reversed_at, posted_at, allocated_at, approval_request_id, notes, created_at, updated_at";

/* ------------------------------------------------------------------ *
 * List
 * ------------------------------------------------------------------ */

export function useLandedCostVouchers() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const [rows, setRows] = useState<LandedCostVoucherRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchRows = useCallback(async () => {
    if (!currentOrg?.id || !currentBusiness?.id) {
      setRows([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const { data, error: err } = await supabase
      .from("landed_cost_vouchers")
      .select(VOUCHER_COLUMNS)
      .eq("organization_id", currentOrg.id)
      .eq("business_id", currentBusiness.id)
      .order("voucher_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(500);
    if (err) setError(err.message);
    else setRows((data ?? []) as LandedCostVoucherRow[]);
    setLoading(false);
  }, [currentOrg?.id, currentBusiness?.id]);

  useEffect(() => {
    void fetchRows();
  }, [fetchRows]);

  return { rows, loading, error, refresh: fetchRows };
}

export interface LandedCostKpis {
  drafts: number;
  awaitingPosting: number;
  posted: number;
  unpostedValue: number;
  capitalizedValue: number;
  expensedValue: number;
}

export function landedCostKpis(rows: LandedCostVoucherRow[]): LandedCostKpis {
  const kpi: LandedCostKpis = {
    drafts: 0,
    awaitingPosting: 0,
    posted: 0,
    unpostedValue: 0,
    capitalizedValue: 0,
    expensedValue: 0,
  };
  for (const r of rows) {
    if (r.status === "draft" || r.status === "pending_approval") kpi.drafts += 1;
    if (r.status === "allocated") {
      kpi.awaitingPosting += 1;
      kpi.unpostedValue += Number(r.total_base_amount ?? 0);
    }
    if (r.status === "draft") kpi.unpostedValue += Number(r.total_base_amount ?? 0);
    if (r.status === "posted") {
      kpi.posted += 1;
      kpi.capitalizedValue += Number(r.capitalized_amount ?? 0);
      kpi.expensedValue += Number(r.expensed_amount ?? 0);
    }
  }
  return kpi;
}

/* ------------------------------------------------------------------ *
 * Record
 * ------------------------------------------------------------------ */

export interface LandedCostRecord {
  voucher: LandedCostVoucherRow;
  components: LandedCostComponentRow[];
  scope: LandedCostScopeRow[];
  allocations: LandedCostAllocationRow[];
}

export function useLandedCostRecord(id: string | null | undefined) {
  const [record, setRecord] = useState<LandedCostRecord | null>(null);
  const [loading, setLoading] = useState(!!id);
  const [error, setError] = useState<string | null>(null);

  const fetchRecord = useCallback(async () => {
    if (!id) {
      setRecord(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);

    const { data: voucher, error: vErr } = await supabase
      .from("landed_cost_vouchers")
      .select(VOUCHER_COLUMNS)
      .eq("id", id)
      .maybeSingle();

    if (vErr) {
      setError(vErr.message);
      setLoading(false);
      return;
    }
    if (!voucher) {
      setRecord(null);
      setLoading(false);
      return;
    }

    const [components, scope, allocations] = await Promise.all([
      supabase
        .from("landed_cost_components")
        .select(
          "id, voucher_id, component_type_id, description, basis, amount, base_amount, is_capitalizable, expense_account_id, sort_order, component_type:landed_cost_component_types(id, name, code)",
        )
        .eq("voucher_id", id)
        .order("sort_order", { ascending: true }),
      supabase
        .from("landed_cost_voucher_receipts")
        .select(
          "id, goods_receipt_id, goods_receipt:goods_receipts(id, receipt_number, receipt_date, status, purchase_order_id)",
        )
        .eq("voucher_id", id),
      supabase
        .from("landed_cost_allocations")
        .select(
          "id, component_id, goods_receipt_id, goods_receipt_item_id, product_id, basis, basis_value, allocation_ratio, allocated_amount, capitalized_amount, expensed_amount, is_manual, product:products(id, name, sku), goods_receipt:goods_receipts(id, receipt_number)",
        )
        .eq("voucher_id", id),
    ]);

    setRecord({
      voucher: voucher as LandedCostVoucherRow,
      components: (components.data ?? []) as unknown as LandedCostComponentRow[],
      scope: (scope.data ?? []) as unknown as LandedCostScopeRow[],
      allocations: (allocations.data ?? []) as unknown as LandedCostAllocationRow[],
    });
    setLoading(false);
  }, [id]);

  useEffect(() => {
    void fetchRecord();
  }, [fetchRecord]);

  return { record, loading, error, refresh: fetchRecord };
}

/* ------------------------------------------------------------------ *
 * Catalogs used by the create surface
 * ------------------------------------------------------------------ */

export function useLandedCostComponentTypes() {
  const { currentBusiness } = useBusinesses();
  const [types, setTypes] = useState<LandedCostComponentType[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!currentBusiness?.id) {
        setTypes([]);
        setLoading(false);
        return;
      }
      setLoading(true);
      const { data } = await supabase
        .from("landed_cost_component_types")
        .select(
          "id, code, name, description, default_basis, is_capitalizable, is_active, sort_order, expense_account_id",
        )
        .eq("business_id", currentBusiness.id)
        .eq("is_active", true)
        .order("sort_order", { ascending: true });
      if (!cancelled) {
        setTypes((data ?? []) as LandedCostComponentType[]);
        setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [currentBusiness?.id]);

  return { types, loading };
}

export interface ReceiptOption {
  id: string;
  receipt_number: string;
  receipt_date: string;
  status: string;
  purchase_order_id: string | null;
  purchase_order?: { id: string; po_number: string | null } | null;
}

/** Completed goods receipts are the only valid landed-cost targets. */
export function useCompletedGoodsReceipts(search: string) {
  const { currentBusiness } = useBusinesses();
  const [receipts, setReceipts] = useState<ReceiptOption[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!currentBusiness?.id) {
        setReceipts([]);
        setLoading(false);
        return;
      }
      setLoading(true);
      const { data } = await supabase
        .from("goods_receipts")
        .select(
          "id, receipt_number, receipt_date, status, purchase_order_id, purchase_order:purchase_orders(id, po_number)",
        )
        .eq("business_id", currentBusiness.id)
        .eq("status", "completed")
        .order("receipt_date", { ascending: false })
        .limit(200);
      if (!cancelled) {
        setReceipts((data ?? []) as unknown as ReceiptOption[]);
        setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [currentBusiness?.id]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return receipts;
    return receipts.filter(
      (r) =>
        r.receipt_number.toLowerCase().includes(q) ||
        (r.purchase_order?.po_number ?? "").toLowerCase().includes(q),
    );
  }, [receipts, search]);

  return { receipts: filtered, loading };
}
