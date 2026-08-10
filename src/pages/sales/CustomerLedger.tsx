/**
 * CustomerLedgerPage — ADR 0027 PR2
 *
 * Chronological customer ledger consuming the canonical
 * `customer_ledger_entries` view via `useCustomerLedger`.
 * Single-source-of-truth for the customer's balance, statement, and aging.
 */
import { useMemo, useState } from "react";
import { downloadCsv } from "@/lib/exports/csv";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useCustomerLedger } from "@/hooks/useCustomerLedger";
import { useCurrency } from "@/hooks/useCurrency";
import { useBusinesses } from "@/hooks/useBusinesses";
import { supabase } from "@/integrations/supabase/client";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ArrowLeft,
  Download,
  FileText,
  Receipt,
  Wallet,
  RotateCcw,
  StickyNote,
  Undo2,
  BookOpen,
  AlertTriangle,
} from "lucide-react";
import { format } from "date-fns";
import { describeLedgerDoc } from "@/services/finance/customerStatementDataset";

const DOC_ICON: Record<string, any> = {
  invoice: FileText,
  payment: Receipt,
  deposit: Wallet,
  credit_note: StickyNote,
  refund: RotateCcw,
  payment_reversal: Undo2,
  journal: BookOpen,
};

/**
 * Labels come from the canonical statement vocabulary so the ledger page and
 * the printed statement can never describe the same row differently.
 */
function docLabel(docType: string): string {
  return describeLedgerDoc(docType, "").trim() || docType;
}

function useContact(contactId?: string) {
  return useQuery({
    queryKey: ["contact-minimal", contactId],
    enabled: !!contactId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("contacts")
        .select("id, name, email, phone")
        .eq("id", contactId!)
        .single();
      if (error) throw error;
      return data as { id: string; name: string; email: string | null; phone: string | null };
    },
  });
}

