import { useEffect, useState, useMemo } from "react";
import { cn } from "@/lib/utils";
import { useDrillDownAnchor } from "@/hooks/payroll/useDrillDownAnchor";
import { useCountries } from "@/hooks/useCountries";

import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import { WorkflowSheet, WorkflowSheetGrid, WorkflowSheetSection, WorkflowField } from "@/components/workflow/WorkflowSheet";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";

import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Plus, Search, Loader2, Edit2, Trash2, Calculator, Shield, AlertTriangle, Settings2, Copy,
} from "lucide-react";
import { ReportExportButtons } from "@/components/reports/ReportExportButtons";
import type { ExportConfig } from "@/services/reports/ReportExportService";
import { format } from "date-fns";
import { PayrollSetupGuideDialog } from "@/components/payroll/PayrollSetupGuideDialog";
import { usePayrollReadiness } from "@/hooks/payroll/usePayrollReadiness";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { StatutoryRuleEditor, type StatutoryRuleRow } from "@/components/payroll/StatutoryRuleEditor";
import { COMPUTATION_METHOD_LIST } from "@/lib/payroll/computationMethods";
import { normalizeError } from "@/services/resilience";
import {
  useStatutoryRuleStatus,
  usePendingUpgradeProposals,
  useStatutoryRuleConflicts,
  type StatutoryRuleStatus,
} from "@/hooks/usePayrollStatutoryRuleStatus";
import { useRuleTypes, type RuleType, type ParameterField } from "@/hooks/usePayrollRuleTypes";
import { StatutoryRuleProvenanceBadge } from "@/components/payroll/StatutoryRuleProvenanceBadge";
import { StatutoryRuleConsumersDrawer } from "@/components/payroll/StatutoryRuleConsumersDrawer";
import { StatutoryRuleWorkspaceHeader } from "@/components/payroll/StatutoryRuleWorkspaceHeader";
import {
  UpgradeInboxPanel,
  ConflictsPanel,
  AuditPanel,
  TimelinePanel,
} from "@/components/payroll/StatutoryRuleWorkspaceTabs";
import { Network, GitPullRequest, History, Clock } from "lucide-react";
import { Link } from "react-router-dom";

// ─── Types ───────────────────────────────────────────────────────────────

interface StatutoryRule {
  id: string;
  organization_id: string;
  country_code: string;
  rule_type: string;
  rule_name: string;
  parameters: Record<string, any>;
  effective_from: string;
  effective_to: string | null;
  sort_order: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  rule_code?: string;
  computation_method?: string;
  business_id?: string | null;
}

// ParameterField + RuleType moved to `@/hooks/usePayrollRuleTypes` so that
// the dedicated Custom Deduction Types workspace and this Statutory Rules
// cockpit share the same shape without coupling pages to each other.

// Dynamic country list from shared config — no hardcoded subset
// Country options are now loaded from useCountries hook inside the component

// ─── Helpers ─────────────────────────────────────────────────────────────

/** Keys that are metadata — shown differently or hidden in compact views */
const META_KEYS = new Set([
  "notes", "period", "type", "status", "base", "currency",
]);

/** Format a single scalar value */
function fmtScalar(val: unknown): string {
  if (val == null) return "—";
  if (typeof val === "boolean") return val ? "Yes" : "No";
  if (typeof val === "number") {
    if (val < 1 && val > 0) return `${(val * 100).toFixed(2)}%`;
    return val.toLocaleString();
  }
  return String(val);
}

/** Format a single bracket/tier object as `min–max @ rate%`. */
function fmtBracket(b: any): string {
  if (!b || typeof b !== "object") return fmtScalar(b);
  const min = b.min ?? b.from ?? b.lower ?? b.threshold_min;
  const max = b.max ?? b.to ?? b.upper ?? b.threshold_max;
  const rate = b.rate ?? b.percent ?? b.percentage;
  const amount = b.amount ?? b.fixed_amount;
  const range =
    min == null && max == null ? null
    : min == null || Number(min) === 0 ? `up to ${fmtScalar(max)}`
    : max == null ? `over ${fmtScalar(min)}`
    : `${fmtScalar(min)}–${fmtScalar(max)}`;
  const value =
    rate != null ? `@ ${typeof rate === "number" && rate < 1 ? (rate * 100).toFixed(2) + "%" : fmtScalar(rate)}`
    : amount != null ? `= ${fmtScalar(amount)}`
    : "";
  if (b.name && !range && !value) return String(b.name);
  return [b.name, range, value].filter(Boolean).join(" ").trim() || JSON.stringify(b);
}

