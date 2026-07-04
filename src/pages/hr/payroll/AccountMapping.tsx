/**
 * PayrollAccountMappingPage — enterprise coverage surface for payroll GL
 * mappings. Every payroll posting key derived from the active statutory
 * rulebook is listed with its bound Chart of Accounts row, source signals,
 * suggested alternatives, per-row audit history, and drill-throughs into
 * the Chart of Accounts and (when applicable) the statutory rule that
 * produced the key.
 *
 * Data sources (all schema-neutral, no migrations needed for Phase 1):
 *   • `payroll_gl_readiness` — required keys + is_mapped + one suggestion.
 *   • `default_account_settings` join `accounts` — mapped account details
 *     + updated_at (proxy "last modified").
 *   • `settings_audit_log` (per-row popover) — change history.
 *   • Client-side `rankCandidateAccounts` — top-3 alternative candidates.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import {
  usePayrollGlReadiness,
  type PayrollGlReadinessRow,
} from "@/hooks/payroll/usePayrollGlReadiness";
import {
  usePayrollMappingDetails,
  usePayrollMappingHistory,
  rankCandidateAccounts,
  type PayrollMappedAccount,
  type PayrollMappingSource,
} from "@/hooks/payroll/usePayrollMappingDetails";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  CheckCircle2,
  Sparkles,
  Plus,
  Search,
  ExternalLink,
  ArrowRight,
  AlertTriangle,
  History,
  ChevronRight,
  Undo2,
} from "lucide-react";
import { PayrollMappingFindingsPanel } from "@/components/payroll/PayrollMappingFindingsPanel";
import { formatDistanceToNow } from "date-fns";

const SOURCE_META: Record<
  PayrollMappingSource,
  { label: string; tone: "ok" | "warn" | "hint" | "neutral" | "danger" }
> = {
  pack_default: { label: "Pack default", tone: "ok" },
  pack_upgrade: { label: "Pack upgrade", tone: "hint" },
  tenant_override: { label: "Override", tone: "warn" },
  manual: { label: "Manual", tone: "neutral" },
  system_seed: { label: "System", tone: "neutral" },
};

interface AccountOpt {
  id: string;
  code: string;
  name: string;
  account_type: string;
  is_active: boolean;
  is_header: boolean;
  business_id: string | null;
}

const KIND_META: Record<
  PayrollGlReadinessRow["kind"],
  { title: string; description: string }
> = {
  core: {
    title: "Core payroll accounts",
    description:
      "Salary expense, net pay clearing, and payroll clearing — required for every run.",
  },
  employee_payable: {
    title: "Employee deductions (payable)",
    description:
      "Amounts withheld from employees and owed to statutory bodies or third parties.",
  },
  employer_expense: {
    title: "Employer contributions (expense)",
    description:
      "Employer-side statutory contributions recognised as payroll expense.",
  },
  employer_payable: {
    title: "Employer contributions (payable)",
    description:
      "Employer liability side of statutory contributions until remitted.",
  },
};

export function PayrollAccountMappingPage() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const readiness = usePayrollGlReadiness();
  const details = usePayrollMappingDetails();

  const { data: accounts = [] } = useQuery({
    queryKey: ["payroll-mapping-accounts", currentOrg?.id, currentBusiness?.id],
    enabled: !!currentOrg?.id,
    queryFn: async (): Promise<AccountOpt[]> => {
      const { data, error } = await supabase
        .from("accounts")
        .select(
          "id, code, name, account_type, is_active, is_header, business_id",
        )
        .eq("organization_id", currentOrg!.id)
        .eq("is_active", true)
        .eq("is_header", false)
        .order("code");
      if (error) throw error;
      return ((data ?? []) as any[]).filter(
        (a) => !a.business_id || a.business_id === currentBusiness?.id,
      ) as AccountOpt[];
    },
  });

  const grouped = useMemo(() => {
    const rows = readiness.rows;
    return {
      core: rows.filter((r) => r.kind === "core"),
      employee_payable: rows.filter((r) => r.kind === "employee_payable"),
      employer_expense: rows.filter((r) => r.kind === "employer_expense"),
      employer_payable: rows.filter((r) => r.kind === "employer_payable"),
    };
  }, [readiness.rows]);

  const missingCount = readiness.missing.length;
  const totalCount = readiness.rows.length;
  const coverage =
    totalCount > 0 ? Math.round(((totalCount - missingCount) / totalCount) * 100) : 100;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            Payroll GL Account Mapping
          </h1>
          <p className="text-sm text-muted-foreground">
            Every payroll posting key — core and per-statutory-rule — must
            point to a postable Chart of Accounts entry.{" "}
            <Button asChild variant="link" size="sm" className="px-1 h-auto">
              <Link to="/finance/accounts" className="inline-flex items-center gap-1">
                Open Chart of Accounts <ExternalLink className="h-3 w-3" />
              </Link>
            </Button>
          </p>
        </div>
        <div className="flex items-center gap-2">
          {readiness.suggestedPairs.length > 0 && (
            <Button
              size="sm"
              onClick={() => readiness.applyAll.mutate(readiness.suggestedPairs)}
              disabled={readiness.applyAll.isPending}
            >
              <Sparkles className="h-4 w-4 mr-1.5" />
              Apply all suggested ({readiness.suggestedPairs.length})
            </Button>
          )}
          <Badge variant={missingCount === 0 ? "outline" : "destructive"}>
            {missingCount === 0
              ? `All ${totalCount} mapped`
              : `${missingCount} of ${totalCount} missing`}
          </Badge>
        </div>
      </div>

      {/* Coverage summary */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
        <CoverageChip label="Coverage" value={`${coverage}%`} tone={coverage === 100 ? "ok" : "warn"} />
        <CoverageChip label="Total keys" value={String(totalCount)} />
        <CoverageChip label="Mapped" value={String(totalCount - missingCount)} tone="ok" />
        <CoverageChip
          label="Missing"
          value={String(missingCount)}
          tone={missingCount === 0 ? "ok" : "danger"}
        />
        <CoverageChip
          label="Auto-suggested"
          value={String(readiness.suggestedPairs.length)}
          tone={readiness.suggestedPairs.length > 0 ? "hint" : "neutral"}
        />
      </div>

      <PayrollMappingFindingsPanel />

      {readiness.isLoading ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            Loading required keys…
          </CardContent>
        </Card>
      ) : totalCount === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No payroll posting keys are active for this business yet. Install a
            localization pack from Payroll → Setup to seed the statutory rulebook.
          </CardContent>
        </Card>
      ) : (
        (
          [
            "core",
            "employee_payable",
            "employer_expense",
            "employer_payable",
          ] as const
        ).map((kind) => {
          const rows = grouped[kind];
          if (rows.length === 0) return null;
          const mappedInKind = rows.filter((r) => r.is_mapped).length;
          return (
            <Card key={kind}>
              <CardHeader className="pb-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <CardTitle className="text-base">{KIND_META[kind].title}</CardTitle>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {KIND_META[kind].description}
                    </p>
                  </div>
                  <Badge variant={mappedInKind === rows.length ? "outline" : "secondary"}>
                    {mappedInKind}/{rows.length} mapped
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="min-w-[220px]">Posting key</TableHead>
                        <TableHead>Required type</TableHead>
                        <TableHead className="min-w-[260px]">Bound account</TableHead>
                        <TableHead>Source</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Last modified</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.map((r) => (
                        <MappingRow
                          key={r.setting_key}
                          row={r}
                          accounts={accounts}
                          mapped={details.mappedByKey[r.setting_key]}
                          readiness={readiness}
                          details={details}
                        />
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          );
        })
      )}

      {missingCount === 0 && totalCount > 0 && (
        <Card>
          <CardContent className="py-4 flex items-center gap-2 text-sm">
            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            All required payroll GL accounts are mapped. Runs can be posted to
            the ledger.
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function CoverageChip({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "ok" | "warn" | "danger" | "hint" | "neutral";
}) {
  const toneCls =
    tone === "ok"
      ? "border-emerald-600/30 text-emerald-700 dark:text-emerald-400"
      : tone === "danger"
        ? "border-destructive/40 text-destructive"
        : tone === "warn"
          ? "border-amber-500/40 text-amber-700 dark:text-amber-400"
          : tone === "hint"
            ? "border-blue-500/40 text-blue-700 dark:text-blue-400"
            : "border-border text-foreground";
  return (
    <div className={`rounded-md border px-3 py-2 ${toneCls}`}>
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="text-lg font-semibold leading-tight">{value}</div>
    </div>
  );
}

function MappingRow({
  row,
  accounts,
  mapped,
  readiness,
  details,
}: {
  row: PayrollGlReadinessRow;
  accounts: AccountOpt[];
  mapped: PayrollMappedAccount | undefined;
  readiness: ReturnType<typeof usePayrollGlReadiness>;
  details: ReturnType<typeof usePayrollMappingDetails>;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState(row.label);

  const filtered = useMemo(
    () => accounts.filter((a) => a.account_type === row.required_account_type),
    [accounts, row.required_account_type],
  );

  const candidates = useMemo(
    () =>
      rankCandidateAccounts(
        accounts,
        row.required_account_type,
        row.label,
        row.rule_code,
        3,
      ),
    [accounts, row.required_account_type, row.label, row.rule_code],
  );

  const isMapped = row.is_mapped;
  const boundDead = isMapped && mapped && (!mapped.is_active || mapped.is_header);

  return (
    <>
      <TableRow className={boundDead ? "bg-destructive/5" : undefined}>
        <TableCell className="align-top">
          <div className="text-sm font-medium">{row.label}</div>
          <div className="text-[11px] text-muted-foreground font-mono">
            {row.setting_key}
            {row.rule_code ? ` · rule ${row.rule_code}` : ""}
          </div>
        </TableCell>
        <TableCell className="align-top">
          <Badge variant="outline" className="capitalize">
            {row.required_account_type}
          </Badge>
        </TableCell>
        <TableCell className="align-top">
          {mapped ? (
            <div className="flex flex-col gap-0.5">
              <Link
                to="/finance/accounts"
                className="inline-flex items-center gap-1 text-sm font-medium hover:underline"
              >
                <span className="font-mono text-xs">{mapped.code}</span>
                <span className="truncate">{mapped.name}</span>
                <ExternalLink className="h-3 w-3 shrink-0 opacity-60" />
              </Link>
              <div className="text-[11px] text-muted-foreground">
                {mapped.account_type}
                {mapped.detail_type ? ` · ${mapped.detail_type}` : ""}
              </div>
            </div>
          ) : row.suggested_account_label ? (
            <div className="text-xs text-muted-foreground">
              Not bound. Suggested:{" "}
              <span className="font-mono">{row.suggested_account_label}</span>
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">Not bound.</div>
          )}
        </TableCell>
        <TableCell className="align-top">
          {mapped ? <SourceBadge source={mapped.source} version={mapped.origin_pack_version} /> : <span className="text-xs text-muted-foreground">—</span>}
          {mapped?.overridden_at && (
            <div className="text-[10px] text-muted-foreground mt-0.5">
              overridden {formatDistanceToNow(new Date(mapped.overridden_at), { addSuffix: true })}
            </div>
          )}
        </TableCell>
        <TableCell className="align-top">
          {boundDead ? (
            <Badge variant="destructive" className="gap-1">
              <AlertTriangle className="h-3 w-3" />
              {mapped?.is_header ? "Header" : "Inactive"}
            </Badge>
          ) : isMapped ? (
            <Badge
              variant="outline"
              className="text-emerald-600 border-emerald-600/30 gap-1"
            >
              <CheckCircle2 className="h-3 w-3" /> Mapped
            </Badge>
          ) : (
            <Badge variant="destructive">Not mapped</Badge>
          )}
        </TableCell>
        <TableCell className="align-top text-xs text-muted-foreground">
          {mapped?.updated_at
            ? formatDistanceToNow(new Date(mapped.updated_at), { addSuffix: true })
            : "—"}
        </TableCell>
        <TableCell className="align-top text-right">
          <div className="flex flex-wrap items-center justify-end gap-1">
            {row.suggested_account_id && !isMapped && (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  readiness.applyOne.mutate({
                    setting_key: row.setting_key,
                    account_id: row.suggested_account_id!,
                  })
                }
              >
                <Sparkles className="mr-1 h-3.5 w-3.5" />
                Use suggested
                <ArrowRight className="ml-1 h-3 w-3" />
              </Button>
            )}
            <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm">
                  <Search className="mr-1 h-3.5 w-3.5" />
                  {isMapped ? "Change" : "Pick"}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="p-0 w-[360px]" align="end">
                <Command>
                  <CommandInput placeholder="Search by code or name…" />
                  <CommandList>
                    <CommandEmpty>
                      No matching {row.required_account_type} accounts.
                    </CommandEmpty>
                    {candidates.length > 0 && (
                      <CommandGroup heading="Top candidates">
                        {candidates.map((c) => (
                          <CommandItem
                            key={`cand-${c.id}`}
                            value={`cand-${c.code} ${c.name}`}
                            onSelect={() => {
                              readiness.applyOne.mutate({
                                setting_key: row.setting_key,
                                account_id: c.id,
                              });
                              setPickerOpen(false);
                            }}
                          >
                            <span className="font-mono text-xs mr-2">{c.code}</span>
                            <span className="truncate">{c.name}</span>
                            <ChevronRight className="ml-auto h-3 w-3 opacity-40" />
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    )}
                    <CommandGroup heading="All eligible">
                      {filtered.map((a) => (
                        <CommandItem
                          key={a.id}
                          value={`${a.code} ${a.name}`}
                          onSelect={() => {
                            readiness.applyOne.mutate({
                              setting_key: row.setting_key,
                              account_id: a.id,
                            });
                            setPickerOpen(false);
                          }}
                        >
                          <span className="font-mono text-xs mr-2">{a.code}</span>
                          <span className="truncate">{a.name}</span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>

            <Popover open={historyOpen} onOpenChange={setHistoryOpen}>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="sm" title="Change history">
                  <History className="h-3.5 w-3.5" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-[360px] p-0">
                <HistoryPanel settingKey={row.setting_key} enabled={historyOpen} />
              </PopoverContent>
            </Popover>

            <Button
              size="sm"
              variant="ghost"
              onClick={() => setCreating((v) => !v)}
              title="Create a new account for this key"
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </div>
        </TableCell>
      </TableRow>
      {creating && (
        <TableRow>
          <TableCell colSpan={6} className="bg-muted/30">
            <div className="flex flex-wrap items-center gap-2 py-1">
              <span className="text-xs text-muted-foreground">
                New {row.required_account_type} account for “{row.label}”:
              </span>
              <Input
                placeholder="Account name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="h-8 max-w-xs"
              />
              <Button
                size="sm"
                disabled={!newName.trim() || readiness.createAndMap.isPending}
                onClick={() =>
                  readiness.createAndMap.mutate(
                    {
                      setting_key: row.setting_key,
                      name: newName.trim(),
                      account_type: row.required_account_type as any,
                    },
                    { onSuccess: () => setCreating(false) },
                  )
                }
              >
                <Plus className="mr-1 h-3.5 w-3.5" /> Create &amp; map
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>
                Cancel
              </Button>
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

function HistoryPanel({
  settingKey,
  enabled,
}: {
  settingKey: string;
  enabled: boolean;
}) {
  const { data, isLoading } = usePayrollMappingHistory(settingKey, enabled);
  if (isLoading) {
    return (
      <div className="p-3 text-xs text-muted-foreground">Loading history…</div>
    );
  }
  if (!data || data.length === 0) {
    return (
      <div className="p-3 text-xs text-muted-foreground">
        No recorded changes for this mapping yet.
      </div>
    );
  }
  return (
    <div className="max-h-72 overflow-y-auto divide-y">
      {data.map((e) => {
        const newAcct =
          e.new_value && typeof e.new_value === "object"
            ? (e.new_value as any).account_id
            : null;
        const oldAcct =
          e.old_value && typeof e.old_value === "object"
            ? (e.old_value as any).account_id
            : null;
        return (
          <div key={e.id} className="p-3 space-y-1">
            <div className="text-[11px] text-muted-foreground">
              {formatDistanceToNow(new Date(e.created_at), { addSuffix: true })}
            </div>
            {oldAcct || newAcct ? (
              <div className="text-xs font-mono break-all">
                {oldAcct ? `${oldAcct.slice(0, 8)}…` : "—"}
                <ArrowRight className="inline h-3 w-3 mx-1" />
                {newAcct ? `${newAcct.slice(0, 8)}…` : "—"}
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">Setting change</div>
            )}
            {e.reason && (
              <div className="text-[11px] text-muted-foreground italic">
                {e.reason}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default PayrollAccountMappingPage;
