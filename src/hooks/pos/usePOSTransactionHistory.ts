import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/contexts/BusinessContext";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";

export interface POSTransactionRecord {
  id: string;
  organization_id: string;
  register_id: string;
  shift_id: string;
  transaction_number: string;
  transaction_type: "sale" | "return" | "exchange";
  customer_id: string | null;
  customer_name: string | null;
  subtotal: number;
  tax_amount: number;
  discount_amount: number;
  total: number;
  payment_status: "paid" | "partial" | "refunded";
  status: "completed" | "voided" | "suspended";
  completed_at: string | null;
  created_at: string;
  created_by: string | null;
  notes: string | null;
  invoice_id: string | null;
  register?: {
    register_name: string;
    register_code: string;
  };
  items?: POSTransactionItem[];
  payments?: POSTransactionPayment[];
}

export interface POSTransactionItem {
  id: string;
  transaction_id: string;
  product_id: string | null;
  description: string;
  quantity: number;
  unit_price: number;
  discount_type: string | null;
  discount_value: number;
  tax_rate: number;
  tax_amount: number;
  line_total: number;
  cost_price: number | null;
}

export interface POSTransactionPayment {
  id: string;
  transaction_id: string;
  payment_method: string;
  amount: number;
  reference: string | null;
  card_last_four: string | null;
  card_type: string | null;
  status: string;
  processed_at: string;
}

interface TransactionFilters {
  shiftId?: string;
  registerId?: string;
  branchId?: string;
  status?: string;
  transactionType?: string;
  dateFrom?: string;
  dateTo?: string;
  searchQuery?: string;
}

const startOfDateFilter = (value: string) =>
  value.length === 10 ? `${value}T00:00:00.000Z` : value;

const exclusiveEndOfDateFilter = (value: string) => {
  if (value.length !== 10) return value;
  const end = new Date(`${value}T00:00:00.000Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  return end.toISOString();
};

const sanitizeReceiptSearch = (value: string) =>
  value.replace(/[(),]/g, " ").trim();

export function usePOSTransactionHistory(filters: TransactionFilters = {}) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const queryClient = useQueryClient();

  const { data: transactions = [], isLoading } = useQuery({
    queryKey: [
      "pos-transactions",
      currentOrg?.id,
      currentBusiness?.id,
      filters,
    ],
    queryFn: async () => {
      if (!currentOrg?.id || !currentBusiness?.id) return [];

      // TB-2: business_id is NOT NULL on pos_transactions; the legacy `is.null` arm
      // was a contamination foothold and has been removed.
      let query = supabase
        .from("pos_transactions")
        .select(
          `
          *,
          register:pos_registers(register_name, register_code)
        `,
        )
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .order("created_at", { ascending: false });

      if (filters.shiftId) {
        query = query.eq("shift_id", filters.shiftId);
      }
      if (filters.registerId) {
        query = query.eq("register_id", filters.registerId);
      }
      if (filters.branchId) {
        query = query.eq("branch_id", filters.branchId);
      }
      if (filters.status) {
        query = query.eq("status", filters.status);
      }
      if (filters.transactionType) {
        query = query.eq("transaction_type", filters.transactionType);
      }
      if (filters.dateFrom) {
        query = query.gte("created_at", startOfDateFilter(filters.dateFrom));
      }
      if (filters.dateTo) {
        query = query.lt(
          "created_at",
          exclusiveEndOfDateFilter(filters.dateTo),
        );
      }
      if (filters.searchQuery) {
        const search = sanitizeReceiptSearch(filters.searchQuery);
        query = query.or(
          `transaction_number.ilike.%${search}%,customer_name.ilike.%${search}%`,
        );
      }

      const { data, error } = await query.limit(100);
      if (error) throw error;

      return data as POSTransactionRecord[];
    },
    enabled: !!currentOrg?.id && !!currentBusiness?.id,
  });

  // Get single transaction with full details
  const getTransactionDetails = async (transactionId: string) => {
    const { data: transaction, error: txError } = await supabase
      .from("pos_transactions")
      .select(
        `
        *,
        register:pos_registers(register_name, register_code)
      `,
      )
      .eq("id", transactionId)
      .single();

    if (txError) throw txError;

    const { data: items } = await supabase
      .from("pos_transaction_items")
      .select("*")
      .eq("transaction_id", transactionId)
      .order("sort_order");

    const { data: payments } = await supabase
      .from("pos_transaction_payments")
      .select("*")
      .eq("transaction_id", transactionId);

    return {
      ...transaction,
      items: items || [],
      payments: payments || [],
    } as POSTransactionRecord;
  };

  const voidTransaction = useMutation({
    mutationFn: async (input: {
      transactionId: string;
      voidReasonId: string;
      voidNote?: string;
      overrideId?: string;
    }) => {
      if (!currentOrg?.id) throw new Error("Organization context required");

      // Stage 5: process_pos_void v2 owns same-shift check, reason FK,
      // override gate, stock + cash reversal, status flip — all atomic.
      // The previous client-side stock_movements double-write was removed
      // because the RPC now writes the canonical reversing movements itself.
      const userId = (await supabase.auth.getUser()).data.user?.id ?? null;
      const { data: result, error: voidErr } = await supabase.rpc(
        "process_pos_void",
        {
          p_organization_id: currentOrg.id,
          p_transaction_id: input.transactionId,
          p_void_reason_id: input.voidReasonId,
          p_void_note: input.voidNote ?? null,
          p_voided_by: userId,
          p_override_id: input.overrideId ?? null,
        } as any,
      );
      if (voidErr) throw voidErr;
      const r = result as any;
      if (!r?.success) {
        const err: any = new Error(r?.details || r?.error || "Void failed");
        err.code = r?.error;
        throw err;
      }
      return r;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-transactions"] });
      queryClient.invalidateQueries({ queryKey: ["pos-products"] });
      queryClient.invalidateQueries({ queryKey: ["products"] });
      toast.success("Transaction voided and stock restored");
    },
    onError: (error: Error) => {
      // Stage 8.6: when assert_manager_override raises override_required, the
      // calling component pops the PIN dialog and replays — don't show a raw
      // toast for that case.
      const msg = (error as any)?.message || "";
      if (/override_required/i.test(msg)) return;
      toast.error(`Failed to void: ${normalizeError(error).message}`);
    },
  });

  // Calculate summary stats
  const completedTransactions = transactions.filter(
    (t) => t.status === "completed",
  );
  const totalSales = completedTransactions
    .filter((t) => t.transaction_type === "sale")
    .reduce((sum, t) => sum + t.total, 0);
  const totalReturns = completedTransactions
    .filter((t) => t.transaction_type === "return")
    .reduce((sum, t) => sum + t.total, 0);
  const transactionCount = completedTransactions.length;

  return {
    transactions,
    isLoading,
    getTransactionDetails,
    voidTransaction,
    totalSales,
    totalReturns,
    netSales: totalSales - totalReturns,
    transactionCount,
  };
}
