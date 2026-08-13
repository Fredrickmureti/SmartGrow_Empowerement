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

/* ------------------------------------------------------------------ *
 * Portfolio lenses — lifecycle and exhaustion states derived from the
 * canonical row. No second source of truth: expiry comes from
 * `end_date`, exhaustion from committed vs. ceiling (never received).
 * ------------------------------------------------------------------ */

export type ContractLifecycleLens =
  | "all"
  | "active"
  | "pending_approval"
  | "expiring_30"
  | "expiring_60"
  | "expiring_90"
  | "exhausted"
  | "expired";

/** Whole days until `end_date`; null when the contract has no end. */
export function daysToExpiry(row: Pick<ContractRow, "end_date">): number | null {
  if (!row.end_date) return null;
  const end = new Date(`${row.end_date}T00:00:00Z`).getTime();
  const today = new Date();
  const start = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((end - start) / 86_400_000);
}

/** Committed / ceiling as a percentage; null when no value ceiling is set. */
export function exhaustionPercent(
  row: Pick<ContractRow, "ceiling_value" | "committed_value">,
): number | null {
  const ceiling = Number(row.ceiling_value ?? 0);
  if (!ceiling) return null;
  return (Number(row.committed_value ?? 0) / ceiling) * 100;
}

const LIVE_STATES = new Set(["active", "suspended"]);

export function matchesLens(row: ContractRow, lens: ContractLifecycleLens): boolean {
  if (lens === "all") return true;
  if (lens === "active") return row.status === "active";
  if (lens === "pending_approval") return row.status === "pending_approval";
  if (lens === "expired") return row.status === "expired";
  if (lens === "exhausted") {
    const pct = exhaustionPercent(row);
    return LIVE_STATES.has(row.status) && pct != null && pct >= 90;
  }
  const window = lens === "expiring_30" ? 30 : lens === "expiring_60" ? 60 : 90;
  const days = daysToExpiry(row);
  return LIVE_STATES.has(row.status) && days != null && days >= 0 && days <= window;
}

export interface ContractPortfolioKpis {
  active: number;
  pendingApproval: number;
  expiring30: number;
  expiring60: number;
  expiring90: number;
  exhausted: number;
  expired: number;
  committedValue: number;
  ceilingValue: number;
}

export function portfolioKpis(rows: ContractRow[]): ContractPortfolioKpis {
  const kpi: ContractPortfolioKpis = {
    active: 0,
    pendingApproval: 0,
    expiring30: 0,
    expiring60: 0,
    expiring90: 0,
    exhausted: 0,
    expired: 0,
    committedValue: 0,
    ceilingValue: 0,
  };
  for (const r of rows) {
    if (matchesLens(r, "active")) kpi.active += 1;
    if (matchesLens(r, "pending_approval")) kpi.pendingApproval += 1;
    if (matchesLens(r, "expiring_30")) kpi.expiring30 += 1;
    if (matchesLens(r, "expiring_60")) kpi.expiring60 += 1;
    if (matchesLens(r, "expiring_90")) kpi.expiring90 += 1;
    if (matchesLens(r, "exhausted")) kpi.exhausted += 1;
    if (matchesLens(r, "expired")) kpi.expired += 1;
    if (LIVE_STATES.has(r.status)) {
      kpi.committedValue += Number(r.committed_value ?? 0);
      kpi.ceilingValue += Number(r.ceiling_value ?? 0);
    }
  }
  return kpi;
}

/**
 * Off-contract leakage — purchase orders raised on a supplier that holds a
 * live contract, but issued without citing one. Measured over the trailing
 * window on non-draft orders, because a draft has not yet committed spend.
 */
export interface ContractLeakage {
  orderCount: number;
  value: number;
  supplierCount: number;
  windowDays: number;
}

export function useContractLeakage(
  contractedSupplierIds: string[],
  windowDays = 90,
): { leakage: ContractLeakage; loading: boolean } {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const [leakage, setLeakage] = useState<ContractLeakage>({
    orderCount: 0,
    value: 0,
    supplierCount: 0,
    windowDays,
  });
  const [loading, setLoading] = useState(false);
  const key = contractedSupplierIds.slice().sort().join(",");

  useEffect(() => {
    let cancelled = false;
    const ids = key ? key.split(",") : [];
    if (!currentOrg || !currentBusiness || ids.length === 0) {
      setLeakage({ orderCount: 0, value: 0, supplierCount: 0, windowDays });
      return;
    }
    const since = new Date(Date.now() - windowDays * 86_400_000)
      .toISOString()
      .slice(0, 10);
    setLoading(true);
    (async () => {
      const { data } = await (supabase as any)
        .from("purchase_orders")
        .select("id, supplier_id, total, order_date, status, contract_id")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .in("supplier_id", ids)
        .is("contract_id", null)
        .gte("order_date", since)
        .not("status", "in", "(draft,cancelled)")
        .limit(1000);
      if (cancelled) return;
      const orders = (data ?? []) as { supplier_id: string; total: number | null }[];
      setLeakage({
        orderCount: orders.length,
        value: orders.reduce((sum, o) => sum + Number(o.total ?? 0), 0),
        supplierCount: new Set(orders.map((o) => o.supplier_id)).size,
        windowDays,
      });
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [currentOrg?.id, currentBusiness?.id, key, windowDays]);

  return { leakage, loading };
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
