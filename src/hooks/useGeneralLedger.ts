import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";

export interface GLTransaction {
  id: string;
  entry_date: string;
  entry_number: string;
  description: string;
  reference: string | null;
  debit_amount: number;
  credit_amount: number;
  running_balance: number;
  source_type: string | null;
  source_id: string | null;
  contact_name: string | null;
  /** 'posted' or 'reversed' — a reversed original stays in the ledger. */
  entry_status: string | null;
  /** True when this movement IS the reversing entry. */
  is_reversal: boolean;
  /** Entry number this movement reverses, when it is a reversal. */
  reversal_of_number: string | null;
  journal_book: string | null;
  branch_name: string | null;
  entry_currency: string | null;
}


export interface GeneralLedgerAccount {
  account_id: string;
  account_code: string;
  account_name: string;
  account_type: "asset" | "liability" | "equity" | "income" | "expense";
  opening_balance: number;
  transactions: GLTransaction[];
  closing_balance: number;
  total_debits: number;
  total_credits: number;
}

export interface GeneralLedgerData {
  accounts: GeneralLedgerAccount[];
  dateRange: { from: string; to: string };
  grandTotals: { debits: number; credits: number };
  /**
   * True when no company is in context for an org with >1 company.
   * Cross-company GL aggregation is intentionally blocked — see /reports/consolidation.
   */
  requiresConsolidation?: boolean;
}

interface UseGeneralLedgerParams {
  dateFrom: string;
  dateTo: string;
  accountIds?: string[];
  includeZeroActivity?: boolean;
  /** Optional branch dimension filter. NULL = all branches (company-wide). */
  branchId?: string | null;
}

/**
 * General Ledger hook — uses server-side RPC to avoid 1000-row limit.
 * The `get_general_ledger` RPC returns all matching rows in a single call,
 * correctly computing opening balances with prior-period movements.
 */
export function useGeneralLedger(params: UseGeneralLedgerParams) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();

  return useQuery({
    queryKey: [
      "general-ledger",
      currentOrg?.id,
      currentBusiness?.id,
      params.dateFrom,
      params.dateTo,
      params.accountIds,
      params.includeZeroActivity,
      params.branchId ?? null,
    ],
    queryFn: async (): Promise<GeneralLedgerData> => {
      const empty = {
        accounts: [],
        dateRange: { from: params.dateFrom, to: params.dateTo },
        grandTotals: { debits: 0, credits: 0 },
      };
      if (!currentOrg?.id) return empty;

      // Consolidation gate: block multi-business GL aggregation.
      if (!currentBusiness?.id) {
        const { count } = await supabase
          .from("businesses")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", currentOrg.id)
          .eq("is_active", true);
        if ((count ?? 0) > 1) {
          return { ...empty, requiresConsolidation: true };
        }
      }

      const { data: rows, error } = await supabase.rpc("get_general_ledger", {
        _org_id: currentOrg.id,
        _date_from: params.dateFrom,
        _date_to: params.dateTo,
        _business_id: currentBusiness?.id || null,
        _account_ids: params.accountIds && params.accountIds.length > 0 ? params.accountIds : null,
        _include_zero_activity: params.includeZeroActivity || false,
        _branch_id: params.branchId || null,
      });

      if (error) throw error;

      return buildGeneralLedgerData(rows || [], params);
    },
    enabled: !!currentOrg?.id,
  });
}

/** Transform flat RPC rows into grouped GeneralLedgerData */
function buildGeneralLedgerData(
  rows: any[],
  params: UseGeneralLedgerParams
): GeneralLedgerData {
  const accountMap = new Map<string, GeneralLedgerAccount>();
  let grandTotalDebits = 0;
  let grandTotalCredits = 0;

  for (const row of rows) {
    const accountId = row.account_id as string;

    if (!accountMap.has(accountId)) {
      accountMap.set(accountId, {
        account_id: accountId,
        account_code: row.account_code,
        account_name: row.account_name,
        account_type: row.account_type as GeneralLedgerAccount["account_type"],
        opening_balance: row.opening_balance || 0,
        transactions: [],
        closing_balance: row.opening_balance || 0,
        total_debits: 0,
        total_credits: 0,
      });
    }

    const account = accountMap.get(accountId)!;

    // If line_id is present, it's a transaction row
    if (row.line_id) {
      const debit = row.debit || 0;
      const credit = row.credit || 0;

      account.total_debits += debit;
      account.total_credits += credit;
      grandTotalDebits += debit;
      grandTotalCredits += credit;

      account.transactions.push({
        id: row.line_id,
        entry_date: row.entry_date,
        entry_number: row.entry_number,
        description: row.line_description || row.je_description || "",
        reference: row.reference,
        debit_amount: debit,
        credit_amount: credit,
        running_balance: 0, // computed below
        source_type: row.source_type,
        source_id: row.source_id,
        contact_name: row.contact_name,
        entry_status: row.entry_status ?? null,
        is_reversal: Boolean(row.is_reversal),
        reversal_of_number: row.reversal_of_number ?? null,
        journal_book: row.journal_book ?? null,
        branch_name: row.branch_name ?? null,
        entry_currency: row.entry_currency ?? null,
      });
    }
  }


  // Calculate running balances and closing balances
  for (const account of accountMap.values()) {
    const isDebitNormal = ["asset", "expense"].includes(account.account_type);
    let runningBalance = account.opening_balance;

    for (const txn of account.transactions) {
      if (isDebitNormal) {
        runningBalance += txn.debit_amount - txn.credit_amount;
      } else {
        runningBalance += txn.credit_amount - txn.debit_amount;
      }
      txn.running_balance = runningBalance;
    }

    account.closing_balance = runningBalance;
  }

  return {
    accounts: Array.from(accountMap.values()),
    dateRange: { from: params.dateFrom, to: params.dateTo },
    grandTotals: { debits: grandTotalDebits, credits: grandTotalCredits },
  };
}
