import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useOpeningBalanceCheck } from "@/hooks/useOpeningBalanceCheck";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useDefaultAccounts } from "@/hooks/useDefaultAccounts";
import { useMigrationSession } from "@/hooks/useMigrationSession";
import { supabase } from "@/integrations/supabase/client";
import { CheckCircle2, XCircle, Loader2, AlertTriangle, ShieldAlert } from "lucide-react";

interface Props {
  onComplete: () => void;
  onSkip: () => void;
}

interface ValidationCheck {
  label: string;
  passed: boolean;
  detail: string;
  severity: "critical" | "warning";
}

export function MigrationStepValidation({ onComplete }: Props) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { accounts: defaultAccounts } = useDefaultAccounts();
  const balanceCheck = useOpeningBalanceCheck();
  const migration = useMigrationSession();
  const [hasRun, setHasRun] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [checks, setChecks] = useState<ValidationCheck[]>([]);
  const [lastRunAt, setLastRunAt] = useState<Date | null>(null);

  const runValidation = async () => {
    setIsRunning(true);
    setHasRun(true);
    const results: ValidationCheck[] = [];

    try {
      // 1. Trial balance balanced
      await balanceCheck.refetch();
      if (balanceCheck.data) {
        const d = balanceCheck.data;
        results.push({
          label: "Trial Balance Balanced",
          passed: d.isBalanced,
          detail: d.isBalanced
            ? `Debits (${d.debitNormalTotal.toLocaleString()}) = Credits (${d.creditNormalTotal.toLocaleString()})`
            : `Imbalance of ${d.imbalance.toLocaleString()}`,
          severity: "critical",
        });
      }

      const orgId = currentOrg?.id;
      const businessId = currentBusiness?.id;
      const sessionId = migration.session?.id;
      if (!orgId) { setChecks(results); setIsRunning(false); return; }

      const isFullTransaction = migration.session?.migration_strategy === "full_transaction";

      // 2. AR check
      const arAccountId = defaultAccounts?.accounts_receivable_id;
      if (arAccountId) {
        let invoiceQuery = supabase
          .from("invoices")
          .select("id, total, journal_entry_id")
          .eq("organization_id", orgId)
          .eq("source", "migration");
        if (sessionId) invoiceQuery = invoiceQuery.eq("migration_session_id", sessionId);
        invoiceQuery = invoiceQuery.eq("business_id", businessId);
        const { data: invoices } = await invoiceQuery;
        const invoiceTotal = (invoices || []).reduce((s: number, i: any) => s + (i.total || 0), 0);

        if (isFullTransaction) {
          // In full_transaction mode, each invoice has its own JE — don't compare against opening_balance (which is 0 by design)
          // Instead, verify every migrated invoice has a linked journal_entry_id
          const invoicesWithoutJE = (invoices || []).filter((i: any) => !i.journal_entry_id);
          const allLinked = invoicesWithoutJE.length === 0;
          results.push({
            label: "AR Invoices — GL Linkage",
            passed: allLinked,
            detail: allLinked
              ? `All ${(invoices || []).length} migrated invoices have linked journal entries (total: ${invoiceTotal.toLocaleString()})`
              : `${invoicesWithoutJE.length} of ${(invoices || []).length} migrated invoices missing GL journal entries`,
            severity: "warning",
          });
        } else {
          // Summary mode: compare opening_balance vs invoice totals
          const { data: arAccount } = await supabase
            .from("accounts")
            .select("opening_balance")
            .eq("id", arAccountId)
            .single();
          const arBalance = arAccount?.opening_balance || 0;
          const arMatches = Math.abs(arBalance - invoiceTotal) < 0.01 || (arBalance === 0 && invoiceTotal === 0);
          results.push({
            label: "AR Balance vs Open Invoices",
            passed: arMatches,
            detail: arMatches
              ? `AR balance (${arBalance.toLocaleString()}) matches open invoices (${invoiceTotal.toLocaleString()})`
              : `AR balance (${arBalance.toLocaleString()}) ≠ open invoices (${invoiceTotal.toLocaleString()}). Diff: ${Math.abs(arBalance - invoiceTotal).toLocaleString()}`,
            severity: "warning",
          });
        }
      }

      // 3. AP check
      const apAccountId = defaultAccounts?.accounts_payable_id;
      if (apAccountId) {
        let billQuery = supabase
          .from("bills")
          .select("id, total, journal_entry_id")
          .eq("organization_id", orgId);
        if (sessionId) billQuery = billQuery.eq("migration_session_id", sessionId);
        billQuery = billQuery.eq("business_id", businessId);
        const { data: bills } = await billQuery;
        const billTotal = (bills || []).reduce((s: number, b: any) => s + (b.total || 0), 0);

        if (isFullTransaction) {
          const billsWithoutJE = (bills || []).filter((b: any) => !b.journal_entry_id);
          const allLinked = billsWithoutJE.length === 0;
          results.push({
            label: "AP Bills — GL Linkage",
            passed: allLinked,
            detail: allLinked
              ? `All ${(bills || []).length} migrated bills have linked journal entries (total: ${billTotal.toLocaleString()})`
              : `${billsWithoutJE.length} of ${(bills || []).length} migrated bills missing GL journal entries`,
            severity: "warning",
          });
        } else {
          const { data: apAccount } = await supabase
            .from("accounts")
            .select("opening_balance")
            .eq("id", apAccountId)
            .single();
          const apBalance = Math.abs(apAccount?.opening_balance || 0);
          const apMatches = Math.abs(apBalance - billTotal) < 0.01 || (apBalance === 0 && billTotal === 0);
          results.push({
            label: "AP Balance vs Open Bills",
            passed: apMatches,
            detail: apMatches
              ? `AP balance (${apBalance.toLocaleString()}) matches open bills (${billTotal.toLocaleString()})`
              : `AP balance (${apBalance.toLocaleString()}) ≠ open bills (${billTotal.toLocaleString()}). Diff: ${Math.abs(apBalance - billTotal).toLocaleString()}`,
            severity: "warning",
          });
        }
      }

      // 4. Inventory check
      const invAccountId = defaultAccounts?.inventory_account_id;
      if (invAccountId) {
        const { data: invAccount } = await supabase
          .from("accounts")
          .select("opening_balance")
          .eq("id", invAccountId)
          .single();

        let smQuery = supabase
          .from("stock_movements")
          .select("quantity, unit_cost")
          .eq("organization_id", orgId)
          .eq("movement_type", "opening");
        if (sessionId) smQuery = smQuery.eq("migration_session_id", sessionId);
        smQuery = smQuery.eq("business_id", businessId);
        const { data: movements } = await smQuery;

        const invBalance = invAccount?.opening_balance || 0;
        const movementTotal = (movements || []).reduce((s: number, m: any) => s + ((m.quantity || 0) * (m.unit_cost || 0)), 0);
        const invMatches = Math.abs(invBalance - movementTotal) < 0.01 || (invBalance === 0 && movementTotal === 0);

        results.push({
          label: "Inventory Balance vs Opening Stock",
          passed: invMatches,
          detail: invMatches
            ? `Inventory balance (${invBalance.toLocaleString()}) matches opening stock (${movementTotal.toLocaleString()})`
            : `Inventory balance (${invBalance.toLocaleString()}) ≠ opening stock (${movementTotal.toLocaleString()})`,
          severity: "warning",
        });
      }

      // 5. Opening Balance Equity should net to zero
      const obeAccountId = defaultAccounts?.opening_balance_equity_id;
      if (obeAccountId) {
        const { data: obeAccount } = await supabase
          .from("accounts")
          .select("opening_balance, current_balance")
          .eq("id", obeAccountId)
          .single();

        const obeBalance = obeAccount?.current_balance ?? obeAccount?.opening_balance ?? 0;
        const obeIsZero = Math.abs(obeBalance) < 0.01;

        results.push({
          label: "Opening Balance Equity Nets to Zero",
          passed: obeIsZero,
          detail: obeIsZero
            ? "Opening Balance Equity account has zero balance — all opening entries are properly balanced"
            : `Opening Balance Equity has a remaining balance of ${obeBalance.toLocaleString()}. This indicates an imbalance in your opening balances that should be investigated.`,
          severity: "warning",
        });
      }

      // 6. Orphan check: invoices without contacts
      let orphanQuery = supabase
        .from("invoices")
        .select("id")
        .eq("organization_id", orgId)
        .eq("business_id", currentBusiness.id)
        .eq("source", "migration")
        .is("contact_id", null);
      if (sessionId) orphanQuery = orphanQuery.eq("migration_session_id", sessionId);
      const { data: orphanInvoices } = await orphanQuery;

      results.push({
        label: "No Orphan AR Records",
        passed: (orphanInvoices?.length || 0) === 0,
        detail: (orphanInvoices?.length || 0) === 0
          ? "All migration invoices have valid contacts"
          : `${orphanInvoices!.length} invoice(s) without contacts`,
        severity: "warning",
      });

    } catch (err: any) {
      results.push({ label: "Validation Error", passed: false, detail: err.message, severity: "critical" });
    }

    setChecks(results);
    setIsRunning(false);
    setLastRunAt(new Date());

    // Auto-mark step status
    const allPassed = results.every(c => c.passed);
    if (allPassed) {
      await migration.updateStepStatus("validation", "completed");
    }
  };

  const allPassed = checks.length > 0 && checks.every(c => c.passed);
  const hasCriticalFailure = checks.some(c => !c.passed && c.severity === "critical");

  return (
    <Card>
      <CardHeader>
        <CardTitle>Migration Validation</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Run cross-module validation to ensure all imported data is consistent and balanced.
        </p>

        {!hasRun ? (
          <Button onClick={runValidation} className="w-full" disabled={isRunning}>
            {isRunning && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Run Validation Checks
          </Button>
        ) : (
          <>
            <div className="space-y-3">
              {checks.map(check => (
                <div key={check.label} className="flex items-start gap-2 p-3 rounded-md bg-muted">
                  {check.passed ? (
                    <CheckCircle2 className="h-5 w-5 text-success mt-0.5" />
                  ) : (
                    <XCircle className="h-5 w-5 text-destructive mt-0.5" />
                  )}
                  <div className="flex-1">
                    <div className="font-medium text-sm">{check.label}</div>
                    <div className="text-xs text-muted-foreground">{check.detail}</div>
                  </div>
                  <div className="flex items-center gap-1 ml-auto">
                    {!check.passed && check.severity === "critical" && (
                      <Badge variant="destructive" className="text-xs">Critical</Badge>
                    )}
                    <Badge variant={check.passed ? "default" : "destructive"} className="text-xs">
                      {check.passed ? "Pass" : "Fail"}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>

            {hasCriticalFailure && (
              <Alert variant="destructive">
                <ShieldAlert className="h-4 w-4" />
                <AlertDescription>
                  Critical validation checks failed. You must fix these before finalizing. 
                  The trial balance must be balanced to proceed.
                </AlertDescription>
              </Alert>
            )}

            {!allPassed && !hasCriticalFailure && (
              <Alert>
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>
                  Some non-critical checks failed. You can proceed, but your subledger detail may not match GL totals.
                  This is acceptable if you imported partial AR/AP/Inventory.
                </AlertDescription>
              </Alert>
            )}

            <div className="flex gap-2">
              <Button variant="outline" onClick={runValidation} disabled={isRunning} className="flex-1">
                {isRunning && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Re-run Checks
              </Button>
              <Button 
                onClick={async () => {
                  if (!allPassed) {
                    await migration.updateStepStatus("validation", "completed", {
                      error_count: checks.filter(c => !c.passed).length,
                    });
                  }
                  onComplete();
                }}
                className="flex-1"
                disabled={hasCriticalFailure}
              >
                {allPassed ? "Proceed to Finalization" : "Proceed with Warnings"}
              </Button>
            </div>
            {lastRunAt && (
              <p className="text-xs text-muted-foreground text-center">
                Last run: {lastRunAt.toLocaleTimeString()} on {lastRunAt.toLocaleDateString()}
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
