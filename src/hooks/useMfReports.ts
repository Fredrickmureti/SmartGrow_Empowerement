/**
 * Microfinance reporting reads (C9).
 *
 * Every figure here is server-derived: the portfolio, arrears and PAR views
 * (`mf_loan_balances`, `mf_loan_arrears`, `mf_par_summary`) own the financial
 * state, and collections/disbursements are read straight off the append-only
 * event tables. React only labels and lays the rows out — it never computes
 * outstanding principal, arrears or PAR.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "./useBusinesses";

export interface MfPortfolioRow {
  loan_id: string;
  loan_number: string;
  client_id: string;
  client_name: string;
  status: string;
  currency_code: string | null;
  principal: number;
  principal_outstanding: number;
  /** Withheld interest not yet earned (upfront-interest loans). Server-derived. */
  unearned_interest: number;
  /** Principal outstanding less unearned interest — what the client effectively owes. */
  net_principal_outstanding: number;
  interest_outstanding: number;
  fees_outstanding: number;
  total_outstanding: number;
  amount_overdue: number;
  days_past_due: number;
  next_due_date: string | null;
}

async function fetchClientNames(businessId: string, ids: string[]) {
  const unique = Array.from(new Set(ids)).filter(Boolean);
  if (unique.length === 0) return new Map<string, string>();
  const { data, error } = await supabase
    .from("mf_clients")
    .select("id, full_name, client_number")
    .eq("business_id", businessId)
    .in("id", unique);
  if (error) throw error;
  return new Map(
    (data ?? []).map((c) => [c.id as string, `${c.full_name} (${c.client_number})`]),
  );
}

async function fetchLoanNumbers(businessId: string, ids: string[]) {
  const unique = Array.from(new Set(ids)).filter(Boolean);
  if (unique.length === 0) return new Map<string, string>();
  const { data, error } = await supabase
    .from("mf_loans")
    .select("id, loan_number")
    .eq("business_id", businessId)
    .in("id", unique);
  if (error) throw error;
  return new Map((data ?? []).map((l) => [l.id as string, l.loan_number as string]));
}

/** Loan portfolio as at now — outstanding balances per loan. */
export function useMfPortfolioReport(status?: string) {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;

  const query = useQuery({
    queryKey: ["mf-report-portfolio", businessId, status ?? "all"],
    queryFn: async (): Promise<MfPortfolioRow[]> => {
      if (!businessId) return [];
      let request = supabase
        .from("mf_loan_balances")
        .select("*")
        .eq("business_id", businessId)
        .order("loan_number", { ascending: true });
      if (status) request = request.eq("status", status);
      const { data, error } = await request;
      if (error) throw error;
      const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
      const names = await fetchClientNames(
        businessId,
        rows.map((r) => r.client_id as string),
      );
      return rows.map((r) => ({
        loan_id: r.loan_id as string,
        loan_number: r.loan_number as string,
        client_id: r.client_id as string,
        client_name: names.get(r.client_id as string) ?? "—",
        status: r.status as string,
        currency_code: (r.currency_code as string) ?? null,
        principal: Number(r.principal ?? 0),
        principal_outstanding: Number(r.principal_outstanding ?? 0),
        unearned_interest: Number(r.unearned_interest ?? 0),
        net_principal_outstanding: Number(r.net_principal_outstanding ?? 0),
        interest_outstanding: Number(r.interest_outstanding ?? 0),
        fees_outstanding: Number(r.fees_outstanding ?? 0),
        total_outstanding: Number(r.total_outstanding ?? 0),
        amount_overdue: Number(r.amount_overdue ?? 0),
        days_past_due: Number(r.days_past_due ?? 0),
        next_due_date: (r.next_due_date as string) ?? null,
      }));
    },
    enabled: !!businessId,
  });

  return {
    rows: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error as Error | null,
  };
}

