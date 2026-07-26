/**
 * MissingMappingsDialog — actionable "set GL mappings" dialog.
 *
 * Opens automatically when:
 *   1. A user clicks "Open mapping fixer" on the readiness card, or
 *   2. `post-payroll-gl` returns a structured `missing_mappings` body and the
 *      GL hook dispatches the `payroll:missing-mappings` event.
 *
 * Per-row affordances:
 *   - "Use suggested" — one-click apply of the heuristic suggestion.
 *   - "Pick account" — choose any active account of the right type.
 *   - "Create new" — provisions a new chart-of-accounts row and maps it.
 *
 * Plus a bulk [Apply all suggested] button.
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import {
  usePayrollGlReadiness,
  type PayrollGlReadinessRow,
  MISSING_MAPPINGS_EVENT,
  type MissingMappingsEventDetail,
} from "@/hooks/payroll/usePayrollGlReadiness";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { CheckCircle2, Sparkles, Plus, ArrowRight, Loader2 } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";

interface Props {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Optional title override (e.g. "Finish setting up Kenya payroll"). */
  title?: string;
}

/**
 * Mounts globally (rendered once near the app root) so it opens whenever
 * the `payroll:missing-mappings` event fires from anywhere in the app.
 * Pages that want to open it explicitly can also pass `open` directly.
 */
export function MissingMappingsDialog({ open: openProp, onOpenChange, title }: Props = {}) {
  const [open, setOpen] = useState(!!openProp);
  const [eventDetail, setEventDetail] = useState<MissingMappingsEventDetail | null>(null);

  // Listen to global trigger event
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<MissingMappingsEventDetail>).detail;
      setEventDetail(detail ?? null);
      setOpen(true);
    };
    window.addEventListener(MISSING_MAPPINGS_EVENT, handler);
    return () => window.removeEventListener(MISSING_MAPPINGS_EVENT, handler);
  }, []);

  // Sync controlled open
  useEffect(() => {
    if (typeof openProp === "boolean") setOpen(openProp);
  }, [openProp]);

  const handleOpenChange = (v: boolean) => {
    setOpen(v);
    onOpenChange?.(v);
    if (!v) setEventDetail(null);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-3xl w-[calc(100vw-1rem)] sm:w-full p-4 sm:p-6 max-h-[90vh] overflow-hidden">
        <DialogHeader>
          <DialogTitle>{title ?? "Set up payroll GL mappings"}</DialogTitle>
          <DialogDescription>
            {eventDetail?.message ??
              "Each statutory rule needs a chart-of-accounts mapping so payroll can post a balanced journal entry. Pick an existing account, accept the suggestion, or create a new account — we'll handle the rest."}
          </DialogDescription>
        </DialogHeader>
        <MappingsBody
          onClose={() => handleOpenChange(false)}
          eventMissing={eventDetail?.missing ?? null}
        />
      </DialogContent>
    </Dialog>
  );
}

