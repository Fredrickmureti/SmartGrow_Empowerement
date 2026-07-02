import { useState, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  CheckCircle2,
  XCircle,
  Info,
  ExternalLink,
  Loader2,
  PlusCircle,
  ChevronDown,
  ChevronRight,
  HelpCircle,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useDefaultAccounts } from "@/hooks/useDefaultAccounts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import {
  REQUIRED_SYSTEM_ACCOUNTS,
  ensureSystemAccount,
} from "@/lib/migration/ensureSystemAccounts";

interface Props {
  onComplete: () => void;
  onSkip: () => void;
}

/** Mapping definition with label, description, and group */
interface MappingDef {
  key: string;
  label: string;
  description: string;
  group: "core" | "cost_inventory" | "tax" | "fixed_assets" | "other";
}

const MAPPING_DEFS: MappingDef[] = [
  // Core — always required
  {
    key: "cash_account_id",
    label: "Cash Account",
    description:
      "Primary cash account for recording cash receipts and payments. Used when posting cash-basis transactions.",
    group: "core",
  },
  {
    key: "bank_account_id",
    label: "Bank Account",
    description:
      "Main bank account for electronic payments, transfers, and bank reconciliation.",
    group: "core",
  },
  {
    key: "accounts_receivable_id",
    label: "Accounts Receivable",
    description:
      "Tracks money owed by customers. Debited when invoices are issued, credited when payments are received.",
    group: "core",
  },
  {
    key: "accounts_payable_id",
    label: "Accounts Payable",
    description:
      "Tracks money owed to suppliers. Credited when bills are recorded, debited when payments are made.",
    group: "core",
  },
  {
    key: "sales_revenue_id",
    label: "Sales Revenue",
    description:
      "Primary income account credited when invoices are posted. Represents your main source of revenue.",
    group: "core",
  },
  {
    key: "retained_earnings_id",
    label: "Retained Earnings",
    description:
      "Equity account where net income accumulates at fiscal year close. Required for period-end processing.",
    group: "core",
  },
  {
    key: "opening_balance_equity_id",
    label: "Opening Balance Equity",
    description:
      "System account used as the balancing entry for opening balance journal entries during migration. Automatically zeroes out once all balances are imported.",
    group: "core",
  },

  // Cost & Inventory — only if inventory detected
  {
    key: "cost_of_goods_sold_id",
    label: "Cost of Goods Sold",
    description:
      "Expense account debited when inventory is sold. Records the direct cost of products delivered to customers.",
    group: "cost_inventory",
  },
  {
    key: "inventory_account_id",
    label: "Inventory",
    description:
      "Asset account tracking the value of goods held for sale. Debited on purchase, credited on sale.",
    group: "cost_inventory",
  },
  {
    key: "inventory_adjustment_id",
    label: "Inventory Adjustment",
    description:
      "Expense account for recording inventory value adjustments — write-downs, shrinkage, or migration corrections.",
    group: "cost_inventory",
  },

  // Tax — only if tax rates configured
  {
    key: "output_tax_account_id",
    label: "Output Tax (VAT/GST Payable)",
    description:
      "Liability account credited when you charge tax on sales. This is the tax you collect and owe to the tax authority.",
    group: "tax",
  },
  {
    key: "input_tax_account_id",
    label: "Input Tax (VAT/GST Receivable)",
    description:
      "Asset account debited when you pay tax on purchases. This is the tax you can reclaim from the tax authority.",
    group: "tax",
  },

  // Fixed Assets — only if fixed asset accounts detected
  {
    key: "fixed_asset_account_id",
    label: "Fixed Assets",
    description:
      "Asset account for long-term tangible assets (equipment, vehicles, buildings). Debited on acquisition.",
    group: "fixed_assets",
  },
  {
    key: "accumulated_depreciation_account_id",
    label: "Accumulated Depreciation",
    description:
      "Contra-asset account credited as assets depreciate over time. Reduces the net book value of fixed assets.",
    group: "fixed_assets",
  },
  {
    key: "depreciation_expense_id",
    label: "Depreciation Expense",
    description:
      "Expense account debited each period to record the cost of asset wear and tear.",
    group: "fixed_assets",
  },

  // Other — contextual
  {
    key: "customer_deposits_id",
    label: "Customer Deposits",
    description:
      "Liability account for advance payments received from customers before goods/services are delivered.",
    group: "other",
  },
  {
    key: "operating_expenses_id",
    label: "Operating Expenses",
    description:
      "Default expense account for general business expenses (rent, utilities, office supplies) when no specific account is assigned.",
    group: "other",
  },
];