/** Build a readable, single-line summary of a rule's parameters for exports. */
function fmtParamsForExport(params: Record<string, any> | null | undefined): string {
  if (!params || typeof params !== "object") return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (META_KEYS.has(k)) continue;
    if (v == null || v === "") continue;
    if (Array.isArray(v)) {
      if (v.length === 0) continue;
      const items = v.map((it) => (typeof it === "object" ? fmtBracket(it) : fmtScalar(it)));
      parts.push(`${fmtKeyLabel(k)}: ${items.join("; ")}`);
    } else if (typeof v === "object") {
      const inner = Object.entries(v)
        .filter(([, vv]) => vv != null && vv !== "")
        .map(([kk, vv]) => `${kk}=${typeof vv === "object" ? JSON.stringify(vv) : fmtScalar(vv)}`)
        .join(", ");
      if (inner) parts.push(`${fmtKeyLabel(k)}: { ${inner} }`);
    } else {
      let display = fmtScalar(v);
      if (params.currency && typeof v === "number" && k !== "rate" && !k.endsWith("_rate")) {
        display = `${params.currency} ${display}`;
      }
      parts.push(`${fmtKeyLabel(k)}: ${display}`);
    }
  }
  return parts.join(" | ");
}

/** Human label for a parameter key */
function fmtKeyLabel(key: string): string {
  const map: Record<string, string> = {
    rate: "Rate",
    employee_rate: "Emp Rate",
    employer_rate: "Empr Rate",
    amount: "Amount",
    amount_per_employee: "Per Emp",
    ceiling: "Ceiling",
    max_amount: "Max",
    min: "Min",
    max: "Max",
    base_tax: "Base Tax",
    marginal_rate: "Marginal Rate",
    personal_relief: "Personal Relief",
    insurance_relief_rate: "Ins. Relief Rate",
    insurance_relief_max: "Ins. Relief Max",
    disability_exemption: "Disability Ex.",
    employee_only: "Employee Only",
    employer_only: "Employer Only",
    old_rates: "Old Rates",
    lower_earnings_limit: "Lower Limit",
    upper_earnings_limit: "Upper Limit",
    name: "Name",
  };
  return map[key] ?? key.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/** Get a compact, human summary of a rule's parameters */
function RuleParameters({
  params,
  schema,
}: {
  params: Record<string, any>;
  schema?: ParameterField[];
}) {
  if (!params || Object.keys(params).length === 0) {
    return <span className="text-xs text-muted-foreground italic">No parameters</span>;
  }

  const chips: { label: string; value: string; variant: "primary" | "secondary" | "muted" }[] = [];

  // —— Special structural cases first ——
  if (Array.isArray(params.brackets) && params.brackets.length > 0) {
    chips.push({
      label: "Brackets",
      value: `${params.brackets.length} tiers`,
      variant: "primary",
    });
  }
  if (Array.isArray(params.tiers) && params.tiers.length > 0) {
    chips.push({
      label: "Tiers",
      value: `${params.tiers.length} tiers`,
      variant: "primary",
    });
  }
  if (params.old_rates && typeof params.old_rates === "object") {
    chips.push({ label: "Old Rates", value: "Defined", variant: "secondary" });
  }

  // —— Scalar params ——
  const scalarKeys = Object.keys(params).filter(
    (k) =>
      !META_KEYS.has(k) &&
      k !== "brackets" &&
      k !== "tiers" &&
      k !== "old_rates" &&
      !Array.isArray(params[k]) &&
      typeof params[k] !== "object",
  );

  for (const key of scalarKeys) {
    const val = params[key];
    let display = fmtScalar(val);
    // Append currency if available and this looks like a monetary amount
    if (params.currency && typeof val === "number" && key !== "rate" && !key.endsWith("_rate")) {
      display = `${params.currency} ${display}`;
    }
    chips.push({
      label: fmtKeyLabel(key),
      value: display,
      variant: key.includes("rate") ? "primary" : "secondary",
    });
  }

  // If we still have nothing meaningful, show a fallback
  if (chips.length === 0) {
    return <span className="text-xs text-muted-foreground italic">See details</span>;
  }

  return (
    <div className="flex flex-wrap gap-1.5 items-center">
      {chips.map((c, i) => (
        <span
          key={i}
          className={cn(
            "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs border",
            c.variant === "primary" &&
              "bg-primary/10 text-primary border-primary/20 font-medium",
            c.variant === "secondary" &&
              "bg-secondary text-secondary-foreground border-border",
            c.variant === "muted" &&
              "bg-muted text-muted-foreground border-border",
          )}
          title={`${c.label}: ${c.value}`}
        >
          <span className="opacity-70">{c.label}</span>
          <span className="font-semibold">{c.value}</span>
        </span>
      ))}
    </div>
  );
}

// ─── Hooks ───────────────────────────────────────────────────────────────
//
// useRuleTypes moved to `@/hooks/usePayrollRuleTypes`. The deduction-type form and
// CUSTOM_TYPE_METHODS moved to `@/components/payroll/CustomDeductionTypeDialog`
// and are owned by the dedicated CustomDeductionTypes workspace at
// `/hr/payroll/configuration/deduction-types`. Statutory Rules no longer
// authors custom deduction types — it only consumes their codes when
// rendering the rule editor's type picker (round-trip for legacy rows).

function useStatutoryRules(orgId: string | undefined) {
  return useQuery({
    queryKey: ["payroll-statutory-rules-admin", orgId],
    queryFn: async () => {
      if (!orgId) return [];
      const { data, error } = await supabase
        .from("payroll_statutory_rules" as any)
        .select("*")
        .eq("organization_id", orgId)
        .order("country_code")
        .order("rule_type")
        .order("sort_order", { ascending: true });
      if (error) throw error;
      return (data ?? []) as unknown as StatutoryRule[];
    },
    enabled: !!orgId,
  });
}

// ─── Main Component ──────────────────────────────────────────────────────

export default function PayrollStatutoryRules() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { toast } = useToast();
  const { countries } = useCountries();
  const COUNTRY_OPTIONS = countries.map(c => ({ value: c.code, label: c.name }));
  const queryClient = useQueryClient();
  const { blockers: readinessBlockers } = usePayrollReadiness("org");

  // Filters
  const [searchQuery, setSearchQuery] = useState("");
  const [filterType, setFilterType] = useState<string>("all");
  // Default to workspace country (if known) so that freshly seeded rules from
  // a localization pack appear immediately. Users can switch back to "All".
  const [filterCountry, setFilterCountry] = useState<string>(currentBusiness?.country || "all");
  const [activeTab, setActiveTab] = useState("rules");

  // Rule form
  const [showRuleDialog, setShowRuleDialog] = useState(false);
  const [editingRule, setEditingRule] = useState<StatutoryRule | null>(null);
  const [deleteRule, setDeleteRule] = useState<StatutoryRule | null>(null);

  // Custom deduction *type* authoring now lives at
  // `/hr/payroll/configuration/deduction-types`. This page consumes ruleTypes
  // only to label the rule editor's type picker — it never writes them.
  const [showPackDialog, setShowPackDialog] = useState(false);

  // Note: rule create/edit state lives inside <StatutoryRuleEditor/> — the
  // engine-driven editor mounted below. The legacy form state and
  // saveRuleMutation that previously lived here have been removed (Stage B
  // cleanup) because they bypassed computation_method and produced rules the
  // engine could not run.

  // Data
  const { data: ruleTypes = [], isLoading: loadingTypes } = useRuleTypes(currentOrg?.id);
  const { data: rules = [], isLoading: loadingRules } = useStatutoryRules(currentOrg?.id);
  // Legislative cockpit read-model — drives provenance badges, header KPIs,
  // and the upgrade/conflict/audit/timeline tabs. All sourced from the
  // SECURITY INVOKER views so RLS stays consistent with the legacy table.
  const { data: ruleStatuses = [] } = useStatutoryRuleStatus(currentOrg?.id);
  const { data: pendingProposals = [] } = usePendingUpgradeProposals(currentOrg?.id);
  const { data: ruleConflicts = [] } = useStatutoryRuleConflicts(currentOrg?.id);
  const statusByRuleId = useMemo(() => {
    const m: Record<string, StatutoryRuleStatus> = {};
    for (const s of ruleStatuses as StatutoryRuleStatus[]) m[s.rule_id] = s;
    return m;
  }, [ruleStatuses]);
  const unresolvedConflictCount = useMemo(
    () =>
      (ruleConflicts as any[]).filter(
        (c) => c.status === "conflict" || c.status === "rollback_blocked",
      ).length,
    [ruleConflicts],
  );
  const [impactRule, setImpactRule] = useState<StatutoryRule | null>(null);

  // Phase 4 P4 — drill-down landing: `?rule={id}&version={pack_version_id}`
  // scrolls the row, briefly highlights it, and (when found) auto-opens the
  // editor pre-selected. `version` is accepted for symmetry — it does not
  // change which row we focus today but is logged so the architecture stays
  // ready for per-version rule editing.
  const ruleAnchor = useDrillDownAnchor("rule", {
    ready: !loadingRules,
    rowIdPrefix: "statutory-rule-",
  });
  useEffect(() => {
    if (!ruleAnchor.target || loadingRules) return;
    const match = rules.find((r: any) => r.id === ruleAnchor.target);
    if (match) {
      setActiveTab("rules");
      setEditingRule(match);
      setShowRuleDialog(true);
    }
  }, [ruleAnchor.target, loadingRules, rules]);


  const ruleTypeMap = useMemo(() => {
    const map: Record<string, RuleType> = {};
    for (const rt of ruleTypes) map[rt.code] = rt;
    return map;
  }, [ruleTypes]);

  // Mutations — saveRuleMutation removed (Stage B). Rule create/update now
  // flows through StatutoryRuleEditor, which writes computation_method and
  // typed parameters that the engine actually consumes.

  const deleteRuleMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("payroll_statutory_rules" as any)
        .delete()
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["payroll-statutory-rules-admin"] });
      queryClient.invalidateQueries({ queryKey: ["payroll-statutory-rules"] });
      toast({ title: "Rule deleted" });
      setDeleteRule(null);
    },
    onError: (err: any) => {
      toast({ title: "Error", description: normalizeError(err).message, variant: "destructive" });
    },
  });

  // Custom deduction type delete-mutation moved to the dedicated workspace.


  // Filtered rules
  const filteredRules = useMemo(() => {
    return rules.filter((rule) => {
      const matchesSearch = searchQuery
        ? rule.rule_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          rule.rule_type.toLowerCase().includes(searchQuery.toLowerCase())
        : true;
      const matchesType = filterType === "all" || rule.rule_type === filterType;
      const matchesCountry = filterCountry === "all" || rule.country_code === filterCountry;
      return matchesSearch && matchesType && matchesCountry;
    });
  }, [rules, searchQuery, filterType, filterCountry]);

  const rulesByGroup = useMemo(() => {
    const grouped: Record<string, StatutoryRule[]> = {};
    for (const rule of filteredRules) {
      const key = `${rule.country_code}::${rule.rule_type}`;
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(rule);
    }
    return grouped;
  }, [filteredRules]);

  // Form handlers — the engine-driven StatutoryRuleEditor owns its own form
  // state; the page just toggles which rule (if any) it should edit.
  function openCreateRule() {
    setEditingRule(null);
    setShowRuleDialog(true);
  }

  function openEditRule(rule: StatutoryRule) {
    setEditingRule(rule);
    setShowRuleDialog(true);
  }

  /**
   * Mirror of Odoo's "Duplicate" action on hr.salary.rule. Opens the editor
   * pre-filled with the source row's parameters, today's effective_from, and
   * a fresh rule_code so the new version supersedes the original cleanly.
   */
  function openDuplicateRule(rule: StatutoryRule) {
    const today = format(new Date(), "yyyy-MM-dd");
    // Strip the inferred marker so the duplicate doesn't carry the "needs
    // confirmation" amber banner inherited from a legacy seed.
    const { _inferred, ...cleanParams } = (rule.parameters || {}) as any;
    // Use editingRule=null so the editor treats this as a "create new" flow
    // (no end-dating prompt, no payslip-line lock check), but seed the form
    // with the cloned values via a synthetic prefill that matches the
    // editor's reset-on-open path.
    setEditingRule(null);
    setShowRuleDialog(true);
    // Defer prefill until the dialog has mounted so its open-effect runs first.
    setTimeout(() => {
      setEditingRule({
        ...rule,
        id: "" as any, // empty id => editor still treats as create
        parameters: cleanParams,
        effective_from: today,
        effective_to: null,
        rule_code: `${rule.rule_code || rule.rule_type}_v${Math.floor(Date.now() / 1000)}`,
      } as StatutoryRule);
    }, 0);
  }

  const isLoading = loadingTypes || loadingRules;

  return (
    <><div className="space-y-4 sm:space-y-6">
        {/* Header */}
        <div className="page-header">
          <div>
            <h1 className="page-title">Payroll Statutory Rules</h1>
            <p className="text-sm sm:text-base text-muted-foreground">
              Manage tax brackets, contributions, and statutory deductions. Fully configurable per country.
            </p>
          </div>
          <ReportExportButtons
            getExportConfig={() => ({
              title: "Payroll Statutory Rules",
              companyName: currentOrg?.name || undefined,
              dateRange: `As of ${format(new Date(), "MMM d, yyyy")}`,
              columns: [
                { key: "country", header: "Country", width: 12 },
                { key: "rule_type", header: "Rule Type", width: 16 },
                { key: "rule_name", header: "Name", width: 22 },
                { key: "parameters", header: "Parameters", width: 30 },
                { key: "effective_from", header: "Effective From", width: 14 },
                { key: "effective_to", header: "Effective To", width: 14 },
                { key: "status", header: "Status", width: 8 },
              ],
              rows: filteredRules.map((r) => ({
                country: COUNTRY_OPTIONS.find(c => c.value === r.country_code)?.label ?? r.country_code,
                rule_type: ruleTypeMap[r.rule_type]?.label ?? r.rule_type,
                rule_name: r.rule_name,
                parameters: fmtParamsForExport(r.parameters),
                effective_from: r.effective_from,
                effective_to: r.effective_to || "Ongoing",
                status: r.is_active ? "Active" : "Inactive",
              })),
              organizationId: currentOrg?.id,
            } as ExportConfig)}
            formats={["excel", "csv", "pdf"]}
            compact
          />
        </div>

        {/* Info Banner */}
        <Card className="border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30">
          <CardContent className="flex items-start gap-3 py-3">
            <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
            <div className="text-sm text-amber-800 dark:text-amber-200">
              <strong>Important:</strong> These rules directly control payroll calculations. Ensure rates match current government regulations.
              Changes apply to <strong>new payroll runs only</strong>.
            </div>
          </CardContent>
        </Card>

        {/* Tabs: Rules vs Rule Types */}
        {/* Legislative cockpit summary — installed pack, pending upgrades,
            unresolved conflicts, tenant override count. */}
        <StatutoryRuleWorkspaceHeader
          statuses={ruleStatuses as StatutoryRuleStatus[]}
          pendingProposalCount={(pendingProposals as any[]).length}
          conflictCount={unresolvedConflictCount}
        />

        {/* Tabs: Rules · Upgrades · Conflicts · Timeline · Audit · Computation methods · Custom types */}
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="flex-wrap h-auto">
            <TabsTrigger value="rules">
              <Calculator className="h-4 w-4 mr-2" /> Rules
            </TabsTrigger>
            <TabsTrigger value="inbox">
              <GitPullRequest className="h-4 w-4 mr-2" /> Upgrade inbox
              {(pendingProposals as any[]).length > 0 ? (
                <Badge variant="secondary" className="ml-2 h-4 px-1 text-[10px]">
                  {(pendingProposals as any[]).length}
                </Badge>
              ) : null}
            </TabsTrigger>
            <TabsTrigger value="conflicts">
              <AlertTriangle className="h-4 w-4 mr-2" /> Conflicts
              {unresolvedConflictCount > 0 ? (
                <Badge variant="destructive" className="ml-2 h-4 px-1 text-[10px]">
                  {unresolvedConflictCount}
                </Badge>
              ) : null}
            </TabsTrigger>
            <TabsTrigger value="timeline">
              <Clock className="h-4 w-4 mr-2" /> Timeline
            </TabsTrigger>
            <TabsTrigger value="audit">
              <History className="h-4 w-4 mr-2" /> Audit
            </TabsTrigger>
            <TabsTrigger value="methods">
              <Shield className="h-4 w-4 mr-2" /> Computation methods
            </TabsTrigger>
            {/* Custom Deduction Types now lives at /hr/payroll/configuration/deduction-types. */}
          </TabsList>

          {/* ────── TAB: RULES ────── */}
          <TabsContent value="rules" className="space-y-4">
            {/* Filters */}
            <div className="flex flex-col sm:flex-row gap-3">
              <div className="relative flex-1 min-w-0">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input placeholder="Search rules..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="pl-10 w-full" />
              </div>
              <Select value={filterCountry} onValueChange={setFilterCountry}>
                <SelectTrigger className="w-full sm:w-[180px]"><SelectValue placeholder="Country" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Countries</SelectItem>
                  {COUNTRY_OPTIONS.map((c) => (
                    <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={filterType} onValueChange={setFilterType}>
                <SelectTrigger className="w-full sm:w-[200px]"><SelectValue placeholder="Rule Type" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Types</SelectItem>
                  {ruleTypes.map((r) => (
                    <SelectItem key={r.code} value={r.code}>{r.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button onClick={openCreateRule}>
                <Plus className="h-4 w-4 mr-2" /> Add Rule
              </Button>
            </div>

            {/* Rules List */}
            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : filteredRules.length === 0 ? (
              <Card>
                <CardContent className="flex flex-col items-center justify-center py-12">
                  <Shield className="h-12 w-12 text-muted-foreground mb-4" />
                  <h3 className="text-lg font-medium">No statutory rules found</h3>
                  <p className="text-muted-foreground text-sm text-center max-w-md mt-1">
                    {rules.length === 0
                      ? `Install your country's localization pack to seed statutory rules in seconds, or add them manually.`
                      : "Try adjusting your filters."}
                  </p>
                  {rules.length === 0 && (
                    <div className="flex gap-2 mt-4">
                      {currentBusiness?.country && (
                        <Button onClick={() => setShowPackDialog(true)}>
                          Install localization pack
                        </Button>
                      )}
                      <Button variant="outline" onClick={openCreateRule}>
                        Add rule manually
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-4">
                {Object.entries(rulesByGroup).map(([key, groupRules]) => {
                  const [countryCode, ruleType] = key.split("::");
                  const countryLabel = COUNTRY_OPTIONS.find((c) => c.value === countryCode)?.label ?? countryCode;
                  const typeInfo = ruleTypeMap[ruleType];
                  return (
                    <Card key={key}>
                      <CardHeader className="pb-2">
                        <CardTitle className="text-base flex items-center gap-2">
                          <span>{countryLabel}</span>
                          <Badge variant="secondary">{typeInfo?.label ?? ruleType}</Badge>
                        </CardTitle>
                        <CardDescription className="text-xs">
                          {groupRules.length} rule{groupRules.length !== 1 ? "s" : ""} · {typeInfo?.description ?? ""}
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="p-0">
                        <div className="overflow-x-auto">
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead className="w-8">#</TableHead>
                                <TableHead>Name</TableHead>
                                <TableHead className="w-[150px]">Provenance</TableHead>
                                <TableHead>Parameters</TableHead>
                                <TableHead>Effective</TableHead>
                                <TableHead>Status</TableHead>
                                <TableHead className="w-28">Actions</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {groupRules.map((rule) => {
                                const anchor = ruleAnchor.getAnchorProps(rule.id);
                                return (
                                <TableRow
                                  key={rule.id}
                                  id={anchor.id}
                                  data-anchor={anchor["data-anchor"]}
                                  className={[!rule.is_active ? "opacity-50" : "", anchor.className].filter(Boolean).join(" ") || undefined}
                                >
                                  <TableCell className="text-muted-foreground text-xs">{rule.sort_order}</TableCell>
                                  <TableCell className="font-medium text-sm">{rule.rule_name}</TableCell>
                                  <TableCell>
                                    {statusByRuleId[rule.id] ? (
                                      <StatutoryRuleProvenanceBadge status={statusByRuleId[rule.id]} />
                                    ) : (
                                      <span className="text-xs text-muted-foreground italic">—</span>
                                    )}
                                  </TableCell>
                                  <TableCell>
                                    <RuleParameters params={rule.parameters} schema={typeInfo?.parameter_schema} />
                                  </TableCell>
                                  <TableCell className="text-xs text-muted-foreground">
                                    {rule.effective_from}{rule.effective_to ? ` → ${rule.effective_to}` : " → ongoing"}
                                  </TableCell>
                                  <TableCell>
                                    <Badge variant={rule.is_active ? "default" : "secondary"}>
                                      {rule.is_active ? "Active" : "Inactive"}
                                    </Badge>
                                  </TableCell>
                                  <TableCell>
                                    <div className="flex gap-1">
                                      <Button variant="ghost" size="icon" onClick={() => setImpactRule(rule)} title="Downstream impact">
                                        <Network className="h-4 w-4" />
                                      </Button>
                                      <Button variant="ghost" size="icon" onClick={() => openEditRule(rule)} title="Edit">
                                        <Edit2 className="h-4 w-4" />
                                      </Button>
                                      <Button variant="ghost" size="icon" onClick={() => openDuplicateRule(rule)} title="Duplicate as new version">
                                        <Copy className="h-4 w-4" />
                                      </Button>
                                      <Button variant="ghost" size="icon" onClick={() => setDeleteRule(rule)} title="Delete">
                                        <Trash2 className="h-4 w-4 text-destructive" />
                                      </Button>
                                    </div>
                                  </TableCell>
                                </TableRow>
                                );
                              })}
                            </TableBody>
                          </Table>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )}
          </TabsContent>

          {/* ────── TAB: UPGRADE INBOX ────── */}
          <TabsContent value="inbox" className="space-y-4">
            <UpgradeInboxPanel orgId={currentOrg?.id} />
          </TabsContent>

          {/* ────── TAB: CONFLICTS ────── */}
          <TabsContent value="conflicts" className="space-y-4">
            <ConflictsPanel orgId={currentOrg?.id} />
          </TabsContent>

          {/* ────── TAB: TIMELINE ────── */}
          <TabsContent value="timeline" className="space-y-4">
            <TimelinePanel orgId={currentOrg?.id} />
          </TabsContent>

          {/* ────── TAB: AUDIT ────── */}
          <TabsContent value="audit" className="space-y-4">
            <AuditPanel orgId={currentOrg?.id} />
          </TabsContent>


          {/* ────── TAB: COMPUTATION METHODS (read-only reference) ────── */}
          <TabsContent value="methods" className="space-y-4">
            <p className="text-sm text-muted-foreground">
              These are the calculation methods the payroll engine knows. Every statutory rule must declare one of them — the
              Add Rule dialog will adapt its parameter editor to the method you pick. New methods cannot be invented from the
              UI; they require an engine change.
            </p>
            <div className="grid gap-4 md:grid-cols-2">
              {COMPUTATION_METHOD_LIST.map((m) => {
                const usage = rules.filter((r: any) => r.computation_method === m.method).length;
                return (
                  <Card key={m.method}>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-base flex items-center gap-2">
                        {m.label}
                        <Badge variant="secondary" className="text-xs">{m.method}</Badge>
                        <Badge variant="outline" className="text-xs ml-auto">{usage} rule{usage === 1 ? "" : "s"}</Badge>
                      </CardTitle>
                      <CardDescription className="text-xs">{m.description}</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-2">
                      <div>
                        <div className="text-xs font-medium mb-1">Scalar parameters</div>
                        <div className="flex flex-wrap gap-1">
                          {m.scalarFields.length === 0
                            ? <span className="text-xs text-muted-foreground">None</span>
                            : m.scalarFields.map((f) => (
                                <span key={f.key} className="text-xs border rounded px-1.5 py-0.5">
                                  <code className="text-[11px]">{f.key}</code>
                                  <span className="text-muted-foreground ml-1">{f.type}{f.optional ? " · optional" : ""}</span>
                                </span>
                              ))}
                        </div>
                      </div>
                      {m.arrayField && (
                        <div>
                          <div className="text-xs font-medium mb-1">{m.arrayField.label} (<code className="text-[11px]">{m.arrayField.key}</code>)</div>
                          <div className="flex flex-wrap gap-1">
                            {m.arrayField.columns.map((c) => (
                              <span key={c.key} className="text-xs border rounded px-1.5 py-0.5">
                                <code className="text-[11px]">{c.key}</code>
                                <span className="text-muted-foreground ml-1">{c.type}{c.allowOpenEnded ? " · nullable" : ""}</span>
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </TabsContent>

          {/* Custom Deduction Types tab removed — Phase C of the Statutory
              Rules architectural hardening separates pack-owned legislative
              concerns (this page) from tenant-owned operational concerns
              (the dedicated /hr/payroll/configuration/deduction-types
              workspace). */}
        </Tabs>
      </div>

      {/* ────── ADD/EDIT RULE DIALOG ────── */}
      <StatutoryRuleEditor
        open={showRuleDialog}
        onOpenChange={(v) => { setShowRuleDialog(v); if (!v) setEditingRule(null); }}
        editingRule={editingRule as unknown as StatutoryRuleRow | null}
        organizationId={currentOrg?.id ?? ""}
        defaultCountry={(currentBusiness as any)?.country || (currentOrg as any)?.country || "GENERIC"}
        countries={COUNTRY_OPTIONS}
        ruleTypeOptions={[
          { value: "income_tax", label: "Income tax" },
          { value: "statutory_deduction", label: "Statutory deduction" },
          { value: "employer_contribution", label: "Employer contribution" },
          { value: "personal_relief", label: "Personal relief" },
          { value: "insurance_relief", label: "Insurance relief" },
          { value: "housing_exemption", label: "Housing exemption" },
          // Tenant-defined types still surface in the catalog tab; we expose
          // their codes here so existing rules round-trip cleanly.
          ...ruleTypes
            .filter((rt) => !["income_tax","statutory_deduction","employer_contribution","personal_relief","insurance_relief","housing_exemption"].includes(rt.code))
            .map((rt) => ({ value: rt.code, label: rt.label })),
        ]}
      />

      {/* Custom Deduction Types form lives at /hr/payroll/configuration/deduction-types. */}

      <PayrollSetupGuideDialog
        open={showPackDialog}
        onOpenChange={setShowPackDialog}
        organizationId={currentOrg?.id ?? null}
        businessId={currentBusiness?.id ?? null}
        countryCode={(currentBusiness as any)?.country || null}
        countryLabel={(currentBusiness as any)?.country || null}
        blockers={readinessBlockers}
        reasons={["No statutory rules configured for this workspace yet."]}
        onInstalled={() => {
          queryClient.invalidateQueries({ queryKey: ["payroll-statutory-rules-admin"] });
        }}
      />

      {/* ────── DELETE RULE CONFIRM ────── */}
      <AlertDialog open={!!deleteRule} onOpenChange={() => setDeleteRule(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Rule?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete <strong>"{deleteRule?.rule_name}"</strong>. Consider deactivating instead to preserve history.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => deleteRule && deleteRuleMutation.mutate(deleteRule.id)} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete-rule-type confirm dialog lives in CustomDeductionTypes workspace. */}

      {/* Downstream impact drawer — opened from any rule row's Network icon. */}
      <StatutoryRuleConsumersDrawer
        open={!!impactRule}
        onOpenChange={(v) => { if (!v) setImpactRule(null); }}
        ruleId={impactRule?.id ?? null}
        ruleName={impactRule?.rule_name}
        ruleCode={impactRule?.rule_code ?? null}
      />
    </>
  );
}
