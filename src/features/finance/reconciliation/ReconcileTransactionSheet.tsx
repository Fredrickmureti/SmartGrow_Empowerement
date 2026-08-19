/**
 * ReconcileTransactionSheet — enterprise side-rail replacement for the
 * legacy `ReconcileTransactionDialog` modal. Presents the same match
 * surface (Invoices / Bills / Expenses / Journal) inside the shared
 * `DetailSheet` primitive from `@/design-system` so users never lose
 * page context while matching a bank transaction.
 *
 * Behaviour ported verbatim from the legacy dialog:
 *  - Multi-select allocation for invoices and bills
 *  - Amount-matched expense picker (RadioGroup)
 *  - Manual / Create Journal Entry against a chosen offset account
 *  - Same `onReconcile` contract, unchanged permission gates
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DetailSheet,
  FooterActionBar,
  ActionBar,
} from "@/design-system";
import { useInvoices } from "@/hooks/useInvoices";
import { useBills } from "@/hooks/useBills";
import { useExpenses } from "@/hooks/useExpenses";
import { useAccounts } from "@/hooks/useAccounts";
import { formatDate, cn } from "@/lib/utils";
import { useBankMoney } from "@/hooks/useBankAccountCurrency";
import { useBankMatchCandidates, TIER_COPY, isExplainedTier } from "@/hooks/useBankMatchCandidates";

import {
  Search,
  FileText,
  Receipt,
  CreditCard,
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  BookOpen,
  Sparkles,
} from "lucide-react";

interface ReconcileTransactionSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  transaction: any;
  onReconcile: (
    transactionId: string,
    reconcileData: {
      reconciled_type:
        | "invoice"
        | "expense"
        | "bill"
        | "transfer"
        | "manual"
        | "payment"
        | "bill_payment";
      reconciled_entity_id?: string;
      category?: string;
      createGLEntry?: boolean;
      offsetAccountId?: string;
      allocations?: Array<{
        document_type:
          | "invoice"
          | "bill"
          | "account"
          | "payment"
          | "bill_payment"
          | "transfer";
        document_id: string;
        amount: number;
        description?: string;
      }>;
      feeAmount?: number;
      feeAccountId?: string;
    },
  ) => Promise<void>;
}

export function ReconcileTransactionSheet({
  open,
  onOpenChange,
  transaction,
  onReconcile,
}: ReconcileTransactionSheetProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedMatch, setSelectedMatch] = useState<{ type: string; id: string } | null>(null);
  const [selectedInvoiceIds, setSelectedInvoiceIds] = useState<string[]>([]);
  const [selectedBillIds, setSelectedBillIds] = useState<string[]>([]);
  const [chosenCandidateIndex, setChosenCandidateIndex] = useState<number | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [offsetAccountId, setOffsetAccountId] = useState("");
  const [manualDescription, setManualDescription] = useState("");

  const { invoices } = useInvoices();
  const { bills } = useBills();
  const { expenses } = useExpenses();
  const { accounts: glAccounts } = useAccounts();
  const { currencyOf, formatBankAmount, formatDocumentAmount } = useBankMoney();

  // The books answer what this line is; the client only presents the answer.
  const { data: candidateSet, isLoading: candidatesLoading } = useBankMatchCandidates(
    transaction?.id,
    open,
  );

  if (!transaction) return null;

  const isCredit = transaction.transaction_type === "credit";
  const transactionAmount = Math.abs(transaction.amount);

  /**
   * The bank line is denominated in its account's currency. A document can
   * only settle it when it is held in the same currency — settling across
   * currencies needs a rate and an FX difference, which the client may not
   * invent (ADR 0136). Mismatched candidates stay visible (so an operator can
   * see why their invoice is not offered) but are not selectable.
   */
  const txnCurrency = currencyOf(transaction.bank_account_id);
  const formatTxn = (amount: number) => formatBankAmount(amount, transaction.bank_account_id);
  const currencyMatches = (documentCurrency?: string | null) =>
    txnCurrency != null && (documentCurrency ?? null) === txnCurrency;

  const incomeExpenseAccounts =
    glAccounts?.filter(
      (a) =>
        a.account_type === "income" ||
        a.account_type === "expense" ||
        a.account_type === "asset" ||
        a.account_type === "liability",
    ) || [];

  const matchingInvoices =
    invoices?.filter((inv) => {
      const remaining = inv.total - (inv.amount_paid || 0);
      const matchesSearch =
        inv.invoice_number.toLowerCase().includes(searchQuery.toLowerCase()) ||
        inv.contact?.name?.toLowerCase().includes(searchQuery.toLowerCase());
      return matchesSearch && remaining > 0;
    }) || [];

  const matchingBills =
    bills?.filter((bill) => {
      const remaining = bill.total - (bill.amount_paid || 0);
      const matchesSearch =
        bill.bill_number.toLowerCase().includes(searchQuery.toLowerCase()) ||
        bill.vendor?.name?.toLowerCase().includes(searchQuery.toLowerCase());
      return matchesSearch && remaining > 0;
    }) || [];

  const matchingExpenses =
    expenses?.filter((exp) => {
      const matchesAmount = Math.abs(exp.amount - transactionAmount) < 0.01;
      const matchesSearch = exp.description.toLowerCase().includes(searchQuery.toLowerCase());
      return matchesSearch && matchesAmount;
    }) || [];

  const selectedInvoiceTotal = matchingInvoices

    .filter((inv) => selectedInvoiceIds.includes(inv.id))
    .reduce((sum, inv) => sum + Math.min(inv.total - (inv.amount_paid || 0), transactionAmount), 0);

  const selectedBillTotal = matchingBills
    .filter((b) => selectedBillIds.includes(b.id))
    .reduce((sum, b) => sum + Math.min(b.total - (b.amount_paid || 0), transactionAmount), 0);

  /**
   * Spread the bank line across the chosen documents, oldest first, never
   * beyond what each still owes and never beyond the line itself. If the
   * documents do not add up to the line, the seam refuses the match — the
   * client does not paper over the difference.
   */
  const allocationsFor = (
    docs: Array<{ id: string; total: number; amount_paid?: number | null }>,
    ids: string[],
    kind: "invoice" | "bill",
  ) => {
    let remainingLine = transactionAmount;
    return docs
      .filter((d) => ids.includes(d.id))
      .map((d) => {
        const open = d.total - (d.amount_paid || 0);
        const amount = Math.min(open, remainingLine);
        remainingLine -= amount;
        return { document_type: kind, document_id: d.id, amount };
      })
      .filter((a) => a.amount > 0);
  };

  const toggleInvoiceSelection = (invoiceId: string) => {
    setSelectedInvoiceIds((prev) =>
      prev.includes(invoiceId) ? prev.filter((id) => id !== invoiceId) : [...prev, invoiceId],
    );
    setSelectedMatch(null);
    setChosenCandidateIndex(null);
  };

  const toggleBillSelection = (billId: string) => {
    setSelectedBillIds((prev) =>
      prev.includes(billId) ? prev.filter((id) => id !== billId) : [...prev, billId],
    );
    setSelectedMatch(null);
    setChosenCandidateIndex(null);
  };

  const close = () => {
    onOpenChange(false);
    setSelectedInvoiceIds([]);
    setSelectedBillIds([]);
    setSelectedMatch(null);
    setChosenCandidateIndex(null);
    setOffsetAccountId("");
    setManualDescription("");
    setSearchQuery("");
  };

  /**
   * One bank line is one match. Every path below builds a single allocation
   * set and hands it over once: settling three invoices from one deposit is
   * one settlement with three allocations, never three settlements. Looping
   * per document was how a single deposit minted several receipts.
   */
  const handleReconcile = async () => {
    const chosen =
      chosenCandidateIndex !== null ? candidateSet?.candidates[chosenCandidateIndex] : undefined;

    const submit = async (
      data: Parameters<ReconcileTransactionSheetProps["onReconcile"]>[1],
    ) => {
      setIsSubmitting(true);
      try {
        await onReconcile(transaction.id, data);
        close();
      } finally {
        setIsSubmitting(false);
      }
    };

    if (chosen) {
      await submit({
        reconciled_type:
          chosen.kind === "account"
            ? "manual"
            : (chosen.kind as "invoice" | "bill" | "payment" | "bill_payment" | "transfer"),
        allocations: chosen.allocations,
        category: chosen.label,
      });
      return;
    }

    if (selectedInvoiceIds.length > 0) {
      await submit({
        reconciled_type: "invoice",
        allocations: allocationsFor(matchingInvoices, selectedInvoiceIds, "invoice"),
      });
      return;
    }

    if (selectedBillIds.length > 0) {
      await submit({
        reconciled_type: "bill",
        allocations: allocationsFor(matchingBills, selectedBillIds, "bill"),
      });
      return;
    }

    if (selectedMatch?.type === "manual") {
      if (!offsetAccountId) return;
      await submit({
        reconciled_type: "manual",
        category: manualDescription || transaction.description,
        createGLEntry: true,
        offsetAccountId,
      });
      return;
    }

    if (!selectedMatch) return;

    await submit({
      reconciled_type: selectedMatch.type as "invoice" | "expense" | "bill" | "transfer" | "manual",
      reconciled_entity_id: selectedMatch.id,
    });
  };

  const hasSelection =
    chosenCandidateIndex !== null ||
    selectedMatch ||
    selectedInvoiceIds.length > 0 ||
    selectedBillIds.length > 0;
  const isManualIncomplete = selectedMatch?.type === "manual" && !offsetAccountId;

  return (
    <DetailSheet
      open={open}
      onOpenChange={(o) => (o ? onOpenChange(true) : close())}
      size="lg"
      title="Match transaction"
      description={
        <span className="flex items-center gap-2">
          {isCredit ? (
            <ArrowDownLeft className="h-3.5 w-3.5 text-green-500" />
          ) : (
            <ArrowUpRight className="h-3.5 w-3.5 text-destructive" />
          )}
          <span className="truncate">{transaction.description}</span>
          <span className={cn("ml-auto font-semibold tabular-nums", isCredit ? "text-green-600" : "text-destructive")}>
            {isCredit ? "+" : "-"}
            {formatTxn(transactionAmount)}
          </span>
        </span>
      }
      footer={
        <FooterActionBar
          anchor="sheet"
          trailing={
            <ActionBar>
              <Button variant="outline" onClick={close} disabled={isSubmitting}>
                Cancel
              </Button>
              <Button
                onClick={handleReconcile}
                disabled={!hasSelection || isSubmitting || isManualIncomplete}
              >
                <Check className="mr-2 h-4 w-4" />
                {isSubmitting ? "Reconciling…" : "Reconcile"}
              </Button>
            </ActionBar>
          }
        />
      }
    >
      <div className="space-y-4">
        <Card className="bg-muted/40">
          <CardContent className="pt-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-medium text-sm">{transaction.description}</p>
                <p className="text-xs text-muted-foreground">
                  {formatDate(transaction.transaction_date)}
                  {transaction.reference && <> • Ref {transaction.reference}</>}
                </p>
              </div>
              <div className={cn("text-lg font-bold tabular-nums", isCredit ? "text-green-600" : "text-destructive")}>
                {isCredit ? "+" : "-"}
                {formatTxn(transactionAmount)}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* What the books say this line is. Evidence, not a score. */}
        {(candidatesLoading || candidateSet) && (
          <Card>
            <CardContent className="space-y-2 pt-4">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  <Sparkles className="h-3.5 w-3.5 text-primary" />
                  What this looks like
                </span>
                {candidateSet && (
                  <Badge
                    variant={
                      candidateSet.tier === "deterministic"
                        ? "default"
                        : candidateSet.tier === "ambiguous" ||
                            candidateSet.tier === "unresolved" ||
                            isExplainedTier(candidateSet.tier)
                          ? "outline"
                          : "secondary"
                    }
                    className="text-xs"
                  >
                    {TIER_COPY[candidateSet.tier].label}
                  </Badge>
                )}
              </div>

              {candidatesLoading ? (
                <p className="text-xs text-muted-foreground">Looking through the books…</p>
              ) : (
                <>
                  <p className="text-xs text-muted-foreground">
                    {candidateSet?.reason ?? TIER_COPY[candidateSet!.tier].hint}
                  </p>

                  {candidateSet!.candidates.map((candidate, idx) => {
                    const isChosen = chosenCandidateIndex === idx;
                    return (
                      <button
                        key={`${candidate.kind}-${idx}`}
                        type="button"
                        onClick={() => {
                          setChosenCandidateIndex(isChosen ? null : idx);
                          setSelectedInvoiceIds([]);
                          setSelectedBillIds([]);
                          setSelectedMatch(null);
                        }}
                        className={cn(
                          "w-full rounded-lg border p-3 text-left transition-colors hover:bg-muted/50",
                          isChosen && "border-primary bg-primary/5",
                        )}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <span className="text-sm font-medium">{candidate.label}</span>
                          {isChosen && <Check className="h-4 w-4 shrink-0 text-primary" />}
                        </div>
                        <p className="mt-0.5 text-xs text-muted-foreground">{candidate.effect}</p>
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {candidate.evidence.map((reason) => (
                            <Badge key={reason} variant="outline" className="text-[10px] font-normal">
                              {reason}
                            </Badge>
                          ))}
                        </div>
                      </button>
                    );
                  })}
                </>
              )}
            </CardContent>
          </Card>
        )}



        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search invoices, bills, or expenses…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>

        <Tabs defaultValue={isCredit ? "invoices" : "bills"}>
          <TabsList className="grid w-full grid-cols-4">
            <TabsTrigger value="invoices" disabled={!isCredit} className="gap-1.5">
              <FileText className="h-3.5 w-3.5" />
              Invoices
            </TabsTrigger>
            <TabsTrigger value="bills" disabled={isCredit} className="gap-1.5">
              <Receipt className="h-3.5 w-3.5" />
              Bills
            </TabsTrigger>
            <TabsTrigger value="expenses" disabled={isCredit} className="gap-1.5">
              <CreditCard className="h-3.5 w-3.5" />
              Expenses
            </TabsTrigger>
            <TabsTrigger value="manual" className="gap-1.5">
              <BookOpen className="h-3.5 w-3.5" />
              Journal
            </TabsTrigger>
          </TabsList>

          <TabsContent value="invoices" className="mt-4">
            {selectedInvoiceIds.length > 0 && (
              <div className="mb-3 flex items-center justify-between rounded-md border bg-primary/5 p-2">
                <span className="text-xs font-medium">
                  {selectedInvoiceIds.length} selected • Total: {formatTxn(selectedInvoiceTotal)}
                </span>
                <Badge
                  variant={Math.abs(selectedInvoiceTotal - transactionAmount) < 0.01 ? "default" : "secondary"}
                  className="text-xs"
                >
                  {Math.abs(selectedInvoiceTotal - transactionAmount) < 0.01
                    ? "Exact match"
                    : `Diff: ${formatTxn(transactionAmount - selectedInvoiceTotal)}`}
                </Badge>
              </div>
            )}
            {matchingInvoices.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">No matching invoices found</p>
            ) : (
              <div className="max-h-[45vh] space-y-2 overflow-y-auto pr-1">
                {matchingInvoices.map((invoice) => {
                  const remaining = invoice.total - (invoice.amount_paid || 0);
                  const sameCurrency = currencyMatches((invoice as any).currency);
                  const isExactMatch =
                    sameCurrency && Math.abs(remaining - transactionAmount) < 0.01;
                  const isSelected = selectedInvoiceIds.includes(invoice.id);
                  return (
                    <Label
                      key={invoice.id}
                      className={cn(
                        "flex items-center justify-between gap-3 rounded-lg border p-3",
                        sameCurrency
                          ? "cursor-pointer hover:bg-muted/50"
                          : "cursor-not-allowed opacity-60",
                        isSelected && "border-primary bg-primary/5",
                      )}
                      onClick={(e) => {
                        e.preventDefault();
                        if (!sameCurrency) return;
                        toggleInvoiceSelection(invoice.id);
                      }}
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        <Checkbox checked={isSelected} disabled={!sameCurrency} />
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium">{invoice.invoice_number}</span>
                            {isExactMatch && (
                              <Badge variant="secondary" className="bg-green-100 text-green-800 text-xs">
                                Exact
                              </Badge>
                            )}
                            {!sameCurrency && (
                              <Badge variant="outline" className="text-xs">
                                {(invoice as any).currency ?? "No currency"} — cannot settle a{" "}
                                {txnCurrency ?? "—"} line
                              </Badge>
                            )}
                          </div>
                          <p className="truncate text-xs text-muted-foreground">
                            {invoice.contact?.name} • Due {formatDate(invoice.due_date)}
                          </p>
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="text-sm font-medium tabular-nums">
                          {formatDocumentAmount(remaining, (invoice as any).currency)}
                        </p>
                        <p className="text-xs text-muted-foreground">Outstanding</p>
                      </div>
                    </Label>
                  );
                })}

              </div>
            )}
          </TabsContent>

          <TabsContent value="bills" className="mt-4">
            {selectedBillIds.length > 0 && (
              <div className="mb-3 flex items-center justify-between rounded-md border bg-primary/5 p-2">
                <span className="text-xs font-medium">
                  {selectedBillIds.length} selected • Total: {formatTxn(selectedBillTotal)}
                </span>
                <Badge
                  variant={Math.abs(selectedBillTotal - transactionAmount) < 0.01 ? "default" : "secondary"}
                  className="text-xs"
                >
                  {Math.abs(selectedBillTotal - transactionAmount) < 0.01
                    ? "Exact match"
                    : `Diff: ${formatTxn(transactionAmount - selectedBillTotal)}`}
                </Badge>
              </div>
            )}
            {matchingBills.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">No matching bills found</p>
            ) : (
              <div className="max-h-[45vh] space-y-2 overflow-y-auto pr-1">
                {matchingBills.map((bill) => {
                  const remaining = bill.total - (bill.amount_paid || 0);
                  const sameCurrency = currencyMatches((bill as any).currency);
                  const isExactMatch =
                    sameCurrency && Math.abs(remaining - transactionAmount) < 0.01;
                  const isSelected = selectedBillIds.includes(bill.id);
                  return (
                    <Label
                      key={bill.id}
                      className={cn(
                        "flex items-center justify-between gap-3 rounded-lg border p-3",
                        sameCurrency
                          ? "cursor-pointer hover:bg-muted/50"
                          : "cursor-not-allowed opacity-60",
                        isSelected && "border-primary bg-primary/5",
                      )}
                      onClick={(e) => {
                        e.preventDefault();
                        if (!sameCurrency) return;
                        toggleBillSelection(bill.id);
                      }}
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        <Checkbox checked={isSelected} disabled={!sameCurrency} />
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium">{bill.bill_number}</span>
                            {isExactMatch && (
                              <Badge variant="secondary" className="bg-green-100 text-green-800 text-xs">
                                Exact
                              </Badge>
                            )}
                            {!sameCurrency && (
                              <Badge variant="outline" className="text-xs">
                                {(bill as any).currency ?? "No currency"} — cannot settle a{" "}
                                {txnCurrency ?? "—"} line
                              </Badge>
                            )}
                          </div>
                          <p className="truncate text-xs text-muted-foreground">
                            {bill.vendor?.name} • Due {formatDate(bill.due_date)}
                          </p>
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="text-sm font-medium tabular-nums">
                          {formatDocumentAmount(remaining, (bill as any).currency)}
                        </p>
                        <p className="text-xs text-muted-foreground">Outstanding</p>
                      </div>
                    </Label>
                  );
                })}
              </div>
            )}
          </TabsContent>

          <TabsContent value="expenses" className="mt-4">
            <RadioGroup
              value={selectedMatch?.type === "expense" ? selectedMatch.id : ""}
              onValueChange={(value) => setSelectedMatch({ type: "expense", id: value })}
            >
              {matchingExpenses.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">No matching expenses found</p>
              ) : (
                <div className="max-h-[45vh] space-y-2 overflow-y-auto pr-1">
                  {matchingExpenses.map((expense) => {
                    const sameCurrency = currencyMatches((expense as any).currency);
                    return (
                    <Label
                      key={expense.id}
                      className={cn(
                        "flex items-center justify-between gap-3 rounded-lg border p-3",
                        sameCurrency
                          ? "cursor-pointer hover:bg-muted/50"
                          : "cursor-not-allowed opacity-60",
                        selectedMatch?.id === expense.id && "border-primary bg-primary/5",
                      )}
                    >
                      <div className="flex items-center gap-3">
                        <RadioGroupItem value={expense.id} disabled={!sameCurrency} />
                        <div className="min-w-0">
                          <span className="text-sm font-medium">{expense.description}</span>
                          <p className="text-xs text-muted-foreground">
                            {formatDate(expense.expense_date)}
                            {!sameCurrency && (
                              <>
                                {" "}• {(expense as any).currency ?? "No currency"} — cannot settle a{" "}
                                {txnCurrency ?? "—"} line
                              </>
                            )}
                          </p>
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="text-sm font-medium tabular-nums">
                          {formatDocumentAmount(expense.amount, (expense as any).currency)}
                        </p>
                      </div>
                    </Label>
                    );
                  })}

                </div>
              )}
            </RadioGroup>
          </TabsContent>

          <TabsContent value="manual" className="mt-4">
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Create a journal entry for this bank transaction (e.g., bank charges, interest income, transfers).
              </p>

              <div className="space-y-2">
                <Label>Offset Account *</Label>
                <AccountCombobox
                  accounts={incomeExpenseAccounts}
                  value={offsetAccountId}
                  onValueChange={(v) => {
                    setOffsetAccountId(v);
                    setSelectedMatch({ type: "manual", id: "manual" });
                  }}
                  placeholder="Search accounts by code or name..."
                />
                <p className="text-xs text-muted-foreground">
                  {isCredit ? "DR Bank, CR this account" : "DR this account, CR Bank"}
                </p>
              </div>

              <div className="space-y-2">
                <Label>Description (optional)</Label>
                <Input
                  placeholder={transaction.description}
                  value={manualDescription}
                  onChange={(e) => setManualDescription(e.target.value)}
                />
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </DetailSheet>
  );
}

export default ReconcileTransactionSheet;
