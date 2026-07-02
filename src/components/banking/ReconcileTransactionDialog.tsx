import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
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
import { useInvoices } from "@/hooks/useInvoices";
import { useBills } from "@/hooks/useBills";
import { useExpenses } from "@/hooks/useExpenses";
import { useAccounts } from "@/hooks/useAccounts";
import { formatCurrency, formatDate, cn } from "@/lib/utils";
import { 
  Search, 
  FileText, 
  Receipt, 
  CreditCard,
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  BookOpen,
} from "lucide-react";

interface ReconcileTransactionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  transaction: any;
  onReconcile: (transactionId: string, reconcileData: {
    reconciled_type: 'invoice' | 'expense' | 'bill' | 'transfer' | 'manual';
    reconciled_entity_id?: string;
    category?: string;
    createGLEntry?: boolean;
    offsetAccountId?: string;
  }) => Promise<void>;
}

export function ReconcileTransactionDialog({
  open,
  onOpenChange,
  transaction,
  onReconcile,
}: ReconcileTransactionDialogProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedMatch, setSelectedMatch] = useState<{ type: string; id: string } | null>(null);
  // R3: Multi-select for one-to-many matching
  const [selectedInvoiceIds, setSelectedInvoiceIds] = useState<string[]>([]);
  const [selectedBillIds, setSelectedBillIds] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [offsetAccountId, setOffsetAccountId] = useState("");
  const [manualDescription, setManualDescription] = useState("");

  const { invoices } = useInvoices();
  const { bills } = useBills();
  const { expenses } = useExpenses();
  const { accounts: glAccounts } = useAccounts();

  if (!transaction) return null;

  const isCredit = transaction.transaction_type === 'credit';
  const transactionAmount = Math.abs(transaction.amount);

  const incomeExpenseAccounts = glAccounts?.filter(a => 
    a.account_type === "income" || a.account_type === "expense" || a.account_type === "asset" || a.account_type === "liability"
  ) || [];

  const matchingInvoices = invoices?.filter((inv) => {
    const remaining = inv.total - (inv.amount_paid || 0);
    const matchesSearch = 
      inv.invoice_number.toLowerCase().includes(searchQuery.toLowerCase()) ||
      inv.contact?.name?.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesSearch && remaining > 0;
  }) || [];

  const matchingBills = bills?.filter((bill) => {
    const remaining = bill.total - (bill.amount_paid || 0);
    const matchesSearch = 
      bill.bill_number.toLowerCase().includes(searchQuery.toLowerCase()) ||
      bill.vendor?.name?.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesSearch && remaining > 0;
  }) || [];

  const matchingExpenses = expenses?.filter((exp) => {
    const matchesAmount = Math.abs(exp.amount - transactionAmount) < 0.01;
    const matchesSearch = exp.description.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesSearch && matchesAmount;
  }) || [];

  // R3: Calculate selected totals for multi-match
  const selectedInvoiceTotal = matchingInvoices
    .filter(inv => selectedInvoiceIds.includes(inv.id))
    .reduce((sum, inv) => sum + Math.min(inv.total - (inv.amount_paid || 0), transactionAmount), 0);

  const selectedBillTotal = matchingBills
    .filter(b => selectedBillIds.includes(b.id))
    .reduce((sum, b) => sum + Math.min(b.total - (b.amount_paid || 0), transactionAmount), 0);

  const toggleInvoiceSelection = (invoiceId: string) => {
    setSelectedInvoiceIds(prev => 
      prev.includes(invoiceId) 
        ? prev.filter(id => id !== invoiceId) 
        : [...prev, invoiceId]
    );
    setSelectedMatch(null); // Clear single-match when using multi
  };

  const toggleBillSelection = (billId: string) => {
    setSelectedBillIds(prev => 
      prev.includes(billId) 
        ? prev.filter(id => id !== billId) 
        : [...prev, billId]
    );
    setSelectedMatch(null);
  };

  const handleReconcile = async () => {
    // R3: Handle multi-invoice matching
    if (selectedInvoiceIds.length > 0) {
      setIsSubmitting(true);
      try {
        // Reconcile each invoice sequentially (each is atomic server-side)
        for (const invoiceId of selectedInvoiceIds) {
          await onReconcile(transaction.id, {
            reconciled_type: "invoice",
            reconciled_entity_id: invoiceId,
          });
        }
        onOpenChange(false);
        setSelectedInvoiceIds([]);
      } finally {
        setIsSubmitting(false);
      }
      return;
    }

    if (selectedBillIds.length > 0) {
      setIsSubmitting(true);
      try {
        for (const billId of selectedBillIds) {
          await onReconcile(transaction.id, {
            reconciled_type: "bill",
            reconciled_entity_id: billId,
          });
        }
        onOpenChange(false);
        setSelectedBillIds([]);
      } finally {
        setIsSubmitting(false);
      }
      return;
    }

    if (selectedMatch?.type === "manual") {
      if (!offsetAccountId) return;
      setIsSubmitting(true);
      try {
        await onReconcile(transaction.id, {
          reconciled_type: "manual",
          category: manualDescription || transaction.description,
          createGLEntry: true,
          offsetAccountId,
        });
        onOpenChange(false);
        setSelectedMatch(null);
        setOffsetAccountId("");
        setManualDescription("");
      } finally {
        setIsSubmitting(false);
      }
      return;
    }

    if (!selectedMatch) return;
    
    setIsSubmitting(true);
    try {
      await onReconcile(transaction.id, {
        reconciled_type: selectedMatch.type as 'invoice' | 'expense' | 'bill' | 'transfer' | 'manual',
        reconciled_entity_id: selectedMatch.id,
      });
      onOpenChange(false);
      setSelectedMatch(null);
    } finally {
      setIsSubmitting(false);
    }
  };

  const hasSelection = selectedMatch || selectedInvoiceIds.length > 0 || selectedBillIds.length > 0;
  const isManualIncomplete = selectedMatch?.type === 'manual' && !offsetAccountId;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[95vw] sm:max-w-lg md:max-w-2xl max-h-[90vh] overflow-y-auto p-4 sm:p-6">
        <DialogHeader>
          <DialogTitle className="text-base sm:text-lg">Reconcile Transaction</DialogTitle>
        </DialogHeader>

        {/* Transaction Details */}
        <Card className="bg-muted/50">
          <CardContent className="pt-3 sm:pt-4 px-3 sm:px-4">
            <div className="flex flex-col xs:flex-row items-start justify-between gap-2">
              <div className="flex items-start gap-2 sm:gap-3">
                {isCredit ? (
                  <ArrowDownLeft className="h-4 w-4 sm:h-5 sm:w-5 text-green-500 mt-0.5 flex-shrink-0" />
                ) : (
                  <ArrowUpRight className="h-4 w-4 sm:h-5 sm:w-5 text-destructive mt-0.5 flex-shrink-0" />
                )}
                <div className="min-w-0">
                  <p className="font-medium text-sm sm:text-base break-words">{transaction.description}</p>
                  <p className="text-xs sm:text-sm text-muted-foreground">
                    {formatDate(transaction.transaction_date)}
                    {transaction.reference && <span className="hidden xs:inline"> • Ref: {transaction.reference}</span>}
                  </p>
                </div>
              </div>
              <div className={cn(
                "text-base sm:text-lg font-bold flex-shrink-0",
                isCredit ? 'text-green-600' : 'text-destructive'
              )}>
                {isCredit ? '+' : '-'}{formatCurrency(transactionAmount)}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-2.5 sm:left-3 top-1/2 h-3.5 w-3.5 sm:h-4 sm:w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search invoices, bills, or expenses..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-8 sm:pl-9 text-xs sm:text-sm h-8 sm:h-10"
          />
        </div>

        {/* Match Options */}
        <Tabs defaultValue={isCredit ? "invoices" : "bills"}>
          <TabsList className="grid w-full grid-cols-4 h-auto p-1">
            <TabsTrigger value="invoices" disabled={!isCredit} className="text-xs sm:text-sm py-1.5 sm:py-2 gap-1">
              <FileText className="h-3 w-3 sm:h-4 sm:w-4" />
              <span className="hidden xs:inline">Invoices</span>
              <span className="xs:hidden">Inv</span>
            </TabsTrigger>
            <TabsTrigger value="bills" disabled={isCredit} className="text-xs sm:text-sm py-1.5 sm:py-2 gap-1">
              <Receipt className="h-3 w-3 sm:h-4 sm:w-4" />
              <span>Bills</span>
            </TabsTrigger>
            <TabsTrigger value="expenses" disabled={isCredit} className="text-xs sm:text-sm py-1.5 sm:py-2 gap-1">
              <CreditCard className="h-3 w-3 sm:h-4 sm:w-4" />
              <span className="hidden xs:inline">Expenses</span>
              <span className="xs:hidden">Exp</span>
            </TabsTrigger>
            <TabsTrigger value="manual" className="text-xs sm:text-sm py-1.5 sm:py-2 gap-1">
              <BookOpen className="h-3 w-3 sm:h-4 sm:w-4" />
              <span className="hidden xs:inline">Journal</span>
              <span className="xs:hidden">JE</span>
            </TabsTrigger>
          </TabsList>

          {/* R3: Invoices Tab with multi-select */}
          <TabsContent value="invoices" className="mt-3 sm:mt-4">
            {selectedInvoiceIds.length > 0 && (
              <div className="mb-3 p-2 rounded-md border bg-primary/5 flex items-center justify-between">
                <span className="text-xs font-medium">
                  {selectedInvoiceIds.length} selected • Total: {formatCurrency(selectedInvoiceTotal)}
                </span>
                <Badge variant={Math.abs(selectedInvoiceTotal - transactionAmount) < 0.01 ? "default" : "secondary"} className="text-xs">
                  {Math.abs(selectedInvoiceTotal - transactionAmount) < 0.01 
                    ? "Exact match" 
                    : `Diff: ${formatCurrency(transactionAmount - selectedInvoiceTotal)}`}
                </Badge>
              </div>
            )}
            {matchingInvoices.length === 0 ? (
              <p className="text-center text-muted-foreground py-6 sm:py-8 text-xs sm:text-sm">
                No matching invoices found
              </p>
            ) : (
              <div className="space-y-1.5 sm:space-y-2 max-h-[30vh] overflow-y-auto">
                {matchingInvoices.map((invoice) => {
                  const remaining = invoice.total - (invoice.amount_paid || 0);
                  const isExactMatch = Math.abs(remaining - transactionAmount) < 0.01;
                  const isSelected = selectedInvoiceIds.includes(invoice.id);
                  return (
                    <Label
                      key={invoice.id}
                      className={cn(
                        "flex flex-col xs:flex-row xs:items-center justify-between p-2 sm:p-3 rounded-lg border cursor-pointer hover:bg-muted/50 gap-2",
                        isSelected && "border-primary bg-primary/5"
                      )}
                      onClick={(e) => {
                        e.preventDefault();
                        toggleInvoiceSelection(invoice.id);
                      }}
                    >
                      <div className="flex items-center gap-2 sm:gap-3">
                        <Checkbox checked={isSelected} />
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-1 sm:gap-2">
                            <span className="font-medium text-xs sm:text-sm">{invoice.invoice_number}</span>
                            {isExactMatch && (
                              <Badge variant="secondary" className="bg-green-100 text-green-800 text-[10px] sm:text-xs px-1 sm:px-2">
                                Exact
                              </Badge>
                            )}
                          </div>
                          <p className="text-[10px] sm:text-sm text-muted-foreground truncate">
                            {invoice.contact?.name} • Due {formatDate(invoice.due_date)}
                          </p>
                        </div>
                      </div>
                      <div className="text-right pl-6 xs:pl-0">
                        <p className="font-medium text-xs sm:text-sm">{formatCurrency(remaining)}</p>
                        <p className="text-[10px] sm:text-xs text-muted-foreground">Outstanding</p>
                      </div>
                    </Label>
                  );
                })}
              </div>
            )}
          </TabsContent>

          {/* R3: Bills Tab with multi-select */}
          <TabsContent value="bills" className="mt-3 sm:mt-4">
            {selectedBillIds.length > 0 && (
              <div className="mb-3 p-2 rounded-md border bg-primary/5 flex items-center justify-between">
                <span className="text-xs font-medium">
                  {selectedBillIds.length} selected • Total: {formatCurrency(selectedBillTotal)}
                </span>
                <Badge variant={Math.abs(selectedBillTotal - transactionAmount) < 0.01 ? "default" : "secondary"} className="text-xs">
                  {Math.abs(selectedBillTotal - transactionAmount) < 0.01 
                    ? "Exact match" 
                    : `Diff: ${formatCurrency(transactionAmount - selectedBillTotal)}`}
                </Badge>
              </div>
            )}
            {matchingBills.length === 0 ? (
              <p className="text-center text-muted-foreground py-6 sm:py-8 text-xs sm:text-sm">
                No matching bills found
              </p>
            ) : (
              <div className="space-y-1.5 sm:space-y-2 max-h-[30vh] overflow-y-auto">
                {matchingBills.map((bill) => {
                  const remaining = bill.total - (bill.amount_paid || 0);
                  const isExactMatch = Math.abs(remaining - transactionAmount) < 0.01;
                  const isSelected = selectedBillIds.includes(bill.id);
                  return (
                    <Label
                      key={bill.id}
                      className={cn(
                        "flex flex-col xs:flex-row xs:items-center justify-between p-2 sm:p-3 rounded-lg border cursor-pointer hover:bg-muted/50 gap-2",
                        isSelected && "border-primary bg-primary/5"
                      )}
                      onClick={(e) => {
                        e.preventDefault();
                        toggleBillSelection(bill.id);
                      }}
                    >
                      <div className="flex items-center gap-2 sm:gap-3">
                        <Checkbox checked={isSelected} />
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-1 sm:gap-2">
                            <span className="font-medium text-xs sm:text-sm">{bill.bill_number}</span>
                            {isExactMatch && (
                              <Badge variant="secondary" className="bg-green-100 text-green-800 text-[10px] sm:text-xs px-1 sm:px-2">
                                Exact
                              </Badge>
                            )}
                          </div>
                          <p className="text-[10px] sm:text-sm text-muted-foreground truncate">
                            {bill.vendor?.name} • Due {formatDate(bill.due_date)}
                          </p>
                        </div>
                      </div>
                      <div className="text-right pl-6 xs:pl-0">
                        <p className="font-medium text-xs sm:text-sm">{formatCurrency(remaining)}</p>
                        <p className="text-[10px] sm:text-xs text-muted-foreground">Outstanding</p>
                      </div>
                    </Label>
                  );
                })}
              </div>
            )}
          </TabsContent>

          {/* Expenses Tab — single select with RadioGroup */}
          <TabsContent value="expenses" className="mt-3 sm:mt-4">
            <RadioGroup
              value={selectedMatch?.type === 'expense' ? selectedMatch.id : ''}
              onValueChange={(value) => setSelectedMatch({ type: 'expense', id: value })}
            >
              {matchingExpenses.length === 0 ? (
                <p className="text-center text-muted-foreground py-6 sm:py-8 text-xs sm:text-sm">
                  No matching expenses found
                </p>
              ) : (
                <div className="space-y-1.5 sm:space-y-2 max-h-[30vh] overflow-y-auto">
                  {matchingExpenses.map((expense) => (
                    <Label
                      key={expense.id}
                      className={cn(
                        "flex flex-col xs:flex-row xs:items-center justify-between p-2 sm:p-3 rounded-lg border cursor-pointer hover:bg-muted/50 gap-2",
                        selectedMatch?.id === expense.id && "border-primary bg-primary/5"
                      )}
                    >
                      <div className="flex items-center gap-2 sm:gap-3">
                        <RadioGroupItem value={expense.id} />
                        <div className="min-w-0">
                          <span className="font-medium text-xs sm:text-sm">{expense.description}</span>
                          <p className="text-[10px] sm:text-sm text-muted-foreground">
                            {formatDate(expense.expense_date)}
                          </p>
                        </div>
                      </div>
                      <div className="text-right pl-6 xs:pl-0">
                        <p className="font-medium text-xs sm:text-sm">{formatCurrency(expense.amount)}</p>
                      </div>
                    </Label>
                  ))}
                </div>
              )}
            </RadioGroup>
          </TabsContent>

          {/* Manual / Create Journal Entry Tab */}
          <TabsContent value="manual" className="mt-3 sm:mt-4">
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Create a journal entry for this bank transaction (e.g., bank charges, interest income, transfers).
              </p>

              <div className="space-y-2">
                <Label>Offset Account *</Label>
                <Select value={offsetAccountId} onValueChange={(v) => {
                  setOffsetAccountId(v);
                  setSelectedMatch({ type: "manual", id: "manual" });
                }}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select account to offset against" />
                  </SelectTrigger>
                  <SelectContent>
                    {incomeExpenseAccounts.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.code} - {a.name} ({a.account_type})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
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

        <DialogFooter className="flex-col xs:flex-row gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} className="text-xs sm:text-sm h-8 sm:h-10 w-full xs:w-auto">
            Cancel
          </Button>
          <Button 
            onClick={handleReconcile} 
            disabled={!hasSelection || isSubmitting || isManualIncomplete}
            className="text-xs sm:text-sm h-8 sm:h-10 w-full xs:w-auto"
          >
            <Check className="mr-1.5 sm:mr-2 h-3.5 w-3.5 sm:h-4 sm:w-4" />
            {isSubmitting ? "Reconciling..." : "Reconcile"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
