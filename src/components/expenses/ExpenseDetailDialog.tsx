import { format } from "date-fns";
import { DetailRow } from "@/components/common/DetailRow";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { ClickableEntity } from "@/components/common/ClickableEntity";
import { ContactPreviewDrawer } from "@/components/contacts/ContactPreviewDrawer";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Calendar,
  Receipt,
  User,
  FileText,
  CreditCard,
  BookOpen,
  ExternalLink,
  Lock,
  Tag,
  Building2,
  Hash,
  Coins,
  Clock,
  CheckCircle2,
  XCircle,
  AlertCircle,
} from "lucide-react";
import { useCurrency } from "@/hooks/useCurrency";
import { DocumentHistoryTab } from "@/components/common/DocumentHistoryTab";

interface ExpenseDetailDialogProps {
  expense: {
    id: string;
    expense_date: string;
    description: string;
    amount: number;
    tax_amount: number;
    reference?: string | null;
    status: string;
    currency?: string;
    payment_method?: string | null;
    is_billable: boolean;
    receipt_url?: string | null;
    journal_entry_id?: string | null;
    vendor_id?: string | null;
    category?: { name: string; color: string } | null;
    vendor?: { name: string } | null;
    payment_account?: { code: string; name: string } | null;
    account?: { code: string; name: string } | null;
  } | null;
  linkedBill?: { id: string; status: string; bill_number: string } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onVoid?: (expenseId: string) => void;
}

interface JournalEntryInfo {
  id: string;
  entry_number: string;
  entry_date: string;
  description: string;
  status: string;
  lines: {
    account_name: string;
    account_code: string;
    debit: number;
    credit: number;
  }[];
}