function MappingsBody({
  onClose,
  eventMissing,
}: {
  onClose: () => void;
  eventMissing: MissingMappingsEventDetail["missing"] | null;
}) {
  const navigate = useNavigate();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const {
    rows,
    missing: setupMissing,
    suggestedPairs: setupSuggestedPairs,
    applyAll,
    applyOne,
    createAndMap,
    isLoading,
  } = usePayrollGlReadiness();

  // When the dialog is opened by a server-side `missing_mappings` event
  // (run-specific from post-payroll-gl), trust the event payload over the
  // broad setup-readiness query — that event lists exactly the keys THIS
  // RUN needs, and is the same source of truth post-payroll-gl uses.
  const useEventList = Array.isArray(eventMissing) && eventMissing.length > 0;

  const effectiveMissing: PayrollGlReadinessRow[] = useEventList
    ? (eventMissing as any[]).map((m) => ({
        setting_key: m.setting_key,
        label: m.label,
        rule_code: m.rule_code,
        kind: m.kind,
        required_account_type:
          m.kind === "employer_expense" ? "expense" :
          m.kind === "core" && m.setting_key === "salary_expense" ? "expense" :
          m.kind === "loan_receivable" ? "asset" :
          m.kind === "interest_income" ? "income" :
          "liability",
        is_mapped: false,
        suggested_account_id: m.suggested_account_id ?? null,
        suggested_account_label: m.suggested_account_label ?? null,
      })) as PayrollGlReadinessRow[]
    : setupMissing;

  // Loan-type-scoped rows live in Loan Types settings, not the generic GL
  // Mapping surface. They're segregated so the generic "one-click setup" /
  // "apply all suggested" flows never try to upsert them into
  // default_account_settings (which would silently fail — those keys aren't
  // in that table's vocabulary).
  const isLoanRow = (r: PayrollGlReadinessRow) =>
    r.kind === "loan_receivable" || r.kind === "interest_income" ||
    r.setting_key.startsWith("loan_type:");
  const loanRows = effectiveMissing.filter(isLoanRow);
  const genericMissing = effectiveMissing.filter((r) => !isLoanRow(r));

  const effectiveSuggestedPairs = useEventList
    ? genericMissing
        .filter((r) => !!r.suggested_account_id)
        .map((r) => ({ setting_key: r.setting_key, account_id: r.suggested_account_id! }))
    : setupSuggestedPairs;

  const [autoRunning, setAutoRunning] = useState(false);

  /**
   * One-click setup: for every missing mapping, either apply the heuristic
   * suggestion (existing account) or provision a new chart-of-accounts row
   * using the canonical label and required account type, then map it.
   * Runs sequentially so DB-side uniqueness checks are respected and the
   * user gets a precise error if any single row fails.
   */
  const runOneClickSetup = async () => {
    // Only the generic default_account_settings-shaped rows can be one-click
    // provisioned. Loan-type rows must be resolved in Loan Types settings
    // because their accounts live on `loan_types`, not `default_account_settings`.
    if (genericMissing.length === 0) return;
    setAutoRunning(true);
    let applied = 0;
    let created = 0;
    try {
      if (effectiveSuggestedPairs.length > 0) {
        await applyAll.mutateAsync(effectiveSuggestedPairs);
        applied = effectiveSuggestedPairs.length;
      }
      const needsCreate = genericMissing.filter((r) => !r.suggested_account_id);
      for (const r of needsCreate) {
        await createAndMap.mutateAsync({
          setting_key: r.setting_key,
          name: r.label,
          account_type: r.required_account_type,
        });
        created += 1;
      }
      toast.success(
        `Payroll GL ready — ${applied} mapped, ${created} account${created === 1 ? "" : "s"} created`,
      );
      if (loanRows.length === 0) onClose();
    } catch (e: any) {
      toast.error(e?.message || "One-click setup failed — fix the failing row and retry");
    } finally {
      setAutoRunning(false);
    }
  };

  const { data: accounts = [] } = useQuery({
    queryKey: ["accounts-for-mapping", currentOrg?.id, currentBusiness?.id],
    enabled: !!currentOrg?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("accounts")
        .select("id, code, name, account_type, is_active, is_header, business_id")
        .eq("organization_id", currentOrg!.id)
        .eq("is_active", true)
        .eq("is_header", false)
        .order("code");
      if (error) throw error;
      return (data ?? []).filter(
        (a: any) => !a.business_id || a.business_id === currentBusiness?.id,
      );
    },
  });

  const grouped = useMemo(() => {
    return {
      core: genericMissing.filter((r) => r.kind === "core"),
      employee: genericMissing.filter((r) => r.kind === "employee_payable"),
      employerExpense: genericMissing.filter((r) => r.kind === "employer_expense"),
      employerPayable: genericMissing.filter((r) => r.kind === "employer_payable"),
    };
  }, [genericMissing]);

  if (isLoading && !useEventList) {
    return (
      <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading mappings…
      </div>
    );
  }

  if (effectiveMissing.length === 0) {
    return (
      <div className="space-y-4 py-2">
        <div className="flex items-center gap-2 rounded-md border bg-muted/30 p-3 text-sm">
          <CheckCircle2 className="h-4 w-4 text-primary" />
          All required GL mappings are configured. {rows.length} key{rows.length === 1 ? "" : "s"} in total.
        </div>
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </div>
    );
  }

  const missing = effectiveMissing;
  const suggestedPairs = effectiveSuggestedPairs;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-amber-50 dark:bg-amber-950/20 p-3 text-sm">
        <span className="min-w-0 break-words">
          <strong>{missing.length}</strong> mapping{missing.length === 1 ? "" : "s"} missing,{" "}
          {suggestedPairs.length} have suggestions.
        </span>
        <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
          <Button
            size="sm"
            variant="default"
            className="w-full sm:w-auto"
            disabled={autoRunning}
            onClick={runOneClickSetup}
          >
            {autoRunning ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="mr-1.5 h-3.5 w-3.5" />
            )}
            One-click setup ({missing.length})
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="w-full sm:w-auto"
            disabled={suggestedPairs.length === 0 || applyAll.isPending}
            onClick={() => applyAll.mutate(suggestedPairs)}
          >
            <Sparkles className="mr-1.5 h-3.5 w-3.5" />
            Apply all suggested ({suggestedPairs.length})
          </Button>
          <Button size="sm" variant="outline" className="w-full sm:w-auto" onClick={() => navigate("/hr/payroll/configuration/accounts")}>
            Open full mapping page <ArrowRight className="ml-1 h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <ScrollArea className="max-h-[55vh] sm:max-h-[50vh] -mx-1 px-1 pr-2">
        <div className="space-y-4">
          {grouped.core.length > 0 && (
            <Section title="Core payroll accounts" rows={grouped.core} accounts={accounts} applyOne={applyOne} createAndMap={createAndMap} />
          )}
          {grouped.employee.length > 0 && (
            <Section title="Employee deductions (payable)" rows={grouped.employee} accounts={accounts} applyOne={applyOne} createAndMap={createAndMap} />
          )}
          {grouped.employerExpense.length > 0 && (
            <Section title="Employer contributions (expense)" rows={grouped.employerExpense} accounts={accounts} applyOne={applyOne} createAndMap={createAndMap} />
          )}
          {grouped.employerPayable.length > 0 && (
            <Section title="Employer contributions (payable)" rows={grouped.employerPayable} accounts={accounts} applyOne={applyOne} createAndMap={createAndMap} />
          )}
        </div>
      </ScrollArea>

      <DialogFooter>
        <Button variant="ghost" className="w-full sm:w-auto" onClick={onClose}>Close</Button>
      </DialogFooter>
    </div>
  );
}

