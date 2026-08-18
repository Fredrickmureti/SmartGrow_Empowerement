// @ts-nocheck
import { useState, useEffect, useMemo } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useAccounts, Account } from "@/hooks/useAccounts";
import { getTaxTerminology } from "@/lib/taxTerminology";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { 
  Settings, 
  Save, 
  Loader2, 
  CheckCircle2, 
  AlertTriangle,
  Building,
  CreditCard,
  Receipt,
  Package,
  Wallet,
  PiggyBank,
  TrendingUp,
  DollarSign,
  ChevronDown,
  ChevronRight,
  Landmark,
  BadgeDollarSign,
  Smartphone,
  BarChart3,
  Scale,
  Lock,
  Info,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ApplyDefaultMappingsDialog } from "./ApplyDefaultMappingsDialog";
import { Sparkles } from "lucide-react";
import { useAccountRoleEligibility } from "@/hooks/useAccountRoleEligibility";
import { explainMappingError } from "@/lib/finance/mappingErrors";
import { useFinancePermission } from "@/hooks/finance/useFinancePermission";

interface MappingConfig {
  key: string;
  label: string;
  description: string;
  icon: any;
  accountType: string;
  codePattern: string[];
  namePattern: string[];
  group: "core" | "tax" | "advanced" | "payment_methods";
  /**
   * System-managed accounts are auto-seeded into the chart of accounts and
   * auto-mapped at business provisioning (see provision_default_chart_of_accounts).
   * They can be re-pointed to a different GL account, but they cannot be left empty.
   */
  systemManaged?: boolean;
}

