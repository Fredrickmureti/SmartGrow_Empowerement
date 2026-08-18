import { normalizeError } from "@/services/resilience";
/**
 * BranchOperations — operational scoping for a branch.
 *
 * RENAMED from `BranchScopedSettings`. The name reflects what this panel
 * actually does: it RE-SCOPES operational records (bank accounts, payment
 * methods) to a specific branch by writing `branch_id` on them. It is NOT
 * a "branch settings" surface — that's `BranchOverridesEditor`, which
 * edits the override columns on `branches` itself (logo, receipt header,
 * invoice prefix suffix, default warehouse).
 *
 * Bank accounts and payment methods both carry an OPTIONAL `branch_id`
 * (NULL = available company-wide; non-null = scoped to that branch only).
 * The DB trigger `enforce_branch_business_match` already validates that any
 * `branch_id` we write belongs to the same `business_id`, so we cannot leak
 * across companies even by accident.
 */
import { useMemo } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
// SCOPE-TRIGGER-EXEMPT: settings copy mentions 'switch branch' as instruction text; no trigger
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ScopeChip } from "@/components/settings/ScopeChip";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { Banknote, CreditCard, Info, Loader2, MoreHorizontal } from "lucide-react";
import { toast } from "sonner";

interface BranchOperationsProps {
  branchId: string;
  branchName: string;
  businessId: string;
}

