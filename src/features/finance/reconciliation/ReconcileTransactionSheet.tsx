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
import { useEffect, useState } from "react";
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
import { useBankAccounts } from "@/hooks/useBankAccounts";
import { AccountCombobox } from "@/components/finance/AccountCombobox";
import { formatDate, cn } from "@/lib/utils";
import { useBankMoney } from "@/hooks/useBankAccountCurrency";
import { useBankMatchCandidates, TIER_COPY, isExplainedTier } from "@/hooks/useBankMatchCandidates";
import { CandidateAdvisoryPanel } from "@/components/banking/ReconciliationAiAdvisory";
import { useBankPendingMatch, usePendingMatchActions } from "@/hooks/useBankPendingMatch";
import { useClearableRecordedPayments } from "@/hooks/useClearableRecordedPayments";

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
  Banknote,
  AlertTriangle,
  X,
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
  const [selectedRecordedId, setSelectedRecordedId] = useState<string | null>(null);
  const [chosenCandidateIndex, setChosenCandidateIndex] = useState<number | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [offsetAccountId, setOffsetAccountId] = useState("");
  const [manualDescription, setManualDescription] = useState("");
  /** Operator has explicitly accepted an abnormal-direction posting. */
  const [abnormalAcknowledged, setAbnormalAcknowledged] = useState(false);
  const [activeTab, setActiveTab] = useState<string | null>(null);

  const { invoices } = useInvoices();
  const { bills } = useBills();
  const { expenses } = useExpenses();
  const { accounts: glAccounts } = useAccounts();
  const { accounts: bankAccounts } = useBankAccounts();
  const { currencyOf, formatBankAmount, formatDocumentAmount } = useBankMoney();

  // The books answer what this line is; the client only presents the answer.
  const { data: candidateSet, isLoading: candidatesLoading } = useBankMatchCandidates(
    transaction?.id,
    open,
  );

  /**
   * An open proposal suppresses every suggestion (ADR-0148). It must therefore
   * be visible and answerable here, or the line is blocked with no way out but
   * a hand-match — the very mistake the engine exists to prevent.
   */
  const { data: pendingMatch } = useBankPendingMatch(transaction?.id, open);
  const { confirm: confirmPending, reject: rejectPending } = usePendingMatchActions(
    transaction?.id,
  );

  const inflow = transaction?.transaction_type === "credit";
  const lineAmount = Math.abs(Number(transaction?.amount ?? 0));

  /** Money already recorded that this line could be clearing rather than re-settling. */
  const { data: clearable } = useClearableRecordedPayments({
    amount: lineAmount,
    isCredit: inflow,
    enabled: open && !!transaction?.id,
  });
  const clearableCandidates = clearable?.candidates ?? [];
  const holdingAccountIds = clearable?.holdingAccountIds ?? [];

  /**
   * Recognising money already recorded is the first offer, never the last: when
   * a recorded receipt fits this line, that tab opens by default.
   */
  useEffect(() => {
    if (activeTab !== null) return;
    if (clearableCandidates.length > 0) setActiveTab("recorded");
  }, [activeTab, clearableCandidates.length]);

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

  /**
   * Direction guardrails for the classify path.
   *
   * Classifying a bank line posts DR bank / CR offset for money in, and
   * DR offset / CR bank for money out. Two postings are almost always a
   * mistake and were exactly how a bank charge and an inter-bank transfer
   * ended up debited to a liability (2012 Accrued Expenses):
   *
   *   money out → debiting a liability, equity or income account
   *   money in  → crediting an expense account
   *
   * Neither is impossible (settling a real accrual, refunding an expense), so
   * this warns and requires an explicit acknowledgement rather than blocking.
   */
  const offsetAccount = glAccounts?.find((a) => a.id === offsetAccountId) ?? null;
  const abnormalDirection = (() => {
    if (!offsetAccount) return null;
    const type = offsetAccount.account_type;
    if (!isCredit && (type === "liability" || type === "equity" || type === "income")) {
      return `Money out of the bank debits ${offsetAccount.code} ${offsetAccount.name}, a ${type} account. That says a previously recorded ${type === "liability" ? "liability is being settled" : "balance is being reduced"} — if this is a cost, pick the expense account instead so it reaches the profit and loss.`;
    }
    if (isCredit && type === "expense") {
      return `Money into the bank credits ${offsetAccount.code} ${offsetAccount.name}, an expense account. That reduces reported costs — if this is income, pick the income account instead.`;
    }
    return null;
  })();

  /**
   * The offset account is the control account of another registered bank
   * account: this is a transfer, not a classification. Posting it here leaves
   * the other bank's own statement unreconciled, so it is blocked outright.
   */
  const transferTargetBank =
    offsetAccountId
      ? (bankAccounts ?? []).find(
          (b) => b.account_id === offsetAccountId && b.id !== transaction.bank_account_id,
        ) ?? null
      : null;

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
    setSelectedRecordedId(null);
  };

  const toggleBillSelection = (billId: string) => {
    setSelectedBillIds((prev) =>
      prev.includes(billId) ? prev.filter((id) => id !== billId) : [...prev, billId],
    );
    setSelectedMatch(null);
    setChosenCandidateIndex(null);
    setSelectedRecordedId(null);
  };

  const toggleRecordedSelection = (id: string) => {
    setSelectedRecordedId((prev) => (prev === id ? null : id));
    setSelectedInvoiceIds([]);
    setSelectedBillIds([]);
    setSelectedMatch(null);
    setChosenCandidateIndex(null);
  };

  const selectedRecorded =
    clearableCandidates.find((c) => c.id === selectedRecordedId) ?? null;

  /** True when a hand-post would drain a holding account behind the seam's back. */
  const isHoldingOffset = offsetAccountId
    ? holdingAccountIds.includes(offsetAccountId)
    : false;

  const close = () => {
    onOpenChange(false);
    setSelectedInvoiceIds([]);
    setSelectedBillIds([]);
    setSelectedRecordedId(null);
    setSelectedMatch(null);
    setChosenCandidateIndex(null);
    setOffsetAccountId("");
    setManualDescription("");
    setSearchQuery("");
    setActiveTab(null);
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

    // Clearing money already recorded: the receipt is deposited in full, and
    // nothing new is settled (ADR-0147 §1).
    if (selectedRecorded) {
      await submit({
        reconciled_type: selectedRecorded.kind,
        allocations: [
          {
            document_type: selectedRecorded.kind,
            document_id: selectedRecorded.id,
            amount: selectedRecorded.amount,
          },
        ],
        category: selectedRecorded.partyName ?? undefined,
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
      if (!offsetAccountId || isHoldingOffset) return;
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
    selectedRecordedId !== null ||
    selectedInvoiceIds.length > 0 ||
    selectedBillIds.length > 0;
  const isManualIncomplete =
    selectedMatch?.type === "manual" &&
    (!offsetAccountId ||
      isHoldingOffset ||
      transferTargetBank !== null ||
      (abnormalDirection !== null && !abnormalAcknowledged));

  /**
   * The seam refuses a match whose allocations do not equal the bank line
   * (`_bank_match_validate`, amount law). Gate the submit on the same law so the
   * operator learns it here rather than from a raw error after pressing
   * Reconcile.
   */
  const documentsBalanceLine =
    selectedInvoiceIds.length > 0
      ? Math.abs(selectedInvoiceTotal - transactionAmount) < 0.01
      : selectedBillIds.length > 0
        ? Math.abs(selectedBillTotal - transactionAmount) < 0.01
        : true;

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
                disabled={
                  !hasSelection || isSubmitting || isManualIncomplete || !documentsBalanceLine
                }
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

                  {/*
                    Phase 6 — the assistant may comment on the candidates above.
                    It is asked, never automatic; it re-orders nothing on screen
                    and confirms nothing. Only offered where a judgement is
                    actually owed.
                  */}
                  {candidateSet!.candidates.length > 1 &&
                    !isExplainedTier(candidateSet!.tier) && (
                      <div className="pt-1">
                        <CandidateAdvisoryPanel bankTransactionId={transaction?.id} />
                      </div>
                    )}
                </>
              )}

            </CardContent>
          </Card>
        )}


        {/*
          An open proposal is an answer the operator owes, not a wall. Show what
          was proposed and let it be confirmed or rejected through the seam.
        */}
        {pendingMatch && (
          <Card className="border-amber-500/40 bg-amber-500/5">
            <CardContent className="space-y-3 pt-4">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                <div className="min-w-0 space-y-1">
                  <p className="text-sm font-medium">A match is already proposed for this line</p>
                  <p className="text-xs text-muted-foreground">
                    Nothing has been posted yet. Confirm it to settle this line, or reject it to
                    match the line yourself. While it stands, no suggestions are offered.
                  </p>
                </div>
              </div>

              <div className="space-y-1 rounded-md border bg-background p-2">
                {pendingMatch.allocations.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No allocations recorded.</p>
                ) : (
                  pendingMatch.allocations.map((a, idx) => (
                    <div
                      key={`${a.document_id}-${idx}`}
                      className="flex items-center justify-between gap-2 text-xs"
                    >
                      <span className="truncate">
                        {a.description ?? a.document_type.replace(/_/g, " ")}
                      </span>
                      <span className="shrink-0 font-medium tabular-nums">
                        {formatTxn(Number(a.amount) || 0)}
                      </span>
                    </div>
                  ))
                )}
                {pendingMatch.fee_amount > 0 && (
                  <div className="flex items-center justify-between gap-2 border-t pt-1 text-xs">
                    <span>Bank charge</span>
                    <span className="font-medium tabular-nums">
                      {formatTxn(pendingMatch.fee_amount)}
                    </span>
                  </div>
                )}
              </div>

              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={() => confirmPending.mutate(pendingMatch.id)}
                  disabled={confirmPending.isPending || rejectPending.isPending}
                >
                  <Check className="mr-1.5 h-3.5 w-3.5" />
                  {confirmPending.isPending ? "Confirming…" : "Confirm match"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => rejectPending.mutate(pendingMatch.id)}
                  disabled={confirmPending.isPending || rejectPending.isPending}
                >
                  <X className="mr-1.5 h-3.5 w-3.5" />
                  {rejectPending.isPending ? "Rejecting…" : "Reject"}
                </Button>
              </div>
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

        <Tabs
          value={activeTab ?? (isCredit ? "invoices" : "bills")}
          onValueChange={setActiveTab}
        >
          <TabsList className="grid w-full grid-cols-5">
            <TabsTrigger value="recorded" className="gap-1.5">
              <Banknote className="h-3.5 w-3.5" />
              Recorded
            </TabsTrigger>
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

          {/*
            Clearing money already recorded. Choosing here does not settle
            anything new — it moves money out of the account it is waiting in.
          */}
          <TabsContent value="recorded" className="mt-4">
            <p className="mb-3 text-xs text-muted-foreground">
              {isCredit
                ? "Receipts already recorded and waiting to be banked. Depositing one moves it out of its holding account — it does not settle the invoice again."
                : "Supplier payments already recorded and waiting to present at the bank."}
            </p>
            {clearableCandidates.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No recorded {isCredit ? "receipt" : "payment"} of {formatTxn(transactionAmount)} is
                waiting. A recorded {isCredit ? "receipt" : "payment"} is cleared in full, so only
                an exact amount can explain this line.
              </p>
            ) : (
              <div className="max-h-[45vh] space-y-2 overflow-y-auto pr-1">
                {clearableCandidates.map((candidate) => {
                  const isSelected = selectedRecordedId === candidate.id;
                  return (
                    <Label
                      key={candidate.id}
                      className={cn(
                        "flex cursor-pointer items-center justify-between gap-3 rounded-lg border p-3 hover:bg-muted/50",
                        isSelected && "border-primary bg-primary/5",
                      )}
                      onClick={(e) => {
                        e.preventDefault();
                        toggleRecordedSelection(candidate.id);
                      }}
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        <Checkbox checked={isSelected} />
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium">
                              {candidate.partyName ?? "Unnamed party"}
                            </span>
                            <Badge variant="secondary" className="bg-green-100 text-green-800 text-xs">
                              Exact
                            </Badge>
                          </div>
                          <p className="truncate text-xs text-muted-foreground">
                            {formatDate(candidate.date)}
                            {candidate.reference && <> • Ref {candidate.reference}</>}
                            {candidate.method && <> • {candidate.method.replace(/_/g, " ")}</>}
                          </p>
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="text-sm font-medium tabular-nums">
                          {formatTxn(candidate.amount)}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {isCredit ? "Not yet banked" : "Not yet cleared"}
                        </p>
                      </div>
                    </Label>
                  );
                })}
              </div>
            )}
          </TabsContent>

          <TabsContent value="invoices" className="mt-4">
            {clearableCandidates.length > 0 && (
              <div className="mb-3 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-2">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
                <p className="text-xs text-muted-foreground">
                  A receipt of {formatTxn(transactionAmount)} is already recorded for this amount.
                  Settling an invoice here records the money a second time — check the{" "}
                  <button
                    type="button"
                    className="font-medium underline"
                    onClick={() => setActiveTab("recorded")}
                  >
                    Recorded
                  </button>{" "}
                  tab first.
                </p>
              </div>
            )}
            <p className="mb-3 text-xs text-muted-foreground">
              The selected invoices must add up to {formatTxn(transactionAmount)} — the bank line is
              settled in full or not at all.
            </p>
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

              {clearableCandidates.length > 0 && (
                <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-2">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
                  <p className="text-xs text-muted-foreground">
                    Money of {formatTxn(transactionAmount)} is already recorded for this line. Use
                    the{" "}
                    <button
                      type="button"
                      className="font-medium underline"
                      onClick={() => setActiveTab("recorded")}
                    >
                      Recorded
                    </button>{" "}
                    tab so it is marked as banked; a hand-posted entry leaves it waiting and it can
                    be banked twice.
                  </p>
                </div>
              )}

              <div className="space-y-2">
                <Label>Offset Account *</Label>
                <AccountCombobox
                  accounts={incomeExpenseAccounts}
                  value={offsetAccountId}
                  onValueChange={(v) => {
                    setOffsetAccountId(v);
                    setAbnormalAcknowledged(false);
                    setSelectedMatch({ type: "manual", id: "manual" });
                  }}
                  placeholder="Search accounts by code or name..."
                />
                {transferTargetBank && (
                  <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-xs text-destructive">
                    <p className="flex items-center gap-1.5 font-medium">
                      <AlertTriangle className="h-3.5 w-3.5" />
                      This is a transfer, not a classification
                    </p>
                    <p className="mt-1">
                      {offsetAccount?.code} {offsetAccount?.name} is the control account of the
                      bank account “{transferTargetBank.name}”. Classifying it here would leave that
                      bank's own statement unreconciled. Record a transfer between the two bank
                      accounts instead.
                    </p>
                  </div>
                )}
                {!transferTargetBank && abnormalDirection && (
                  <div className="space-y-2 rounded-md border border-warning/50 bg-warning/5 p-3 text-xs">
                    <p className="flex items-center gap-1.5 font-medium text-warning-foreground">
                      <AlertTriangle className="h-3.5 w-3.5" />
                      Unusual posting direction
                    </p>
                    <p className="text-muted-foreground">{abnormalDirection}</p>
                    <label className="flex items-start gap-2 pt-1">
                      <Checkbox
                        checked={abnormalAcknowledged}
                        onCheckedChange={(v) => setAbnormalAcknowledged(v === true)}
                      />
                      <span className="text-muted-foreground">
                        I have checked this and it is correct
                      </span>
                    </label>
                  </div>
                )}
                {isHoldingOffset ? (
                  <p className="text-xs text-destructive">
                    This is a holding account for money already recorded. Clearing it by hand would
                    move the cash without marking the receipt banked, so the same receipt could be
                    banked again. Clear it from the Recorded tab instead.
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {isCredit ? "DR Bank, CR this account" : "DR this account, CR Bank"}
                  </p>
                )}
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
