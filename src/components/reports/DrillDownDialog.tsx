import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useCurrency } from "@/hooks/useCurrency";
import { useQuery } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, ExternalLink } from "lucide-react";
import { TransactionPreviewDrawer } from "@/components/finance/TransactionPreviewDrawer";
import { resolveLedgerDrillTarget } from "@/lib/reports/ledgerDrillTarget";
import { format } from "date-fns";

export interface DrillDownConfig {
  title: string;
  accountId?: string;
  accountType?: string;
  startDate: string;
  endDate: string;
  sourceType?: string;
  /**
   * Partner-scoped drill-down (Sales / Purchases reports). When set, the dialog
   * lists that partner's documents for the period instead of GL lines. The
   * document kind is taken from `sourceType` ("invoice" | "bill"); anything
   * else is refused rather than guessed, so no report can drill into a
   * relationship that does not exist in the business model.
   */
  contactId?: string;
  /**
   * Branch scope of the report that opened this dialog. A branch-scoped Trial
   * Balance must drill into that branch's lines only — omitting it silently
   * showed all-branch movement behind a branch figure.
   */
  branchId?: string | null;
}

interface DrillDownTransaction {
  id: string;
  date: string;
  reference: string;
  description: string;
  debit: number;
  credit: number;
  source_type: string;
  source_id: string | null;
  journal_entry_id: string | null;
}

interface DrillDownDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  config: DrillDownConfig | null;
}