export function BranchOperations({ branchId, branchName, businessId }: BranchOperationsProps) {
  const { currentOrg } = useOrganization();
  const queryClient = useQueryClient();

  const { data: bankAccounts = [], isLoading: loadingBanks } = useQuery({
    queryKey: ["branch-bank-accounts", currentOrg?.id, businessId],
    enabled: !!currentOrg?.id && !!businessId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("bank_accounts")
        .select("id, name, bank_name, branch_id")
        .eq("organization_id", currentOrg!.id)
        .eq("business_id", businessId)
        .eq("is_active", true);
      if (error) throw error;
      return data ?? [];
    },
  });

  // Read raw rows directly so we keep `branch_id` (the typed hook strips it).
  const { data: rawMethods = [], isLoading: loadingMethods } = useQuery({
    queryKey: ["branch-payment-methods", currentOrg?.id, businessId],
    enabled: !!currentOrg?.id && !!businessId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("organization_payment_methods")
        .select("id, label, type, branch_id")
        .eq("organization_id", currentOrg!.id)
        .eq("business_id", businessId);
      if (error) throw error;
      return data ?? [];
    },
  });

  const branchBanks = useMemo(
    () =>
      bankAccounts.filter((b) => b.branch_id === branchId || b.branch_id == null),
    [bankAccounts, branchId],
  );

  const branchMethods = useMemo(
    () => rawMethods.filter((m) => m.branch_id === branchId || m.branch_id == null),
    [rawMethods, branchId],
  );

  const setBankBranch = useMutation({
    mutationFn: async ({ id, newBranchId }: { id: string; newBranchId: string | null }) => {
      // Belt-and-braces scope filters: never trust ID alone, even with RLS.
      // Mirrors the architecture-guard test in src/test/architecture/business-scoped-queries.test.ts.
      if (!currentOrg?.id || !businessId) {
        throw new Error("No branch company selected");
      }
      // Wave 1: bank accounts are only mutated through the server write seam,
      // which re-validates branch/company coherence and permissions.
      const { error } = await supabase.rpc("bank_account_update", {
        _id: id,
        _row_version: null,
        _payload: { branch_id: newBranchId } as never,
      });

      if (error) throw error;
    },
    onSuccess: (_d, vars) => {
      toast.success(
        vars.newBranchId ? "Bank account moved to this branch" : "Bank account is now company-wide",
      );
      queryClient.invalidateQueries({ queryKey: ["branch-bank-accounts"] });
    },
    onError: (err: Error) => toast.error(normalizeError(err).message),
  });

  const setMethodBranch = useMutation({
    mutationFn: async ({ id, newBranchId }: { id: string; newBranchId: string | null }) => {
      if (!currentOrg?.id || !businessId) {
        throw new Error("No branch company selected");
      }
      const { error } = await supabase
        .from("organization_payment_methods")
        .update({ branch_id: newBranchId })
        .eq("id", id)
        .eq("organization_id", currentOrg.id)
        .eq("business_id", businessId);
      if (error) throw error;
    },
    onSuccess: (_d, vars) => {
      toast.success(
        vars.newBranchId
          ? "Payment method moved to this branch"
          : "Payment method is now company-wide",
      );
      queryClient.invalidateQueries({ queryKey: ["branch-payment-methods"] });
    },
    onError: (err: Error) => toast.error(normalizeError(err).message),
  });

  return (
    <div className="space-y-4">
      <Alert>
        <Info className="h-4 w-4" />
        <AlertDescription className="text-xs">
          <strong>Operational scoping.</strong> Restrict bank accounts and
          payment methods to <strong>{branchName}</strong>. Records with no
          branch are inherited company-wide. For branding overrides (logo,
          receipt text, invoice prefix), use the Overrides tab.
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Banknote className="h-4 w-4" />
                Bank accounts
              </CardTitle>
              <CardDescription className="text-xs">
                Bank accounts available to this branch
              </CardDescription>
            </div>
            <ScopeChip scope="branch" label={branchName} />
          </div>
        </CardHeader>
        <CardContent>
          {loadingBanks ? (
            <div className="flex justify-center py-6">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : branchBanks.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No bank accounts configured.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead className="hidden sm:table-cell">Bank</TableHead>
                  <TableHead>Scope</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {branchBanks.map((b) => {
                  const onThisBranch = b.branch_id === branchId;
                  return (
                    <TableRow key={b.id}>
                      <TableCell className="font-medium">{b.name}</TableCell>
                      <TableCell className="hidden sm:table-cell text-muted-foreground">
                        {b.bank_name ?? "-"}
                      </TableCell>
                      <TableCell>
                        {onThisBranch ? (
                          <Badge variant="default">This branch</Badge>
                        ) : (
                          <Badge variant="secondary">Company-wide</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              disabled={setBankBranch.isPending}
                              aria-label="Change scope"
                            >
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {onThisBranch ? (
                              <DropdownMenuItem
                                onClick={() =>
                                  setBankBranch.mutate({ id: b.id, newBranchId: null })
                                }
                              >
                                Make company-wide
                              </DropdownMenuItem>
                            ) : (
                              <DropdownMenuItem
                                onClick={() =>
                                  setBankBranch.mutate({ id: b.id, newBranchId: branchId })
                                }
                              >
                                Move to {branchName}
                              </DropdownMenuItem>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <CreditCard className="h-4 w-4" />
                Payment methods
              </CardTitle>
              <CardDescription className="text-xs">
                Methods customers can use to pay this branch
              </CardDescription>
            </div>
            <ScopeChip scope="branch" label={branchName} />
          </div>
        </CardHeader>
        <CardContent>
          {loadingMethods ? (
            <div className="flex justify-center py-6">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : branchMethods.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No payment methods configured.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead className="hidden sm:table-cell">Type</TableHead>
                  <TableHead>Scope</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {branchMethods.map((m) => {
                  const onThisBranch = m.branch_id === branchId;
                  return (
                    <TableRow key={m.id}>
                      <TableCell className="font-medium">{m.label}</TableCell>
                      <TableCell className="hidden sm:table-cell text-muted-foreground capitalize">
                        {m.type ?? "-"}
                      </TableCell>
                      <TableCell>
                        {onThisBranch ? (
                          <Badge variant="default">This branch</Badge>
                        ) : (
                          <Badge variant="secondary">Company-wide</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              disabled={setMethodBranch.isPending}
                              aria-label="Change scope"
                            >
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {onThisBranch ? (
                              <DropdownMenuItem
                                onClick={() =>
                                  setMethodBranch.mutate({ id: m.id, newBranchId: null })
                                }
                              >
                                Make company-wide
                              </DropdownMenuItem>
                            ) : (
                              <DropdownMenuItem
                                onClick={() =>
                                  setMethodBranch.mutate({ id: m.id, newBranchId: branchId })
                                }
                              >
                                Move to {branchName}
                              </DropdownMenuItem>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
