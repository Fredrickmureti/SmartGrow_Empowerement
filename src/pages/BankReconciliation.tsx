import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useBankTransactions } from "@/hooks/useBankTransactions";
import { useBankAccounts } from "@/hooks/useBankAccounts";
import { useReconciliationSessions } from "@/hooks/useReconciliationSessions";
import { useReconciliationSuggestions } from "@/hooks/useReconciliationSuggestions";
import { ReconcileTransactionSheet } from "@/features/finance/reconciliation/ReconcileTransactionSheet";
// TransactionRulesDialog removed — Rules now live at /finance/banking/rules.

import { TransferReconcileSheet } from "@/features/finance/reconciliation/TransferReconcileSheet";
import { ReconciliationWorkspace } from "@/components/banking/ReconciliationWorkspace";
import { ImportHistoryTab } from "@/components/banking/ImportHistoryTab";
import { ReconciliationHistoryTab } from "@/components/banking/ReconciliationHistoryTab";
import { TransactionPreviewDrawer } from "@/components/finance/TransactionPreviewDrawer";
import {
  Search, 
  CheckCircle2, 
  XCircle, 
  ArrowUpRight, 
  ArrowDownLeft,
  ArrowRightLeft,
  Settings2,
  Loader2,
  ArrowUpDown,
  MoreHorizontal,
  Undo2,
  FileText,
  History,
  Scale,
  Lightbulb,
} from "lucide-react";
import { formatCurrency, formatDate, cn } from "@/lib/utils";
import { useSubscriptionAccess } from "@/contexts/SubscriptionAccessContext";
import { PermissionGate } from "@/components/common/PermissionGate";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { FinanceScopeBadge } from "@/components/finance/FinanceScopeBadge";


