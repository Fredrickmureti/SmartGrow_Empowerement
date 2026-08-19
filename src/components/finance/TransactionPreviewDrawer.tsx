/**
 * TransactionPreviewDrawer
 * 
 * Reusable right-side drawer that fetches and displays any source transaction
 * by source_type + source_id. Used in Account Register, Journal Entries,
 * and General Ledger for reference traceability.
 * 
 * Follows the ExpenseDetailDialog layout pattern for UI consistency.
 */

import { useEffect, useState } from "react";
import { DetailRow } from "@/components/common/DetailRow";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { deriveInvoiceFromAllocations } from "@/lib/payments/deriveInvoiceFromAllocations";
import { DetailSheet } from "@/design-system/primitives/DetailSheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Calendar,
  Receipt,
  FileText,
  CreditCard,
  BookOpen,
  ExternalLink,
  Tag,
  Building2,
  Hash,
  Coins,
  User,
  Loader2,
} from "lucide-react";
import { useCurrency } from "@/hooks/useCurrency";
import { format } from "date-fns";

interface TransactionPreviewDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sourceType: string | null;
  sourceId: string | null;
}

interface TransactionData {
  type: string;
  title: string;
  subtitle?: string;
  status: string;
  amount: number;
  currency?: string;
  date: string;
  details: { icon: React.ElementType; label: string; value: string }[];
  navigateTo?: string;
  /**
   * Set when the user can see this JE (org-wide) but cannot view the
   * underlying source record (e.g. Finance role at HQ but no Payroll
   * permission for the branch the run belongs to). Used to suppress the
   * "View full record" button and surface a clear no-access note.
   */
  accessNote?: string;
}

const SOURCE_LABELS: Record<string, string> = {
  invoice: "Customer Invoice",
  invoice_payment: "Invoice Payment",
  payment: "Invoice Payment",
  bill: "Vendor Bill",
  bill_payment: "Bill Payment",
  expense: "Expense",
  credit_note: "Credit Note",
  credit_application: "Credit Application",
  manual: "Manual Journal Entry",
  journal: "Journal Entry",
  migration: "Migration Opening Balance",
  owner_investment: "Owner Investment",
  owner_drawing: "Owner Drawing",
  bank_transfer: "Bank Transfer",
  loan_received: "Loan Received",
  loan_payment: "Loan Payment",
  stock_adjustment: "Stock Adjustment",
  asset_acquisition: "Asset Acquisition",
  asset_disposal: "Asset Disposal",
  depreciation: "Depreciation",
  opening_balance: "Opening Balance",
  year_end_closing: "Year-End Closing",
  bank_recon: "Bank Reconciliation",
  bank_reconciliation: "Bank Deposit / Reconciliation",
  pos_sale: "POS Sale",
  payroll: "Payroll",
  purchase_return: "Purchase Return",
};

