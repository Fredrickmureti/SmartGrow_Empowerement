import React, { useState, useEffect } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { ConfirmDeleteDialog, useConfirmDelete } from "@/components/shared/ConfirmDeleteDialog";
import { ReturnToMigrationBanner } from "@/components/migration/ReturnToMigrationBanner";
import { MissingSystemAccountsBanner } from "@/components/accounts/MissingSystemAccountsBanner";
import { useAccounts, Account } from "@/hooks/useAccounts";
import { useAccountBalances } from "@/hooks/useAccountBalances";
import { useBalanceIntegrityCheck } from "@/hooks/useBalanceIntegrityCheck";
import { useCurrency } from "@/hooks/useCurrency";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
  Plus,
  Search,
  Landmark,
  MoreHorizontal,
  Loader2,
  Pencil,
  Trash2,
  TrendingUp,
  TrendingDown,
  Wallet,
  CreditCard,
  PiggyBank,
  Upload,
  BookOpen,
} from "lucide-react";
import { ImportWizard } from "@/components/common/ImportWizard";
import { FieldDefinition } from "@/lib/importUtils";
import { ACCOUNT_IMPORT_FIELDS } from "@/lib/importConfigs/accountImportConfig";
import { resolveAccountType } from "@/lib/accountTypeResolver";
import { ReportExportButtons } from "@/components/reports/ReportExportButtons";
import type { ExportConfig, ExportRow, ExportColumn } from "@/services/reports/ReportExportService";
import { useOrganization } from "@/hooks/useOrganization";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { useFinanceScope } from "@/hooks/finance/useFinanceScope";
import { FinanceScopeBadge } from "@/components/finance/FinanceScopeBadge";
import { BranchReadOnlyBanner } from "@/components/finance/BranchReadOnlyBanner";
import { useFinancePermission } from "@/hooks/finance/useFinancePermission";
import { DeleteAllAccountsDialog } from "@/components/accounts/DeleteAllAccountsDialog";
import { AccountTree } from "@/components/accounts/AccountTree";
import { getDetailTypesForAccountType, resolveDetailTypeFromName } from "@/lib/accountDetailTypes";
import { normalizeError } from "@/services/resilience";
// useSearchParams already imported above

