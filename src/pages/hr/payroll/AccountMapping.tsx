/**
 * PayrollAccountMappingPage — canonical mapping UI backed by
 * `payroll_gl_readiness` so every required key (core + per-statutory-rule)
 * is visible, with searchable account picker, type-filtered choices,
 * one-click suggestion, bulk apply, and inline create+map.
 *
 * Replaces the old hardcoded 4-key table that silently failed when validation
 * triggers rejected the saved account.
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CheckCircle2, Sparkles, Plus, Search, ExternalLink, ArrowRight } from "lucide-react";
import { PayrollMappingFindingsPanel } from "@/components/payroll/PayrollMappingFindingsPanel";

interface AccountOpt {
  id: string;
  code: string;
  name: string;
  account_type: string;
  is_active: boolean;
  is_header: boolean;
  business_id: string | null;
}

export function PayrollAccountMappingPage() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const readiness = usePayrollGlReadiness();

  const { data: accounts = [] } = useQuery({
    queryKey: ["payroll-mapping-accounts", currentOrg?.id, currentBusiness?.id],
    enabled: !!currentOrg?.id,
    queryFn: async (): Promise<AccountOpt[]> => {
      const { data, error } = await supabase
        .from("accounts")
        .select("id, code, name, account_type, is_active, is_header, business_id")
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
      employee: rows.filter((r) => r.kind === "employee_payable"),
      employerExpense: rows.filter((r) => r.kind === "employer_expense"),
      employerPayable: rows.filter((r) => r.kind === "employer_payable"),
    };
  }, [readiness.rows]);

  const missingCount = readiness.missing.length;
  const totalCount = readiness.rows.length;

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Payroll GL Account Mapping</h1>
          <p className="text-sm text-muted-foreground">
            Every payroll posting key — core and per-statutory-rule — must point to a postable Chart of Accounts entry.
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

      <PayrollMappingFindingsPanel />

      {readiness.isLoading ? (
        <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">Loading required keys…</CardContent></Card>
      ) : missingCount === 0 && totalCount > 0 ? (
        <Card>
          <CardContent className="py-6 flex items-center gap-2 text-sm">
            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            All required payroll GL accounts are mapped. You can now post payroll runs to the ledger.
          </CardContent>
        </Card>
      ) : (
        <>
          <Section title="Core payroll accounts" rows={grouped.core} accounts={accounts} readiness={readiness} />
          <Section title="Employee deductions (payable)" rows={grouped.employee} accounts={accounts} readiness={readiness} />
          <Section title="Employer contributions (expense)" rows={grouped.employerExpense} accounts={accounts} readiness={readiness} />
          <Section title="Employer contributions (payable)" rows={grouped.employerPayable} accounts={accounts} readiness={readiness} />
        </>
      )}
    </div>
  );
}

function Section({
  title, rows, accounts, readiness,
}: {
  title: string;
  rows: PayrollGlReadinessRow[];
  accounts: AccountOpt[];
  readiness: ReturnType<typeof usePayrollGlReadiness>;
}) {
  if (rows.length === 0) return null;
  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-base">{title}</CardTitle></CardHeader>
      <CardContent className="space-y-2">
        {rows.map((r) => (
          <RowEditor key={r.setting_key} row={r} accounts={accounts} readiness={readiness} />
        ))}
      </CardContent>
    </Card>
  );
}

function RowEditor({
  row, accounts, readiness,
}: {
  row: PayrollGlReadinessRow;
  accounts: AccountOpt[];
  readiness: ReturnType<typeof usePayrollGlReadiness>;
}) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState(row.label);

  const filtered = useMemo(
    () => accounts.filter((a) => a.account_type === row.required_account_type),
    [accounts, row.required_account_type],
  );

  const isMapped = row.is_mapped;

  return (
    <div className={`rounded-md border p-3 space-y-2 ${isMapped ? "bg-emerald-50/30 dark:bg-emerald-950/10" : ""}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-medium flex items-center gap-2">
            {row.label}
            {isMapped ? (
              <Badge variant="outline" className="text-emerald-600 border-emerald-600/30">
                <CheckCircle2 className="h-3 w-3 mr-1" /> Mapped
              </Badge>
            ) : (
              <Badge variant="destructive">Not mapped</Badge>
            )}
          </div>
          <div className="text-xs text-muted-foreground font-mono truncate">
            {row.setting_key} · needs {row.required_account_type}
          </div>
          {row.suggested_account_label && !isMapped && (
            <div className="text-xs text-muted-foreground mt-0.5">
              Suggested: <span className="font-mono">{row.suggested_account_label}</span>
            </div>
          )}
        </div>
      </div>

      {creating ? (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            placeholder="New account name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="h-8 max-w-xs"
          />
          <Button
            size="sm"
            disabled={!newName.trim() || readiness.createAndMap.isPending}
            onClick={() =>
              readiness.createAndMap.mutate({
                setting_key: row.setting_key,
                name: newName.trim(),
                account_type: row.required_account_type as any,
              }, { onSuccess: () => setCreating(false) })
            }
          >
            <Plus className="mr-1.5 h-3.5 w-3.5" /> Create &amp; map
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>Cancel</Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="justify-between min-w-[260px] h-8">
                <span className="flex items-center gap-1.5 truncate">
                  <Search className="h-3.5 w-3.5" />
                  {isMapped ? "Change account…" : "Pick an account…"}
                </span>
              </Button>
            </PopoverTrigger>
            <PopoverContent className="p-0 w-[360px]" align="start">
              <Command>
                <CommandInput placeholder="Search accounts by code or name…" />
                <CommandList>
                  <CommandEmpty>No matching {row.required_account_type} accounts.</CommandEmpty>
                  <CommandGroup>
                    {filtered.map((a) => (
                      <CommandItem
                        key={a.id}
                        value={`${a.code} ${a.name}`}
                        onSelect={() => {
                          readiness.applyOne.mutate({ setting_key: row.setting_key, account_id: a.id });
                          setOpen(false);
                        }}
                      >
                        <span className="font-mono text-xs mr-2">{a.code}</span>
                        {a.name}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>

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
              <Sparkles className="mr-1.5 h-3.5 w-3.5" /> Use suggested
              <ArrowRight className="ml-1 h-3 w-3" />
            </Button>
          )}

          <Button size="sm" variant="ghost" onClick={() => setCreating(true)}>
            <Plus className="mr-1.5 h-3.5 w-3.5" /> New account
          </Button>
        </div>
      )}
    </div>
  );
}

export default PayrollAccountMappingPage;