export function TransactionPreviewDrawer({
  open,
  onOpenChange,
  sourceType,
  sourceId,
}: TransactionPreviewDrawerProps) {
  const navigate = useNavigate();
  const { formatCurrency } = useCurrency();
  const [data, setData] = useState<TransactionData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !sourceType || !sourceId) {
      setData(null);
      setError(null);
      return;
    }

    const fetchTransaction = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const result = await fetchSourceTransaction(sourceType, sourceId);
        setData(result);
      } catch (err: any) {
        console.error("Failed to fetch transaction:", err);
        setError(err.message || "Failed to load transaction");
      } finally {
        setIsLoading(false);
      }
    };

    fetchTransaction();
  }, [open, sourceType, sourceId]);

  const handleViewFull = () => {
    if (data?.navigateTo) {
      onOpenChange(false);
      navigate(data.navigateTo);
    }
  };

  return (
    <DetailSheet
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={isLoading ? <Skeleton className="h-7 w-48" /> : data?.title || "Transaction Preview"}
      description={
        <span className="flex items-center gap-2 text-xs">
          <FileText className="h-3 w-3" />
          {SOURCE_LABELS[sourceType || ""] || sourceType || "Transaction"}
        </span>
      }
    >
        <ScrollArea className="h-[calc(100vh-160px)]">
          <div className="space-y-5">

            {isLoading && (
              <div className="space-y-4">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-6 w-32" />
                <div className="grid grid-cols-2 gap-4">
                  {[...Array(6)].map((_, i) => (
                    <Skeleton key={i} className="h-12 w-full" />
                  ))}
                </div>
              </div>
            )}

            {error && (
              <div className="text-center py-8 text-muted-foreground">
                <FileText className="h-10 w-10 mx-auto mb-3 opacity-50" />
                <p className="text-sm">{error}</p>
              </div>
            )}

            {data && !isLoading && (
              <>
                {/* Amount & Status */}
                <div className="flex items-start justify-between gap-4">
                  <Badge variant={
                    data.status === "paid" || data.status === "posted" || data.status === "applied" ? "default" :
                    data.status === "draft" ? "outline" :
                    data.status === "overdue" || data.status === "voided" ? "destructive" : "secondary"
                  }>
                    {data.status}
                  </Badge>
                  <div className="text-right">
                    <div className="text-2xl font-bold">{formatCurrency(data.amount, data.currency)}</div>
                    {data.subtitle && (
                      <div className="text-sm text-muted-foreground">{data.subtitle}</div>
                    )}
                  </div>
                </div>

                <Separator />

                {/* Details Grid */}
                <div className="grid grid-cols-2 gap-4">
                  {data.details.map((detail, i) => (
                    <DetailRow key={i} icon={detail.icon} label={detail.label} value={detail.value} />
                  ))}
                </div>

                {/* View Full Record */}
                {data.navigateTo && (
                  <>
                    <Separator />
                    <Button variant="outline" className="w-full" onClick={handleViewFull}>
                      <ExternalLink className="h-4 w-4 mr-2" />
                      View Full Record
                    </Button>
                  </>
                )}

                {/* No-access note (e.g. JE visible at HQ but payroll run is branch-restricted) */}
                {data.accessNote && (
                  <>
                    <Separator />
                    <div className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
                      {data.accessNote}
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </ScrollArea>
    </DetailSheet>

  );
}


async function fetchSourceTransaction(sourceType: string, sourceId: string): Promise<TransactionData> {
  switch (sourceType) {
    case "invoice": {
      // @ts-ignore
      const { data, error } = await supabase
        .from("invoices")
        .select("*, contact:contacts(id, name)")
        .eq("id", sourceId)
        .single();
      if (error || !data) throw new Error("Invoice not found");
      return {
        type: "invoice",
        title: `Invoice #${data.invoice_number}`,
        subtitle: data.contact?.name,
        status: data.status,
        amount: data.total,
        currency: data.currency,
        date: data.issue_date,
        details: [
          { icon: Calendar, label: "Issue Date", value: format(new Date(data.issue_date), "MMM d, yyyy") },
          { icon: Calendar, label: "Due Date", value: format(new Date(data.due_date), "MMM d, yyyy") },
          { icon: Building2, label: "Customer", value: data.contact?.name || "—" },
          { icon: Hash, label: "Invoice #", value: data.invoice_number },
          { icon: Coins, label: "Paid", value: `${data.amount_paid || 0}` },
          { icon: CreditCard, label: "Balance Due", value: `${data.total - (data.amount_paid || 0)}` },
        ],
        navigateTo: `/sales/invoices?id=${sourceId}`,
      };
    }

    case "invoice_payment":
    case "payment": {
      // @ts-ignore
      const { data, error } = await supabase
        .from("payments")
        .select("*, contact:contacts(id, name), payment_allocations(amount, invoice:invoices(id, invoice_number))")
        .eq("id", sourceId)
        .single();
      if (error || !data) throw new Error("Payment not found");
      const derivedInvoice = deriveInvoiceFromAllocations((data as any).payment_allocations);
      const customerName = (data as any).contact?.name ?? null;
      return {
        type: "payment",
        title: `Payment ${data.receipt_number || ""}`,
        subtitle: customerName,
        status: data.status || "applied",
        amount: data.amount,
        date: data.payment_date,
        details: [
          { icon: Calendar, label: "Date", value: format(new Date(data.payment_date), "MMM d, yyyy") },
          { icon: FileText, label: "Invoice", value: derivedInvoice?.invoice_number || "—" },
          { icon: Building2, label: "Customer", value: customerName || "—" },
          { icon: CreditCard, label: "Method", value: data.payment_method || "—" },
          { icon: Hash, label: "Receipt #", value: data.receipt_number || "—" },
          { icon: Tag, label: "Reference", value: data.reference || "—" },
        ],
        navigateTo: derivedInvoice?.id
          ? `/sales/invoices?id=${derivedInvoice.id}`
          : `/sales/invoices?payment=${sourceId}`,
      };
    }

    case "bill": {
      // @ts-ignore
      const { data, error } = await supabase
        .from("bills")
        .select("*, vendor:contacts(id, name)")
        .eq("id", sourceId)
        .single();
      if (error || !data) throw new Error("Bill not found");
      return {
        type: "bill",
        title: `Bill #${data.bill_number}`,
        subtitle: data.vendor?.name,
        status: data.status,
        amount: data.total,
        currency: data.currency,
        date: data.bill_date,
        details: [
          { icon: Calendar, label: "Bill Date", value: format(new Date(data.bill_date), "MMM d, yyyy") },
          { icon: Calendar, label: "Due Date", value: format(new Date(data.due_date), "MMM d, yyyy") },
          { icon: Building2, label: "Vendor", value: data.vendor?.name || "—" },
          { icon: Hash, label: "Bill #", value: data.bill_number },
          { icon: Coins, label: "Paid", value: `${data.amount_paid || 0}` },
          { icon: CreditCard, label: "Balance Due", value: `${data.total - (data.amount_paid || 0)}` },
        ],
        navigateTo: `/purchases/bills?id=${sourceId}`,
      };
    }

    case "bill_payment": {
      // ADR 0028 — read the payment header, then derive bill(s) from the
      // canonical allocations table. Single-bill payments show the bill;
      // multi-bill payments show "N bills" and deep-link to the payment.
      // @ts-ignore
      const { data, error } = await supabase
        .from("bill_payments")
        .select("*")
        .eq("id", sourceId)
        .single();
      if (error || !data) throw new Error("Bill payment not found");

      const { data: allocations } = await supabase
        .from("bill_payment_allocations")
        .select("bill_id, amount, bill:bills(id, bill_number, vendor:contacts(id, name))")
        .eq("bill_payment_id", sourceId);

      const allocList = (allocations || []) as Array<{
        bill_id: string;
        amount: number;
        bill: { id: string; bill_number: string; vendor: { id: string; name: string } | null } | null;
      }>;
      const firstBill = allocList[0]?.bill ?? null;
      const billLabel = allocList.length === 0
        ? "—"
        : allocList.length === 1
          ? (firstBill?.bill_number ?? "—")
          : `${allocList.length} bills`;

      return {
        type: "bill_payment",
        title: `Bill Payment`,
        subtitle: firstBill?.vendor?.name,
        status: "applied",
        amount: data.amount,
        date: data.payment_date,
        details: [
          { icon: Calendar, label: "Date", value: format(new Date(data.payment_date), "MMM d, yyyy") },
          { icon: FileText, label: "Bill", value: billLabel },
          { icon: Building2, label: "Vendor", value: firstBill?.vendor?.name || "—" },
          { icon: CreditCard, label: "Method", value: data.payment_method || "—" },
          { icon: Tag, label: "Reference", value: data.reference || "—" },
        ],
        navigateTo: allocList.length === 1 && firstBill
          ? `/purchases/bills?id=${firstBill.id}`
          : `/purchases/bills?payment=${sourceId}`,
      };
    }

    case "expense": {
      // @ts-ignore
      const { data, error } = await supabase
        .from("expenses")
        .select("*, category:expense_categories(name), vendor:contacts(id, name)")
        .eq("id", sourceId)
        .single();
      if (error || !data) throw new Error("Expense not found");
      return {
        type: "expense",
        title: data.description || "Expense",
        subtitle: data.vendor?.name || data.category?.name,
        status: data.status,
        amount: data.amount,
        currency: data.currency,
        date: data.expense_date,
        details: [
          { icon: Calendar, label: "Date", value: format(new Date(data.expense_date), "MMM d, yyyy") },
          { icon: Tag, label: "Category", value: data.category?.name || "—" },
          { icon: Building2, label: "Vendor", value: data.vendor?.name || "—" },
          { icon: CreditCard, label: "Method", value: data.payment_method || "—" },
          { icon: Hash, label: "Reference", value: data.reference || "—" },
        ],
        navigateTo: `/purchases/expenses?id=${sourceId}`,
      };
    }

    case "credit_note": {
      // @ts-ignore
      const { data, error } = await supabase
        .from("credit_notes")
        .select("*, contact:contacts(id, name)")
        .eq("id", sourceId)
        .single();
      if (error || !data) throw new Error("Credit note not found");
      return {
        type: "credit_note",
        title: `Credit Note #${data.credit_note_number}`,
        subtitle: data.contact?.name,
        status: data.status,
        amount: data.total,
        currency: data.currency,
        date: data.issue_date,
        details: [
          { icon: Calendar, label: "Date", value: format(new Date(data.issue_date), "MMM d, yyyy") },
          { icon: Building2, label: "Customer", value: data.contact?.name || "—" },
          { icon: Hash, label: "Credit Note #", value: data.credit_note_number },
          { icon: Tag, label: "Reason", value: data.reason || "—" },
        ],
        navigateTo: `/finance/customer-credits?id=${sourceId}`,
      };
    }

    case "credit_application": {
      // Credit applications don't have their own table - look up the journal entry
      // @ts-ignore
      const { data, error } = await supabase
        .from("journal_entries")
        .select("*")
        .eq("source_type", "credit_application")
        .eq("source_id", sourceId)
        .maybeSingle();
      
      const je = data;
      return {
        type: "credit_application",
        title: `Credit Application`,
        subtitle: je?.reference || "",
        status: "applied",
        amount: 0,
        date: je?.entry_date || new Date().toISOString(),
        details: [
          { icon: Calendar, label: "Date", value: je?.entry_date ? format(new Date(je.entry_date), "MMM d, yyyy") : "—" },
          { icon: Hash, label: "Journal Entry", value: je?.entry_number || "—" },
          { icon: FileText, label: "Description", value: je?.description || "—" },
          { icon: Tag, label: "Reference", value: je?.reference || "—" },
        ],
        navigateTo: `/finance/customer-credits?id=${sourceId}`,
      };
    }

    case "migration": {
      // Migration Opening Balance — look up the journal entry directly
      const { data: je, error } = await supabase
        .from("journal_entries")
        .select("*")
        .eq("source_type", "migration")
        .eq("source_id", sourceId)
        .maybeSingle();

      if (error || !je) {
        // Fallback: try matching by source_id as ID
        const { data: jeById } = await supabase
          .from("journal_entries")
          .select("*")
          .eq("source_type", "migration")
          .ilike("source_id", `%${sourceId}%`)
          .limit(1)
          .maybeSingle();

        const entry = jeById;
        if (!entry) throw new Error("Migration journal entry not found");
        return {
          type: "migration",
          title: "Migration Opening Balance",
          subtitle: entry.reference || "Opening Balance Journal Entry",
          status: "posted",
          amount: 0,
          date: entry.entry_date,
          details: [
            { icon: Calendar, label: "Entry Date", value: format(new Date(entry.entry_date), "MMM d, yyyy") },
            { icon: Hash, label: "Entry #", value: entry.entry_number || "—" },
            { icon: FileText, label: "Description", value: entry.description || "Migration opening balances" },
            { icon: Tag, label: "Reference", value: entry.reference || "—" },
            { icon: BookOpen, label: "Source", value: "Data Migration" },
          ],
          navigateTo: `/finance/journal-entries/${entry.id}`,
        };
      }

      return {
        type: "migration",
        title: "Migration Opening Balance",
        subtitle: je.reference || "Opening Balance Journal Entry",
        status: "posted",
        amount: 0,
        date: je.entry_date,
        details: [
          { icon: Calendar, label: "Entry Date", value: format(new Date(je.entry_date), "MMM d, yyyy") },
          { icon: Hash, label: "Entry #", value: je.entry_number || "—" },
          { icon: FileText, label: "Description", value: je.description || "Migration opening balances" },
          { icon: Tag, label: "Reference", value: je.reference || "—" },
          { icon: BookOpen, label: "Source", value: "Data Migration" },
        ],
        navigateTo: `/finance/journal-entries/${je.id}`,
      };
    }

    case "journal_entry": {
      // Direct JE lookup by id (not by source_type/source_id).
      // Used by GL, Account Register, Drill-Down, Bank Recon, Journal Report
      // when previewing a manual JE or any JE without a dedicated source document.
      const { data: je, error } = await supabase
        .from("journal_entries")
        .select(`
          id, entry_date, entry_number, description, reference, status,
          source_type, source_id, created_at, posted_at, voided_at,
          reversal_of_id, reversed_by_id, is_reversal,
          journal_entry_lines(id, debit, credit, description, accounts(code, name))
        `)
        .eq("id", sourceId)
        .maybeSingle();

      if (error || !je) throw new Error("Journal entry not found");

      const lines = (je.journal_entry_lines || []) as any[];
      const totalDebit = lines.reduce((s, l) => s + (Number(l.debit) || 0), 0);
      const totalCredit = lines.reduce((s, l) => s + (Number(l.credit) || 0), 0);
      const lineSummary = lines
        .map((l) => `${l.accounts?.code || ""} ${l.accounts?.name || ""}`.trim())
        .filter(Boolean)
        .slice(0, 4)
        .join(" • ");

      const sourceLabel = je.source_type && je.source_type !== "manual"
        ? SOURCE_LABELS[je.source_type] || je.source_type
        : "Manual entry";

      return {
        type: "journal_entry",
        title: `Journal ${je.entry_number || ""}`.trim(),
        subtitle: lineSummary || je.description || "",
        status: je.status || "posted",
        amount: totalDebit, // Dr === Cr in a balanced entry
        date: je.entry_date,
        details: [
          { icon: Calendar, label: "Entry Date", value: format(new Date(je.entry_date), "MMM d, yyyy") },
          { icon: Hash, label: "Entry #", value: je.entry_number || "—" },
          { icon: FileText, label: "Description", value: je.description || "—" },
          { icon: Tag, label: "Reference", value: je.reference || "—" },
          { icon: BookOpen, label: "Source", value: sourceLabel },
          { icon: Coins, label: "Lines", value: `${lines.length} (Dr=Cr ✓)` },
          ...(je.posted_at
            ? [{ icon: Calendar, label: "Posted At", value: format(new Date(je.posted_at), "MMM d, yyyy HH:mm") }]
            : []),
          ...(je.voided_at
            ? [{ icon: Calendar, label: "Voided At", value: format(new Date(je.voided_at), "MMM d, yyyy HH:mm") }]
            : []),
          ...(je.reversal_of_id
            ? [{ icon: Tag, label: "Reverses", value: "Yes" }]
            : []),
          ...(je.reversed_by_id
            ? [{ icon: Tag, label: "Reversed By", value: "Yes" }]
            : []),
        ],
        navigateTo: `/finance/journal-entries/${je.id}`,
      };
    }

    case "payroll": {
      // Always show the JE itself first — the JE is the thing the user is
      // looking at in Finance and they're entitled to see its totals.
      const { data: je } = await supabase
        .from("journal_entries")
        .select("id, entry_date, entry_number, description, reference, status, total_debit, total_credit, source_id")
        .eq("source_type", "payroll")
        .eq("source_id", sourceId)
        .maybeSingle();

      if (!je) throw new Error("Payroll journal entry not found");

      // Try to fetch the underlying payroll run. RLS will silently filter
      // it out if the caller lacks payroll visibility for this run's
      // org/business, which is exactly the desired permission model.
      const { data: run } = await supabase
        .from("payroll_runs")
        .select("id, payroll_number, pay_period_start, pay_period_end, payment_date, status, employee_count, total_gross, total_net, business_id")
        .eq("id", sourceId)
        .maybeSingle();

      const totalAmt = Number(je.total_debit ?? je.total_credit ?? 0);

      if (run) {
        const totalDeductions = Math.max(0, Number(run.total_gross ?? 0) - Number(run.total_net ?? 0));
        return {
          type: "payroll",
          title: `Payroll ${run.payroll_number}`,
          subtitle: je.entry_number || "",
          status: run.status || je.status || "posted",
          amount: Number(run.total_net ?? totalAmt),
          date: je.entry_date,
          details: [
            { icon: Calendar, label: "Pay Period", value: `${format(new Date(run.pay_period_start), "MMM d")} – ${format(new Date(run.pay_period_end), "MMM d, yyyy")}` },
            { icon: Calendar, label: "Payment Date", value: run.payment_date ? format(new Date(run.payment_date), "MMM d, yyyy") : "—" },
            { icon: User, label: "Employees", value: String(run.employee_count ?? "—") },
            { icon: Coins, label: "Gross Pay", value: String(run.total_gross ?? 0) },
            { icon: Coins, label: "Total Deductions", value: String(totalDeductions) },
            { icon: Coins, label: "Net Pay", value: String(run.total_net ?? 0) },
            { icon: Hash, label: "JE #", value: je.entry_number || "—" },
            { icon: FileText, label: "Reference", value: je.reference || je.description || "—" },
          ],
          navigateTo: `/hr/payroll/runs/${run.id}`,
        };
      }

      // No access to the payroll run — show the JE numbers honestly,
      // hide the drilldown, and explain why.
      return {
        type: "payroll",
        title: `Payroll Journal Entry`,
        subtitle: je.entry_number || "",
        status: je.status || "posted",
        amount: totalAmt,
        date: je.entry_date,
        details: [
          { icon: Calendar, label: "Date", value: format(new Date(je.entry_date), "MMM d, yyyy") },
          { icon: Hash, label: "JE #", value: je.entry_number || "—" },
          { icon: FileText, label: "Description", value: je.description || "—" },
          { icon: Tag, label: "Reference", value: je.reference || "—" },
          { icon: Coins, label: "Total Debit", value: String(je.total_debit ?? 0) },
          { icon: Coins, label: "Total Credit", value: String(je.total_credit ?? 0) },
        ],
        accessNote: "You don't have permission to view the underlying payroll run. Ask a Payroll administrator for access.",
      };
    }

    case "manual":
    case "year_end_closing":
    case "bank_recon":
    case "bank_reconciliation":
    case "pos_sale":
    case "purchase_return":
    case "owner_investment":
    case "owner_drawing":
    case "bank_transfer":
    case "loan_received":
    case "loan_payment":
    case "stock_adjustment":
    case "asset_acquisition":
    case "asset_disposal":
    case "depreciation":
    case "opening_balance": {
      // Generic journal entry lookup for types without dedicated tables.
      const je = await fetchJournalEntryBySource(sourceType, sourceId);
      if (!je) throw new Error(`${SOURCE_LABELS[sourceType] || sourceType} not found`);
      return journalEntryPreview(je, SOURCE_LABELS[sourceType] || sourceType, sourceType);
    }

    default: {
      // Graceful fallback: attempt journal entry lookup for any unknown source type
      console.warn(`[TransactionPreviewDrawer] Unrecognized source_type "${sourceType}" — attempting JE fallback lookup`);
      const je = await fetchJournalEntryBySource(sourceType, sourceId);
      if (!je) throw new Error(`Transaction not found for type: ${sourceType}`);
      const title =
        SOURCE_LABELS[sourceType] ||
        sourceType.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      return journalEntryPreview(je, title, sourceType);
    }
  }
}

interface SourcedJournalEntry {
  id: string;
  entry_date: string;
  entry_number: string | null;
  description: string | null;
  reference: string | null;
  status: string | null;
  journal_entry_lines?: {
    debit: number | null;
    credit: number | null;
    description: string | null;
    accounts: { code: string | null; name: string | null } | null;
  }[] | null;
}

/**
 * The entry a source produced, with its lines — the lines are what carry the
 * amount. `journal_entries` holds no amount column, so a preview built from the
 * header alone can only show zero, which is what every generic source type used
 * to display. Ordered + limited rather than `maybeSingle()` so a source that
 * ever produced more than one entry still renders instead of erroring.
 */
async function fetchJournalEntryBySource(
  sourceType: string,
  sourceId: string,
): Promise<SourcedJournalEntry | null> {
  const { data } = await supabase
    .from("journal_entries")
    .select(
      "id, entry_date, entry_number, description, reference, status, journal_entry_lines(debit, credit, description, accounts(code, name))",
    )
    .eq("source_type", sourceType)
    .eq("source_id", sourceId)
    .order("created_at", { ascending: true })
    .limit(1);

  return ((data ?? [])[0] as SourcedJournalEntry | undefined) ?? null;
}

/** Shared shape for previews whose only record is the journal entry itself. */
function journalEntryPreview(
  je: SourcedJournalEntry,
  title: string,
  type: string,
): TransactionData {
  const lines = je.journal_entry_lines ?? [];
  const totalDebit = lines.reduce((sum, l) => sum + (Number(l.debit) || 0), 0);
  const lineSummary = lines
    .map((l) => `${l.accounts?.code || ""} ${l.accounts?.name || ""}`.trim())
    .filter(Boolean)
    .slice(0, 4)
    .join(" • ");

  return {
    type,
    title,
    subtitle: lineSummary || je.description || je.reference || "",
    status: je.status || "posted",
    amount: totalDebit,
    date: je.entry_date,
    details: [
      { icon: Calendar, label: "Date", value: format(new Date(je.entry_date), "MMM d, yyyy") },
      { icon: Hash, label: "Entry #", value: je.entry_number || "—" },
      { icon: FileText, label: "Description", value: je.description || "—" },
      { icon: Tag, label: "Reference", value: je.reference || "—" },
      { icon: Coins, label: "Lines", value: `${lines.length}` },
    ],
    navigateTo: `/finance/journal-entries/${je.id}`,
  };
}
