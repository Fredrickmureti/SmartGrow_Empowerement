import { useState, useRef, useCallback, useEffect } from "react";
import { JOURNAL_ENTRY_IMPORT_FIELDS } from "@/lib/importConfigs/journalEntryImportConfig";
import { useSearchParams, useNavigate } from "react-router-dom";
import { ConfirmDeleteDialog, useConfirmDelete } from "@/components/shared/ConfirmDeleteDialog";
import { useJournalEntries, JournalEntry } from "@/hooks/useJournalEntries";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
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
  const [viewingEntry, setViewingEntry] = useState<JournalEntry | null>(null);
  const [showVoidDialog, setShowVoidDialog] = useState(false);
  const [voidingEntryId, setVoidingEntryId] = useState<string | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const [showImportWizard, setShowImportWizard] = useState(false);
  const accountResolverRef = useRef<AccountResolver | null>(null);
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
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

  // Handle ?selected={journalId} deep-link to auto-open detail view
  useEffect(() => {
    const selectedId = searchParams.get("selected");
    if (selectedId && journalEntries?.length) {
      const entry = journalEntries.find(e => e.id === selectedId);
      if (entry) {
        setViewingEntry(entry);
      }
    }
  }, [searchParams, journalEntries]);

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
                          onClick={() => setViewingEntry(entry)}
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
                            <DropdownMenuItem onClick={() => setViewingEntry(entry)}>
                              <Eye className="mr-2 h-4 w-4" />
                              View
                            </DropdownMenuItem>
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

        {/* Create/Edit Dialog */}
        <Dialog open={showDialog} onOpenChange={setShowDialog}>
              <DialogContent className="w-full max-w-[95vw] sm:max-w-2xl md:max-w-3xl lg:max-w-4xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>
                {editingEntry ? "Edit Journal Entry" : "Create Journal Entry"}
              </DialogTitle>
              <DialogDescription>
                Debits must equal credits for the entry to be valid
              </DialogDescription>
            </DialogHeader>
            
            <form onSubmit={handleSubmit} className="space-y-4">
                <div className="grid gap-4 md:grid-cols-3">
                  <div className="space-y-2">
                  <Label>Date *</Label>
                  <Input
                    type="date"
                    value={formData.entry_date}
                    onChange={(e) => setFormData({ ...formData, entry_date: e.target.value })}
                    required
                  />
                  {formData.entry_date && isDateLocked(formData.entry_date) && (
                    <Alert variant="destructive" className="py-2">
                      <Lock className="h-3.5 w-3.5" />
                      <AlertDescription className="text-xs">
                        Fiscal period for {format(new Date(formData.entry_date), "MMM d, yyyy")} is closed — saving will fail.
                      </AlertDescription>
                    </Alert>
                  )}
                </div>
                  <div className="space-y-2">
                  <Label>Reference</Label>
                  <Input
                    value={formData.reference}
                    onChange={(e) => setFormData({ ...formData, reference: e.target.value })}
                    placeholder="Optional reference"
                  />
                </div>
                <div className="space-y-2 flex items-end gap-4">
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="is_adjusting"
                      checked={formData.is_adjusting}
                      onCheckedChange={(checked) => setFormData({ ...formData, is_adjusting: !!checked })}
                    />
                    <Label htmlFor="is_adjusting">Adjusting Entry</Label>
                  </div>
                </div>
              </div>

                  <div className="space-y-2">
                <Label>Description *</Label>
                <Textarea
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  placeholder="Describe the purpose of this entry"
                  required
                />
              </div>

                  <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>Lines</Label>
                  <Button type="button" variant="outline" size="sm" onClick={handleAddLine}>
                    <Plus className="h-4 w-4 mr-1" />
                    Add Line
                  </Button>
                </div>
                
                    {/* Mobile card layout */}
                    <div className="flex flex-col gap-3 sm:hidden">
                      {formData.lines.map((line, index) => (
                        <div key={index} className="rounded-lg border p-3 space-y-3">
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-medium text-muted-foreground">Line {index + 1}</span>
                            <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={() => handleRemoveLine(index)}>
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs">Account *</Label>
                            <AccountCombobox
                              accounts={accounts}
                              value={line.account_id}
                              onValueChange={(v) => handleLineChange(index, "account_id", v)}
                              placeholder="Search account..."
                            />
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs">Description</Label>
                            <Input
                              value={line.description}
                              onChange={(e) => handleLineChange(index, "description", e.target.value)}
                              placeholder="Line description"
                            />
                          </div>
                          {controlRoleFor(line.account_id) && (
                            <div className="space-y-1">
                              <Label className="text-xs">
                                {controlRoleFor(line.account_id) === "ar" ? "Customer" : "Vendor"} *
                              </Label>
                              <ContactCombobox
                                contacts={contacts}
                                role={controlRoleFor(line.account_id) === "ar" ? "customer" : "supplier"}
                                value={line.contact_id}
                                onValueChange={(v) => handleLineChange(index, "contact_id", v ?? "")}
                                invalid={!line.contact_id}
                                placeholder="Required for control account"
                              />
                            </div>
                          )}
                          <div className="grid grid-cols-2 gap-3">
                            <div className="space-y-1">
                              <Label className="text-xs">Debit</Label>
                              <Input
                                type="number"
                                step="0.01"
                                min="0"
                                value={line.debit || ""}
                                onChange={(e) => handleLineChange(index, "debit", parseFloat(e.target.value) || 0)}
                                disabled={line.credit > 0}
                              />
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">Credit</Label>
                              <Input
                                type="number"
                                step="0.01"
                                min="0"
                                value={line.credit || ""}
                                onChange={(e) => handleLineChange(index, "credit", parseFloat(e.target.value) || 0)}
                                disabled={line.debit > 0}
                              />
                            </div>
                          </div>
                        </div>
                      ))}
                      <div className="flex items-center justify-between rounded-lg border bg-muted/50 p-3 font-bold text-sm">
                        <span>Totals:</span>
                        <div className="flex gap-4">
                          <span className={!isBalanced ? "text-destructive" : ""}>{formatCurrency(totalDebit)}</span>
                          <span className={!isBalanced ? "text-destructive" : ""}>{formatCurrency(totalCredit)}</span>
                        </div>
                      </div>
                    </div>

                    {/* Desktop table layout */}
                    <div className="hidden sm:block overflow-x-auto">
                      <Table className="min-w-[600px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Account *</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead className="w-44">Customer / Vendor</TableHead>
                      <TableHead className="w-32">Debit</TableHead>
                      <TableHead className="w-32">Credit</TableHead>
                      <TableHead className="w-12"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {formData.lines.map((line, index) => {
                      const role = controlRoleFor(line.account_id);
                      return (
                      <TableRow key={index}>
                        <TableCell className="min-w-[200px]">
                          <AccountCombobox
                            accounts={accounts}
                            value={line.account_id}
                            onValueChange={(v) => handleLineChange(index, "account_id", v)}
                            placeholder="Search account..."
                          />
                        </TableCell>
                        <TableCell>
                          <Input
                            value={line.description}
                            onChange={(e) => handleLineChange(index, "description", e.target.value)}
                            placeholder="Line description"
                          />
                        </TableCell>
                        <TableCell>
                          {role ? (
                            <ContactCombobox
                              contacts={contacts}
                              role={role === "ar" ? "customer" : "supplier"}
                              value={line.contact_id}
                              onValueChange={(v) => handleLineChange(index, "contact_id", v ?? "")}
                              invalid={!line.contact_id}
                              placeholder={role === "ar" ? "Customer *" : "Vendor *"}
                            />
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <Input
                            type="number"
                            step="0.01"
                            min="0"
                            value={line.debit || ""}
                            onChange={(e) => handleLineChange(index, "debit", parseFloat(e.target.value) || 0)}
                            disabled={line.credit > 0}
                          />
                        </TableCell>
                        <TableCell>
                          <Input
                            type="number"
                            step="0.01"
                            min="0"
                            value={line.credit || ""}
                            onChange={(e) => handleLineChange(index, "credit", parseFloat(e.target.value) || 0)}
                            disabled={line.debit > 0}
                          />
                        </TableCell>
                        <TableCell>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            onClick={() => handleRemoveLine(index)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                      );
                    })}
                    <TableRow className="font-bold">
                      <TableCell colSpan={3} className="text-right">Totals:</TableCell>
                      <TableCell className={!isBalanced ? "text-destructive" : ""}>
                        {formatCurrency(totalDebit)}
                      </TableCell>
                      <TableCell className={!isBalanced ? "text-destructive" : ""}>
                        {formatCurrency(totalCredit)}
                      </TableCell>
                      <TableCell></TableCell>
                    </TableRow>
                  </TableBody>
                      </Table>
                    </div>

                {!isBalanced && (
                  <p className="text-sm text-destructive">
                    Entry is unbalanced. Difference: {formatCurrency(Math.abs(totalDebit - totalCredit))}
                  </p>
                )}
                {hasMissingContact && (
                  <p className="text-sm text-destructive">
                    {missingContactLines.length === 1 ? "Line" : "Lines"}{" "}
                    {missingContactLines.map((x) => x.i + 1).join(", ")}{" "}
                    post to an AR/AP control account — pick a customer or vendor
                    to keep the subledger reconciled with the GL.
                  </p>
                )}
              </div>

              <DialogFooter className="flex-col sm:flex-row gap-2">
                <Button type="button" variant="outline" onClick={() => setShowDialog(false)} className="w-full sm:w-auto">
                  Cancel
                </Button>
                <Button type="submit" disabled={isSubmitting || !isBalanced || hasMissingContact || formData.lines.length < 2 || isDateLocked(formData.entry_date)} className="w-full sm:w-auto">
                  {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {editingEntry ? "Update" : "Create"} Entry
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>

        {/* View Entry Dialog */}
        <Dialog open={!!viewingEntry} onOpenChange={() => setViewingEntry(null)}>
          <DialogContent className="w-[95vw] max-w-3xl p-4 sm:p-6">
            <DialogHeader>
              <DialogTitle className="text-lg">Journal Entry {viewingEntry?.entry_number}</DialogTitle>
              <DialogDescription>
                {viewingEntry && format(new Date(viewingEntry.entry_date), "MMMM d, yyyy")}
              </DialogDescription>
            </DialogHeader>
            
            {viewingEntry && (
              <div className="space-y-4 overflow-hidden">
                <div className="flex flex-wrap items-center gap-2">
                  {getStatusBadge(viewingEntry)}
                  {viewingEntry.is_adjusting && <Badge variant="outline">Adjusting Entry</Badge>}
                  {viewingEntry.is_reversal && viewingEntry.reversal_of_id && (
                    <Badge variant="outline" className="text-purple-700">
                      Reversal of {journalEntries.find(e => e.id === viewingEntry.reversal_of_id)?.entry_number || "unknown"}
                    </Badge>
                  )}
                  {viewingEntry.reversed_by_id && (
                    <Badge variant="outline" className="text-amber-700">
                      Reversed by {journalEntries.find(e => e.id === viewingEntry.reversed_by_id)?.entry_number || "unknown"}
                    </Badge>
                  )}
                </div>

                <div>
                  <Label className="text-muted-foreground">Description</Label>
                  <p className="text-sm break-words">{viewingEntry.description}</p>
                </div>

                {viewingEntry.reference && (
                  <div>
                    <Label className="text-muted-foreground">Reference</Label>
                    <p className="text-sm">{viewingEntry.reference}</p>
                  </div>
                )}

                {/* Audit Trail Metadata */}
                <div className="grid grid-cols-2 gap-3">
                  {viewingEntry.posted_at && (
                    <div>
                      <Label className="text-muted-foreground text-xs">Posted</Label>
                      <p className="text-xs">{format(new Date(viewingEntry.posted_at), "MMM d, yyyy HH:mm")}</p>
                    </div>
                  )}
                  {viewingEntry.voided_at && (
                    <div>
                      <Label className="text-muted-foreground text-xs">Voided</Label>
                      <p className="text-xs">{format(new Date(viewingEntry.voided_at), "MMM d, yyyy HH:mm")}</p>
                    </div>
                  )}
                  {viewingEntry.void_reason && (
                    <div className="col-span-2">
                      <Label className="text-muted-foreground text-xs">Void Reason</Label>
                      <p className="text-xs text-destructive">{viewingEntry.void_reason}</p>
                    </div>
                  )}
                  {viewingEntry.created_at && (
                    <div>
                      <Label className="text-muted-foreground text-xs">Created</Label>
                      <p className="text-xs">{format(new Date(viewingEntry.created_at), "MMM d, yyyy HH:mm")}</p>
                    </div>
                  )}
                </div>

                {/* Source Transaction Link */}
                {(viewingEntry as any).source_type && (viewingEntry as any).source_id && (
                  <div>
                    <Label className="text-muted-foreground">Source Transaction</Label>
                    <Button
                      variant="link"
                      className="p-0 h-auto text-primary"
                      onClick={() => {
                        setDrawerSource({
                          type: (viewingEntry as any).source_type,
                          id: (viewingEntry as any).source_id,
                        });
                        setDrawerOpen(true);
                      }}
                    >
                      View {(viewingEntry as any).source_type?.replace("_", " ")} →
                    </Button>
                  </div>
                )}

                {/* Mobile card layout for journal lines */}
                <div className="sm:hidden space-y-3">
                  {viewingEntry.lines?.map((line) => (
                    <div key={line.id} className="p-3 border rounded-lg bg-muted/30 space-y-2">
                      <p className="text-sm font-medium">{line.accounts?.code} - {line.accounts?.name}</p>
                      {line.description && <p className="text-xs text-muted-foreground">{line.description}</p>}
                      <div className="flex justify-between text-sm">
                        <span>
                          {line.debit > 0 && <span className="text-foreground">Dr: {formatCurrency(line.debit)}</span>}
                        </span>
                        <span>
                          {line.credit > 0 && <span className="text-foreground">Cr: {formatCurrency(line.credit)}</span>}
                        </span>
                      </div>
                    </div>
                  ))}
                  <div className="p-3 border rounded-lg bg-muted/50 flex justify-between font-bold text-sm">
                    <span>Dr: {formatCurrency(viewingEntry.total_debit || 0)}</span>
                    <span>Cr: {formatCurrency(viewingEntry.total_credit || 0)}</span>
                  </div>
                </div>

                {/* Desktop table layout */}
                <div className="hidden sm:block">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Account</TableHead>
                        <TableHead>Description</TableHead>
                        <TableHead className="text-right">Debit</TableHead>
                        <TableHead className="text-right">Credit</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {viewingEntry.lines?.map((line) => (
                        <TableRow key={line.id}>
                          <TableCell>
                            {line.accounts?.code} - {line.accounts?.name}
                          </TableCell>
                          <TableCell>{line.description || "-"}</TableCell>
                          <TableCell className="text-right">
                            {line.debit > 0 ? formatCurrency(line.debit) : "-"}
                          </TableCell>
                          <TableCell className="text-right">
                            {line.credit > 0 ? formatCurrency(line.credit) : "-"}
                          </TableCell>
                        </TableRow>
                      ))}
                      <TableRow className="font-bold">
                        <TableCell colSpan={2} className="text-right">Totals:</TableCell>
                        <TableCell className="text-right">{formatCurrency(viewingEntry.total_debit || 0)}</TableCell>
                        <TableCell className="text-right">{formatCurrency(viewingEntry.total_credit || 0)}</TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                </div>

                {viewingEntry.void_reason && (
                  <div className="p-3 bg-destructive/10 rounded-lg">
                    <Label className="text-destructive">Void Reason</Label>
                    <p>{viewingEntry.void_reason}</p>
                  </div>
                )}
              </div>
            )}
          </DialogContent>
        </Dialog>

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
