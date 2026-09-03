/**
 * Group collection sheet (M4).
 *
 * An officer opens a group meeting and sees, for every active member, their
 * active loan and the amount the contract says is due now. Nothing here does
 * money maths: due figures come from the server-derived
 * `mf_loan_installment_status` and `mf_loan_balances` views, and each member's
 * payment is posted through the same `mf_record_repayment` allocation call the
 * single-client path uses.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "./useBusinesses";
import type { MfLoanBalance } from "./useMfRepayments";

export interface MfGroupSheetRow {
  clientId: string;
  clientNumber: string;
  clientName: string;
  loanId: string;
  loanNumber: string;
  currencyCode: string;
  roleInGroup: string;
  /** Earliest still-open installment for this loan. */
  installmentNo: number | null;
  dueDate: string | null;
  /** Outstanding on that installment — the default collection amount. */
  installmentDue: number;
  amountOverdue: number;
  daysPastDue: number;
  totalOutstanding: number;
}

/** Rows for one group's meeting sheet: one active loan per active member. */
export function useMfGroupSheet(groupId?: string | null) {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;

  const query = useQuery({
    queryKey: ["mf-group-sheet", businessId, groupId ?? null],
    queryFn: async (): Promise<MfGroupSheetRow[]> => {
      if (!businessId || !groupId) return [];

      const { data: members, error: membersError } = await supabase
        .from("mf_group_members")
        .select("client_id,role_in_group")
        .eq("business_id", businessId)
        .eq("group_id", groupId)
        .eq("is_active", true);
      if (membersError) throw membersError;
      const clientIds = (members ?? []).map((m) => m.client_id);
      if (clientIds.length === 0) return [];

      const roleByClient = new Map(
        (members ?? []).map((m) => [m.client_id, m.role_in_group ?? "member"]),
      );

      const [{ data: clients, error: clientsError }, { data: balances, error: balancesError }] =
        await Promise.all([
          supabase
            .from("mf_clients")
            .select("id,client_number,full_name")
            .eq("business_id", businessId)
            .in("id", clientIds),
          supabase
            .from("mf_loan_balances")
            .select("*")
            .eq("business_id", businessId)
            .eq("status", "active")
            .in("client_id", clientIds),
        ]);
      if (clientsError) throw clientsError;
      if (balancesError) throw balancesError;

      const loans = (balances ?? []) as MfLoanBalance[];
      if (loans.length === 0) return [];

      const { data: installments, error: installmentsError } = await supabase
        .from("mf_loan_installment_status")
        .select("loan_id,installment_no,due_date,total_outstanding")
        .in(
          "loan_id",
          loans.map((l) => l.loan_id),
        )
        .gt("total_outstanding", 0)
        .order("due_date", { ascending: true });
      if (installmentsError) throw installmentsError;

      const nextByLoan = new Map<
        string,
        { installment_no: number | null; due_date: string | null; total_outstanding: number }
      >();
      for (const row of installments ?? []) {
        if (!row.loan_id || nextByLoan.has(row.loan_id)) continue;
        nextByLoan.set(row.loan_id, {
          installment_no: row.installment_no ?? null,
          due_date: row.due_date ?? null,
          total_outstanding: Number(row.total_outstanding ?? 0),
        });
      }

      const clientById = new Map((clients ?? []).map((c) => [c.id, c]));

      return loans
        .map((loan) => {
          const client = clientById.get(loan.client_id);
          const next = nextByLoan.get(loan.loan_id);
          return {
            clientId: loan.client_id,
            clientNumber: client?.client_number ?? "—",
            clientName: client?.full_name ?? "—",
            loanId: loan.loan_id,
            loanNumber: loan.loan_number,
            currencyCode: loan.currency_code,
            roleInGroup: roleByClient.get(loan.client_id) ?? "member",
            installmentNo: next?.installment_no ?? null,
            dueDate: next?.due_date ?? null,
            installmentDue: next?.total_outstanding ?? 0,
            amountOverdue: Number(loan.amount_overdue ?? 0),
            daysPastDue: Number(loan.days_past_due ?? 0),
            totalOutstanding: Number(loan.total_outstanding ?? 0),
          } satisfies MfGroupSheetRow;
        })
        .sort((a, b) => a.clientName.localeCompare(b.clientName));
    },
    enabled: !!businessId && !!groupId,
  });

  return {
    rows: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error as Error | null,
  };
}
