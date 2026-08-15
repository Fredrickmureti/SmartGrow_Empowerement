/**
 * Phase 9 — atomic, governed estimate writes.
 *
 * Estimates used to be authored by the browser: insert the header, then insert
 * the lines, then (on edit) `delete ... where estimate_id` followed by a fresh
 * insert. A failure between those statements left an estimate whose header
 * still showed totals while its lines were gone, and a double submit minted a
 * second numbered estimate.
 *
 * `create_estimate_atomic` / `update_estimate_atomic` are now the only legal
 * writers — `trg_00_estimate_items_governed_write` and
 * `trg_00_estimate_costs_governed_write` reject direct DML from the client.
 * The browser states what the customer asked for; the server resolves the base
 * quantity through `resolve_line_base_quantity`, recomputes line money and
 * header totals, stamps the exchange rate and the document number, and writes
 * header + lines + additional costs in one transaction. The idempotency key
 * makes a retry return the first estimate instead of a second one.
 */
import { supabase } from "@/integrations/supabase/client";

export interface AtomicEstimateHeader {
  organization_id: string;
  business_id: string;
  branch_id?: string | null;
  /** Pre-allocated number; omit to let the server allocate one. */
  estimate_number?: string | null;
  contact_id?: string | null;
  issue_date?: string | null;
  expiry_date?: string | null;
  notes?: string | null;
  terms?: string | null;
  discount_amount?: number | null;
  currency?: string | null;
  source_lead_id?: string | null;
  template_id?: string | null;
  bill_to_contact_id?: string | null;
  billing_address?: unknown;
}

export interface AtomicEstimateItem {
  product_id?: string | null;
  description?: string | null;
  /** Canonical base quantity, when the caller already holds it. */
  quantity?: number | null;
  /** What the customer actually asked for, in the unit they chose. */
  display_quantity?: number | null;
  display_uom_id?: string | null;
  packaging_id?: string | null;
  unit_price?: number | null;
  discount_percent?: number | null;
  tax_rate?: number | null;
  tax_rate_id?: string | null;
  sort_order?: number | null;
  scope_of_work?: string | null;
  estimated_hours?: number | null;
  hourly_rate?: number | null;
}

export interface AtomicEstimateCost {
  name: string;
  amount: number;
  is_taxable?: boolean | null;
  tax_rate?: number | null;
  sort_order?: number | null;
}

export interface AtomicEstimateResult {
  success: boolean;
  estimate_id: string;
  estimate_number: string;
  subtotal: number;
  tax_amount: number;
  discount_amount: number;
  total: number;
  exchange_rate?: number;
  item_count?: number;
  cost_count?: number;
  idempotent_replay?: boolean;
}

/** A stable per-submission key, so a retry cannot create a second estimate. */
export function newEstimateIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `est-${crypto.randomUUID()}`;
  }
  return `est-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export async function createEstimateAtomic(
  header: AtomicEstimateHeader,
  items: AtomicEstimateItem[],
  costs: AtomicEstimateCost[] = [],
  idempotencyKey?: string,
): Promise<AtomicEstimateResult> {
  const { data, error } = await supabase.rpc("create_estimate_atomic", {
    p_header: header as unknown as never,
    p_items: items as unknown as never,
    p_costs: costs as unknown as never,
    p_idempotency_key: idempotencyKey ?? newEstimateIdempotencyKey(),
  } as never);

  if (error) throw error;

  const result = data as unknown as AtomicEstimateResult | null;
  if (!result?.estimate_id) {
    throw new Error("Estimate creation did not return an estimate");
  }
  return result;
}

export async function updateEstimateAtomic(
  estimateId: string,
  header: Partial<AtomicEstimateHeader> = {},
  items?: AtomicEstimateItem[],
  costs?: AtomicEstimateCost[],
): Promise<AtomicEstimateResult> {
  const { data, error } = await supabase.rpc("update_estimate_atomic", {
    p_estimate_id: estimateId,
    p_header: header as unknown as never,
    p_items: (items ?? null) as unknown as never,
    p_costs: (costs ?? null) as unknown as never,
  } as never);

  if (error) throw error;

  const result = data as unknown as AtomicEstimateResult | null;
  if (!result?.estimate_id) {
    throw new Error("Estimate update did not return an estimate");
  }
  return result;
}
