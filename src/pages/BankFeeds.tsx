import { useState, useMemo } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useBankTransactions } from "@/hooks/useBankTransactions";
import { useBankAccounts } from "@/hooks/useBankAccounts";
import { useTransactionRules } from "@/hooks/useTransactionRules";
// TransactionRulesDialog removed — Rules now live at /finance/banking/rules.
import { ReconcileTransactionSheet } from "@/features/finance/reconciliation/ReconcileTransactionSheet";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { FinanceScopeBadge } from "@/components/finance/FinanceScopeBadge";

import { useFinanceScope } from "@/hooks/finance/useFinanceScope";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import {
  Search,
  CheckCircle2,
  ArrowUpRight,
  ArrowDownLeft,
  Settings2,
  Brain,
  ChevronRight,
  Plus,
  Check,
  RefreshCw,
  AlertCircle,
  FileText
} from "lucide-react";
import { formatDate, cn } from "@/lib/utils";
import { useBankMoney } from "@/hooks/useBankAccountCurrency";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { normalizeError } from "@/services/resilience";

const CATEGORY_OPTIONS = [
  "Office Supplies",
  "Travel & Transportation",
  "Meals & Entertainment",
  "Professional Services",
  "Software & Subscriptions",
  "Utilities",
  "Marketing & Advertising",
  "Equipment & Hardware",
  "Insurance",
  "Rent & Facilities",
  "Bank & Finance Charges",
  "Payroll & Wages",
  "Sales Revenue",
  "Customer Payment",
  "Refund",
  "Transfer",
  "Other",
];