const ACCOUNT_TYPE_CONFIGS: MappingConfig[] = [
  // ── Core (always visible) ──────────────────────
  {
    key: "cash",
    label: "Cash Account",
    description: "Default account for cash transactions and POS cash sales",
    icon: Wallet,
    accountType: "asset",
    codePattern: ["1000", "100"],
    namePattern: ["cash", "petty"],
    group: "core",
    systemManaged: true,
  },
  {
    key: "bank",
    label: "Bank Account",
    description: "Default bank account for payments and transfers",
    icon: Building,
    accountType: "asset",
    codePattern: ["1010", "101"],
    namePattern: ["bank"],
    group: "core",
    systemManaged: true,
  },
  {
    key: "accounts_receivable",
    label: "Accounts Receivable",
    description: "Trade receivables — debited when invoices are confirmed",
    icon: CreditCard,
    accountType: "asset",
    codePattern: ["1100", "110"],
    namePattern: ["receivable", "debtors"],
    group: "core",
    systemManaged: true,
  },
  {
    key: "accounts_payable",
    label: "Accounts Payable",
    description: "Trade payables — credited when bills are confirmed",
    icon: Receipt,
    accountType: "liability",
    codePattern: ["2000", "200"],
    namePattern: ["payable", "creditors"],
    group: "core",
    systemManaged: true,
  },
  {
    key: "sales_revenue",
    label: "Sales Revenue",
    description: "Default revenue account (products can override with their own)",
    icon: TrendingUp,
    accountType: "income",
    codePattern: ["4000", "400"],
    namePattern: ["sales", "revenue"],
    group: "core",
    systemManaged: true,
  },
  {
    key: "cost_of_goods_sold",
    label: "Cost of Goods Sold",
    description: "COGS — posted when inventory products are sold",
    icon: Package,
    accountType: "expense",
    codePattern: ["5000", "500"],
    namePattern: ["cost of goods", "cogs", "cost of sales"],
    group: "core",
    systemManaged: true,
  },
  {
    key: "operating_expenses",
    label: "Operating Expenses",
    description: "Default expense account for bills and general expenses",
    icon: BarChart3,
    accountType: "expense",
    codePattern: ["6000", "600"],
    namePattern: ["operating"],
    group: "core",
  },
  {
    key: "retained_earnings",
    label: "Retained Earnings",
    description: "Accumulated profits — used for year-end closing entries",
    icon: PiggyBank,
    accountType: "equity",
    codePattern: ["3200", "320"],
    namePattern: ["retained", "earnings"],
    group: "core",
    systemManaged: true,
  },

  // ── Tax ────────────────────────────────────────
  {
    key: "sales_tax_payable",
    label: "__OUTPUT_TAX_LABEL__",
    description: "__OUTPUT_TAX_DESC__",
    icon: DollarSign,
    accountType: "liability",
    codePattern: ["2100", "210"],
    namePattern: ["output tax", "vat payable", "sales tax", "gst payable"],
    group: "tax",
  },
  {
    key: "purchase_tax_receivable",
    label: "__INPUT_TAX_LABEL__",
    description: "__INPUT_TAX_DESC__",
    icon: DollarSign,
    accountType: "asset",
    codePattern: ["1300", "130"],
    namePattern: ["input tax", "vat receivable", "gst receivable", "sales tax receivable"],
    group: "tax",
  },

  // ── Advanced (collapsible) ─────────────────────
  {
    key: "inventory",
    label: "Inventory",
    description: "Stock/inventory asset — debited on purchase, credited on sale",
    icon: Package,
    accountType: "asset",
    codePattern: ["1200", "120"],
    namePattern: ["inventory", "stock"],
    group: "advanced",
  },
  {
    key: "customer_deposits",
    label: "Customer Deposits / Prepayments",
    description: "Liability for customer overpayments and credit note refund obligations",
    icon: BadgeDollarSign,
    accountType: "liability",
    codePattern: ["2200", "220"],
    namePattern: ["customer deposit", "customer advance", "unearned revenue", "customer credit"],
    group: "advanced",
  },
  {
    key: "fixed_asset",
    label: "Fixed Assets",
    description: "Default account for fixed asset acquisitions (property, equipment)",
    icon: Landmark,
    accountType: "asset",
    codePattern: ["1500", "150"],
    namePattern: ["fixed asset", "property", "equipment", "furniture"],
    group: "advanced",
  },
  {
    key: "accumulated_depreciation",
    label: "Accumulated Depreciation",
    description: "Contra-asset credited when depreciation is posted",
    icon: Landmark,
    accountType: "asset",
    codePattern: ["1590", "159"],
    namePattern: ["accumulated depreciation", "accum. depreciation"],
    group: "advanced",
  },
  {
    key: "depreciation_expense",
    label: "Depreciation Expense",
    description: "Expense account debited when depreciation runs",
    icon: BarChart3,
    accountType: "expense",
    codePattern: ["6100", "610"],
    namePattern: ["depreciation expense", "depreciation"],
    group: "advanced",
  },
  {
    key: "opening_balance_equity",
    label: "Opening Balance Equity",
    description: "Used during migration for trial balance rounding adjustments",
    icon: Scale,
    accountType: "equity",
    codePattern: ["3100", "310"],
    namePattern: ["opening balance", "obe", "opening equity"],
    group: "advanced",
    systemManaged: true,
  },
  {
    key: "inventory_adjustment",
    label: "Inventory Adjustment",
    description: "Expense for stock write-offs, shrinkage, and adjustments",
    icon: Package,
    accountType: "expense",
    codePattern: ["5100", "510"],
    namePattern: ["inventory adjustment", "stock adjustment", "inventory shrinkage"],
    group: "advanced",
  },
  {
    key: "cash_short_over",
    label: "Cash Over/Short",
    description: "P&L account used by POS shift close: shortages debit this account; overages credit it.",
    icon: Scale,
    accountType: "expense",
    codePattern: ["6910", "690"],
    namePattern: ["cash over", "cash short", "over/short", "short over"],
    group: "payment_methods",
    systemManaged: true,
  },
  {
    key: "other_income",
    label: "Other Income",
    description: "Non-operating income (interest, misc. revenue)",
    icon: TrendingUp,
    accountType: "income",
    codePattern: ["4500", "450"],
    namePattern: ["other income", "miscellaneous income", "interest income"],
    group: "advanced",
  },

  // ── Payment Methods (collapsible) ──────────────
  {
    key: "credit_card_clearing",
    label: "Credit Card Clearing",
    description: "Intermediate account for credit card receipts before bank settlement",
    icon: CreditCard,
    accountType: "asset",
    codePattern: ["1050", "105"],
    namePattern: ["credit card", "card clearing"],
    group: "payment_methods",
  },
  {
    key: "mobile_money",
    label: "Mobile Money",
    description: "Account for mobile money payments (general)",
    icon: Smartphone,
    accountType: "asset",
    codePattern: ["1060", "106"],
    namePattern: ["mobile money", "mobile wallet"],
    group: "payment_methods",
  },
  {
    key: "mpesa",
    label: "M-Pesa",
    description: "Account for Safaricom M-Pesa transactions",
    icon: Smartphone,
    accountType: "asset",
    codePattern: ["1061"],
    namePattern: ["m-pesa", "mpesa"],
    group: "payment_methods",
  },
];