export function DrillDownDialog({ open, onOpenChange, config }: DrillDownDialogProps) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { formatCurrency } = useCurrency();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerSource, setDrawerSource] = useState<{ type: string | null; id: string | null }>({ type: null, id: null });

  const { data: transactions = [], isLoading } = useQuery({
    queryKey: [
      "drilldown-gl",
      currentOrg?.id,
      currentBusiness?.id,
      config?.accountId,
      config?.branchId ?? null,
      config?.startDate,
      config?.endDate,
    ],
    queryFn: async (): Promise<DrillDownTransaction[]> => {
      if (!currentOrg?.id || !config?.accountId) return [];

      const { data: rows, error } = await supabase.rpc("get_general_ledger", {
        _org_id: currentOrg.id,
        _date_from: config.startDate,
        _date_to: config.endDate,
        _business_id: currentBusiness?.id || null,
        _account_ids: [config.accountId],
        _include_zero_activity: false,
        _branch_id: config.branchId || null,
      });

      if (error) throw error;

      return (rows || [])
        .filter((row: any) => row.line_id)
        .map((row: any) => ({
          id: row.line_id as string,
          date: row.entry_date as string,
          reference: (row.entry_number || row.reference || "") as string,
          description: (row.line_description || row.je_description || "") as string,
          debit: (row.debit || 0) as number,
          credit: (row.credit || 0) as number,
          source_type: (row.source_type || "manual") as string,
          source_id: (row.source_id || null) as string | null,
          journal_entry_id: (row.journal_entry_id || null) as string | null,
        }))
        .sort((a: DrillDownTransaction, b: DrillDownTransaction) =>
          new Date(b.date).getTime() - new Date(a.date).getTime()
        );
    },
    enabled: open && !!currentOrg?.id && !!config?.accountId && !config?.contactId,
    staleTime: 15_000,
  });

  // Partner drill-down: the documents that make up a customer's or supplier's
  // figure in a Sales / Purchases report. Read through the same RLS-scoped
  // client as every other report query — no privileged path.
  const partnerKind: "invoice" | "bill" | null =
    config?.sourceType === "invoice"
      ? "invoice"
      : config?.sourceType === "bill"
        ? "bill"
        : null;

  const { data: partnerDocs = [], isLoading: partnerLoading } = useQuery({
    queryKey: [
      "drilldown-partner",
      currentOrg?.id,
      currentBusiness?.id,
      config?.contactId,
      partnerKind,
      config?.startDate,
      config?.endDate,
    ],
    queryFn: async (): Promise<DrillDownTransaction[]> => {
      if (!currentOrg?.id || !config?.contactId || !partnerKind) return [];
      const table = partnerKind === "invoice" ? "invoices" : "bills";
      const dateColumn = partnerKind === "invoice" ? "issue_date" : "bill_date";
      // `invoices` links the partner via `contact_id`, `bills` via
      // `vendor_id`; the generated table types are disjoint, so the builder
      // is assembled untyped and the rows are narrowed on read below.
      let query = (supabase as any)
        .from(table)
        .select(
          partnerKind === "invoice"
            ? "id, invoice_number, issue_date, total, amount_paid, status"
            : "id, bill_number, bill_date, total, amount_paid, status",
        )
        .eq("organization_id", currentOrg.id)
        .eq(partnerKind === "invoice" ? "contact_id" : "vendor_id", config.contactId)
        .gte(dateColumn, config.startDate)
        .lte(dateColumn, config.endDate);
      if (currentBusiness?.id) query = query.eq("business_id", currentBusiness.id);

      const { data: rows, error } = await query;
      if (error) throw error;

      return (rows || []).map((row: any) => {
        const total = Number(row.total || 0);
        const paid = Number(row.amount_paid || 0);
        return {
          id: row.id as string,
          date: (partnerKind === "invoice" ? row.issue_date : row.bill_date) as string,
          reference: (partnerKind === "invoice" ? row.invoice_number : row.bill_number) || "",
          description: `${row.status ?? ""} · ${formatCurrency(paid)} settled`,
          // Presented on the side the document naturally sits on: a sales
          // invoice is a receivable (debit), a purchase bill a payable (credit).
          debit: partnerKind === "invoice" ? total : 0,
          credit: partnerKind === "bill" ? total : 0,
          source_type: partnerKind,
          source_id: row.id as string,
        } satisfies DrillDownTransaction;
      }).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    },
    enabled: open && !!currentOrg?.id && !!config?.contactId && !!partnerKind,
    staleTime: 15_000,
  });

  const getSourceBadge = (sourceType: string) => {
    const labels: Record<string, string> = {
      invoice: "Invoice", bill: "Bill", expense: "Expense", payment: "Payment", manual: "Manual",
      bill_payment: "Bill Payment", pos_sale: "POS Sale", payroll: "Payroll", credit_note: "Credit Note",
      bank_recon: "Bank Recon", year_end_closing: "Year-End", purchase_return: "Purchase Return",
      stock_adjustment: "Stock Adj.", asset_acquisition: "Asset Acq.", asset_disposal: "Asset Disposal",
      depreciation: "Depreciation", opening_balance: "Opening Bal.", migration: "Migration",
      owner_investment: "Owner Investment", owner_drawing: "Owner Drawing", bank_transfer: "Transfer",
      loan_received: "Loan Received", loan_payment: "Loan Payment",
    };
    const styles: Record<string, string> = {
      invoice: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
      bill: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200",
      expense: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
      payment: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
      manual: "bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200",
      depreciation: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200",
      stock_adjustment: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
      asset_acquisition: "bg-teal-100 text-teal-800 dark:bg-teal-900 dark:text-teal-200",
      owner_investment: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200",
      bank_transfer: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-200",
    };
    return <Badge className={styles[sourceType] || styles.manual}>{labels[sourceType] || sourceType}</Badge>;
  };

  const rowsToShow = config?.contactId ? partnerDocs : transactions;
  const busy = config?.contactId ? partnerLoading : isLoading;
  const totalDebit = rowsToShow.reduce((sum, t) => sum + t.debit, 0);
  const totalCredit = rowsToShow.reduce((sum, t) => sum + t.credit, 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>{config?.title || "Transaction Details"}</DialogTitle>
          <DialogDescription>
            {config?.startDate && config?.endDate && (
              <>
                {format(new Date(config.startDate), "MMM d, yyyy")} -{" "}
                {format(new Date(config.endDate), "MMM d, yyyy")}
              </>
            )}
            <span className="ml-4">
              {rowsToShow.length} transaction{rowsToShow.length !== 1 ? "s" : ""}
            </span>
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-auto">
          {busy ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : rowsToShow.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              No transactions found for this period.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Reference</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead className="text-right">Debit</TableHead>
                  <TableHead className="text-right">Credit</TableHead>
                  <TableHead className="w-12"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rowsToShow.map((txn) => (
                  <TableRow key={txn.id}>
                    <TableCell className="whitespace-nowrap">
                      {format(new Date(txn.date), "MMM d, yyyy")}
                    </TableCell>
                    <TableCell className="font-mono text-sm">{txn.reference}</TableCell>
                    <TableCell className="max-w-xs truncate">{txn.description}</TableCell>
                    <TableCell>{getSourceBadge(txn.source_type)}</TableCell>
                    <TableCell className="text-right">
                      {txn.debit > 0 ? formatCurrency(txn.debit) : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      {txn.credit > 0 ? formatCurrency(txn.credit) : "—"}
                    </TableCell>
                    <TableCell>
                      {(() => {
                        const target = resolveLedgerDrillTarget(txn);
                        if (!target) return null;
                        return (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => {
                              setDrawerSource(target);
                              setDrawerOpen(true);
                            }}
                          >
                            <ExternalLink className="h-4 w-4" />
                          </Button>
                        );
                      })()}
                    </TableCell>
                  </TableRow>
                ))}
                <TableRow className="font-bold bg-muted/50">
                  <TableCell colSpan={4}>Total</TableCell>
                  <TableCell className="text-right">{formatCurrency(totalDebit)}</TableCell>
                  <TableCell className="text-right">{formatCurrency(totalCredit)}</TableCell>
                  <TableCell></TableCell>
                </TableRow>
              </TableBody>
            </Table>
          )}
        </div>
      </DialogContent>
      <TransactionPreviewDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        sourceType={drawerSource.type}
        sourceId={drawerSource.id}
      />
    </Dialog>
  );
}

// Helper component to make any value clickable for drill-down
interface DrillDownValueProps {
  value: number | string;
  config: DrillDownConfig;
  formatValue?: (value: number | string) => string;
  className?: string;
}

export function DrillDownValue({ value, config, formatValue, className }: DrillDownValueProps) {
  const [showDialog, setShowDialog] = useState(false);
  const displayValue = formatValue ? formatValue(value) : String(value);

  return (
    <>
      <button
        onClick={() => setShowDialog(true)}
        className={`hover:underline hover:text-primary cursor-pointer text-left ${className || ""}`}
      >
        {displayValue}
      </button>
      <DrillDownDialog open={showDialog} onOpenChange={setShowDialog} config={config} />
    </>
  );
}