export default function CustomerLedgerPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { currentBusiness } = useBusinesses();
  const { formatCurrency } = useCurrency();
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const { data: contact } = useContact(id);
  const { entries, outstandingBalance, isLoading } = useCustomerLedger({
    contactId: id,
    businessId: currentBusiness?.id ?? null,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
  });

  const totals = useMemo(() => {
    return entries.reduce(
      (acc, e) => {
        acc.debit += e.debit;
        acc.credit += e.credit;
        return acc;
      },
      { debit: 0, credit: 0 },
    );
  }, [entries]);

  // A running balance across mixed transaction currencies is meaningless.
  // The statement builder raises the same guard (`otherCurrencies`).
  const currencies = useMemo(
    () =>
      Array.from(
        new Set(
          entries
            .map((e) => (e.currency ? String(e.currency).toUpperCase() : null))
            .filter((c): c is string => !!c),
        ),
      ),
    [entries],
  );
  const isMixedCurrency = currencies.length > 1;

  const handleExportCsv = () => {
    if (entries.length === 0) return;
    const header = ["Date", "Type", "Reference", "Debit", "Credit", "Running Balance"];
    const rows = entries.map((e) => [
      e.entry_date,
      docLabel(e.doc_type),
      e.doc_ref,
      e.debit ? e.debit.toFixed(2) : "",
      e.credit ? e.credit.toFixed(2) : "",
      e.running_balance.toFixed(2),
    ]);
    const csv = [header, ...rows]
      .map((row) => row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))
      .join("\r\n");
    downloadCsv(
      `customer-ledger-${contact?.name ?? id}-${new Date().toISOString().slice(0, 10)}.csv`,
      csv,
    );
  };

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-7xl mx-auto">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => navigate(-1)}>
          <ArrowLeft className="h-4 w-4 mr-1" />
          Back
        </Button>
      </div>

      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Customer Ledger</h1>
          <p className="text-sm text-muted-foreground">
            {contact?.name ?? "—"} · chronological invoices, payments, deposits, credit notes,
            and refunds. Single source of truth for the customer's AR position (ADR 0027).
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={handleExportCsv} disabled={entries.length === 0}>
          <Download className="h-4 w-4 mr-2" />
          Export CSV
        </Button>
      </div>

      <Card className="p-4 grid grid-cols-1 sm:grid-cols-4 gap-3">
        <div>
          <Label htmlFor="from">From</Label>
          <Input id="from" type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="to">To</Label>
          <Input id="to" type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
        </div>
        <div className="sm:col-span-2 sm:text-right">
          <div className="text-xs text-muted-foreground">Outstanding balance</div>
          <div
            className={`text-3xl font-bold tabular-nums ${
              outstandingBalance > 0
                ? "text-amber-700 dark:text-amber-400"
                : outstandingBalance < 0
                ? "text-emerald-700 dark:text-emerald-400"
                : ""
            }`}
          >
            {formatCurrency(outstandingBalance)}
          </div>
          <div className="text-xs text-muted-foreground">
            {outstandingBalance > 0
              ? "Owed by customer"
              : outstandingBalance < 0
              ? "Customer credit on file"
              : "Settled"}
          </div>
        </div>
      </Card>

      {isMixedCurrency && (
        <Card className="p-3 flex items-start gap-2 border-amber-500/50 bg-amber-500/10">
          <AlertTriangle className="h-4 w-4 mt-0.5 text-amber-700 dark:text-amber-400" />
          <div className="text-sm">
            <span className="font-medium">Mixed-currency ledger.</span>{" "}
            Entries are recorded in {currencies.join(", ")}. The running balance
            adds transaction-currency amounts and is not a valid total — filter
            to a single currency, or use the base-currency AR reports.
          </div>
        </Card>
      )}

      <Card className="overflow-hidden">
        {isLoading ? (
          <div className="p-6 space-y-2">
            {[...Array(6)].map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : entries.length === 0 ? (
          <div className="p-12 text-center text-muted-foreground">
            No ledger entries for this customer in the selected window.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 sticky top-0">
                <tr>
                  <th className="text-left px-3 py-2 font-medium">Date</th>
                  <th className="text-left px-3 py-2 font-medium">Type</th>
                  <th className="text-left px-3 py-2 font-medium">Reference</th>
                  <th className="text-right px-3 py-2 font-medium">Debit</th>
                  <th className="text-right px-3 py-2 font-medium">Credit</th>
                  <th className="text-right px-3 py-2 font-medium">Running Balance</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => {
                  const Icon = DOC_ICON[e.doc_type] ?? FileText;
                  return (
                    <tr key={`${e.doc_type}-${e.doc_id}-${e.entry_date}-${e.debit}-${e.credit}`} className="border-t">
                      <td className="px-3 py-2 whitespace-nowrap">
                        {format(new Date(e.entry_date), "yyyy-MM-dd")}
                      </td>
                      <td className="px-3 py-2">
                        <Badge variant="outline" className="gap-1 capitalize">
                          <Icon className="h-3 w-3" />
                          {docLabel(e.doc_type)}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 font-medium">{e.doc_ref}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {e.debit > 0 ? formatCurrency(e.debit) : "—"}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {e.credit > 0 ? formatCurrency(e.credit) : "—"}
                      </td>
                      <td
                        className={`px-3 py-2 text-right tabular-nums font-medium ${
                          e.running_balance < 0 ? "text-emerald-700 dark:text-emerald-400" : ""
                        }`}
                      >
                        {formatCurrency(e.running_balance)}
                      </td>
                    </tr>
                  );
                })}
                <tr className="border-t bg-muted/30 font-medium">
                  <td colSpan={3} className="px-3 py-2 text-right">
                    Totals
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(totals.debit)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(totals.credit)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatCurrency(outstandingBalance)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {id && (
        <div className="text-xs text-muted-foreground">
          See also: <Link className="underline" to={`/sales/statements?customer=${id}`}>Statement view</Link>
          {" · "}
          <Link className="underline" to={`/sales/payments?customer=${id}`}>Payments</Link>
        </div>
      )}
    </div>
  );
}