const MAPPING_LABELS: Record<string, string> = Object.fromEntries(
  MAPPING_DEFS.map((d) => [d.key, d.label])
);

const GROUP_META: Record<
  string,
  { label: string; description: string; icon: string }
> = {
  core: {
    label: "Core Accounts",
    description: "Essential accounts required for every migration",
    icon: "📋",
  },
  cost_inventory: {
    label: "Cost & Inventory",
    description: "Accounts for tracking inventory and cost of goods sold",
    icon: "📦",
  },
  tax: {
    label: "Tax Accounts",
    description: "VAT/GST accounts for tax-registered businesses",
    icon: "🧾",
  },
  fixed_assets: {
    label: "Fixed Assets & Depreciation",
    description: "Accounts for long-term assets and their depreciation",
    icon: "🏗️",
  },
  other: {
    label: "Other Accounts",
    description: "Additional accounts based on your business needs",
    icon: "📂",
  },
};

/** Core mappings always required for any migration */
const ALWAYS_REQUIRED: string[] = [
  "cash_account_id",
  "bank_account_id",
  "accounts_receivable_id",
  "accounts_payable_id",
  "sales_revenue_id",
  "retained_earnings_id",
  "opening_balance_equity_id",
];

/** Contextually required based on what data is being migrated */
const CONTEXT_RULES: {
  key: string;
  condition: string;
  label: string;
}[] = [
  {
    key: "operating_expenses_id",
    condition: "has_bills",
    label: "Bills/expenses data detected",
  },
  {
    key: "cost_of_goods_sold_id",
    condition: "has_inventory",
    label: "Inventory data detected",
  },
  {
    key: "inventory_account_id",
    condition: "has_inventory",
    label: "Inventory data detected",
  },
  {
    key: "output_tax_account_id",
    condition: "has_tax",
    label: "Tax rates configured",
  },
  {
    key: "input_tax_account_id",
    condition: "has_tax",
    label: "Tax rates configured",
  },
  {
    key: "fixed_asset_account_id",
    condition: "has_assets",
    label: "Fixed asset accounts detected",
  },
  {
    key: "accumulated_depreciation_account_id",
    condition: "has_assets",
    label: "Fixed asset accounts detected",
  },
  {
    key: "depreciation_expense_id",
    condition: "has_assets",
    label: "Fixed asset accounts detected",
  },
  {
    key: "customer_deposits_id",
    condition: "has_deposits",
    label: "Customer deposits/prepayments detected",
  },
  {
    key: "inventory_adjustment_id",
    condition: "has_inventory",
    label: "Inventory data detected",
  },
];

