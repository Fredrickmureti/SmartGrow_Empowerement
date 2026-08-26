/**
 * Finance Settings Page
 *
 * Hosts the canonical, eligibility-aware default GL account mapping UI
 * (`DefaultAccountsConfig`) — the SAME engine used by Apply Defaults and the
 * `apply-default-mappings` edge function. No more naive account_type-only
 * dropdowns: header (group) accounts and detail-type-incompatible accounts
 * are filtered out at the UI layer, with the DB triggers acting as
 * defense-in-depth.
 *
 * The legacy hand-rolled mapping grid that lived here previously allowed
 * users to map header accounts (e.g. "1110 Cash and Cash Equivalents") to
 * roles like Accounts Receivable, which the DB then rejected with an
 * unfriendly error. That grid is removed.
 */

import { useState, useEffect, useMemo } from "react";
import { ReturnToMigrationBanner } from "@/components/migration/ReturnToMigrationBanner";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useToast } from "@/hooks/use-toast";
import { PermissionGate } from "@/components/common/PermissionGate";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, Settings, AlertTriangle } from "lucide-react";
import { LockDatesCard } from "@/components/finance/LockDatesCard";
import { AccountingIntegrityCard } from "@/components/finance/AccountingIntegrityCard";
import { InventoryReconciliationCard } from "@/components/finance/InventoryReconciliationCard";
import { FinanceAccountingControls } from "@/components/finance/FinanceAccountingControls";
import { DefaultAccountsConfig } from "@/components/finance/DefaultAccountsConfig";
import { BranchReadOnlyBanner } from "@/components/finance/BranchReadOnlyBanner";
import { ConsolidationGroupsSettings } from "@/components/settings/ConsolidationGroupsSettings";


interface Account {
  id: string;
  code: string;
  name: string;
  account_type: string;
}

export default function FinanceSettings() {
  const { currentOrg } = useOrganization();
  const { currentBusiness, isLoading: businessLoading } = useBusinesses();
  const { toast } = useToast();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!currentOrg) return;

    const load = async () => {
      if (!currentBusiness?.id) {
        setIsLoading(false);
        return;
      }
      setIsLoading(true);
      try {
        // Load accounts only for the surrounding cards
        // (FinanceAccountingControls). Mapping is fully owned by
        // <DefaultAccountsConfig />.
        const { data } = await supabase
          .from("accounts")
          .select("id, code, name, account_type")
          .eq("organization_id", currentOrg.id)
          .eq("business_id", currentBusiness.id)
          .eq("is_active", true)
          .order("code");
        setAccounts(data || []);
      } catch (err) {
        console.error("Error loading finance settings:", err);
      } finally {
        setIsLoading(false);
      }
    };

    load();
  }, [currentOrg?.id, currentBusiness?.id]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <PermissionGate permission="manageFinancials" fallback={
      <div className="space-y-4 sm:space-y-6 px-3 sm:px-6 py-4 sm:py-6">
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>You do not have permission to manage finance settings.</AlertDescription>
        </Alert>
      </div>
    }>
      <ReturnToMigrationBanner />
      <div className="space-y-4 sm:space-y-6 px-3 sm:px-6 py-4 sm:py-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h1 className="text-lg sm:text-2xl font-bold tracking-tight flex items-center gap-2">
              <Settings className="h-5 w-5 sm:h-6 sm:w-6" />
              Finance Settings
            </h1>
            <p className="text-xs sm:text-sm text-muted-foreground mt-1">
              Configure default GL account mappings for automated journal postings. Header (group) accounts are excluded — only postable leaf accounts of the correct detail type are selectable per role.
            </p>
          </div>
        </div>

        <BranchReadOnlyBanner area="Finance Settings" permissionLabel="finance.manage_settings" />

        {/* Odoo-parity lock-date hierarchy */}
        <LockDatesCard />

        {/* Zero-trust finance integrity audit */}
        <AccountingIntegrityCard />

        {/* Inventory subledger ↔ GL reconciliation (drift + opening backfill) */}
        <InventoryReconciliationCard />

        {/* Odoo-grade accountant controls */}
        <FinanceAccountingControls accounts={accounts} />

        {/* Canonical, eligibility-aware default account mapping UI.
            Header (group) accounts are filtered out at the dropdown level
            and detail-type eligibility is enforced per role — same engine
            used by the `apply-default-mappings` edge function. */}
        <DefaultAccountsConfig />

        {/* Consolidation group structure (Brick 1). Configuration only — no
            consolidated figures are produced here. Write actions are hidden
            for roles the RLS write policy would refuse. */}
        <ConsolidationGroupsSettings />


        {/* Only after the company context has settled — a company that is
            still loading is NOT "no company selected". */}
        {!businessLoading && !currentBusiness?.id && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              Select a Company first — default account mappings are per-company.
            </AlertDescription>
          </Alert>
        )}
      </div>
    </PermissionGate>
  );
}