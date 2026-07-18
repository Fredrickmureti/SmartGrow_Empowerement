/**
 * Procurement contracts hooks — P2-UI (Contracts Workbench).
 *
 * Reads canonical `procurement_contracts` with supplier + line rollups.
 * `utilized_value` / `utilized_quantity` are maintained by the
 * `tg_purchase_order_contract_ceiling` trigger; the UI just displays them.
 */
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/contexts/BusinessContext";

export type ContractStatus =
  | "draft"
  | "pending_approval"
  | "active"
  | "expired"
  | "terminated"
  | "suspended";

export type ContractKind =
  | "master"
  | "blanket"
  | "framework"
  | "spot"
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
  start_date: string | null;
  end_date: string | null;
  ceiling_value: number | null;
  utilized_value: number | null;
  auto_renew: boolean;
  notes: string | null;
  approved_at: string | null;
  terminated_at: string | null;
  terminated_reason: string | null;
  created_at: string;
  updated_at: string;
  supplier?: {
    id: string;
    supplier_code: string | null;
    contact?: { id: string; name: string } | null;
  } | null;
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
  unit_price: number | null;
  min_quantity: number | null;
  max_quantity: number | null;
  ceiling_quantity: number | null;
  ceiling_value: number | null;
  utilized_quantity: number | null;
  utilized_value: number | null;
  sort_order: number | null;
}

export interface ContractRelease {
  id: string;
  contract_id: string;
  contract_line_id: string | null;
  purchase_order_id: string | null;
  purchase_order_item_id: string | null;
  quantity: number | null;
  value: number | null;
  released_at: string;
  released_by: string | null;
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

      const [linesRes, releasesRes] = await Promise.all([
        (supabase as any)
          .from("procurement_contract_lines")
          .select("*")
          .eq("contract_id", id)
          .order("sort_order", { ascending: true }),
        (supabase as any)
          .from("procurement_contract_releases")
          .select(
            "*, purchase_order:purchase_orders(id, order_number, status)",
          )
          .eq("contract_id", id)
          .order("released_at", { ascending: false })
          .limit(200),
      ]);

      setRecord({
        ...(core as ContractRow),
        lines: (linesRes.data ?? []) as ContractLine[],
        releases: (releasesRes.data ?? []) as any,
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