export default function Accounts() {
  const { accounts, isLoading, createAccount, deleteAccount, archiveAccount, restoreAccount, getAccountsByType, refreshAccounts } =
    useAccounts();
  const { formatCurrency } = useCurrency();
  const { getEffectiveBalance: rpcBalance, refetch: refetchBalances } = useAccountBalances();
  const { data: integrityDrift } = useBalanceIntegrityCheck();
  const { currentOrg } = useOrganization();
  const { scopeLabel, branchId, hasMultipleBranches, isBranchScopedReadOnly } = useFinanceScope();
  const { allowed: canManageCoa, isLoading: permLoading } = useFinancePermission("finance.manage_coa");
  // Chart of Accounts is a business-level entity. HQ branch IS the edit
  // surface; only NON-HQ branches in a multi-branch business are read-only
  // (mirrors BranchReadOnlyBanner via useFinanceScope).
  const isBranchReadOnly = isBranchScopedReadOnly;
  const canEditCoa = canManageCoa && !isBranchReadOnly;
  const { toast } = useToast();
  const navigate = useNavigate();
  // openingBalanceCheck removed — balances should not be editable on accounts
  const [searchQuery, setSearchQuery] = useState("");
  const [showImportWizard, setShowImportWizard] = useState(false);
  const [showDeleteAllDialog, setShowDeleteAllDialog] = useState(false);

  const accountFieldDefinitions = ACCOUNT_IMPORT_FIELDS;

  const handleImportAccount = async (row: Record<string, any>) => {
    const resolvedType = resolveAccountType(row.account_type || "asset");

    // Resolve detail_type: use explicit value if valid, otherwise auto-resolve from name
    let detailType = row.detail_type || "";
    if (detailType) {
      // Validate that the provided detail_type is valid for this account_type
      const validTypes = getDetailTypesForAccountType(resolvedType.value);
      const isValid = validTypes.some(dt => dt.value === detailType.toLowerCase().replace(/[\s-]/g, "_"));
      if (isValid) {
        detailType = detailType.toLowerCase().replace(/[\s-]/g, "_");
      } else {
        // Invalid detail_type provided — auto-resolve from name
        detailType = resolveDetailTypeFromName(resolvedType.value, row.name || "");
      }
    } else {
      // No detail_type provided — auto-resolve from account name
      detailType = resolveDetailTypeFromName(resolvedType.value, row.name || "");
    }

    // Resolve parent_code to parent_id using DB lookup (handles same-batch imports)
    let parentId: string | null = null;
    if (row.parent_code) {
      const inMemory = accounts.find((a) => a.code === row.parent_code);
      if (inMemory) {
        parentId = inMemory.id;
      } else {
        const { data: dbParent } = await import("@/integrations/supabase/client").then(
          ({ supabase }) =>
            supabase
              .from("accounts")
              .select("id")
              .eq("code", row.parent_code)
              .limit(1)
        );
        if (dbParent && dbParent.length > 0) parentId = dbParent[0].id;
      }
    }

    await createAccount({
      code: row.code,
      name: row.name,
      account_type: resolvedType.value,
      detail_type: detailType || null,
      description: row.description || null,
      opening_balance: row.opening_balance ? Number(row.opening_balance) : 0,
      current_balance: 0, // current_balance is trigger-maintained from JE lines only
      parent_id: parentId,
      is_active: true,
      is_system: false,
    });
  };


  const [searchParams] = useSearchParams();
  // Handle ?action=create from global create menu → navigate to routed create page
  useEffect(() => {
    if (searchParams.get("action") === "create") {
      navigate("/finance/accounts/new", { replace: true });
    }
  }, [searchParams, navigate]);

  const handleCreate = () => navigate("/finance/accounts/new");
  const handleEdit = (account: Account) => navigate(`/finance/accounts/${account.id}/edit`);

  // Build tree structure for display
  const getChildAccounts = (parentId: string) => accounts.filter(a => a.parent_id === parentId);

  const executeDeleteAccount = async (account: Account) => {
    try {
      await deleteAccount(account.id);
      toast({ title: "Account deleted" });
    } catch (error: any) {
      const msg = error.message || "";
      if (msg.includes("cannot be deleted")) {
        toast({
          title: "Cannot delete account",
          description: msg,
          variant: "destructive",
        });
      } else {
        toast({
          title: "Error deleting account",
          description: msg,
          variant: "destructive",
        });
      }
    }
  };

  const handleArchive = async (account: Account) => {
    try {
      await archiveAccount(account.id);
      toast({ title: "Account archived", description: `${account.name} has been deactivated.` });
    } catch (error: any) {
      toast({ title: "Error archiving account", description: normalizeError(error).message, variant: "destructive" });
    }
  };

  const handleRestore = async (account: Account) => {
    try {
      await restoreAccount(account.id);
      toast({ title: "Account restored", description: `${account.name} has been reactivated.` });
    } catch (error: any) {
      toast({ title: "Error restoring account", description: normalizeError(error).message, variant: "destructive" });
    }
  };

  const deleteConfirm = useConfirmDelete<Account>({ onConfirm: executeDeleteAccount });

  const handleDelete = (account: Account) => {
    if (account.is_system) {
      toast({
        title: "Cannot delete",
        description: "System accounts cannot be deleted.",
        variant: "destructive",
      });
      return;
    }
    deleteConfirm.requestDelete(account);
  };

  const filteredAccounts = accounts.filter(
    (a) =>
      a.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      a.code.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Use formatCurrency from hook - removed local function

  const getTypeIcon = (type: Account["account_type"]) => {
    switch (type) {
      case "asset":
        return <Wallet className="h-4 w-4" />;
      case "liability":
        return <CreditCard className="h-4 w-4" />;
      case "equity":
        return <PiggyBank className="h-4 w-4" />;
      case "income":
        return <TrendingUp className="h-4 w-4" />;
      case "expense":
        return <TrendingDown className="h-4 w-4" />;
    }
  };

  const getTypeBadge = (type: Account["account_type"]) => {
    const styles: Record<string, string> = {
      asset: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
      liability: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
      equity: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200",
      income: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
      expense: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200",
    };
    return <Badge className={styles[type]}>{type}</Badge>;
  };

  const accountTypes: { type: Account["account_type"]; label: string; description: string }[] = [
    { type: "asset", label: "Assets", description: "What you own (cash, inventory, equipment)" },
    { type: "liability", label: "Liabilities", description: "What you owe (loans, accounts payable)" },
    { type: "equity", label: "Equity", description: "Owner's stake in the business" },
    { type: "income", label: "Income", description: "Revenue and earnings" },
    { type: "expense", label: "Expenses", description: "Costs of running the business" },
  ];

  // Effective balance derived from RPC (posted JE lines) + opening_balance
  // This matches how financial reports compute balances — single source of truth
  const effectiveBalance = (a: typeof accounts[0]) => rpcBalance(a.id, a.opening_balance || 0);

  const totals = {
    assets: getAccountsByType("asset").reduce((sum, a) => sum + effectiveBalance(a), 0),
    liabilities: getAccountsByType("liability").reduce((sum, a) => sum + effectiveBalance(a), 0),
    equity: getAccountsByType("equity").reduce((sum, a) => sum + effectiveBalance(a), 0),
    income: getAccountsByType("income").reduce((sum, a) => sum + effectiveBalance(a), 0),
    expenses: getAccountsByType("expense").reduce((sum, a) => sum + effectiveBalance(a), 0),
  };

  return (
    <>
      <ReturnToMigrationBanner />
      <MissingSystemAccountsBanner />
      <BranchReadOnlyBanner area="Chart of Accounts" permissionLabel="finance.manage_coa" />
      <div className="space-y-4 sm:space-y-6">
        <div className="page-header">
          <div>
            <h1 className="page-title">Chart of Accounts</h1>
            <p className="text-sm sm:text-base text-muted-foreground">
              Manage your accounting structure
            </p>
            <div className="mt-2"><FinanceScopeBadge /></div>
          </div>
          <div className="action-buttons w-full sm:w-auto">
            <RefreshButton
              queryKeyPrefixes={[
                ['accounts'] as const,
                ['account-balances-rpc'] as const,
              ]}
              tooltip="Refresh accounts"
            />
            <ReportExportButtons
              getExportConfig={() => {
                const columns: ExportColumn[] = [
                  { key: "code", header: "Code", width: 12 },
                  { key: "name", header: "Account Name", width: 30 },
                  { key: "type", header: "Type", width: 14 },
                  { key: "description", header: "Description", width: 30 },
                  { key: "opening_balance", header: "Opening Balance", width: 16, format: "currency", align: "right" },
                  { key: "current_balance", header: "Current Balance", width: 16, format: "currency", align: "right" },
                  { key: "status", header: "Status", width: 10 },
                ];
                const rows: ExportRow[] = accounts.map((a) => ({
                  code: a.code,
                  name: a.name,
                  type: (a.account_type || "").replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()),
                  description: a.description || "",
                  opening_balance: a.opening_balance || 0,
                  current_balance: effectiveBalance(a),
                  status: a.is_active ? "Active" : "Inactive",
                }));
                return {
                  title: "Chart of Accounts",
                  companyName: currentOrg?.name,
                  columns,
                  rows,
                  sheetName: "Chart of Accounts",
                  organizationId: currentOrg?.id,
                  generatedAt: new Date(),
                } as ExportConfig;
              }}
            />
            {canEditCoa && (
              <Button variant="outline" onClick={() => setShowImportWizard(true)} className="flex-1 sm:flex-none">
                <Upload className="mr-2 h-4 w-4" />
                Import
              </Button>
            )}
            {canEditCoa && (
              <Button onClick={handleCreate} className="flex-1 sm:flex-none">
                <Plus className="mr-2 h-4 w-4" />
                Add Account
              </Button>
            )}
            {canEditCoa && accounts.length > 0 && (
              <Button
                variant="destructive"
                onClick={() => setShowDeleteAllDialog(true)}
                className="flex-1 sm:flex-none"
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Delete All
              </Button>
            )}
          </div>
        </div>

        {/* Summary Cards — match AR/AP grid so wide currency values never overflow */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Assets</CardTitle>
              <Wallet className="h-4 w-4 text-blue-600 shrink-0" />
            </CardHeader>
            <CardContent>
              <div className="text-xl font-bold tabular-nums break-words" title={formatCurrency(totals.assets)}>
                {formatCurrency(totals.assets)}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Liabilities</CardTitle>
              <CreditCard className="h-4 w-4 text-red-600 shrink-0" />
            </CardHeader>
            <CardContent>
              <div className="text-xl font-bold tabular-nums break-words" title={formatCurrency(totals.liabilities)}>
                {formatCurrency(totals.liabilities)}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Equity</CardTitle>
              <PiggyBank className="h-4 w-4 text-purple-600 shrink-0" />
            </CardHeader>
            <CardContent>
              <div className="text-xl font-bold tabular-nums break-words" title={formatCurrency(totals.equity)}>
                {formatCurrency(totals.equity)}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Income</CardTitle>
              <TrendingUp className="h-4 w-4 text-green-600 shrink-0" />
            </CardHeader>
            <CardContent>
              <div className="text-xl font-bold tabular-nums break-words" title={formatCurrency(totals.income)}>
                {formatCurrency(totals.income)}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Expenses</CardTitle>
              <TrendingDown className="h-4 w-4 text-orange-600 shrink-0" />
            </CardHeader>
            <CardContent>
              <div className="text-xl font-bold tabular-nums break-words" title={formatCurrency(totals.expenses)}>
                {formatCurrency(totals.expenses)}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Search */}
        <div className="relative max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search accounts..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10"
          />
        </div>

        {/* Accounts List */}
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : accounts.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12 text-center">
              <Landmark className="h-12 w-12 text-muted-foreground mb-4" />
              <h3 className="text-lg font-medium">No accounts yet</h3>
              <p className="text-muted-foreground mb-4">
                Set up your chart of accounts to start tracking finances.
              </p>
              {canEditCoa && (
                <Button onClick={handleCreate}>
                  <Plus className="mr-2 h-4 w-4" />
                  Add Your First Account
                </Button>
              )}
            </CardContent>
          </Card>
        ) : (
          <Accordion type="multiple" defaultValue={["asset", "liability", "equity", "income", "expense"]}>
            {accountTypes.map(({ type, label, description }) => {
              const typeAccounts = filteredAccounts.filter((a) => a.account_type === type);
              if (typeAccounts.length === 0 && searchQuery) return null;

              return (
                <AccordionItem key={type} value={type}>
                  <AccordionTrigger className="hover:no-underline">
                    <div className="flex items-center gap-3">
                      {getTypeIcon(type)}
                      <div className="text-left">
                        <span className="font-medium">{label}</span>
                        <span className="text-sm text-muted-foreground ml-2">
                          ({typeAccounts.length})
                        </span>
                      </div>
                    </div>
                  </AccordionTrigger>
                  <AccordionContent>
                    {typeAccounts.length === 0 ? (
                      <p className="text-sm text-muted-foreground py-4 text-center">
                        No {label.toLowerCase()} accounts. {description}
                      </p>
                    ) : (
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Code</TableHead>
                            <TableHead>Name</TableHead>
                            <TableHead>Description</TableHead>
                            <TableHead className="text-right">Balance</TableHead>
                            <TableHead className="w-12"></TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {typeAccounts.map((account) => {
                            const children = getChildAccounts(account.id);
                            const isParent = children.length > 0;
                            const isChild = !!account.parent_id;
                            // Skip children at top level - they render under parents
                            if (isChild) return null;
                            
                            return (
                              <React.Fragment key={account.id}>
                              <TableRow key={account.id}>
                              <TableCell className="font-mono text-sm">
                                {account.code}
                              </TableCell>
                              <TableCell className="font-medium">
                                <div className="flex items-center gap-1">
                                  {account.name}
                                  {account.is_system && (
                                    <Badge variant="outline" className="ml-2 text-xs">
                                      System
                                    </Badge>
                                  )}
                                  {!account.is_active && (
                                    <Badge variant="secondary" className="ml-2 text-xs">
                                      Archived
                                    </Badge>
                                  )}
                                  {account.detail_type && (
                                    <Badge variant="outline" className="ml-1 text-xs text-muted-foreground">
                                      {getDetailTypeLabel(account.account_type, account.detail_type)}
                                    </Badge>
                                  )}
                                </div>
                              </TableCell>
                              <TableCell className="text-muted-foreground">
                                {account.description || "—"}
                              </TableCell>
                              <TableCell className="text-right font-medium">
                                {formatCurrency(effectiveBalance(account))}
                              </TableCell>
                              <TableCell>
                                <DropdownMenu>
                                  <DropdownMenuTrigger asChild>
                                    <Button variant="ghost" size="icon">
                                      <MoreHorizontal className="h-4 w-4" />
                                    </Button>
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent align="end">
                                    <DropdownMenuItem
                                      onClick={() => navigate(`/finance/accounts/register?account_id=${account.id}`)}
                                    >
                                      <BookOpen className="mr-2 h-4 w-4" />
                                      View Register
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                      onClick={() => navigate(`/finance/reports/general-ledger?account_id=${account.id}`)}
                                    >
                                      <TrendingUp className="mr-2 h-4 w-4" />
                                      Run Report
                                    </DropdownMenuItem>
                                    {canEditCoa && (
                                      <DropdownMenuItem
                                        onClick={() => handleEdit(account)}
                                      >
                                        <Pencil className="mr-2 h-4 w-4" />
                                        Edit
                                      </DropdownMenuItem>
                                    )}
                                    {canEditCoa && !account.is_system && account.is_active && (
                                      <DropdownMenuItem
                                        onClick={() => handleArchive(account)}
                                      >
                                        Make Inactive
                                      </DropdownMenuItem>
                                    )}
                                    {canEditCoa && !account.is_system && !account.is_active && (
                                      <DropdownMenuItem
                                        onClick={() => handleRestore(account)}
                                      >
                                        Make Active
                                      </DropdownMenuItem>
                                    )}
                                    {canEditCoa && !account.is_system && (
                                      <DropdownMenuItem
                                        onClick={() => handleDelete(account)}
                                        className="text-destructive"
                                      >
                                        <Trash2 className="mr-2 h-4 w-4" />
                                        Delete
                                      </DropdownMenuItem>
                                    )}
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              </TableCell>
                            </TableRow>
                              {/* Render child accounts indented */}
                              {children.map((child) => (
                                <TableRow key={child.id} className="bg-muted/30">
                                  <TableCell className="font-mono text-sm pl-8">
                                    <span className="text-muted-foreground mr-1">↳</span> {child.code}
                                  </TableCell>
                                  <TableCell className="font-medium pl-8">
                                    <div className="flex items-center gap-1">
                                      {child.name}
                                      {child.detail_type && (
                                        <Badge variant="outline" className="ml-1 text-xs text-muted-foreground">
                                          {getDetailTypeLabel(child.account_type, child.detail_type)}
                                        </Badge>
                                      )}
                                    </div>
                                  </TableCell>
                                  <TableCell className="text-muted-foreground">
                                    {child.description || "—"}
                                  </TableCell>
                                  <TableCell className="text-right font-medium">
                                    {formatCurrency(effectiveBalance(child))}
                                  </TableCell>
                                  <TableCell>
                                    <DropdownMenu>
                                      <DropdownMenuTrigger asChild>
                                        <Button variant="ghost" size="icon">
                                          <MoreHorizontal className="h-4 w-4" />
                                        </Button>
                                      </DropdownMenuTrigger>
                                      <DropdownMenuContent align="end">
                                        <DropdownMenuItem onClick={() => navigate(`/finance/accounts/register?account_id=${child.id}`)}>
                                          <BookOpen className="mr-2 h-4 w-4" /> View Register
                                        </DropdownMenuItem>
                                        {canEditCoa && (
                                          <DropdownMenuItem onClick={() => handleEdit(child)}>
                                            <Pencil className="mr-2 h-4 w-4" /> Edit
                                          </DropdownMenuItem>
                                        )}
                                        {canEditCoa && !child.is_system && child.is_active && (
                                          <DropdownMenuItem onClick={() => handleArchive(child)}>
                                            Make Inactive
                                          </DropdownMenuItem>
                                        )}
                                        {canEditCoa && !child.is_system && !child.is_active && (
                                          <DropdownMenuItem onClick={() => handleRestore(child)}>
                                            Make Active
                                          </DropdownMenuItem>
                                        )}
                                        {canEditCoa && !child.is_system && (
                                          <DropdownMenuItem onClick={() => handleDelete(child)} className="text-destructive">
                                            <Trash2 className="mr-2 h-4 w-4" /> Delete
                                          </DropdownMenuItem>
                                        )}
                                      </DropdownMenuContent>
                                    </DropdownMenu>
                                  </TableCell>
                              </TableRow>
                              ))}
                              </React.Fragment>
                            );
                          })}
                        </TableBody>
                      </Table>
                    )}
                  </AccordionContent>
                </AccordionItem>
              );
            })}
          </Accordion>
        )}


        {/* Delete Confirmation Dialog */}
        <ConfirmDeleteDialog
          open={deleteConfirm.isOpen}
          onOpenChange={deleteConfirm.setIsOpen}
          title="Delete Account"
          itemName={deleteConfirm.itemToDelete?.name}
          onConfirm={deleteConfirm.confirmDelete}
          isLoading={deleteConfirm.isDeleting}
        />

        {/* Import Wizard */}
        <ImportWizard
          open={showImportWizard}
          onOpenChange={setShowImportWizard}
          entityName="Account"
          fieldDefinitions={accountFieldDefinitions}
          onImport={handleImportAccount}
          onComplete={() => {}}
        />

        {/* Delete All Chart of Accounts */}
        <DeleteAllAccountsDialog
          open={showDeleteAllDialog}
          onOpenChange={setShowDeleteAllDialog}
          accounts={accounts}
          organizationId={currentOrg?.id ?? ""}
          organizationName={currentOrg?.name ?? "this organization"}
          onDeleted={refreshAccounts}
        />
      </div>
    </>
  );
}
