import { useState, useEffect } from "react";
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
  Loader2,
  Trash2,
  TrendingUp,
  TrendingDown,
  Wallet,
  CreditCard,
  PiggyBank,
  Upload,
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
          <AccountTree
            accounts={filteredAccounts}
            searchQuery={searchQuery}
            formatCurrency={formatCurrency}
            effectiveBalance={effectiveBalance}
            canEditCoa={canEditCoa}
            storageKey={`coa-tree-expanded:${currentOrg?.id ?? "default"}`}
            onAddRoot={(type) =>
              navigate(`/finance/accounts/new?account_type=${type}`)
            }
            onAddChild={(parent) =>
              navigate(
                `/finance/accounts/new?parent_id=${parent.id}&account_type=${parent.account_type}`,
              )
            }
            onEdit={handleEdit}
            onArchive={handleArchive}
            onRestore={handleRestore}
            onDelete={handleDelete}
            onViewRegister={(a) =>
              navigate(`/finance/accounts/register?account_id=${a.id}`)
            }
            onRunReport={(a) =>
              navigate(`/finance/reports/general-ledger?account_id=${a.id}`)
            }
          />
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
