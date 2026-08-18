import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
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
import { BankAccount, resolveBankAccountBalance } from "@/hooks/useBankAccounts";
import { useCurrency } from "@/hooks/useCurrency";
import { getBankAccountTypeLabel } from "@/lib/bankAccountTypes";
import {
  Building2,
  RefreshCw,
  MoreVertical,
  Trash2,
  Edit,
  CheckCircle2,
  AlertCircle,
  Clock,
  Loader2,
  Star,
  Scale,
  FileUp,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { Link } from "react-router-dom";

interface BankAccountCardProps {
  account: BankAccount;
  glBalance?: number | null;
  unreconciledCount?: number;
  lastReconciledDate?: string | null;
  onSync: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onImport?: () => void;
  isSyncing?: boolean;
}

export function BankAccountCard({ 
  account, 
  glBalance,
  unreconciledCount,
  lastReconciledDate,
  onSync, 
  onEdit, 
  onDelete,
  onImport,
  isSyncing = false,
}: BankAccountCardProps) {
  const { formatCurrency } = useCurrency();
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [logoError, setLogoError] = useState(false);

  // Phase 7: prefer the caller-supplied GL balance, then the server-derived
  // position. When neither resolves we render an em dash — a balance we cannot
  // trace to a source row is an absence, not a zero.
  const resolved = resolveBankAccountBalance(account);
  const displayBalance = glBalance ?? resolved?.amount ?? null;
  const balanceLabel =
    glBalance != null || resolved?.source === "gl"
      ? "Book Balance (GL)"
      : resolved?.source === "statement"
        ? "Statement Balance"
        : "Balance";

  const formatAmount = (amount: number, currency: string) => {
    return formatCurrency(amount, currency);
  };

  const providerLogo = (account as any).platform_bank_providers?.logo_url;
  const hasProvider = !!account.provider_id;

  // Phase 14: feed state comes from the connection + its latest run, never from
  // the account row. `running` is a real run row, not an optimistic UI flag.
  const feed = account.feed ?? null;
  const isRunning = feed?.last_run_status === "running";
  const lastSyncAt = feed?.last_success_at ?? feed?.last_run_at ?? null;
  const feedError =
    feed?.last_run_status === "failed" || feed?.status === "error"
      ? feed?.last_error ?? feed?.last_run_error_code ?? "Last sync failed"
      : null;

  const getSyncStatusBadge = () => {
    if (isRunning) {
      return (
        <Badge variant="outline" className="text-blue-600 border-blue-500">
          <Loader2 className="h-3 w-3 mr-1 animate-spin" />
          Syncing
        </Badge>
      );
    }
    if (feedError) {
      return (
        <Badge variant="outline" className="text-destructive border-destructive/50">
          <AlertCircle className="h-3 w-3 mr-1" />
          Error
        </Badge>
      );
    }
    if (feed?.last_run_status === "succeeded" || feed?.last_success_at) {
      return (
        <Badge variant="outline" className="text-green-600 border-green-500">
          <CheckCircle2 className="h-3 w-3 mr-1" />
          Synced
        </Badge>
      );
    }
    return (
      <Badge variant="outline" className="text-muted-foreground">
        <Clock className="h-3 w-3 mr-1" />
        {feed ? "Pending" : hasProvider ? "Not connected" : "Manual"}
      </Badge>
    );
  };


  const renderBankLogo = () => {
    if (providerLogo && !logoError) {
      return (
        <img 
          src={providerLogo} 
          alt={account.bank_name || "Bank"}
          className="h-full w-full object-contain"
          onError={() => setLogoError(true)}
        />
      );
    }
    return <Building2 className="h-5 w-5" />;
  };

  return (
    <>
      <Card className={account.is_primary ? "border-primary/50" : ""}>
        <CardHeader className="pb-2">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-muted flex items-center justify-center overflow-hidden">
                {renderBankLogo()}
              </div>
              <div>
                <CardTitle className="text-base flex items-center gap-2">
                  {account.name}
                  {account.is_primary && (
                    <Star className="h-4 w-4 text-amber-500 fill-amber-500" />
                  )}
                </CardTitle>
                <p className="text-sm text-muted-foreground">
                  {account.bank_name || "Unknown Bank"}
                  {account.account_number && ` • ****${account.account_number.slice(-4)}`}
                  {(account as any).account_type && ` • ${getBankAccountTypeLabel((account as any).account_type)}`}
                </p>
              </div>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8">
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={onEdit}>
                  <Edit className="h-4 w-4 mr-2" />
                  Edit Account
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link to={`/bank-reconciliation?account=${account.id}`}>
                    <Scale className="h-4 w-4 mr-2" />
                    Reconcile
                  </Link>
                </DropdownMenuItem>
                {onImport && (
                  <DropdownMenuItem onClick={onImport}>
                    <FileUp className="h-4 w-4 mr-2" />
                    Import Statement
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem 
                  onClick={() => setDeleteDialogOpen(true)}
                  className="text-destructive"
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete Account
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-muted-foreground">
                {balanceLabel}
              </p>
              <p className="text-2xl font-bold">
                {displayBalance == null
                  ? "—"
                  : formatAmount(displayBalance, account.currency || "USD")}
              </p>
              {glBalance == null && account.account_id == null && (
                <p className="text-xs text-amber-600 mt-0.5">⚠ No GL link — balance is not ledger-derived</p>
              )}
            </div>
            {getSyncStatusBadge()}
          </div>

          {feedError && (
            <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20">
              <p className="text-sm text-destructive">{feedError}</p>
              {feed?.consecutive_failures ? (
                <p className="text-xs text-destructive/80 mt-1">
                  {feed.consecutive_failures} consecutive failed run
                  {feed.consecutive_failures === 1 ? "" : "s"}
                </p>
              ) : null}
            </div>
          )}


          {/* Per-account stats */}
          {(unreconciledCount !== undefined || lastReconciledDate) && (
            <div className="flex items-center justify-between text-xs text-muted-foreground border-t pt-2">
              {unreconciledCount !== undefined && unreconciledCount > 0 ? (
                <span className="text-amber-600 dark:text-amber-400">
                  {unreconciledCount} unreconciled
                </span>
              ) : unreconciledCount === 0 ? (
                <span className="text-green-600 dark:text-green-400">All reconciled</span>
              ) : <span />}
              {lastReconciledDate && (
                <span>Last recon: {formatDistanceToNow(new Date(lastReconciledDate), { addSuffix: true })}</span>
              )}
            </div>
          )}

          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>
              {account.last_sync_at 
                ? `Last synced ${formatDistanceToNow(new Date(account.last_sync_at), { addSuffix: true })}`
                : hasProvider ? "Never synced" : "Manual account"
              }
            </span>
            {hasProvider && (
              <Button 
                variant="outline" 
                size="sm" 
                onClick={onSync}
                disabled={isSyncing || account.sync_status === "syncing"}
              >
                {(isSyncing || account.sync_status === "syncing") ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4 mr-2" />
                )}
                Sync
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Bank Account?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete "{account.name}" and all associated transaction data. 
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                onDelete();
                setDeleteDialogOpen(false);
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
