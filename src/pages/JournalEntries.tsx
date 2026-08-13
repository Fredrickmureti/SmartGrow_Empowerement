import { useState, useRef, useCallback, useEffect } from "react";
import { JOURNAL_ENTRY_IMPORT_FIELDS } from "@/lib/importConfigs/journalEntryImportConfig";
import { useSearchParams, useNavigate } from "react-router-dom";
import { ConfirmDeleteDialog, useConfirmDelete } from "@/components/shared/ConfirmDeleteDialog";
import { useJournalEntries, JournalEntry } from "@/hooks/useJournalEntries";
import { JournalEntryOutputMenuItems } from "@/features/finance/journal-entries/JournalEntryOutputMenuItems";
import { useAccounts } from "@/hooks/useAccounts";
import { useContacts } from "@/hooks/useContacts";
import { useCurrency } from "@/hooks/useCurrency";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
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
import {
  Plus,
  Search,
  BookOpen,
  Loader2,
  MoreHorizontal,
  CheckCircle,
  XCircle,
  Clock,
  Trash2,
  Eye,
  RotateCcw,
  Send,
  FileText,
} from "lucide-react";
import { format } from "date-fns";
import { useSubscriptionAccess } from "@/contexts/SubscriptionAccessContext";
import { PermissionGate } from "@/components/common/PermissionGate";
import { ImportWizard } from "@/components/common/ImportWizard";
import { FieldDefinition } from "@/lib/importUtils";
import { AccountResolver } from "@/lib/entityResolver";
import { ImportResults, BatchImportFn } from "@/hooks/useImport";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { queryKeys } from "@/lib/queryKeys";
import { Upload, Download } from "lucide-react";
import { useExport } from "@/hooks/useExport";
import { TransactionPreviewDrawer } from "@/components/finance/TransactionPreviewDrawer";
import { DataTablePagination } from "@/components/common/DataTablePagination";
import { useFinanceScope } from "@/hooks/finance/useFinanceScope";
import { FinanceScopeBadge } from "@/components/finance/FinanceScopeBadge";
import { useFinancePermission } from "@/hooks/finance/useFinancePermission";
import { usePeekParam } from "@/design-system";
import { JournalEntryPeekSheet } from "@/features/finance/journal-entries/JournalEntryPeekSheet";