function Section({
  title, rows, accounts, applyOne, createAndMap,
}: {
  title: string;
  rows: PayrollGlReadinessRow[];
  accounts: any[];
  applyOne: ReturnType<typeof usePayrollGlReadiness>["applyOne"];
  createAndMap: ReturnType<typeof usePayrollGlReadiness>["createAndMap"];
}) {
  return (
    <div className="space-y-2">
      <h4 className="text-sm font-semibold text-muted-foreground">{title}</h4>
      <div className="space-y-2">
        {rows.map((r) => (
          <RowEditor key={r.setting_key} row={r} accounts={accounts} applyOne={applyOne} createAndMap={createAndMap} />
        ))}
      </div>
    </div>
  );
}

function RowEditor({
  row, accounts, applyOne, createAndMap,
}: {
  row: PayrollGlReadinessRow;
  accounts: any[];
  applyOne: ReturnType<typeof usePayrollGlReadiness>["applyOne"];
  createAndMap: ReturnType<typeof usePayrollGlReadiness>["createAndMap"];
}) {
  const [pickedId, setPickedId] = useState<string>(row.suggested_account_id ?? "");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState(row.label);

  const filteredAccounts = useMemo(
    () => accounts.filter((a) => a.account_type === row.required_account_type),
    [accounts, row.required_account_type],
  );

  return (
    <div className="rounded-md border p-3 space-y-2 min-w-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium break-words">{row.label}</div>
          <div className="text-xs text-muted-foreground font-mono break-all">
            {row.setting_key} · needs {row.required_account_type}
          </div>
        </div>
        <Badge variant="outline" className="text-xs">{row.kind.replace("_", " ")}</Badge>
      </div>

      {row.suggested_account_label && !creating && (
        <div className="text-xs text-muted-foreground">
          Suggested: <span className="font-mono">{row.suggested_account_label}</span>
        </div>
      )}

      {creating ? (
        <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-2">
          <Input
            placeholder="New account name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="h-8 w-full sm:max-w-xs min-w-0"
          />
          <Button
            size="sm"
            className="w-full sm:w-auto"
            disabled={!newName.trim() || createAndMap.isPending}
            onClick={() =>
              createAndMap.mutate({
                setting_key: row.setting_key,
                name: newName.trim(),
                account_type: row.required_account_type,
              })
            }
          >
            <Plus className="mr-1.5 h-3.5 w-3.5" /> Create & map
          </Button>
          <Button size="sm" variant="ghost" className="w-full sm:w-auto" onClick={() => setCreating(false)}>Cancel</Button>
        </div>
      ) : (
        <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-2">
          <Select value={pickedId} onValueChange={setPickedId}>
            <SelectTrigger className="h-8 w-full sm:max-w-xs min-w-0">
              <SelectValue placeholder="Pick an account…" />
            </SelectTrigger>
            <SelectContent>
              {filteredAccounts.map((a) => (
                <SelectItem key={a.id} value={a.id}>{a.code} — {a.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            className="w-full sm:w-auto"
            disabled={!pickedId || applyOne.isPending}
            onClick={() => applyOne.mutate({ setting_key: row.setting_key, account_id: pickedId })}
          >
            Apply
          </Button>
          {row.suggested_account_id && row.suggested_account_id !== pickedId && (
            <Button
              size="sm"
              variant="outline"
              className="w-full sm:w-auto"
              onClick={() =>
                applyOne.mutate({ setting_key: row.setting_key, account_id: row.suggested_account_id! })
              }
            >
              <Sparkles className="mr-1.5 h-3.5 w-3.5" /> Use suggested
            </Button>
          )}
          <Button size="sm" variant="ghost" className="w-full sm:w-auto" onClick={() => setCreating(true)}>
            <Plus className="mr-1.5 h-3.5 w-3.5" /> New account
          </Button>
        </div>
      )}
    </div>
  );
}