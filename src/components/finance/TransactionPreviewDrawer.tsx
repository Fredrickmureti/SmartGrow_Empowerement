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
import { useBusinesses } from "@/hooks/useBusinesses";
import { format } from "date-fns";

interface TransactionPreviewDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sourceType: string | null;
  sourceId: string | null;
  /**
   * Company that owns this record. Consolidated surfaces preview records that
   * belong to a member company other than the active workspace: the amount must
   * be labelled in that company's own currency, and "View full record" must
   * land the viewer in that company's books rather than dropping them on an
   * empty page in the currently selected company.
   */
  businessId?: string | null;
  businessName?: string | null;
  /**
   * Currency of the books the record was posted in, used when the fetched
   * record carries no currency of its own (journal entries are recorded in the
   * owning company's base currency). Without this the ambient workspace
   * currency would be stamped onto another company's amount.
   */
  fallbackCurrency?: string | null;
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
  businessId,
  businessName,
  fallbackCurrency,
}: TransactionPreviewDrawerProps) {
  const navigate = useNavigate();
  const { formatCurrency } = useCurrency();
  const { currentBusiness, switchBusiness } = useBusinesses();
  const [switching, setSwitching] = useState(false);
  const foreignBusiness = !!businessId && businessId !== currentBusiness?.id;
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

  // A record belongs to exactly one company. Navigating to it without moving
  // the workspace to that company lands on a page scoped to the wrong books —
  // the record is filtered out and the page reads as empty. So the workspace
  // follows the record: switch first, then navigate.
  const handleViewFull = async () => {
    if (!data?.navigateTo) return;
    try {
      if (foreignBusiness && businessId) {
        setSwitching(true);
        await switchBusiness(businessId);
      }
      onOpenChange(false);
      navigate(data.navigateTo);
    } finally {
      setSwitching(false);
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
                    <div className="text-2xl font-bold">
                      {formatCurrency(data.amount, data.currency ?? fallbackCurrency ?? undefined)}
                    </div>
                    {data.subtitle && (
                      <div className="text-sm text-muted-foreground">{data.subtitle}</div>
                    )}
                    {foreignBusiness && businessName && (
                      <div className="text-xs text-muted-foreground">Books of {businessName}</div>
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
                    <Button
                      variant="outline"
                      className="w-full"
                      onClick={handleViewFull}
                      disabled={switching}
                    >
                      {switching ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <ExternalLink className="h-4 w-4 mr-2" />
                      )}
                      View Full Record
                    </Button>
                    {foreignBusiness && (
                      <p className="text-xs text-muted-foreground text-center">
                        This record is kept in {businessName ?? "another company"}'s books —
                        opening it switches your workspace to that company.
                      </p>
                    )}
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
    // Sales/purchase document previews were removed with the ERP chain; those
    // source types now resolve through the generic journal-entry fallback.


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

    case "payroll":

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

  return ((data ?? [])[0] as unknown as SourcedJournalEntry | undefined) ?? null;
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