/** Maps config key → default_account_settings setting_key (same key for most, with alias handling) */
const CONFIG_KEY_TO_SETTING_KEY: Record<string, string> = {
  cash: "cash",
  bank: "bank",
  accounts_receivable: "accounts_receivable",
  accounts_payable: "accounts_payable",
  inventory: "inventory",
  sales_tax_payable: "output_tax",
  purchase_tax_receivable: "input_tax",
  sales_revenue: "sales_revenue",
  // DB canonicalize_role_key() rewrites 'cost_of_goods_sold' → 'cogs' on write,
  // so the stored setting_key is always 'cogs'. Map UI config key to the
  // canonical form so the reverse-map at load time finds the row.
  cost_of_goods_sold: "cogs",
  operating_expenses: "operating_expenses",
  retained_earnings: "retained_earnings",
  customer_deposits: "customer_deposits",
  fixed_asset: "fixed_asset",
  accumulated_depreciation: "accumulated_depreciation",
  depreciation_expense: "depreciation_expense",
  opening_balance_equity: "opening_balance_equity",
  inventory_adjustment: "inventory_adjustment",
  cash_short_over: "cash_short_over",
  other_income: "other_income",
  credit_card_clearing: "credit_card_clearing",
  mobile_money: "mobile_money",
  mpesa: "mpesa",
};

const GROUP_META: Record<string, { title: string; description: string; defaultOpen: boolean }> = {
  core: { title: "Core Accounts", description: "Required for invoicing, bills, payments, and expenses", defaultOpen: true },
  tax: { title: "Tax Accounts", description: "Required if you collect or pay tax (VAT/GST)", defaultOpen: true },
  advanced: { title: "Advanced Accounts", description: "Assets, depreciation, deposits, and migration", defaultOpen: false },
  payment_methods: { title: "POS & Payment Method Accounts", description: "Specific accounts for POS cash variance, card, mobile money, and M-Pesa receipts", defaultOpen: false },
};

