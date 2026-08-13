/**
 * Procurement contracts hooks — Contracts Workbench.
 *
 * Reads canonical `procurement_contracts` with supplier, line, version,
 * amendment and consumption-ledger rollups. All utilization measures
 * (committed / received / billed / paid) are derived server-side from the
 * append-only `procurement_contract_releases` ledger; the UI only displays them.
 */
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/contexts/BusinessContext";

export type ContractStatus =
  | "draft"
  | "pending_approval"
  | "active"
  | "suspended"
  | "expired"
  | "terminated"
  | "closed";

export type ContractKind =
  | "master"
  | "framework"
  | "blanket"
  | "rate"
  | "volume"
  | "service"
  | "consignment";

export interface ContractRow {
  id: string;
  organization_id: string;
  business_id: string;
  supplier_id: string;
  contract_number: string;
  title: string;
  kind: ContractKind | string;
  status: ContractStatus | string;
  currency: string | null;
  base_currency: string | null;
  exchange_rate: number | null;
  exchange_rate_date: string | null;
  start_date: string | null;
  end_date: string | null;
  ceiling_value: number | null;
  committed_value: number | null;
  received_value: number | null;
  billed_value: number | null;
  paid_value: number | null;
  current_version: number | null;
  price_tolerance_percent: number | null;
  price_tolerance_amount: number | null;
  enforce_item_coverage: boolean | null;
  auto_renew: boolean;
  notes: string | null;
  approval_request_id: string | null;
  submitted_at: string | null;
  approved_at: string | null;
  suspended_at: string | null;
  suspension_reason: string | null;
  terminated_at: string | null;
  terminated_reason: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
  supplier?: {
    id: string;
    supplier_code: string | null;
    contact?: { id: string; name: string } | null;
  } | null;
}

/** Remaining capacity is always ceiling minus *committed*, never minus received. */
export function remainingValue(row: Pick<ContractRow, "ceiling_value" | "committed_value">) {
  if (row.ceiling_value == null) return null;
  return Number(row.ceiling_value) - Number(row.committed_value ?? 0);
}

export function useContracts() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const [rows, setRows] = useState<ContractRow[]>([]);
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
      .from("procurement_contracts")
      .select(
        "*, supplier:suppliers(id, supplier_code, contact:contacts(id, name))",
      )
      .eq("organization_id", currentOrg.id)
      .eq("business_id", currentBusiness.id)
      .order("updated_at", { ascending: false });
    if (err) setError(err.message);
    else setRows((data ?? []) as ContractRow[]);
    setLoading(false);
  }, [currentOrg?.id, currentBusiness?.id]);

  useEffect(() => {
    fetchRows();
  }, [fetchRows]);

  return { rows, loading, error, refresh: fetchRows };
}

export interface ContractLine {
  id: string;
  contract_id: string;
  product_id: string | null;
  description: string | null;
  uom_id: string | null;
  base_uom_id: string | null;
  supplier_sku: string | null;
  unit_price: number | null;
  min_quantity: number | null;
  max_quantity: number | null;
  ceiling_quantity: number | null;
  ceiling_quantity_base: number | null;
  ceiling_value: number | null;
  committed_quantity: number | null;
  committed_quantity_base: number | null;
  committed_value: number | null;
  received_quantity_base: number | null;
  received_value: number | null;
  billed_value: number | null;
  effective_from: string | null;
  effective_to: string | null;
  sort_order: number | null;
}

export type ContractLedgerKind =
  | "commitment"
  | "reversal"
  | "receipt"
  | "billing"
  | "payment";

export interface ContractRelease {
  id: string;
  contract_id: string;
  contract_line_id: string | null;
  purchase_order_id: string | null;
  purchase_order_item_id: string | null;
  entry_kind: ContractLedgerKind | string;
  quantity: number | null;
  quantity_base: number | null;
  value: number | null;
  contract_version: number | null;
  source_doc_type: string | null;
  released_at: string;
  released_by: string | null;
}

export interface ContractVersion {
  id: string;
  contract_id: string;
  version_number: number;
  effective_from: string;
  effective_to: string | null;
  header_snapshot: Record<string, unknown>;
  lines_snapshot: Record<string, unknown>[];
  created_at: string;
}

export interface ContractAmendment {
  id: string;
  contract_id: string;
  amendment_number: number;
  from_version: number;
  to_version: number;
  kind: string;
  effective_on: string;
  reason: string | null;
  changes: Record<string, unknown>;
  created_at: string;
}

export interface ContractRecord extends ContractRow {
  lines: ContractLine[];
  releases: (ContractRelease & {
    purchase_order?: {
      id: string;
      order_number: string | null;
      status: string | null;
    } | null;
  })[];
  versions: ContractVersion[];
  amendments: ContractAmendment[];
}

export function useContractRecord(id: string | undefined) {
  const [record, setRecord] = useState<ContractRecord | null>(null);
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
        .from("procurement_contracts")
        .select(
          "*, supplier:suppliers(id, supplier_code, contact:contacts(id, name, email, phone))",
        )
        .eq("id", id)
        .maybeSingle();
      if (e1) throw e1;
      if (!core) {
        setRecord(null);
        setLoading(false);
        return;
      }

      const [linesRes, releasesRes, versionsRes, amendmentsRes] = await Promise.all([
        (supabase as any)
          .from("procurement_contract_lines")
          .select("*")
          .eq("contract_id", id)
          .order("sort_order", { ascending: true }),
        (supabase as any)
          .from("procurement_contract_releases")
          .select("*, purchase_order:purchase_orders(id, order_number, status)")
          .eq("contract_id", id)
          .order("released_at", { ascending: false })
          .limit(200),
        (supabase as any)
          .from("procurement_contract_versions")
          .select("*")
          .eq("contract_id", id)
          .order("version_number", { ascending: false }),
        (supabase as any)
          .from("procurement_contract_amendments")
          .select("*")
          .eq("contract_id", id)
          .order("amendment_number", { ascending: false }),
      ]);

      setRecord({
        ...(core as ContractRow),
        lines: (linesRes.data ?? []) as ContractLine[],
        releases: (releasesRes.data ?? []) as any,
        versions: (versionsRes.data ?? []) as ContractVersion[],
        amendments: (amendmentsRes.data ?? []) as ContractAmendment[],
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