export interface MfCollectionRow {
  id: string;
  receipt_number: string | null;
  paid_on: string;
  loan_number: string;
  client_name: string;
  method: string;
  reference: string | null;
  status: string;
  amount: number;
}

/** Payments received in a period (reversals excluded from the collected total). */
export function useMfCollectionsReport(from: string, to: string) {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;

  const query = useQuery({
    queryKey: ["mf-report-collections", businessId, from, to],
    queryFn: async (): Promise<MfCollectionRow[]> => {
      if (!businessId) return [];
      const { data, error } = await supabase
        .from("mf_repayments")
        .select("*")
        .eq("business_id", businessId)
        .gte("paid_on", from)
        .lte("paid_on", to)
        .order("paid_on", { ascending: false });
      if (error) throw error;
      const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
      const [names, loans] = await Promise.all([
        fetchClientNames(businessId, rows.map((r) => r.client_id as string)),
        fetchLoanNumbers(businessId, rows.map((r) => r.loan_id as string)),
      ]);
      return rows.map((r) => ({
        id: r.id as string,
        receipt_number: (r.receipt_number as string) ?? null,
        paid_on: r.paid_on as string,
        loan_number: loans.get(r.loan_id as string) ?? "—",
        client_name: names.get(r.client_id as string) ?? "—",
        method: r.method as string,
        reference: (r.reference as string) ?? null,
        status: r.status as string,
        amount: Number(r.amount ?? 0),
      }));
    },
    enabled: !!businessId,
  });

  return {
    rows: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error as Error | null,
  };
}

export interface MfDisbursementRow {
  id: string;
  disbursed_on: string;
  loan_number: string;
  amount: number;
  method: string;
  reference: string | null;
  received_by_name: string | null;
  fees_deducted: number;
  net_amount: number;
  reversed: boolean;
}

/** Disbursements made in a period. */
export function useMfDisbursementsReport(from: string, to: string) {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;

  const query = useQuery({
    queryKey: ["mf-report-disbursements", businessId, from, to],
    queryFn: async (): Promise<MfDisbursementRow[]> => {
      if (!businessId) return [];
      const { data, error } = await supabase
        .from("mf_loan_disbursements")
        .select("*")
        .eq("business_id", businessId)
        .gte("disbursed_on", from)
        .lte("disbursed_on", to)
        .order("disbursed_on", { ascending: false });
      if (error) throw error;
      const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
      const loans = await fetchLoanNumbers(
        businessId,
        rows.map((r) => r.loan_id as string),
      );
      return rows.map((r) => ({
        id: r.id as string,
        disbursed_on: r.disbursed_on as string,
        loan_number: loans.get(r.loan_id as string) ?? "—",
        amount: Number(r.amount ?? 0),
        method: r.method as string,
        reference: (r.reference as string) ?? null,
        received_by_name: (r.received_by_name as string) ?? null,
        fees_deducted: Number(r.fees_deducted ?? 0),
        net_amount: Number(r.net_amount ?? r.amount ?? 0),
        reversed: !!r.reversed_at,
      }));
    },
    enabled: !!businessId,
  });

  return {
    rows: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error as Error | null,
  };
}

export interface MfClientStatementRow {
  entry_id: string;
  entry_date: string;
  entry_type: "disbursement" | "repayment";
  description: string;
  loan_number: string;
  method: string | null;
  reference: string | null;
  amount_out: number;
  amount_in: number;
}

/**
 * Client statement — every money movement for one client across all their
 * loans, straight off the server-owned `mf_client_statement` view. The running
 * balance is derived in order from those authoritative amounts only.
 */