export function DefaultAccountsConfig() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { accounts } = useAccounts();
  const queryClient = useQueryClient();
  const { data: eligibilityData } = useAccountRoleEligibility();
  const { allowed: canManageSettings, isLoading: permLoading } =
    useFinancePermission("finance.manage_settings");
  const readOnly = !canManageSettings;
  // Tax terminology follows the business (legal entity), not the org tenant.
  const taxTerms = useMemo(() => getTaxTerminology(currentBusiness?.country ?? undefined), [currentBusiness?.country]);

  const resolvedConfigs = useMemo(() =>
    ACCOUNT_TYPE_CONFIGS.map(c => {
      if (c.key === "sales_tax_payable") {
        return { ...c, label: `${taxTerms.outputLabel} (Payable)`, description: taxTerms.outputDescription };
      }
      if (c.key === "purchase_tax_receivable") {
        return { ...c, label: `${taxTerms.inputLabel} (Receivable)`, description: taxTerms.inputDescription };
      }
      return c;
    }),
    [taxTerms]
  );

  const [mappings, setMappings] = useState<Record<string, string>>({});
  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({
    core: true,
    tax: true,
    advanced: false,
    payment_methods: true,
  });
  const [previewOpen, setPreviewOpen] = useState(false);

  // Load existing mappings from default_account_settings (explicit, highest priority table)
  useEffect(() => {
    const loadMappings = async () => {
      if (!currentOrg?.id || !currentBusiness?.id) return;

      setIsLoading(true);
      try {
        // Load from the explicit settings table (source of truth)
        const { data: explicitData } = await supabase
          .from("default_account_settings")
          .select("setting_key, account_id")
          .eq("organization_id", currentOrg.id)
          .eq("business_id", currentBusiness.id);

        const loadedMappings: Record<string, string> = {};

        if (explicitData?.length) {
          // Reverse-map setting_key → config key
          const settingToConfig: Record<string, string> = {};
          for (const [configKey, settingKey] of Object.entries(CONFIG_KEY_TO_SETTING_KEY)) {
            settingToConfig[settingKey] = configKey;
          }
          explicitData.forEach((m) => {
            const configKey = settingToConfig[m.setting_key];
            if (configKey) {
              loadedMappings[configKey] = m.account_id;
            }
          });
        }

        // Legacy fallback table `default_account_mappings` removed in Stage 2 of
        // the Settings audit. `default_account_settings` is now the single source
        // of truth for default GL mappings.

        setMappings(loadedMappings);
      } catch (error) {
        console.log("Using auto-detection for default accounts");
      } finally {
        setIsLoading(false);
      }
    };

    loadMappings();
  }, [currentOrg?.id, currentBusiness?.id]);

  // Auto-detect accounts based on patterns (only if nothing loaded)
  useEffect(() => {
    if (isLoading || Object.keys(mappings).length > 0) return;

    const autoDetected: Record<string, string> = {};

    for (const config of ACCOUNT_TYPE_CONFIGS) {
      const matchingAccounts = accounts.filter(a => {
        if (a.account_type !== config.accountType) return false;
        // Headers (parent/group accounts) are non-postable and never mappable.
        if ((a as any).is_header === true) return false;
        const codeLower = a.code.toLowerCase();
        const nameLower = a.name.toLowerCase();
        const codeMatch = config.codePattern.some(p => codeLower.startsWith(p.toLowerCase()));
        const nameMatch = config.namePattern.some(p => nameLower.includes(p));
        return codeMatch || nameMatch;
      });

      if (matchingAccounts.length > 0) {
        autoDetected[config.key] = matchingAccounts[0].id;
      }
    }

    if (Object.keys(autoDetected).length > 0) {
      setMappings(autoDetected);
    }
  }, [accounts, isLoading, mappings]);

  /**
   * Returns the accounts the engine considers eligible for a given role.
   *
   * Hard filters (DB triggers will reject anything that violates these):
   *   - account_type must equal the role's required type
   *   - is_header must be false (group/parent accounts are non-postable)
   *   - is_active must be true
   *   - if eligibility rows exist for the role, the account's detail_type
   *     must appear in that list (or detail_type is null AND no rows exist).
   *
   * If we can't resolve a role's eligibility (e.g. role not registered in
   * system_account_roles yet), we fall back to the legacy account_type-only
   * filter — still excluding headers — so the dropdown is never empty for
   * unmigrated roles.
   */
  const getEligibleAccounts = (config: MappingConfig): Account[] => {
    const roleKey = CONFIG_KEY_TO_SETTING_KEY[config.key] ?? config.key;
    const eligibilityRows = eligibilityData?.eligibilityByRole.get(roleKey);
    const allowedDetailTypes = eligibilityRows
      ? new Set(eligibilityRows.map((r) => r.detail_type))
      : null;

    return accounts.filter((a) => {
      if (a.account_type !== config.accountType) return false;
      if (!a.is_active) return false;
      if ((a as any).is_header === true) return false;
      if (allowedDetailTypes && allowedDetailTypes.size > 0) {
        // Engine-mapped role — enforce detail_type eligibility.
        return !!a.detail_type && allowedDetailTypes.has(a.detail_type);
      }
      return true;
    });
  };

  const handleMappingChange = (key: string, accountId: string) => {
    setMappings(prev => ({ ...prev, [key]: accountId === "__none__" ? "" : accountId }));
  };

  /**
   * Save to default_account_settings (the explicit, highest-priority table).
   * This fixes the split-brain bug where the old UI wrote to default_account_mappings
   * (legacy table), which was silently overridden by auto-saved heuristics in
   * default_account_settings.
   */
  const handleSave = async () => {
    if (!currentOrg?.id || !currentBusiness?.id) return;

    setIsSaving(true);
    try {
      const upsertData = Object.entries(mappings)
        .filter(([_, accountId]) => accountId)
        .map(([configKey, accountId]) => ({
          organization_id: currentOrg.id,
          business_id: currentBusiness.id,
          branch_id: null,
          setting_key: CONFIG_KEY_TO_SETTING_KEY[configKey] || configKey,
          account_id: accountId,
        }));

      if (upsertData.length > 0) {
        const { error } = await supabase
          .from("default_account_settings")
          .upsert(upsertData, {
            onConflict: "organization_id,business_id,branch_id,setting_key",
            ignoreDuplicates: false,
          });

        if (error) throw error;
      }

      // Legacy mirror to `default_account_mappings` removed in Stage 1 of the
      // Settings audit — `default_account_settings` is the canonical writer
      // and the only table read by edge functions (process-recurring-invoices,
      // check-accounting-integrity, etc.).

      toast.success("Default account mappings saved successfully");
      queryClient.invalidateQueries({ queryKey: ["default-accounts"] });
    } catch (error: any) {
      if (error.code === "42P01") {
        toast.info("Default accounts configured (stored locally). Full persistence requires database migration.");
      } else {
        toast.error(
          explainMappingError(error, { accounts: accounts as any }),
          { duration: 8000 },
        );
      }
    } finally {
      setIsSaving(false);
    }
  };

  const getMappingStatus = () => {
    const coreConfigs = resolvedConfigs.filter(c => c.group === "core" || c.group === "tax");
    const coreConfigured = coreConfigs.filter(c => !!mappings[c.key]).length;
    const totalConfigured = Object.values(mappings).filter(Boolean).length;
    const total = resolvedConfigs.length;
    return { coreConfigured, coreTotal: coreConfigs.length, totalConfigured, total };
  };

  const status = getMappingStatus();

  const toggleGroup = (group: string) => {
    setOpenGroups(prev => ({ ...prev, [group]: !prev[group] }));
  };

  const renderField = (config: MappingConfig) => {
    const Icon = config.icon;
    const availableAccounts = getEligibleAccounts(config);
    const currentValue = mappings[config.key] || "";
    const isConfigured = Boolean(currentValue);
    const isSystem = !!config.systemManaged;

    return (
      <div
        key={config.key}
        className={
          "space-y-2 rounded-md p-3 transition-colors " +
          (isSystem
            ? "border border-primary/20 bg-primary/[0.03]"
            : "border border-border/50 bg-background")
        }
      >
        <Label className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-muted-foreground" />
          <span className="flex-1">{config.label}</span>
          {isSystem && (
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge variant="secondary" className="gap-1 text-[10px] font-medium">
                    <Lock className="h-2.5 w-2.5" />
                    System
                  </Badge>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-xs">
                  Auto-seeded into your chart of accounts and auto-mapped at signup.
                  You can re-point it to a different GL account, but the mapping
                  must remain set for the accounting engine to post correctly.
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          {isConfigured && <CheckCircle2 className="h-3 w-3 text-primary" />}
        </Label>
        <Select
          value={currentValue || "__none__"}
          onValueChange={(value) => handleMappingChange(config.key, value)}
          disabled={readOnly}
        >
          <SelectTrigger
            className={
              !isConfigured && (config.group === "core" || isSystem)
                ? "border-destructive/50"
                : ""
            }
          >
            <SelectValue placeholder={`Select ${config.label.toLowerCase()}`} />
          </SelectTrigger>
          <SelectContent>
            {!isSystem && <SelectItem value="__none__">— Not configured —</SelectItem>}
            {availableAccounts.map(account => (
              <SelectItem key={account.id} value={account.id}>
                {account.code} - {account.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{config.description}</p>
      </div>
    );
  };

  const renderSubsection = (
    title: string,
    icon: any,
    helper: string,
    items: MappingConfig[],
  ) => {
    if (items.length === 0) return null;
    const SubIcon = icon;
    return (
      <div className="space-y-3">
        <div className="flex items-start gap-2">
          <SubIcon className="h-4 w-4 mt-0.5 text-muted-foreground" />
          <div className="flex-1">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {title}
            </p>
            <p className="text-xs text-muted-foreground/80">{helper}</p>
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          {items.map(renderField)}
        </div>
      </div>
    );
  };

  const renderGroup = (groupKey: string) => {
    const meta = GROUP_META[groupKey];
    const groupConfigs = resolvedConfigs.filter(c => c.group === groupKey);
    if (groupConfigs.length === 0) return null;

    const configuredCount = groupConfigs.filter(c => !!mappings[c.key]).length;
    const isOpen = openGroups[groupKey];
    const isCollapsible = groupKey === "advanced" || groupKey === "payment_methods";

    const systemItems = groupConfigs.filter(c => c.systemManaged);
    const userItems = groupConfigs.filter(c => !c.systemManaged);

    const content = (
      <div className="space-y-5">
        {renderSubsection(
          "System-managed accounts",
          Lock,
          "Auto-seeded and auto-mapped at signup. Re-point only if you know what you're doing.",
          systemItems,
        )}
        {systemItems.length > 0 && userItems.length > 0 && <Separator />}
        {renderSubsection(
          "User-mappable accounts",
          Info,
          "Optional mappings — configure to enable additional automation.",
          userItems,
        )}
      </div>
    );

    if (isCollapsible) {
      return (
        <Collapsible key={groupKey} open={isOpen} onOpenChange={() => toggleGroup(groupKey)}>
          <CollapsibleTrigger className="flex items-center gap-2 w-full text-left py-2 hover:bg-accent/50 rounded-md px-2 -mx-2 transition-colors">
            {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            <span className="font-medium text-sm">{meta.title}</span>
            <Badge variant="outline" className="ml-auto text-xs">
              {configuredCount}/{groupConfigs.length}
            </Badge>
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-3">
            <p className="text-xs text-muted-foreground mb-3">{meta.description}</p>
            {content}
          </CollapsibleContent>
        </Collapsible>
      );
    }

    return (
      <div key={groupKey}>
        <div className="flex items-center gap-2 mb-3">
          <span className="font-medium text-sm">{meta.title}</span>
          <Badge variant="outline" className="text-xs">
            {configuredCount}/{groupConfigs.length}
          </Badge>
          <Separator className="flex-1" />
        </div>
        <p className="text-xs text-muted-foreground mb-3">{meta.description}</p>
        {content}
      </div>
    );
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Settings className="h-5 w-5" />
              Default Account Configuration
            </CardTitle>
            <CardDescription>
              Configure default GL accounts for automatic journal posting across all modules
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={status.coreConfigured === status.coreTotal ? "default" : "secondary"}>
              {status.coreConfigured}/{status.coreTotal} Core
            </Badge>
            <Badge variant="outline">
              {status.totalConfigured}/{status.total} Total
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        <FinanceReadOnlyNotice
          what="review the current default GL mappings"
          permission="finance.manage_settings"
          isLoading={permLoading}
          readOnly={readOnly}
        />

        {status.coreConfigured < status.coreTotal && (
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              Some core accounts are not configured. Invoicing, bill posting, and payment processing require these mappings.
            </AlertDescription>
          </Alert>
        )}

        {status.coreConfigured === status.coreTotal && status.totalConfigured < status.total && (
          <Alert className="border-primary/30 bg-primary/5">
            <CheckCircle2 className="h-4 w-4 text-primary" />
            <AlertDescription className="text-foreground">
              Core accounts are configured. Expand Advanced or Payment Methods to configure additional mappings for depreciation, deposits, and mobile payments.
            </AlertDescription>
          </Alert>
        )}

        {status.totalConfigured === status.total && (
          <Alert className="border-primary/30 bg-primary/5">
            <CheckCircle2 className="h-4 w-4 text-primary" />
            <AlertDescription className="text-foreground">
              All default accounts are fully configured. Automatic GL posting is operational across all modules.
            </AlertDescription>
          </Alert>
        )}

        <Alert className="border-primary/30 bg-primary/5">
          <Info className="h-4 w-4" />
          <AlertDescription className="text-foreground">
            Payroll-specific GL mappings (salary expense, PAYE payable, employer
            contributions, net-salary clearing, statutory remittances) are
            managed on the dedicated{" "}
            <a
              href="/hr/payroll/account-mapping"
              className="font-medium underline underline-offset-2"
            >
              Payroll → Account Mapping
            </a>{" "}
            page, which enforces role/type guards, pack provenance, and posting
            simulation.
          </AlertDescription>
        </Alert>

        <div className="space-y-6">
          {["core", "tax", "advanced", "payment_methods"].map(group => renderGroup(group))}
        </div>

        <Separator />

        <div className="flex justify-end">
          <Button
            variant="outline"
            className="mr-2"
            disabled={!currentOrg?.id || !currentBusiness?.id || readOnly}
            onClick={() => setPreviewOpen(true)}
          >
            <Sparkles className="h-4 w-4 mr-2" />
            Apply Default Mapping
          </Button>
          <Button onClick={handleSave} disabled={isSaving || readOnly}>
            {isSaving ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <Save className="h-4 w-4 mr-2" />
                Save Configuration
              </>
            )}
          </Button>
        </div>

        {currentOrg?.id && currentBusiness?.id && (
          <ApplyDefaultMappingsDialog
            open={previewOpen}
            onOpenChange={setPreviewOpen}
            organizationId={currentOrg.id}
            businessId={currentBusiness.id}
            onApplied={() => {
              queryClient.invalidateQueries({ queryKey: ["default-accounts"] });
            }}
          />
        )}
      </CardContent>
    </Card>
  );
}
