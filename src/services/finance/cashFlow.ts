/**
 * Cash flow statement — client seam.
 *
 * The indirect-method statement is accounting output. It is produced by
 * `finance_cash_flow_statement` in SQL from posted journal entries, in BASE
 * currency, and consumed verbatim here. This module is the ONLY caller of
 * that RPC.
 *
 * Never re-derive cash flow in the browser: the client cannot see every
 * posted line (row limits), cannot derive closing cash independently, and
 * cannot isolate FX effects on cash. The engine returns BOTH the built-up
 * statement and the ledger-derived closing balance, plus their residual —
 * a non-zero residual is a bookkeeping finding to surface, never to hide.
 */

import { supabase } from "@/integrations/supabase/client";

export interface CashFlowItem {
  key: string;
  label: string;
  amount: number;
}

export interface CashFlowSectionPayload {
  label: string;
  total: number;
  items: CashFlowItem[];
}

export interface CashFlowReconciliation {
  openingCash: number;
  netCashFlow: number;
  fxEffect: number;
  expectedClosingCash: number;
  derivedClosingCash: number;
  residual: number;
  inBalance: boolean;
}

export interface CashFlowAccountBalance {
  accountId: string;
  code: string;
  name: string;
  opening: number;
  closing: number;
  movement: number;
}

export interface CashFlowUnclassifiedAccount {
  accountId: string;
  code: string;
  name: string;
  accountType: string;
  assumedBucket: string;
  netMovement: number;
}

export interface CashFlowStatement {
  from: string;
  to: string;
  operating: CashFlowSectionPayload;
  investing: CashFlowSectionPayload;
  financing: CashFlowSectionPayload;
  netCashFlow: number;
  fxEffect: number;
  openingCash: number;
  closingCash: number;
  reconciliation: CashFlowReconciliation;
  cashAccounts: CashFlowAccountBalance[];
  needsClassification: CashFlowUnclassifiedAccount[];
}

export interface CashFlowParams {
  orgId: string;
  businessId?: string | null;
  branchId?: string | null;
  from: string;
  to: string;
}

const num = (value: unknown): number => Number(value ?? 0) || 0;

function normalizeSection(
  raw: unknown,
  fallbackLabel: string,
): CashFlowSectionPayload {
  const section = (raw ?? {}) as Record<string, unknown>;
  const items = Array.isArray(section.items)
    ? (section.items as Record<string, unknown>[])
    : [];
  return {
    label: String(section.label ?? fallbackLabel),
    total: num(section.total),
    items: items.map((item) => ({
      key: String(item.key ?? ""),
      label: String(item.label ?? ""),
      amount: num(item.amount),
    })),
  };
}

export async function fetchCashFlowStatement(
  params: CashFlowParams,
): Promise<CashFlowStatement> {
  const { data, error } = await (supabase.rpc as any)("finance_cash_flow_statement", {
    _org_id: params.orgId,
    _from: params.from,
    _to: params.to,
    _business_id: params.businessId ?? null,
    _branch_id: params.branchId ?? null,
  });

  if (error) throw error;

  const payload = (data ?? {}) as Record<string, unknown>;
  const recon = (payload.reconciliation ?? {}) as Record<string, unknown>;
  const cashAccounts = Array.isArray(payload.cash_accounts)
    ? (payload.cash_accounts as Record<string, unknown>[])
    : [];
  const unclassified = Array.isArray(payload.needs_classification)
    ? (payload.needs_classification as Record<string, unknown>[])
    : [];

  return {
    from: String(payload.from ?? params.from),
    to: String(payload.to ?? params.to),
    operating: normalizeSection(payload.operating, "Cash flows from operating activities"),
    investing: normalizeSection(payload.investing, "Cash flows from investing activities"),
    financing: normalizeSection(payload.financing, "Cash flows from financing activities"),
    netCashFlow: num(payload.net_cash_flow),
    fxEffect: num(payload.fx_effect),
    openingCash: num(payload.opening_cash),
    closingCash: num(payload.closing_cash),
    reconciliation: {
      openingCash: num(recon.opening_cash),
      netCashFlow: num(recon.net_cash_flow),
      fxEffect: num(recon.fx_effect),
      expectedClosingCash: num(recon.expected_closing_cash),
      derivedClosingCash: num(recon.derived_closing_cash),
      residual: num(recon.residual),
      inBalance: Boolean(recon.in_balance),
    },
    cashAccounts: cashAccounts.map((row) => ({
      accountId: String(row.account_id ?? ""),
      code: String(row.code ?? ""),
      name: String(row.name ?? ""),
      opening: num(row.opening),
      closing: num(row.closing),
      movement: num(row.movement),
    })),
    needsClassification: unclassified.map((row) => ({
      accountId: String(row.account_id ?? ""),
      code: String(row.code ?? ""),
      name: String(row.name ?? ""),
      accountType: String(row.account_type ?? ""),
      assumedBucket: String(row.assumed_bucket ?? ""),
      netMovement: num(row.net_movement),
    })),
  };
}