export function MigrationStepConfig({ onComplete }: Props) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const {
    accounts: defaultAccounts,
    isLoading: accountsLoading,
  } = useDefaultAccounts();
  const [creatingAccount, setCreatingAccount] = useState<string | null>(null);

  const { data: fiscalPeriods = [], isLoading: fiscalLoading } = useQuery({
    queryKey: ["fiscal-periods-check", currentOrg?.id, currentBusiness?.id],
    queryFn: async () => {
      if (!currentOrg?.id || !currentBusiness?.id) return [];
      const { data } = await supabase
        .from("fiscal_periods")
        .select("id, name, start_date, end_date")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .limit(5);
      return data || [];
    },
    enabled: !!currentOrg?.id && !!currentBusiness?.id,
    staleTime: 30_000,
    refetchOnMount: "always" as const,
  });

  const { data: taxRates = [], isLoading: taxLoading } = useQuery({
    queryKey: ["tax-rates-check", currentOrg?.id, currentBusiness?.id],
    queryFn: async () => {
      if (!currentOrg?.id || !currentBusiness?.id) return [];
      const { data } = await supabase
        .from("tax_rates")
        .select("id")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("is_active", true)
        .limit(1);
      return data || [];
    },
    enabled: !!currentOrg?.id && !!currentBusiness?.id,
    staleTime: 30_000,
    refetchOnMount: "always" as const,
  });

  // Fetch account detail_types for context-aware detection
  const { data: accountDetailInfo = { types: [] as string[], detailTypes: [] as string[] }, isLoading: detailTypesLoading } = useQuery({
    queryKey: ["account-detail-types-check", currentOrg?.id, currentBusiness?.id],
    queryFn: async () => {
      if (!currentOrg?.id || !currentBusiness?.id) return { types: [] as string[], detailTypes: [] as string[] };
      const { data } = await supabase
        .from("accounts")
        .select("account_type, detail_type")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("is_active", true);
      if (!data) return { types: [] as string[], detailTypes: [] as string[] };
      const types = Array.from(new Set(data.map((a) => a.account_type)));
      const detailTypes = Array.from(
        new Set(data.map((a) => a.detail_type).filter(Boolean))
      ) as string[];
      return { types, detailTypes };
    },
    enabled: !!currentOrg?.id && !!currentBusiness?.id,
    staleTime: 30_000,
    refetchOnMount: "always" as const,
  });

  const accountTypes = accountDetailInfo.types;
  const detailTypes = accountDetailInfo.detailTypes;

  // Context-aware detection using detail_types (not just account_type)
  const migrationContext = useMemo(() => {
    const INVENTORY_DETAIL_TYPES = ["inventory"];
    const FIXED_ASSET_DETAIL_TYPES = [
      "fixed_asset_computers",
      "fixed_asset_copiers",
      "fixed_asset_furniture",
      "fixed_asset_phone",
      "fixed_asset_photo_video",
      "fixed_asset_software",
      "fixed_asset_other",
      "buildings",
      "vehicles",
      "machinery_equipment",
      "leasehold_improvements",
      "land",
    ];
    const DEPOSIT_DETAIL_TYPES = ["unearned_revenue", "customer_deposits"];

    return {
      has_bills: true, // expenses are universal
      has_inventory: detailTypes.some((dt) =>
        INVENTORY_DETAIL_TYPES.includes(dt)
      ),
      has_tax: taxRates.length > 0,
      has_assets: detailTypes.some((dt) =>
        FIXED_ASSET_DETAIL_TYPES.includes(dt)
      ),
      has_deposits: detailTypes.some((dt) =>
        DEPOSIT_DETAIL_TYPES.includes(dt)
      ),
    };
  }, [detailTypes, taxRates]);

  // Build required mapping list from context
  const requiredMappingKeys = useMemo(() => {
    const keys = new Set<string>(ALWAYS_REQUIRED);
    for (const rule of CONTEXT_RULES) {
      if (
        migrationContext[rule.condition as keyof typeof migrationContext]
      ) {
        keys.add(rule.key);
      }
    }
    return keys;
  }, [migrationContext]);

  // Check which required mappings are actually configured
  const { missingMappings, configuredMappings } = useMemo(() => {
    const missing: { key: string; label: string; reason?: string }[] = [];
    const configured: { key: string; label: string }[] = [];

    for (const key of requiredMappingKeys) {
      const value = (defaultAccounts as any)?.[key];
      if (value) {
        configured.push({ key, label: MAPPING_LABELS[key] || key });
      } else {
        const contextRule = CONTEXT_RULES.find((r) => r.key === key);
        missing.push({
          key,
          label: MAPPING_LABELS[key] || key,
          reason: contextRule?.label,
        });
      }
    }
    return { missingMappings: missing, configuredMappings: configured };
  }, [requiredMappingKeys, defaultAccounts]);

  // Group mappings by section for progressive disclosure
  const groupedMappings = useMemo(() => {
    const groups: Record<
      string,
      {
        configured: { key: string; label: string }[];
        missing: { key: string; label: string; reason?: string }[];
        isRequired: boolean;
      }
    > = {};

    for (const group of ["core", "cost_inventory", "tax", "fixed_assets", "other"]) {
      groups[group] = { configured: [], missing: [], isRequired: false };
    }

    for (const m of configuredMappings) {
      const def = MAPPING_DEFS.find((d) => d.key === m.key);
      if (def) groups[def.group].configured.push(m);
    }
    for (const m of missingMappings) {
      const def = MAPPING_DEFS.find((d) => d.key === m.key);
      if (def) {
        groups[def.group].missing.push(m);
        groups[def.group].isRequired = true;
      }
    }

    return groups;
  }, [configuredMappings, missingMappings]);

  // Filter to only show groups that have required mappings
  const activeGroups = useMemo(() => {
    return Object.entries(groupedMappings).filter(
      ([, g]) => g.configured.length > 0 || g.missing.length > 0
    );
  }, [groupedMappings]);

  const requiredAccountTypes = [
    "asset",
    "liability",
    "equity",
    "income",
    "expense",
  ];
  const hasAllAccountTypes = requiredAccountTypes.every((t) =>
    accountTypes.includes(t as any)
  );

  const systemChecks = [
    {
      label: "Organization configured",
      ok: !!currentOrg?.id,
      required: true,
      fixRoute: "/settings",
      fixLabel: "Organization Settings",
    },
    {
      label: "Organization name set",
      ok: !!currentOrg?.name,
      required: true,
      fixRoute: "/settings",
      fixLabel: "Organization Settings",
    },
    {
      label: "Currency configured",
      ok: !!currentBusiness?.base_currency,
      required: true,
      fixRoute: "/settings/company?tab=company",
      fixLabel: "Company Settings",
    },
    {
      label: "Fiscal periods defined",
      ok: fiscalPeriods.length > 0,
      required: true,
      fixRoute: "/finance/fiscal-periods",
      fixLabel: "Create Fiscal Periods",
    },
    {
      label: "Chart of accounts covers all types",
      ok: hasAllAccountTypes,
      required: false,
      fixRoute: "/finance/accounts",
      fixLabel: "Chart of Accounts",
    },
    {
      label: "Tax rates configured",
      ok: taxRates.length > 0,
      required: false,
      fixRoute: "/settings/company?tab=tax",
      fixLabel: "Tax Rate Settings",
    },
  ];

  const systemChecksPassed = systemChecks
    .filter((c) => c.required)
    .every((c) => c.ok);
  const failingSystemChecks = systemChecks.filter(
    (c) => c.required && !c.ok
  );
  const advisoryWarnings = systemChecks.filter(
    (c) => !c.required && !c.ok
  );
  const mappingsPassed = missingMappings.length === 0;
  const allPassed = systemChecksPassed && mappingsPassed;

  const returnParam = "?returnTo=/settings/migration";

  const handleCreateAndMap = async (mappingKey: string) => {
    const systemSpec = REQUIRED_SYSTEM_ACCOUNTS.find(
      (s) => `${s.settingKey}_id` === mappingKey
    );
    if (!systemSpec || !currentOrg?.id) return;

    setCreatingAccount(mappingKey);
    try {
      await ensureSystemAccount(
        systemSpec,
        currentOrg.id,
        currentBusiness?.id || null
      );
      await queryClient.invalidateQueries({
        queryKey: ["default-accounts"],
      });
      await queryClient.invalidateQueries({
        queryKey: ["account-detail-types-check"],
      });
      toast({ title: `${systemSpec.name} created and mapped` });
    } catch (err: any) {
      const msg = err?.message || "";
      // Translate cryptic DB errors into user-friendly messages
      if (msg.includes("detail_type") || msg.includes("Invalid")) {
        toast({
          title: "Could not auto-create this account",
          description:
            "Please create the account manually in Chart of Accounts, then map it in Finance Settings.",
          variant: "destructive",
        });
      } else {
        toast({
          title: "Error creating account",
          description: msg,
          variant: "destructive",
        });
      }
    } finally {
      setCreatingAccount(null);
    }
  };

  const isDataLoading = accountsLoading || fiscalLoading || taxLoading || detailTypesLoading;

  if (isDataLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>System Configuration Check</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center gap-3 py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          <span className="text-sm text-muted-foreground">Checking system configuration…</span>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>System Configuration Check</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <p className="text-sm text-muted-foreground">
          Before migrating data, ensure your organization settings and GL
          account mappings are properly configured.
        </p>

        {/* System checks */}
        <div className="space-y-3">
          <h4 className="text-sm font-medium">System Requirements</h4>
          {systemChecks.map((check) => (
            <div key={check.label} className="flex items-center gap-2">
              {check.ok ? (
                <CheckCircle2 className="h-4 w-4 text-success shrink-0" />
              ) : check.required ? (
                <XCircle className="h-4 w-4 text-destructive shrink-0" />
              ) : (
                <Info className="h-4 w-4 text-warning shrink-0" />
              )}
              <span className="text-sm">{check.label}</span>
              {!check.ok && (
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto p-0 ml-1 text-xs"
                  onClick={() =>
                    navigate(
                      check.fixRoute +
                        (check.fixRoute.includes("?") ? "&" : "?") +
                        returnParam.slice(1)
                    )
                  }
                >
                  {check.fixLabel} →
                </Button>
              )}
              <Badge
                variant={
                  check.ok
                    ? "default"
                    : check.required
                    ? "destructive"
                    : "secondary"
                }
                className="text-xs ml-auto"
              >
                {check.ok ? "Pass" : check.required ? "Missing" : "Advisory"}
              </Badge>
            </div>
          ))}
        </div>

        {/* Account mapping checks — progressive disclosure with groups */}
        {systemChecksPassed && !accountsLoading && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-medium">GL Account Mappings</h4>
              <Badge
                variant={mappingsPassed ? "default" : "destructive"}
                className="text-xs"
              >
                {configuredMappings.length}/
                {configuredMappings.length + missingMappings.length} Configured
              </Badge>
            </div>

            {mappingsPassed && (
              <Alert className="border-primary/30 bg-primary/5">
                <CheckCircle2 className="h-4 w-4 text-primary" />
                <AlertDescription>
                  All required GL account mappings are configured for migration.
                </AlertDescription>
              </Alert>
            )}

            <TooltipProvider>
              {activeGroups.map(([groupKey, group]) => {
                const meta = GROUP_META[groupKey];
                const hasMissing = group.missing.length > 0;
                const total =
                  group.configured.length + group.missing.length;

                return (
                  <MappingGroup
                    key={groupKey}
                    groupKey={groupKey}
                    meta={meta}
                    hasMissing={hasMissing}
                    total={total}
                    configuredCount={group.configured.length}
                    configured={group.configured}
                    missing={group.missing}
                    creatingAccount={creatingAccount}
                    currentOrgId={currentOrg?.id}
                    onCreateAndMap={handleCreateAndMap}
                  />
                );
              })}
            </TooltipProvider>

            {missingMappings.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  navigate("/finance/settings" + returnParam)
                }
                className="gap-2 w-full"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                Configure All Default Accounts
              </Button>
            )}
          </div>
        )}

        {/* Failing system requirements */}
        {!systemChecksPassed && (
          <div className="space-y-3">
            <p className="text-sm text-destructive">
              Please configure missing items before proceeding:
            </p>
            <div className="flex flex-wrap gap-2">
              {failingSystemChecks.map((check) => (
                <Button
                  key={check.label}
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    navigate(
                      check.fixRoute +
                        (check.fixRoute.includes("?") ? "&" : "?") +
                        returnParam.slice(1)
                    )
                  }
                  className="gap-2"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  {check.fixLabel}
                </Button>
              ))}
            </div>
          </div>
        )}

        {/* Advisory warnings */}
        {systemChecksPassed && advisoryWarnings.length > 0 && (
          <Alert>
            <Info className="h-4 w-4" />
            <AlertDescription className="space-y-2">
              {advisoryWarnings.some((w) =>
                w.label.includes("Chart of accounts")
              ) && (
                <p>
                  Your chart of accounts doesn't cover all 5 types (Asset,
                  Liability, Equity, Income, Expense). You can add missing
                  types during the Accounts step or{" "}
                  <Button
                    variant="link"
                    size="sm"
                    className="h-auto p-0"
                    onClick={() =>
                      navigate("/finance/accounts" + returnParam)
                    }
                  >
                    manage accounts now →
                  </Button>
                </p>
              )}
              {advisoryWarnings.some((w) =>
                w.label.includes("Tax rates")
              ) && (
                <p>
                  No tax rates are configured. If you're VAT/GST-registered,
                  consider setting up tax rates before importing AR/AP data.{" "}
                  <Button
                    variant="link"
                    size="sm"
                    className="h-auto p-0"
                    onClick={() =>
                      navigate(
                        "/settings/company?tab=tax" + "&" + returnParam.slice(1)
                      )
                    }
                  >
                    Configure tax rates →
                  </Button>
                </p>
              )}
            </AlertDescription>
          </Alert>
        )}

        <Button
          onClick={onComplete}
          disabled={!allPassed}
          className="w-full"
        >
          Confirm Configuration
        </Button>
      </CardContent>
    </Card>
  );
}

