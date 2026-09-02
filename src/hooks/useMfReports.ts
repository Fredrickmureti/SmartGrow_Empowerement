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