export default function BankReconciliation() {
  const { isReadOnly, openUpgradeModal } = useSubscriptionAccess();
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedAccount, setSelectedAccount] = useState<string>("all");
  const [selectedType, setSelectedType] = useState<string>("all");
  const [selectedStatus, setSelectedStatus] = useState<string>("unreconciled");
  const [selectedTransactions, setSelectedTransactions] = useState<string[]>([]);
  const [reconcileDialogOpen, setReconcileDialogOpen] = useState(false);
  // Rules dialog was removed — Rules now open as a routed page.
  const [selectedTransaction, setSelectedTransaction] = useState<any>(null);
  const [isAutoMatching, setIsAutoMatching] = useState(false);
  const [activeTab, setActiveTab] = useState("transactions");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewSource, setPreviewSource] = useState<{ type: string | null; id: string | null }>({ type: null, id: null });

  // Unreconcile confirmation
  const [unreconcileDialogOpen, setUnreconcileDialogOpen] = useState(false);
  const [transactionToUnreconcile, setTransactionToUnreconcile] = useState<any>(null);
  const navigate = useNavigate();

  // R1: Statement-level reconciliation lives on a routed page now
  // (see /finance/reconciliation/new). Nothing to track locally.
  
  // R2: Transfer dialog
  const [transferDialogOpen, setTransferDialogOpen] = useState(false);
  const [transferTransaction, setTransferTransaction] = useState<any>(null);

  // Pagination
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 100;

  const { accounts: bankAccounts } = useBankAccounts();
  const { transactions, isLoading, reconcileTransaction, unreconcileTransaction, stats, autoMatchTransactions, isSaving, fetchTransactions } = useBankTransactions();
  const { activeSession, startSession, updateSessionBalance, completeSession, cancelSession, canReconcile, scope } = useReconciliationSessions(selectedAccount !== "all" ? selectedAccount : undefined);
  const { data: matchSuggestions = [], isLoading: suggestionsLoading } = useReconciliationSuggestions(selectedAccount !== "all" ? selectedAccount : undefined);

  // Filter transactions
  const filteredTransactions = transactions?.filter((tx) => {
    const matchesSearch = 
      tx.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
      tx.reference?.toLowerCase().includes(searchQuery.toLowerCase());
    
    const matchesAccount = selectedAccount === "all" || tx.bank_account_id === selectedAccount;
    const matchesType = selectedType === "all" || tx.transaction_type === selectedType;
    const matchesStatus = 
      selectedStatus === "all" ||
      (selectedStatus === "reconciled" && tx.is_reconciled) ||
      (selectedStatus === "unreconciled" && !tx.is_reconciled);

    return matchesSearch && matchesAccount && matchesType && matchesStatus;
  }) || [];

  // Paginate
  const totalPages = Math.ceil(filteredTransactions.length / PAGE_SIZE);
  const paginatedTransactions = filteredTransactions.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const unreconciledCount = stats?.unreconciledCount || 0;
  const reconciledCount = stats?.reconciledCount || 0;

  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedTransactions(paginatedTransactions.map(tx => tx.id));
    } else {
      setSelectedTransactions([]);
    }
  };

  const handleSelectTransaction = (id: string, checked: boolean) => {
    if (checked) {
      setSelectedTransactions([...selectedTransactions, id]);
    } else {
      setSelectedTransactions(selectedTransactions.filter(txId => txId !== id));
    }
  };

  const handleReconcile = (transaction: any) => {
    if (isReadOnly) { openUpgradeModal("banking"); return; }
    setSelectedTransaction(transaction);
    setReconcileDialogOpen(true);
  };

  const handleTransfer = (transaction: any) => {
    if (isReadOnly) { openUpgradeModal("banking"); return; }
    setTransferTransaction(transaction);
    setTransferDialogOpen(true);
  };

  const handleUnreconcileConfirm = (transaction: any) => {
    if (isReadOnly) { openUpgradeModal("banking"); return; }
    setTransactionToUnreconcile(transaction);
    setUnreconcileDialogOpen(true);
  };

  const executeUnreconcile = async () => {
    if (!transactionToUnreconcile) return;
    try {
      await unreconcileTransaction(transactionToUnreconcile.id);
    } catch {
      // Error handled in hook
    } finally {
      setUnreconcileDialogOpen(false);
      setTransactionToUnreconcile(null);
    }
  };

  const handleAutoMatch = async () => {
    if (isReadOnly) { openUpgradeModal("banking"); return; }
    const txIds = selectedTransactions.length > 0 
      ? selectedTransactions 
      : filteredTransactions.filter(tx => !tx.is_reconciled).map(tx => tx.id);
    
    if (txIds.length === 0) return;

    setIsAutoMatching(true);
    try {
      const result = await autoMatchTransactions(txIds);
      if (result?.deterministicMatches && result.deterministicMatches.length > 0) {
        toast.info(`Found ${result.deterministicMatches.length} deterministic matches and ${result.summary.aiCount} AI suggestions.`);
      } else {
        toast.info("No automatic matches found. Try reconciling transactions manually.");
      }
    } finally {
      setIsAutoMatching(false);
      setSelectedTransactions([]);
    }
  };

  // If there's an active reconciliation session, show the workspace
  const showWorkspace = !!activeSession;

  return (
    <>
      <div className="space-y-4 sm:space-y-6">
        {/* Header */}
        <div className="page-header">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="page-title">Bank Reconciliation</h1>
              <FinanceScopeBadge />
            </div>
            <p className="text-sm sm:text-base text-muted-foreground">
              {showWorkspace
                ? "Check off cleared transactions to match your statement"
                : "Match bank transactions with invoices, bills, and expenses"}
              {scope?.hasMultipleBranches ? ` · ${scope.scopeLabel}` : ""}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <RefreshButton
              queryKeyPrefixes={[
                ['bank-transactions'] as const,
                ['bank-accounts'] as const,
              ]}
              tooltip="Refresh reconciliation data"
            />
          </div>
          <div className="action-buttons w-full sm:w-auto">
            {!showWorkspace && (
              <>
                <Button
                  variant="outline"
                  disabled={!canReconcile}
                  title={!canReconcile ? "You don't have permission to reconcile bank transactions in this scope." : undefined}
                  onClick={() => {
                    if (isReadOnly) { openUpgradeModal("banking"); return; }
                    const q = selectedAccount !== "all" ? `?account=${selectedAccount}` : "";
                    navigate(`/finance/reconciliation/new${q}`);
                  }}>
                  <Scale className="mr-2 h-4 w-4" />
                  Reconcile
                </Button>
                <Button
                  variant="outline"
                  disabled={!canReconcile}
                  title={!canReconcile ? "You don't have permission to manage reconciliation rules in this scope." : undefined}
                  onClick={() => {
                    if (isReadOnly) { openUpgradeModal("banking"); return; }
                    navigate("/finance/banking/rules");
                  }}>
                  <Settings2 className="mr-2 h-4 w-4" />
                  Rules
                </Button>
                <Button
                  onClick={handleAutoMatch}
                  className="flex-1 sm:flex-none"
                  disabled={isAutoMatching || !canReconcile}
                  title={!canReconcile ? "You don't have permission to reconcile bank transactions in this scope." : undefined}
                >
                  {isAutoMatching ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <ArrowUpDown className="mr-2 h-4 w-4" />
                  )}
                  {isAutoMatching ? "Matching..." : "Auto-Match"}
                </Button>
              </>
            )}
          </div>
        </div>

        

        {/* Active Session: ReconciliationWorkspace */}
        {showWorkspace ? (
          <ReconciliationWorkspace
            session={activeSession}
            onComplete={completeSession}
            onCancel={cancelSession}
            onWriteOff={writeOffSession}
          />

        ) : (
          <>
            {/* Summary Cards */}
            <div className="stats-grid grid-cols-1 sm:grid-cols-3">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Unreconciled</CardTitle>
                  <XCircle className="h-4 w-4 text-destructive" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{unreconciledCount}</div>
                  <p className="text-xs text-muted-foreground">Need attention</p>
                </CardContent>
              </Card>
              
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Reconciled</CardTitle>
                  <CheckCircle2 className="h-4 w-4 text-green-500" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{reconciledCount}</div>
                  <p className="text-xs text-muted-foreground">Matched successfully</p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Match Rate</CardTitle>
                  <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">
                    {transactions?.length ? Math.round((reconciledCount / transactions.length) * 100) : 0}%
                  </div>
                  <p className="text-xs text-muted-foreground">Reconciliation progress</p>
                </CardContent>
              </Card>
            </div>

            {/* Tabs: Transactions | Import History */}
            <Tabs value={activeTab} onValueChange={setActiveTab}>
              <TabsList>
                <TabsTrigger value="transactions" className="gap-2">
                  <FileText className="h-4 w-4" />
                  Transactions
                </TabsTrigger>
                <TabsTrigger value="history" className="gap-2">
                  <History className="h-4 w-4" />
                  Import History
                </TabsTrigger>
                <TabsTrigger value="recon-history" className="gap-2">
                  <Scale className="h-4 w-4" />
                  Reconciliation History
                </TabsTrigger>
                <TabsTrigger value="suggestions" className="gap-2">
                  <Lightbulb className="h-4 w-4" />
                  Match Suggestions
                  {matchSuggestions.length > 0 && (
                    <Badge variant="secondary" className="ml-1 text-xs">{matchSuggestions.length}</Badge>
                  )}
                </TabsTrigger>
              </TabsList>

              <TabsContent value="transactions" className="space-y-4">
                {/* Filters */}
                <Card>
                  <CardContent className="pt-6">
                    <div className="filter-bar">
                      <div className="relative flex-1 min-w-0">
                        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                          placeholder="Search transactions..."
                          value={searchQuery}
                          onChange={(e) => { setSearchQuery(e.target.value); setPage(0); }}
                          className="pl-9 w-full"
                        />
                      </div>
                      
                      <Select value={selectedAccount} onValueChange={(v) => { setSelectedAccount(v); setPage(0); }}>
                        <SelectTrigger className="w-full sm:w-[180px]">
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

                      <Select value={selectedType} onValueChange={(v) => { setSelectedType(v); setPage(0); }}>
                        <SelectTrigger className="w-full sm:w-[150px]">
                          <SelectValue placeholder="All Types" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All Types</SelectItem>
                          <SelectItem value="credit">Deposits</SelectItem>
                          <SelectItem value="debit">Payments</SelectItem>
                        </SelectContent>
                      </Select>

                      <Select value={selectedStatus} onValueChange={(v) => { setSelectedStatus(v); setPage(0); }}>
                        <SelectTrigger className="w-full sm:w-[160px]">
                          <SelectValue placeholder="Status" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All Status</SelectItem>
                          <SelectItem value="unreconciled">Unreconciled</SelectItem>
                          <SelectItem value="reconciled">Reconciled</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </CardContent>
                </Card>

                {/* Transactions Table */}
                <Card>
                  <CardContent className="pt-6">
                    <div className="table-container">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="w-12">
                              <Checkbox
                                checked={selectedTransactions.length === paginatedTransactions.length && paginatedTransactions.length > 0}
                                onCheckedChange={handleSelectAll}
                              />
                            </TableHead>
                            <TableHead>Date</TableHead>
                            <TableHead>Description</TableHead>
                            <TableHead>Reference</TableHead>
                            <TableHead>Category</TableHead>
                            <TableHead className="text-right">Amount</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead className="text-right">Actions</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {isLoading ? (
                            <TableRow>
                              <TableCell colSpan={8} className="h-24 text-center">
                                <Loader2 className="h-6 w-6 mx-auto animate-spin text-muted-foreground" />
                              </TableCell>
                            </TableRow>
                          ) : paginatedTransactions.length === 0 ? (
                            <TableRow>
                              <TableCell colSpan={8} className="h-24 text-center text-muted-foreground">
                                No transactions found
                              </TableCell>
                            </TableRow>
                          ) : (
                            paginatedTransactions.map((tx) => (
                              <TableRow key={tx.id}>
                                <TableCell>
                                  <Checkbox
                                    checked={selectedTransactions.includes(tx.id)}
                                    onCheckedChange={(checked) => handleSelectTransaction(tx.id, checked as boolean)}
                                  />
                                </TableCell>
                                <TableCell className="whitespace-nowrap">
                                  {formatDate(tx.transaction_date)}
                                </TableCell>
                                <TableCell>
                                  <div className="flex items-center gap-2">
                                    {tx.transaction_type === "credit" ? (
                                      <ArrowDownLeft className="h-4 w-4 text-green-500 shrink-0" />
                                    ) : (
                                      <ArrowUpRight className="h-4 w-4 text-destructive shrink-0" />
                                    )}
                                    <span className="truncate max-w-[200px]">{tx.description}</span>
                                  </div>
                                </TableCell>
                                <TableCell className="text-muted-foreground">
                                  {tx.reference || "—"}
                                </TableCell>
                                <TableCell>
                                  {tx.category ? (
                                    <Badge variant="secondary" className="text-xs">
                                      {tx.category}
                                    </Badge>
                                  ) : (
                                    <span className="text-muted-foreground text-sm">—</span>
                                  )}
                                </TableCell>
                                <TableCell className={cn(
                                  "text-right font-medium tabular-nums",
                                  tx.transaction_type === "credit" ? "text-green-600" : "text-destructive"
                                )}>
                                  {tx.transaction_type === "credit" ? "+" : "-"}
                                  {formatCurrency(Math.abs(tx.amount))}
                                </TableCell>
                                <TableCell>
                                  {tx.is_reconciled ? (
                                    <Badge variant="secondary" className="bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400">
                                      <CheckCircle2 className="mr-1 h-3 w-3" />
                                      Reconciled
                                    </Badge>
                                  ) : (
                                    <Badge variant="outline">Pending</Badge>
                                  )}
                                </TableCell>
                                <TableCell className="text-right">
                                  {tx.is_reconciled ? (
                                    <DropdownMenu>
                                      <DropdownMenuTrigger asChild>
                                        <Button variant="ghost" size="sm">
                                          <MoreHorizontal className="h-4 w-4" />
                                        </Button>
                                      </DropdownMenuTrigger>
                                      <DropdownMenuContent align="end">
                                        <DropdownMenuItem
                                          disabled={!canReconcile}
                                          onClick={() => canReconcile && handleUnreconcileConfirm(tx)}
                                          className="text-destructive"
                                        >
                                          <Undo2 className="mr-2 h-4 w-4" />
                                          Unreconcile
                                        </DropdownMenuItem>
                                      </DropdownMenuContent>
                                    </DropdownMenu>
                                  ) : (
                                    <div className="flex items-center gap-1">
                                      <Button variant="ghost" size="sm" onClick={() => handleReconcile(tx)}>
                                        Match
                                      </Button>
                                      <DropdownMenu>
                                        <DropdownMenuTrigger asChild>
                                          <Button variant="ghost" size="sm">
                                            <MoreHorizontal className="h-4 w-4" />
                                          </Button>
                                        </DropdownMenuTrigger>
                                        <DropdownMenuContent align="end">
                                          <DropdownMenuItem onClick={() => handleTransfer(tx)}>
                                            <ArrowRightLeft className="mr-2 h-4 w-4" />
                                            Record Transfer
                                          </DropdownMenuItem>
                                        </DropdownMenuContent>
                                      </DropdownMenu>
                                    </div>
                                  )}
                                </TableCell>
                              </TableRow>
                            ))
                          )}
                        </TableBody>
                      </Table>
                    </div>

                    {/* Pagination */}
                    {totalPages > 1 && (
                      <div className="flex items-center justify-between mt-4 pt-4 border-t">
                        <p className="text-sm text-muted-foreground">
                          Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, filteredTransactions.length)} of {filteredTransactions.length}
                        </p>
                        <div className="flex items-center gap-2">
                          <Button variant="outline" size="sm" onClick={() => setPage(Math.max(0, page - 1))} disabled={page === 0}>
                            Previous
                          </Button>
                          <span className="text-sm text-muted-foreground">
                            Page {page + 1} of {totalPages}
                          </span>
                          <Button variant="outline" size="sm" onClick={() => setPage(Math.min(totalPages - 1, page + 1))} disabled={page >= totalPages - 1}>
                            Next
                          </Button>
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="history">
                <ImportHistoryTab />
              </TabsContent>

              <TabsContent value="recon-history">
                <ReconciliationHistoryTab />
              </TabsContent>

              <TabsContent value="suggestions">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">GL Match Suggestions</CardTitle>
                    <p className="text-sm text-muted-foreground">
                      Server-side suggestions matching unreconciled bank transactions to posted journal entries by amount, date, and reference.
                      {selectedAccount === "all" && " Select a specific bank account to see suggestions."}
                    </p>
                  </CardHeader>
                  <CardContent>
                    {selectedAccount === "all" ? (
                      <p className="text-sm text-muted-foreground text-center py-8">Select a bank account from the filter above to view match suggestions.</p>
                    ) : suggestionsLoading ? (
                      <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
                    ) : matchSuggestions.length === 0 ? (
                      <p className="text-sm text-muted-foreground text-center py-8">No match suggestions found for this account.</p>
                    ) : (
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Bank Txn Date</TableHead>
                            <TableHead>Bank Description</TableHead>
                            <TableHead className="text-right">Bank Amount</TableHead>
                            <TableHead>JE Number</TableHead>
                            <TableHead>JE Date</TableHead>
                            <TableHead>JE Description</TableHead>
                            <TableHead className="text-right">GL Amount</TableHead>
                            <TableHead className="text-center">Score</TableHead>
                            <TableHead className="text-right">Action</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {matchSuggestions.map((s, idx) => (
                            <TableRow key={`${s.bank_transaction_id}-${s.line_id}-${idx}`}>
                              <TableCell>{formatDate(s.bank_date)}</TableCell>
                              <TableCell className="max-w-[200px] truncate">{s.bank_description}</TableCell>
                              <TableCell className="text-right font-medium">{formatCurrency(Math.abs(s.bank_amount))}</TableCell>
                              <TableCell className="font-mono text-xs">
                                <button
                                  className="text-primary hover:underline cursor-pointer bg-transparent border-none p-0"
                                  onClick={() => {
                                    setPreviewSource({ type: "journal_entry", id: s.journal_entry_id });
                                    setPreviewOpen(true);
                                  }}
                                  title="Preview journal entry"
                                >
                                  {s.entry_number}
                                </button>
                              </TableCell>
                              <TableCell>{formatDate(s.entry_date)}</TableCell>
                              <TableCell className="max-w-[200px] truncate">{s.je_description}</TableCell>
                              <TableCell className="text-right font-medium">{formatCurrency(s.gl_amount)}</TableCell>
                              <TableCell className="text-center">
                                <Badge variant={s.match_score >= 80 ? "default" : s.match_score >= 50 ? "secondary" : "outline"}>
                                  {s.match_score}
                                </Badge>
                              </TableCell>
                              <TableCell className="text-right">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={async () => {
                                    try {
                                      await reconcileTransaction(s.bank_transaction_id, {
                                        reconciled_type: "manual",
                                        reconciled_entity_id: s.journal_entry_id,
                                        createGLEntry: false,
                                      });
                                      toast.success("Transaction reconciled from suggestion");
                                    } catch (err) {
                                      toast.error("Failed to reconcile");
                                    }
                                  }}
                                >
                                  <CheckCircle2 className="h-3 w-3 mr-1" />
                                  Match
                                </Button>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>
          </>
        )}
      </div>

      {/* Reconcile side rail — enterprise DetailSheet (no modal). */}
      <ReconcileTransactionSheet
        open={reconcileDialogOpen}
        onOpenChange={setReconcileDialogOpen}
        transaction={selectedTransaction}
        onReconcile={reconcileTransaction}
      />

      {/* Transfer side rail — enterprise DetailSheet (no modal). */}
      <TransferReconcileSheet
        open={transferDialogOpen}
        onOpenChange={setTransferDialogOpen}
        transaction={transferTransaction}
        onSuccess={fetchTransactions}
      />

      {/* Start Statement Reconciliation is now a routed page at
          /finance/reconciliation/new — see StartReconciliationPage. */}


      {/* Unreconcile Confirmation */}
      <AlertDialog open={unreconcileDialogOpen} onOpenChange={setUnreconcileDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unreconcile Transaction</AlertDialogTitle>
            <AlertDialogDescription>
              This will reverse the accounting impact of this reconciliation, including any journal entries and payment records created.
              {transactionToUnreconcile && (
                <span className="block mt-2 font-medium text-foreground">
                  {transactionToUnreconcile.description} — {formatCurrency(Math.abs(transactionToUnreconcile.amount))}
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={executeUnreconcile}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={isSaving}
            >
              {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Unreconcile
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Source preview drawer (suggestions / history) */}
      <TransactionPreviewDrawer
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        sourceType={previewSource.type}
        sourceId={previewSource.id}
      />
    </>
  );
}