// ─── Collapsible Mapping Group ─────────────────────────────────────

interface MappingGroupProps {
  groupKey: string;
  meta: { label: string; description: string; icon: string };
  hasMissing: boolean;
  total: number;
  configuredCount: number;
  configured: { key: string; label: string }[];
  missing: { key: string; label: string; reason?: string }[];
  creatingAccount: string | null;
  currentOrgId?: string;
  onCreateAndMap: (key: string) => void;
}

function MappingGroup({
  groupKey,
  meta,
  hasMissing,
  total,
  configuredCount,
  configured,
  missing,
  creatingAccount,
  currentOrgId,
  onCreateAndMap,
}: MappingGroupProps) {
  // Auto-expand groups with missing mappings
  const [isOpen, setIsOpen] = useState(hasMissing);

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger asChild>
        <button className="flex items-center gap-2 w-full p-3 rounded-lg border bg-card hover:bg-accent/50 transition-colors text-left">
          <span className="text-base">{meta.icon}</span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{meta.label}</span>
              <Badge
                variant={hasMissing ? "destructive" : "default"}
                className="text-xs"
              >
                {configuredCount}/{total}
              </Badge>
            </div>
            {hasMissing && (
              <p className="text-xs text-muted-foreground mt-0.5">
                {missing.length} mapping{missing.length > 1 ? "s" : ""} need
                configuration
              </p>
            )}
          </div>
          {isOpen ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
          )}
        </button>
      </CollapsibleTrigger>

      <CollapsibleContent className="pl-4 pr-1 pt-2 space-y-1.5">
        {/* Configured items */}
        {configured.map((m) => {
          const def = MAPPING_DEFS.find((d) => d.key === m.key);
          return (
            <div
              key={m.key}
              className="flex items-center gap-2 py-1.5 px-2 rounded text-sm"
            >
              <CheckCircle2 className="h-3.5 w-3.5 text-success shrink-0" />
              <span>{m.label}</span>
              {def && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <HelpCircle className="h-3.5 w-3.5 text-muted-foreground cursor-help shrink-0" />
                  </TooltipTrigger>
                  <TooltipContent
                    side="right"
                    className="max-w-[280px] text-xs"
                  >
                    {def.description}
                  </TooltipContent>
                </Tooltip>
              )}
              <Badge variant="secondary" className="text-xs ml-auto">
                Configured
              </Badge>
            </div>
          );
        })}

        {/* Missing items */}
        {missing.map((m) => {
          const def = MAPPING_DEFS.find((d) => d.key === m.key);
          const systemSpec = REQUIRED_SYSTEM_ACCOUNTS.find(
            (s) => `${s.settingKey}_id` === m.key
          );

          return (
            <div
              key={m.key}
              className="flex items-center gap-2 py-1.5 px-2 rounded bg-destructive/5 border border-destructive/20 text-sm flex-wrap"
            >
              <XCircle className="h-3.5 w-3.5 text-destructive shrink-0" />
              <strong className="text-sm">{m.label}</strong>
              {def && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <HelpCircle className="h-3.5 w-3.5 text-muted-foreground cursor-help shrink-0" />
                  </TooltipTrigger>
                  <TooltipContent
                    side="right"
                    className="max-w-[280px] text-xs"
                  >
                    {def.description}
                  </TooltipContent>
                </Tooltip>
              )}
              {m.reason && (
                <span className="text-xs text-muted-foreground">
                  — {m.reason}
                </span>
              )}
              {systemSpec && currentOrgId && (
                <Button
                  variant="secondary"
                  size="sm"
                  className="h-7 text-xs gap-1 ml-auto"
                  disabled={creatingAccount === m.key}
                  onClick={() => onCreateAndMap(m.key)}
                >
                  {creatingAccount === m.key ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <PlusCircle className="h-3 w-3" />
                  )}
                  Create & Map
                </Button>
              )}
            </div>
          );
        })}
      </CollapsibleContent>
    </Collapsible>
  );
}