const statusConfig: Record<string, { icon: React.ElementType; color: string; label: string }> = {
  pending: { icon: Clock, label: "Pending Approval", color: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300" },
  approved: { icon: CheckCircle2, label: "Approved", color: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300" },
  paid: { icon: CreditCard, label: "Paid", color: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300" },
  rejected: { icon: XCircle, label: "Rejected", color: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300" },
  voided: { icon: XCircle, label: "Voided", color: "bg-muted text-muted-foreground" },
};

export function ExpenseDetailDialog({ expense, linkedBill, open, onOpenChange, onVoid }: ExpenseDetailDialogProps) {
  const { formatCurrency, baseCurrency } = useCurrency();
  const navigate = useNavigate();
  const [journalEntry, setJournalEntry] = useState<JournalEntryInfo | null>(null);
  const [isLoadingJE, setIsLoadingJE] = useState(false);
  const [contactDrawerOpen, setContactDrawerOpen] = useState(false);
  const [contactDrawerId, setContactDrawerId] = useState<string | null>(null);

  useEffect(() => {
    if (!expense?.journal_entry_id || !open) {
      setJournalEntry(null);
      return;
    }

    const fetchJE = async () => {
      setIsLoadingJE(true);
      try {
        // @ts-ignore - tables not in auto-generated types
        const { data: je } = await supabase
          .from("journal_entries")
          .select("id, entry_number, entry_date, description, status")
          .eq("id", expense.journal_entry_id)
          .single();

        if (je) {
          // @ts-ignore
          const { data: lines } = await supabase
            .from("journal_entry_lines")
            .select("debit, credit, accounts:account_id(name, code)")
            .eq("journal_entry_id", je.id)
            .order("debit", { ascending: false });

          setJournalEntry({
            ...je,
            lines: (lines || []).map((l: any) => ({
              account_name: l.accounts?.name || "Unknown",
              account_code: l.accounts?.code || "",
              debit: l.debit || 0,
              credit: l.credit || 0,
            })),
          });
        }
      } catch (err) {
        console.error("Error fetching journal entry:", err);
      } finally {
        setIsLoadingJE(false);
      }
    };

    fetchJE();
  }, [expense?.journal_entry_id, open]);

  if (!expense) return null;

  const status = statusConfig[expense.status] || statusConfig.pending;
  const StatusIcon = status.icon;
  const isLocked = expense.status === "approved" || expense.status === "paid";
  const cur = expense.currency || baseCurrency;

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] p-0">
        <DialogHeader className="px-6 pt-6 pb-0">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1 min-w-0">
              <DialogTitle className="text-xl">{expense.description}</DialogTitle>
              <div className="flex items-center gap-2 flex-wrap">
                <Badge className={status.color}>
                  <StatusIcon className="h-3 w-3 mr-1" />
                  {status.label}
                </Badge>
                {isLocked && (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Lock className="h-3 w-3" />
                    Read-only
                  </span>
                )}
              </div>
            </div>
            <div className="text-right shrink-0">
              <div className="text-2xl font-bold">{formatCurrency(expense.amount, cur)}</div>
              {expense.tax_amount > 0 && (
                <div className="text-sm text-muted-foreground">
                  Tax: {formatCurrency(expense.tax_amount, cur)}
                </div>
              )}
            </div>
          </div>
        </DialogHeader>

        <ScrollArea className="max-h-[60vh]">
          <div className="px-6 pb-6 space-y-5">
            <Separator />

            {/* Details Grid */}
            <div className="grid grid-cols-2 gap-4">
              <DetailRow icon={Calendar} label="Date" value={format(new Date(expense.expense_date), "MMMM d, yyyy")} />
              <DetailRow icon={Tag} label="Category" value={
                expense.category ? (
                  <span className="flex items-center gap-1.5">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: expense.category.color }} />
                    {expense.category.name}
                  </span>
                ) : "—"
              } />
              <DetailRow icon={Building2} label="Supplier" value={
                expense.vendor_id ? (
                  <ClickableEntity onClick={() => { setContactDrawerId(expense.vendor_id!); setContactDrawerOpen(true); }}>
                    {expense.vendor?.name || "—"}
                  </ClickableEntity>
                ) : (expense.vendor?.name || "—")
              } />
              <DetailRow icon={CreditCard} label="Payment Method" value={expense.payment_method || "—"} />
              <DetailRow icon={Coins} label="Paid From" value={
                expense.payment_account
                  ? `${expense.payment_account.code} — ${expense.payment_account.name}`
                  : "—"
              } />
              <DetailRow icon={Hash} label="Reference" value={expense.reference || "—"} />
              <DetailRow icon={BookOpen} label="Expense Account" value={
                expense.account
                  ? `${expense.account.code} — ${expense.account.name}`
                  : "Default"
              } />
              <DetailRow icon={Receipt} label="Billable" value={expense.is_billable ? "Yes" : "No"} />
            </div>

            {/* Receipt */}
            {expense.receipt_url && (
              <>
                <Separator />
                <div>
                  <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                    <Receipt className="h-4 w-4" />
                    Attached Receipt
                  </h4>
                  <a
                    href={expense.receipt_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-primary hover:underline flex items-center gap-1"
                  >
                    View Receipt <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
              </>
            )}

            {/* Journal Entry */}
            {journalEntry && (
              <>
                <Separator />
                <div>
                  <h4 className="text-sm font-medium mb-3 flex items-center gap-2">
                    <BookOpen className="h-4 w-4" />
                    Journal Entry — {journalEntry.entry_number}
                  </h4>
                  <div className="rounded-lg border overflow-hidden">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-muted/50">
                          <th className="text-left px-3 py-2 font-medium">Account</th>
                          <th className="text-right px-3 py-2 font-medium">Debit</th>
                          <th className="text-right px-3 py-2 font-medium">Credit</th>
                        </tr>
                      </thead>
                      <tbody>
                        {journalEntry.lines.map((line, i) => (
                          <tr key={i} className="border-t">
                            <td className="px-3 py-2">
                              <span className="text-muted-foreground mr-1">{line.account_code}</span>
                              {line.account_name}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums">
                              {line.debit > 0 ? formatCurrency(line.debit, cur) : "—"}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums">
                              {line.credit > 0 ? formatCurrency(line.credit, cur) : "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1.5">
                    Status: <Badge variant="outline" className="text-[10px] ml-1">{journalEntry.status}</Badge>
                  </p>
                </div>
              </>
            )}

            {isLoadingJE && expense.journal_entry_id && (
              <>
                <Separator />
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <BookOpen className="h-4 w-4 animate-pulse" />
                  Loading journal entry...
                </div>
              </>
            )}

            {/* Linked Bill */}
            {linkedBill && (
              <>
                <Separator />
                <div>
                  <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                    <FileText className="h-4 w-4" />
                    Linked Vendor Bill
                  </h4>
                  <div
                    className="flex items-center gap-3 rounded-lg border p-3 cursor-pointer hover:bg-muted/50 transition-colors"
                    onClick={() => {
                      onOpenChange(false);
                      navigate(`/purchases/bills?id=${linkedBill.id}`);
                    }}
                  >
                    <FileText className="h-5 w-5 text-muted-foreground" />
                    <div className="flex-1">
                      <div className="font-medium text-sm text-primary">{linkedBill.bill_number}</div>
                      <div className="text-xs text-muted-foreground">
                        Vendor bill created from this expense
                      </div>
                    </div>
                    <Badge variant="outline" className="capitalize">{linkedBill.status}</Badge>
                  </div>
                </div>
              </>
            )}

            {/* Void Action — for approved/paid expenses */}
            {onVoid && isLocked && expense.status !== "voided" && (
              <>
                <Separator />
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={() => {
                      onVoid(expense.id);
                      onOpenChange(false);
                    }}
                    className="inline-flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-2 text-sm font-medium text-destructive hover:bg-destructive/20 transition-colors"
                  >
                    <XCircle className="h-4 w-4" />
                    Void Expense
                  </button>
                </div>
              </>
            )}

            {/* Accounting Lock Notice */}
            {isLocked && expense.status !== "voided" && (
              <>
                <Separator />
                <div className="flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950 p-3">
                  <AlertCircle className="h-4 w-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
                  <div className="text-xs text-amber-700 dark:text-amber-300">
                    <strong>This expense is locked.</strong> Approved and paid expenses cannot be edited because
                    they have been posted to the general ledger. Editing would create discrepancies in the books
                    of account. To make corrections, void this expense and create a new one.
                  </div>
                </div>
              </>
            )}

            {/* Voided Notice */}
            {expense.status === "voided" && (
              <>
                <Separator />
                <div className="flex items-start gap-2.5 rounded-lg border border-muted p-3">
                  <XCircle className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                  <div className="text-xs text-muted-foreground">
                    <strong>This expense has been voided.</strong> A reversing journal entry was created to negate the original GL impact. This record is preserved for audit trail purposes.
                  </div>
                </div>
              </>
            )}

            {/* History Timeline */}
            <Separator />
            <div>
              <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                <Clock className="h-4 w-4" />
                Activity History
              </h4>
              <DocumentHistoryTab entityType="expense" entityId={expense.id} />
            </div>
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>

    <ContactPreviewDrawer
      open={contactDrawerOpen}
      onOpenChange={setContactDrawerOpen}
      contactId={contactDrawerId}
    />
    </>
  );
}