export function useMfClientStatement(clientId: string | null, from: string, to: string) {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;

  const query = useQuery({
    queryKey: ["mf-client-statement", businessId, clientId, from, to],
    queryFn: async (): Promise<MfClientStatementRow[]> => {
      if (!businessId || !clientId) return [];
      const { data, error } = await supabase
        .from("mf_client_statement")
        .select("*")
        .eq("business_id", businessId)
        .eq("client_id", clientId)
        .gte("entry_date", from)
        .lte("entry_date", to)
        .order("entry_date", { ascending: true });
      if (error) throw error;
      const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        entry_id: r.entry_id as string,
        entry_date: r.entry_date as string,
        entry_type: r.entry_type as "disbursement" | "repayment",
        description: r.description as string,
        loan_number: (r.loan_number as string) ?? "—",
        method: (r.method as string) ?? null,
        reference: (r.reference as string) ?? null,
        amount_out: Number(r.amount_out ?? 0),
        amount_in: Number(r.amount_in ?? 0),
      }));
    },
    enabled: !!businessId && !!clientId,
  });

  return {
    rows: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error as Error | null,
  };
}

export interface MfCollectionsByScopeRow {
  branch_id: string | null;
  loan_officer_id: string | null;
  paid_on: string;
  receipt_count: number;
  client_count: number;
  amount_collected: number;
  cash_collected: number;
  mobile_money_collected: number;
  other_collected: number;
}

/**
 * Collections aggregated by loan officer or by branch for a period, from the
 * server views `mf_collections_by_officer` / `mf_collections_by_branch`. The
 * browser only sums the already-aggregated day rows for display totals.
 */
export function useMfCollectionsByScope(
  scope: "officer" | "branch",
  from: string,
  to: string,
) {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;

  const query = useQuery({
    queryKey: ["mf-collections-scope", scope, businessId, from, to],
    queryFn: async (): Promise<MfCollectionsByScopeRow[]> => {
      if (!businessId) return [];
      const view = scope === "officer" ? "mf_collections_by_officer" : "mf_collections_by_branch";
      const { data, error } = await supabase
        .from(view)
        .select("*")
        .eq("business_id", businessId)
        .gte("paid_on", from)
        .lte("paid_on", to)
        .order("paid_on", { ascending: true });
      if (error) throw error;
      const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        branch_id: (r.branch_id as string) ?? null,
        loan_officer_id: (r.loan_officer_id as string) ?? null,
        paid_on: r.paid_on as string,
        receipt_count: Number(r.receipt_count ?? 0),
        client_count: Number(r.client_count ?? 0),
        amount_collected: Number(r.amount_collected ?? 0),
        cash_collected: Number(r.cash_collected ?? 0),
        mobile_money_collected: Number(r.mobile_money_collected ?? 0),
        other_collected: Number(r.other_collected ?? 0),
      }));
    },
    enabled: !!businessId,
  });

  return {
    rows: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error as Error | null,
  };
}

export interface MfProductPerformanceRow {
  product_id: string;
  product_code: string;
  product_name: string;
  loan_count: number;
  active_loan_count: number;
  closed_loan_count: number;
  written_off_loan_count: number;
  principal_contracted: number;
  principal_disbursed: number;
  outstanding: number;
  amount_overdue: number;
  worst_days_past_due: number;
}

/** Product performance — disbursed, outstanding and overdue per loan product. */
export function useMfProductPerformance() {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;

  const query = useQuery({
    queryKey: ["mf-product-performance", businessId],
    queryFn: async (): Promise<MfProductPerformanceRow[]> => {
      if (!businessId) return [];
      const { data, error } = await supabase
        .from("mf_product_performance")
        .select("*")
        .eq("business_id", businessId)
        .order("product_name", { ascending: true });
      if (error) throw error;
      const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        product_id: r.product_id as string,
        product_code: (r.product_code as string) ?? "—",
        product_name: (r.product_name as string) ?? "—",
        loan_count: Number(r.loan_count ?? 0),
        active_loan_count: Number(r.active_loan_count ?? 0),
        closed_loan_count: Number(r.closed_loan_count ?? 0),
        written_off_loan_count: Number(r.written_off_loan_count ?? 0),
        principal_contracted: Number(r.principal_contracted ?? 0),
        principal_disbursed: Number(r.principal_disbursed ?? 0),
        outstanding: Number(r.outstanding ?? 0),
        amount_overdue: Number(r.amount_overdue ?? 0),
        worst_days_past_due: Number(r.worst_days_past_due ?? 0),
      }));
    },
    enabled: !!businessId,
  });

  return {
    rows: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error as Error | null,
  };
}