export default function JournalEntries() {
  const { 
    journalEntries, 
    isLoading,
    createJournalEntry,
    postJournalEntry,
    voidJournalEntry,
    deleteJournalEntry,
    createReversingEntry,
  } = useJournalEntries();
  const { accounts } = useAccounts();
  // contacts still consumed by ContactCombobox in view surfaces below; keep hook for cache warm-up
  useContacts();
  const { formatCurrency } = useCurrency();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { isReadOnly, openUpgradeModal } = useSubscriptionAccess();
  const { scopeLabel } = useFinanceScope();
  const { allowed: canManageJE } = useFinancePermission("finance.manage_je");
  const { allowed: canVoidJE } = useFinancePermission("finance.void_je");
  
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [showVoidDialog, setShowVoidDialog] = useState(false);
  const [voidingEntryId, setVoidingEntryId] = useState<string | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const [showImportWizard, setShowImportWizard] = useState(false);
  const accountResolverRef = useRef<AccountResolver | null>(null);
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [peekId, setPeekId] = usePeekParam();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerSource, setDrawerSource] = useState<{ type: string | null; id: string | null }>({ type: null, id: null });

  // Handle ?action=create from global create menu → route to new page.
  useEffect(() => {
    if (searchParams.get("action") === "create") {
      if (isReadOnly) {
        openUpgradeModal("journal_entries");
        return;
      }
      navigate("/finance/journal-entries/new", { replace: true });
    }
  }, [searchParams, isReadOnly, navigate, openUpgradeModal]);

  // Back-compat: `?selected=<id>` now opens the peek sheet via `?peek=<id>`.
  // Legacy inbound links from payments / bills / drilldowns keep working.
  useEffect(() => {
    const selectedId = searchParams.get("selected");
    if (selectedId && !peekId) {
      setPeekId(selectedId);
    }
  }, [searchParams, peekId, setPeekId]);

  const journalFieldDefinitions = JOURNAL_ENTRY_IMPORT_FIELDS;

  /**
   * BATCH import: groups CSV rows by reference so all lines sharing the same
   * reference become one balanced double-entry journal record.
   */
  const handleBatchImportJE: BatchImportFn = useCallback(async (rows) => {
    if (!currentOrg) throw new Error("No organization selected");
    if (!currentBusiness?.id) throw new Error("Please select a company before importing journal entries");

    if (!accountResolverRef.current) {
      accountResolverRef.current = new AccountResolver(currentOrg.id, currentBusiness.id, accounts);
    }

    const groups = new Map<string, Record<string, any>[]>();
    rows.forEach((row, idx) => {
      const groupKey = row.reference ? `ref:${row.reference}` : `single:${idx}`;
      if (!groups.has(groupKey)) groups.set(groupKey, []);
      groups.get(groupKey)!.push(row);
    });

    const results: ImportResults = { total: rows.length, imported: 0, skipped: 0, errors: [] };

    for (const [, groupRows] of groups) {
      try {
        const firstRow = groupRows[0];

        const resolvedLines = await Promise.all(
          groupRows.map(async (row) => {
            const debit = Number(row.debit) || 0;
            const credit = Number(row.credit) || 0;
            if (debit === 0 && credit === 0) {
              throw new Error(`Row has no debit or credit (account: ${row.account_code})`);
            }
            const resolved = await accountResolverRef.current!.resolve(row.account_code);
            return { account_id: resolved.id, description: row.description || firstRow.description, debit, credit };
          })
        );

        const totalDebit = resolvedLines.reduce((s, l) => s + l.debit, 0);
        const totalCredit = resolvedLines.reduce((s, l) => s + l.credit, 0);
        if (Math.abs(totalDebit - totalCredit) > 0.01) {
          throw new Error(
            `Entry "${firstRow.reference || firstRow.description}" is not balanced ` +
            `(Dr: ${totalDebit.toFixed(2)}, Cr: ${totalCredit.toFixed(2)}). ` +
            `Rows with the same Reference must have equal total debits and credits.`
          );
        }

        await createJournalEntry.mutateAsync({
          entry_date: firstRow.entry_date,
          description: firstRow.description,
          reference: firstRow.reference || null,
          is_adjusting: false,
          is_closing: false,
          lines: resolvedLines,
        });

        results.imported += groupRows.length;
      } catch (error: any) {
        groupRows.forEach((row, idx) => {
          results.errors.push({ rowIndex: idx, data: row, errors: error.message || "Unknown error" });
        });
        results.skipped += groupRows.length;
      }
    }

    return results;
  }, [currentOrg, accounts, createJournalEntry]);

  const handleImportComplete = () => {
    accountResolverRef.current = null;
  };

  const handleOpenCreate = () => {
    if (isReadOnly) {
      openUpgradeModal("journal_entries");
      return;
    }
    navigate("/finance/journal-entries/new");
  };

  const handleOpenEdit = (entry: JournalEntry) => {
    if (isReadOnly) {
      openUpgradeModal("journal_entries");
      return;
    }
    navigate(`/finance/journal-entries/${entry.id}/edit`);
  };

  const handlePost = async (id: string) => {
    await postJournalEntry.mutateAsync(id);
  };

  const handleVoid = async () => {
    if (!voidingEntryId || !voidReason) return;
    await voidJournalEntry.mutateAsync({ entryId: voidingEntryId, reason: voidReason });
    setShowVoidDialog(false);
    setVoidingEntryId(null);
    setVoidReason("");
  };

  const executeDeleteJournalEntry = async (entry: JournalEntry) => {
    await deleteJournalEntry.mutateAsync(entry.id);
  };

  const deleteConfirm = useConfirmDelete<JournalEntry>({ onConfirm: executeDeleteJournalEntry });

  const handleDelete = (entry: JournalEntry) => {
    deleteConfirm.requestDelete(entry);
  };

  const handleReverse = async (id: string) => {
    await createReversingEntry.mutateAsync(id);
  };

  const filteredEntries = journalEntries.filter(e => {
    const matchesSearch = 
      e.entry_number.toLowerCase().includes(searchQuery.toLowerCase()) ||
      e.description.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus = statusFilter === "all" || e.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  // Client-side pagination — keeps the page snappy when there are 1k+ JEs
  // and stops the DOM from rendering thousands of rows at once.
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  useEffect(() => { setPage(1); }, [searchQuery, statusFilter, pageSize]);
  const totalCount = filteredEntries.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const safePage = Math.min(page, totalPages);
  const pagedEntries = filteredEntries.slice((safePage - 1) * pageSize, safePage * pageSize);

  const getStatusBadge = (entry: JournalEntry) => {
    const status = entry.status;
    switch (status) {
      case "draft": return <Badge variant="outline"><Clock className="h-3 w-3 mr-1" />Draft</Badge>;
      case "posted": 
        if (entry.is_reversal) {
          return <Badge className="bg-purple-100 text-purple-800"><RotateCcw className="h-3 w-3 mr-1" />Reversal</Badge>;
        }
        return <Badge className="bg-green-100 text-green-800"><CheckCircle className="h-3 w-3 mr-1" />Posted</Badge>;
      case "reversed": return <Badge className="bg-amber-100 text-amber-800"><RotateCcw className="h-3 w-3 mr-1" />Reversed</Badge>;
      case "voided": return <Badge variant="destructive"><XCircle className="h-3 w-3 mr-1" />Voided</Badge>;
      default: return <Badge variant="outline">{status}</Badge>;
    }
  };

  const stats = {
    total: journalEntries.length,
    draft: journalEntries.filter(e => e.status === "draft").length,
    posted: journalEntries.filter(e => e.status === "posted").length,
    reversed: journalEntries.filter(e => e.status === "reversed").length,
    voided: journalEntries.filter(e => e.status === "voided").length,
  };

  return (
    <>
      <div className="space-y-4 sm:space-y-6">
        <div className="page-header">
          <div className="flex items-center gap-2">
            <div>
              <h1 className="page-title">Journal Entries</h1>
              <p className="text-sm sm:text-base text-muted-foreground">
                Record manual accounting adjustments and entries
              </p>
              <div className="mt-2"><FinanceScopeBadge /></div>
            </div>
            <RefreshButton
              queryKeyPrefixes={[
                queryKeys.journalEntries.all(currentOrg?.id || ""),
                queryKeys.accounts.all(currentOrg?.id || ""),
              ]}
              tooltip="Refresh journal entries"
            />
          </div>
          <PermissionGate permission="manageFinancials">
            {canManageJE && (
              <div className="action-buttons w-full sm:w-auto">
                <Button variant="outline" onClick={() => setShowImportWizard(true)} className="flex-1 sm:flex-none">
                  <Upload className="mr-2 h-4 w-4" />
                  Import
                </Button>
                <Button onClick={handleOpenCreate} className="flex-1 sm:flex-none">
                  <Plus className="mr-2 h-4 w-4" />
                  New Entry
                </Button>
              </div>
            )}
          </PermissionGate>
        </div>

        {/* Stats */}
        <div className="stats-grid">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Entries</CardTitle>
              <BookOpen className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.total}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Draft</CardTitle>
              <Clock className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.draft}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Posted</CardTitle>
              <CheckCircle className="h-4 w-4 text-success" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-success">{stats.posted}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Voided</CardTitle>
              <XCircle className="h-4 w-4 text-destructive" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-destructive">{stats.voided}</div>
            </CardContent>
          </Card>
        </div>

        {/* Filters */}
        <div className="filter-bar">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search entries..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10 w-full"
            />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-full sm:w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="draft">Draft</SelectItem>
              <SelectItem value="posted">Posted</SelectItem>
              <SelectItem value="reversed">Reversed</SelectItem>
              <SelectItem value="voided">Voided</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Table */}
        <Card>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : filteredEntries.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <BookOpen className="h-12 w-12 text-muted-foreground mb-4" />
                <h3 className="text-lg font-medium">No journal entries</h3>
                <p className="text-muted-foreground">Create your first journal entry</p>
              </div>
            ) : (
              <div className="table-container">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Entry #</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead>Reference</TableHead>
                    <TableHead className="text-right">Debit</TableHead>
                    <TableHead className="text-right">Credit</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="w-12"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pagedEntries.map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell className="font-medium">
                        <button 
                          onClick={() => setPeekId(entry.id)}
                          className="hover:underline"
                        >
                          {entry.entry_number}
                        </button>
                        {entry.is_adjusting && <Badge variant="outline" className="ml-2">Adj</Badge>}
                        {entry.is_reversal && <Badge className="ml-2 bg-purple-100 text-purple-800 text-xs">Reversal</Badge>}
                        {entry.status === "reversed" && <Badge className="ml-2 bg-amber-100 text-amber-800 text-xs">Reversed</Badge>}
                      </TableCell>
                      <TableCell>{format(new Date(entry.entry_date), "MMM d, yyyy")}</TableCell>
                      <TableCell className="max-w-xs truncate">{entry.description}</TableCell>
                      <TableCell>{entry.reference || "-"}</TableCell>
                      <TableCell className="text-right">{formatCurrency(entry.total_debit || 0)}</TableCell>
                      <TableCell className="text-right">{formatCurrency(entry.total_credit || 0)}</TableCell>
                      <TableCell>{getStatusBadge(entry)}</TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon">
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => setPeekId(entry.id)}>
                              <Eye className="mr-2 h-4 w-4" />
                              View
                            </DropdownMenuItem>
                            <JournalEntryOutputMenuItems entry={entry} />
                            {/* View Source Document — opens TransactionPreviewDrawer */}
                            {entry.source_type && (entry as any).source_id && (
                              <DropdownMenuItem onClick={() => {
                                setDrawerSource({ type: entry.source_type, id: (entry as any).source_id });
                                setDrawerOpen(true);
                              }}>
                                <FileText className="mr-2 h-4 w-4" />
                                View Source ({entry.source_type?.replace(/_/g, " ")})
                              </DropdownMenuItem>
                            )}
                            {entry.status === "draft" && canManageJE && (
                              <>
                                <DropdownMenuItem onClick={() => handleOpenEdit(entry)}>
                                  <BookOpen className="mr-2 h-4 w-4" />
                                  Edit
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => handlePost(entry.id)}>
                                  <Send className="mr-2 h-4 w-4" />
                                  Post
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => handleDelete(entry)} className="text-destructive">
                                  <Trash2 className="mr-2 h-4 w-4" />
                                  Delete
                                </DropdownMenuItem>
                              </>
                            )}
                            {entry.status === "posted" && !entry.is_reversal && !entry.reversal_of_id && canVoidJE && (() => {
                              const SOURCE_DOCUMENT_TYPES = ['invoice', 'bill', 'payment', 'credit_note', 'bill_payment', 'customer_payment'];
                              const isSourceGenerated = entry.source_type && SOURCE_DOCUMENT_TYPES.includes(entry.source_type);
                              if (isSourceGenerated) {
                                return (
                                  <DropdownMenuItem disabled>
                                    <Eye className="mr-2 h-4 w-4" />
                                    Managed by source ({entry.source_type})
                                  </DropdownMenuItem>
                                );
                              }
                              return (
                                <>
                                  <DropdownMenuItem onClick={() => handleReverse(entry.id)}>
                                    <RotateCcw className="mr-2 h-4 w-4" />
                                    Create Reversal
                                  </DropdownMenuItem>
                                  <DropdownMenuItem 
                                    onClick={() => {
                                      setVoidingEntryId(entry.id);
                                      setShowVoidDialog(true);
                                    }}
                                    className="text-destructive"
                                  >
                                    <XCircle className="mr-2 h-4 w-4" />
                                    Void
                                  </DropdownMenuItem>
                                </>
                              );
                            })()}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            )}
            {!isLoading && totalCount > 0 && (
              <DataTablePagination
                pagination={{
                  page: safePage,
                  pageSize,
                  totalCount,
                  totalPages,
                  hasNextPage: safePage < totalPages,
                  hasPreviousPage: safePage > 1,
                }}
                onPageChange={setPage}
                onPageSizeChange={setPageSize}
              />
            )}
          </CardContent>
        </Card>


        {/* Journal Entry peek — the standardized ?peek=<id> surface. */}
        <JournalEntryPeekSheet
          entryId={peekId}
          onOpenChange={(open) => !open && setPeekId(null)}
        />

        {/* Void Confirmation Dialog */}
        <AlertDialog open={showVoidDialog} onOpenChange={setShowVoidDialog}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Void Journal Entry</AlertDialogTitle>
              <AlertDialogDescription>
                This action cannot be undone. Please provide a reason for voiding this entry.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="py-4">
              <Label>Reason *</Label>
              <Textarea
                value={voidReason}
                onChange={(e) => setVoidReason(e.target.value)}
                placeholder="Enter reason for voiding"
              />
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={handleVoid} disabled={!voidReason}>
                Void Entry
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* Delete Confirmation Dialog */}
        <ConfirmDeleteDialog
          open={deleteConfirm.isOpen}
          onOpenChange={deleteConfirm.setIsOpen}
          title="Delete Journal Entry"
          description="Are you sure you want to delete this draft entry? This action cannot be undone."
          onConfirm={deleteConfirm.confirmDelete}
          isLoading={deleteConfirm.isDeleting}
        />

        {/* Import Wizard */}
        <ImportWizard
          open={showImportWizard}
          onOpenChange={setShowImportWizard}
          entityName="Journal Entry"
          fieldDefinitions={journalFieldDefinitions}
          onImport={async () => {}}
          onBatchImport={handleBatchImportJE}
          onComplete={handleImportComplete}
        />

        {/* Transaction Preview Drawer */}
        <TransactionPreviewDrawer
          open={drawerOpen}
          onOpenChange={setDrawerOpen}
          sourceType={drawerSource.type}
          sourceId={drawerSource.id}
        />
      </div>
    </>
  );
}
