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
import { FinanceAccountingControls } from "@/components/finance/FinanceAccountingControls";
import { DefaultAccountsConfig } from "@/components/finance/DefaultAccountsConfig";
import { BranchReadOnlyBanner } from "@/components/finance/BranchReadOnlyBanner";
import { ConsolidationGroupsSettings } from "@/components/settings/ConsolidationGroupsSettings";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";


interface Account {
  id: string;
  code: string;
  name: string;
  account_type: string;
}

/**
 * A collapsed settings group. Finance settings is a long page of independent
 * panels; large ERPs surface them as a list of headers the accountant expands
 * one at a time rather than an endless scroll of every panel at once.
 */
function SettingsSection({
  id,
  title,
  description,
  defaultOpen = false,
  children,
}: {
  id: string;
  title: string;
  description: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible
      id={id}
      open={open}
      onOpenChange={setOpen}
      className="rounded-lg border bg-card"
    >
      <CollapsibleTrigger className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/50">
        <ChevronDown
          className={cn(
            "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
        <span className="min-w-0">
          <span className="block text-sm font-semibold sm:text-base">{title}</span>
          <span className="block text-xs text-muted-foreground">{description}</span>
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t p-3 sm:p-4">{children}</CollapsibleContent>
    </Collapsible>
  );
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

        {/* Every section is collapsible and only the first is open by default,
            so reaching Accounting Controls or Consolidation no longer means
            scrolling past unrelated, fully-expanded panels. */}
        <SettingsSection
          id="lock-dates"
          title="Period lock dates"
          description="Hard, soft and tax lock dates that decide which periods still accept postings."
          defaultOpen
        >
          <LockDatesCard />
        </SettingsSection>

        <SettingsSection
          id="integrity"
          title="Accounting integrity"
          description="Zero-trust audit of the ledger: unbalanced entries, orphaned postings, control-account drift."
        >
          <AccountingIntegrityCard />
        </SettingsSection>


        <SettingsSection
          id="accounting-controls"
          title="Accounting controls"
          description="Journal, reconciliation and foreign-exchange policies for this company."
        >
          <FinanceAccountingControls accounts={accounts} />
        </SettingsSection>

        {/* Canonical, eligibility-aware default account mapping UI. */}
        <SettingsSection
          id="default-accounts"
          title="Default account configuration"
          description="Which GL account each automated posting role uses. Only postable leaf accounts of the correct detail type are selectable."
        >
          <DefaultAccountsConfig />
        </SettingsSection>

        {/* Consolidation group structure (Brick 1). Configuration only. */}
        <SettingsSection
          id="consolidation"
          title="Consolidation groups"
          description="Group structure, group chart of accounts and member account mapping."
        >
          <ConsolidationGroupsSettings />
        </SettingsSection>


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