export interface MfClientExposureRow {
  client_id: string;
  client_number: string;
  full_name: string;
  client_status: string;
  branch_id: string | null;
  loan_officer_id: string | null;
  active_loan_count: number;
  principal_outstanding: number;
  interest_outstanding: number;
  fees_outstanding: number;
  total_outstanding: number;
  amount_overdue: number;
  worst_days_past_due: number;
  next_due_date: string | null;
}

/** Client exposure — total outstanding and overdue per client, server-derived. */
export function useMfClientExposure() {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;

  const query = useQuery({
    queryKey: ["mf-client-exposure", businessId],
    queryFn: async (): Promise<MfClientExposureRow[]> => {
      if (!businessId) return [];
      const { data, error } = await supabase
        .from("mf_client_exposure")
        .select("*")
        .eq("business_id", businessId)
        .order("full_name", { ascending: true });
      if (error) throw error;
      const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        client_id: r.client_id as string,
        client_number: (r.client_number as string) ?? "—",
        full_name: (r.full_name as string) ?? "—",
        client_status: (r.client_status as string) ?? "—",
        branch_id: (r.branch_id as string) ?? null,
        loan_officer_id: (r.loan_officer_id as string) ?? null,
        active_loan_count: Number(r.active_loan_count ?? 0),
        principal_outstanding: Number(r.principal_outstanding ?? 0),
        interest_outstanding: Number(r.interest_outstanding ?? 0),
        fees_outstanding: Number(r.fees_outstanding ?? 0),
        total_outstanding: Number(r.total_outstanding ?? 0),
        amount_overdue: Number(r.amount_overdue ?? 0),
        worst_days_past_due: Number(r.worst_days_past_due ?? 0),
        next_due_date: (r.next_due_date as string) ?? null,
      }));
    },
    enabled: !!businessId,
  });

  return {
    rows: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error as Error | null,
  };
}

export interface MfParAgingRow {
  branch_id: string | null;
  loan_officer_id: string | null;
  loan_count: number;
  loans_in_arrears: number;
  portfolio_outstanding: number;
  current_outstanding: number;
  bucket_1_30: number;
  bucket_31_60: number;
  bucket_61_90: number;
  bucket_90_plus: number;
}

/** PAR aging — outstanding split into DPD buckets per branch and officer. */
export function useMfParAging() {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;

  const query = useQuery({
    queryKey: ["mf-par-aging", businessId],
    queryFn: async (): Promise<MfParAgingRow[]> => {
      if (!businessId) return [];
      const { data, error } = await supabase
        .from("mf_par_aging")
        .select("*")
        .eq("business_id", businessId);
      if (error) throw error;
      const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        branch_id: (r.branch_id as string) ?? null,
        loan_officer_id: (r.loan_officer_id as string) ?? null,
        loan_count: Number(r.loan_count ?? 0),
        loans_in_arrears: Number(r.loans_in_arrears ?? 0),
        portfolio_outstanding: Number(r.portfolio_outstanding ?? 0),
        current_outstanding: Number(r.current_outstanding ?? 0),
        bucket_1_30: Number(r.bucket_1_30 ?? 0),
        bucket_31_60: Number(r.bucket_31_60 ?? 0),
        bucket_61_90: Number(r.bucket_61_90 ?? 0),
        bucket_90_plus: Number(r.bucket_90_plus ?? 0),
      }));
    },
    enabled: !!businessId,
  });

  return {
    rows: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error as Error | null,
  };
}