export default function BankFeeds() {
  const { toast } = useToast();
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedAccount, setSelectedAccount] = useState<string>("all");
  const [selectedTransaction, setSelectedTransaction] = useState<any>(null);
  const [selectedTransactions, setSelectedTransactions] = useState<string[]>([]);
  const [reconcileDialogOpen, setReconcileDialogOpen] = useState(false);
  // Rules dialog was removed — Rules now open as a routed page.
  
  const { accounts: bankAccounts } = useBankAccounts();
  const { transactions, isLoading, fetchTransactions } = useBankTransactions();
  const { createRule } = useTransactionRules();
  const scope = useFinanceScope();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();

  // Filter to only unreconciled transactions
  const unreconciledTransactions = useMemo(() => {
    return (transactions || []).filter((tx) => {
      const matchesSearch = 
        tx.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
        tx.reference?.toLowerCase().includes(searchQuery.toLowerCase());
      
      const matchesAccount = selectedAccount === "all" || tx.bank_account_id === selectedAccount;
      const isUnreconciled = !tx.is_reconciled;

      return matchesSearch && matchesAccount && isUnreconciled;
    });
  }, [transactions, searchQuery, selectedAccount]);

  // Group transactions by date
  const groupedTransactions = useMemo(() => {
    const groups: Record<string, typeof unreconciledTransactions> = {};
    unreconciledTransactions.forEach((tx) => {
      const date = tx.transaction_date?.split('T')[0] || 'Unknown';
      if (!groups[date]) groups[date] = [];
      groups[date].push(tx);
    });
    return Object.entries(groups).sort((a, b) => b[0].localeCompare(a[0]));
  }, [unreconciledTransactions]);

  const handleSelectTransaction = (tx: any) => {
    setSelectedTransaction(tx);
  };

  const handleCategorize = async (transactionId: string, category: string) => {
    try {
      // Phase 4 — categorization runs through the server-side write seam.
      // `authenticated` has no UPDATE on bank_transactions any more; the RPC
      // re-checks the finance permission for the owning business.
      const { error } = await (supabase as any).rpc('bank_transaction_set_category', {
        _transaction_ids: [transactionId],
        _category: category,
        _confidence: 1.0,
      });

      if (error) throw error;

      toast({ title: "Categorized", description: `Transaction categorized as ${category}` });
      fetchTransactions();
    } catch (error: any) {
      toast({ title: "Error", description: normalizeError(error).message, variant: "destructive" });
    }
  };


  const handleCreateRule = async (tx: any) => {
    // Extract a pattern from the description (first meaningful word)
    const words = tx.description.split(/\s+/).filter((w: string) => w.length > 3);
    const pattern = words[0] || tx.description.substring(0, 10);
    
    try {
      await createRule({
        rule_name: `Rule: ${pattern}`,
        description_pattern: pattern,
        target_category: tx.category || tx.ai_suggested_category || "Other",
        priority: 50,
        is_active: true,
      });
      toast({ title: "Rule created", description: `New rule created for "${pattern}"` });
    } catch (error: any) {
      toast({ title: "Error", description: normalizeError(error).message, variant: "destructive" });
    }
  };

  const handleBulkCategorize = async (category: string) => {
    if (selectedTransactions.length === 0) return;

    try {
      // Phase 4 — bulk categorization goes through the same server-side write
      // seam; the RPC asserts the finance permission for every business the
      // selection touches, so a stale cross-company id cannot land.
      const { error } = await (supabase as any).rpc('bank_transaction_set_category', {
        _transaction_ids: selectedTransactions,
        _category: category,
        _confidence: 1.0,
      });

      if (error) throw error;


      toast({
        title: "Bulk categorized",
        description: `${selectedTransactions.length} transactions categorized as ${category}`
      });
      setSelectedTransactions([]);
      fetchTransactions();
    } catch (error: any) {
      toast({ title: "Error", description: normalizeError(error).message, variant: "destructive" });
    }
  };

  const handleAcceptAISuggestion = async (tx: any) => {
    if (!tx.ai_suggested_category) return;
    await handleCategorize(tx.id, tx.ai_suggested_category);
  };

  const getConfidenceBadge = (confidence: number | null) => {
    if (!confidence) return null;
    if (confidence >= 0.8) {
      return <Badge variant="secondary" className="bg-green-100 text-green-800 text-xs">High</Badge>;
    } else if (confidence >= 0.5) {
      return <Badge variant="secondary" className="bg-yellow-100 text-yellow-800 text-xs">Medium</Badge>;
    }
    return <Badge variant="secondary" className="bg-red-100 text-red-800 text-xs">Low</Badge>;
  };

  return (
    <>
      <div className="flex flex-col gap-4 sm:gap-6 h-auto lg:h-[calc(100vh-12rem)] lg:flex-row overflow-hidden">
        {/* Left Panel - Transaction List */}
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          {/* Header */}
          <div className="page-header mb-3 sm:mb-4">
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="page-title text-xl sm:text-2xl md:text-3xl">Bank Feeds</h1>
                <FinanceScopeBadge />
              </div>
              <p className="text-xs sm:text-sm text-muted-foreground">
                {unreconciledTransactions.length} transactions need review
                {scope.hasMultipleBranches && (
                  <span className="ml-1 text-muted-foreground/80"> · {scope.scopeLabel}</span>
                )}
              </p>
            </div>
            <div className="action-buttons flex-wrap">
              <RefreshButton
                queryKeyPrefixes={[['bank-transactions'] as const]}
                tooltip="Refresh bank feeds"
              />
              <Button asChild variant="outline" size="sm" className="text-xs sm:text-sm h-8 sm:h-9">
                <Link to="/finance/banking/rules">
                  <Settings2 className="mr-1.5 sm:mr-2 h-3.5 w-3.5 sm:h-4 sm:w-4" />
                  <span className="hidden xs:inline">Rules</span>
                  <span className="xs:hidden">Rules</span>
                </Link>
              </Button>
            </div>
          </div>

          {/* Filters */}
          <Card className="mb-3 sm:mb-4">
            <CardContent className="pt-3 pb-3 sm:pt-4 sm:pb-4 px-3 sm:px-6">
              <div className="flex flex-col xs:flex-row gap-2 sm:gap-3">
                <div className="relative flex-1 min-w-0">
                  <Search className="absolute left-2.5 sm:left-3 top-1/2 h-3.5 w-3.5 sm:h-4 sm:w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    placeholder="Search transactions..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-8 sm:pl-9 text-xs sm:text-sm h-8 sm:h-10"
                  />
                </div>
                <Select value={selectedAccount} onValueChange={setSelectedAccount}>
                  <SelectTrigger className="w-full xs:w-[140px] sm:w-[180px] text-xs sm:text-sm h-8 sm:h-10">
                    <SelectValue placeholder="All Accounts" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Accounts</SelectItem>
                    {bankAccounts?.map((account) => (
                      <SelectItem key={account.id} value={account.id}>
                        {account.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Bulk actions */}
              {selectedTransactions.length > 0 && (
                <div className="flex flex-col xs:flex-row items-start xs:items-center gap-2 sm:gap-3 mt-2 sm:mt-3 pt-2 sm:pt-3 border-t">
                  <span className="text-xs sm:text-sm text-muted-foreground">
                    {selectedTransactions.length} selected
                  </span>
                  <Select onValueChange={handleBulkCategorize}>
                    <SelectTrigger className="w-full xs:w-[140px] sm:w-[180px] text-xs sm:text-sm h-8 sm:h-10">
                      <SelectValue placeholder="Bulk categorize..." />
                    </SelectTrigger>
                    <SelectContent>
                      {CATEGORY_OPTIONS.map((cat) => (
                        <SelectItem key={cat} value={cat}>{cat}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button 
                    variant="ghost" 
                    size="sm"
                    className="text-xs h-8"
                    onClick={() => setSelectedTransactions([])}
                  >
                    Clear
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Transaction List */}
          <Card className="flex-1 overflow-hidden min-h-[200px] lg:min-h-0">
            <ScrollArea className="h-full max-h-[50vh] lg:max-h-full">
              <div className="p-2.5 sm:p-4 space-y-4 sm:space-y-6">
                {isLoading ? (
                  <div className="text-center py-6 sm:py-8 text-xs sm:text-sm text-muted-foreground">
                    Loading transactions...
                  </div>
                ) : groupedTransactions.length === 0 ? (
                  <div className="text-center py-8 sm:py-12">
                    <CheckCircle2 className="mx-auto h-10 w-10 sm:h-12 sm:w-12 text-green-500 mb-3 sm:mb-4" />
                    <h3 className="text-base sm:text-lg font-medium">All caught up!</h3>
                    <p className="text-xs sm:text-sm text-muted-foreground">No transactions need review</p>
                  </div>
                ) : (
                  groupedTransactions.map(([date, txs]) => (
                    <div key={date}>
                      <h3 className="text-xs sm:text-sm font-medium text-muted-foreground mb-1.5 sm:mb-2">
                        {formatDate(date)}
                      </h3>
                      <div className="space-y-1.5 sm:space-y-2">
                        {txs.map((tx) => (
                          <div
                            key={tx.id}
                            className={cn(
                              "p-2 sm:p-3 rounded-lg border cursor-pointer transition-colors overflow-x-auto",
                              selectedTransaction?.id === tx.id
                                ? "border-primary bg-primary/5"
                                : "hover:border-primary/50 hover:bg-muted/50"
                            )}
                            onClick={() => handleSelectTransaction(tx)}
                          >
                            <div className="flex items-start gap-2 sm:gap-3 min-w-max sm:min-w-0">
                              <Checkbox
                                checked={selectedTransactions.includes(tx.id)}
                                onCheckedChange={(checked) => {
                                  if (checked) {
                                    setSelectedTransactions([...selectedTransactions, tx.id]);
                                  } else {
                                    setSelectedTransactions(selectedTransactions.filter(id => id !== tx.id));
                                  }
                                }}
                                onClick={(e) => e.stopPropagation()}
                                className="mt-0.5 shrink-0"
                              />
                              <div className="flex-1 min-w-0 sm:min-w-0">
                                <div className="flex items-center gap-1.5 sm:gap-2">
                                  {tx.transaction_type === 'credit' ? (
                                    <ArrowDownLeft className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-green-500 shrink-0" />
                                  ) : (
                                    <ArrowUpRight className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-destructive shrink-0" />
                                  )}
                                  <span className="font-medium text-xs sm:text-sm whitespace-nowrap sm:whitespace-normal sm:truncate">{tx.description}</span>
                                </div>
                                <div className="flex items-center gap-1 sm:gap-2 mt-0.5 sm:mt-1 sm:flex-wrap">
                                  {tx.ai_suggested_category && (
                                    <Badge variant="outline" className="text-[10px] sm:text-xs gap-0.5 sm:gap-1 px-1 sm:px-2 py-0 h-5 whitespace-nowrap shrink-0">
                                      <Brain className="h-2.5 w-2.5 sm:h-3 sm:w-3" />
                                      <span className="hidden xs:inline">{tx.ai_suggested_category}</span>
                                      <span className="xs:hidden">AI</span>
                                      {getConfidenceBadge(tx.ai_confidence)}
                                    </Badge>
                                  )}
                                  {tx.category && tx.category !== 'Uncategorized' && (
                                    <Badge variant="secondary" className="text-[10px] sm:text-xs px-1 sm:px-2 py-0 h-5 whitespace-nowrap shrink-0">
                                      {tx.category}
                                    </Badge>
                                  )}
                                </div>
                              </div>
                              <div className="text-right shrink-0">
                                <div className={cn(
                                  "font-medium text-xs sm:text-sm whitespace-nowrap",
                                  tx.transaction_type === 'credit' ? 'text-green-600' : 'text-destructive'
                                )}>
                                  {tx.transaction_type === 'credit' ? '+' : '-'}
                                  {formatBankAmount(Math.abs(tx.amount), tx.bank_account_id)}
                                </div>
                              </div>
                              <ChevronRight className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-muted-foreground shrink-0 hidden xs:block" />
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </ScrollArea>
          </Card>
        </div>

        {/* Right Panel - Transaction Details */}
        <div className="w-full lg:w-[360px] xl:w-[400px] shrink-0">
          <Card className="h-full">
            {selectedTransaction ? (
              <>
                <CardHeader className="pb-3 sm:pb-4 px-3 sm:px-6 pt-4 sm:pt-6">
                  <CardTitle className="text-base sm:text-lg">Transaction Details</CardTitle>
                  <CardDescription className="text-xs sm:text-sm">
                    Review and categorize this transaction
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4 sm:space-y-6 px-3 sm:px-6">
                  {/* Transaction Info */}
                  <div className="space-y-2 sm:space-y-3">
                    <div>
                      <label className="text-[10px] sm:text-xs text-muted-foreground uppercase">Description</label>
                      <p className="font-medium text-sm sm:text-base break-words">{selectedTransaction.description}</p>
                    </div>
                    <div className="grid grid-cols-2 gap-2 sm:gap-3">
                      <div>
                        <label className="text-[10px] sm:text-xs text-muted-foreground uppercase">Amount</label>
                        <p className={cn(
                          "font-medium text-base sm:text-lg",
                          selectedTransaction.transaction_type === 'credit' ? 'text-green-600' : 'text-destructive'
                        )}>
                          {selectedTransaction.transaction_type === 'credit' ? '+' : '-'}
                          {formatBankAmount(Math.abs(selectedTransaction.amount), selectedTransaction.bank_account_id)}
                        </p>
                      </div>
                      <div>
                        <label className="text-[10px] sm:text-xs text-muted-foreground uppercase">Date</label>
                        <p className="font-medium text-sm sm:text-base">{formatDate(selectedTransaction.transaction_date)}</p>
                      </div>
                    </div>
                    {selectedTransaction.reference && (
                      <div>
                        <label className="text-[10px] sm:text-xs text-muted-foreground uppercase">Reference</label>
                        <p className="text-xs sm:text-sm break-all">{selectedTransaction.reference}</p>
                      </div>
                    )}
                  </div>

                  {/* AI Suggestion */}
                  {selectedTransaction.ai_suggested_category && (
                    <Card className="bg-primary/5 border-primary/20">
                      <CardContent className="pt-3 sm:pt-4 px-3 sm:px-4">
                        <div className="flex items-start gap-2 sm:gap-3">
                          <div className="p-1.5 sm:p-2 rounded-full bg-primary/10 flex-shrink-0">
                            <Brain className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-primary" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex flex-wrap items-center gap-1 sm:gap-2">
                              <span className="font-medium text-xs sm:text-sm">AI Suggestion</span>
                              {getConfidenceBadge(selectedTransaction.ai_confidence)}
                            </div>
                            <p className="text-xs sm:text-sm font-medium text-primary mt-0.5 sm:mt-1">
                              {selectedTransaction.ai_suggested_category}
                            </p>
                            {selectedTransaction.ai_reasoning && (
                              <p className="text-[10px] sm:text-xs text-muted-foreground mt-0.5 sm:mt-1">
                                {selectedTransaction.ai_reasoning}
                              </p>
                            )}
                            <Button
                              size="sm"
                              className="mt-2 sm:mt-3 text-xs h-7 sm:h-8"
                              onClick={() => handleAcceptAISuggestion(selectedTransaction)}
                            >
                              <Check className="mr-1.5 sm:mr-2 h-3 w-3" />
                              Accept
                            </Button>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  )}

                  {/* Quick Categorize */}
                  <div>
                    <label className="text-[10px] sm:text-xs text-muted-foreground uppercase mb-1.5 sm:mb-2 block">
                      Categorize
                    </label>
                    <Select onValueChange={(val) => handleCategorize(selectedTransaction.id, val)}>
                      <SelectTrigger className="text-xs sm:text-sm h-8 sm:h-10">
                        <SelectValue placeholder="Choose category..." />
                      </SelectTrigger>
                      <SelectContent>
                        {CATEGORY_OPTIONS.map((cat) => (
                          <SelectItem key={cat} value={cat}>{cat}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Quick Actions */}
                  <div className="space-y-1.5 sm:space-y-2">
                    <label className="text-[10px] sm:text-xs text-muted-foreground uppercase block">
                      Quick Actions
                    </label>
                    <div className="grid grid-cols-2 gap-1.5 sm:gap-2">
                      <Button 
                        variant="outline" 
                        size="sm"
                        className="text-xs h-8 sm:h-9"
                        onClick={() => setReconcileDialogOpen(true)}
                      >
                        <FileText className="mr-1 sm:mr-2 h-3 w-3" />
                        Match
                      </Button>
                      <Button 
                        variant="outline" 
                        size="sm"
                        className="text-xs h-8 sm:h-9"
                        onClick={() => handleCreateRule(selectedTransaction)}
                      >
                        <Plus className="mr-1 sm:mr-2 h-3 w-3" />
                        Rule
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </>
            ) : (
              <div className="flex items-center justify-center h-full min-h-[200px] text-center p-4 sm:p-6">
                <div>
                  <AlertCircle className="mx-auto h-10 w-10 sm:h-12 sm:w-12 text-muted-foreground/50 mb-3 sm:mb-4" />
                  <h3 className="font-medium text-sm sm:text-base">No transaction selected</h3>
                  <p className="text-xs sm:text-sm text-muted-foreground mt-1">
                    Click on a transaction to view details and categorize
                  </p>
                </div>
              </div>
            )}
          </Card>
        </div>
      </div>

      <ReconcileTransactionSheet
        open={reconcileDialogOpen}
        onOpenChange={setReconcileDialogOpen}
        transaction={selectedTransaction}
        onReconcile={async (_transactionId: string, _reconcileData: any) => {
          // The sheet handles the reconciliation internally, we just refresh.
          await fetchTransactions();
          setSelectedTransaction(null);
        }}
      />
    </>
  );
}
