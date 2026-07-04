/**
 * Loan Types Settings — Phase F cockpit for `public.loan_types`.
 *
 * Mounted at `/hr/payroll/configuration/loan-types`. Replaces the previous
 * bare list with an operational cockpit for the Payroll Officer:
 *
 *   1. KPI strip     — active types, missing GL, total outstanding, pending
 *                       requests, runs at risk (from Phase C readiness rules).
 *   2. Per-row cards — GL health chip, approval-policy chip, skip-policy chip,
 *                       usage stats (active loans / outstanding / pending),
 *                       quick links to loans / approvals / GL mapping.
 *   3. Full editor   — every policy field enforced by Phases A–E is now
 *                       exposed: tenure bounds, deduction priority,
 *                       dual control, collateral/consent, skip caps,
 *                       interest method, and all four GL accounts.
 */
import { useMemo, useState } from "react";
import {
  useLoanTypes, useLoanTypeStats,
  type LoanType, type LoanTypeFieldSpec, type RepaymentMethod, type LoanKind,
  type InterestMethod, type SkipInterestTreatment, type SkipScheduleAdjustment,
} from "@/hooks/useLoanTypes";
import { useAccounts } from "@/hooks/useAccounts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumericInput } from "@/components/ui/numeric-input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import {
  Plus, Trash2, Sparkles, AlertTriangle, CheckCircle2,
  Users, Wallet, ShieldCheck, Clock, ExternalLink,
} from "lucide-react";
import { Link } from "react-router-dom";

const KINDS: { value: LoanKind; label: string }[] = [
  { value: "loan", label: "Loan" },
  { value: "salary_advance", label: "Salary advance" },
  { value: "emergency", label: "Emergency" },
  { value: "asset", label: "Asset" },
  { value: "custom", label: "Custom" },
];

const METHODS: { value: RepaymentMethod; label: string; helper: string }[] = [
  { value: "fixed_installment", label: "Fixed installment", helper: "Equal monthly amounts from a generated schedule." },
  { value: "fixed_amount", label: "Fixed amount", helper: "Same monthly deduction until the balance clears." },
  { value: "percent_of_net", label: "% of net pay", helper: "A percentage of the period's net pay each run." },
  { value: "one_off_next_payroll", label: "One-off next payroll", helper: "Recovered in full on the next payroll run." },
];

const INTEREST_METHODS: { value: InterestMethod; label: string }[] = [
  { value: "none", label: "None" },
  { value: "flat", label: "Flat" },
  { value: "reducing_balance", label: "Reducing balance" },
];

const SKIP_INTEREST: { value: SkipInterestTreatment; label: string }[] = [
  { value: "accrue", label: "Accrue during skip" },
  { value: "waive", label: "Waive during skip" },
  { value: "capitalise", label: "Capitalise into balance" },
];

const SKIP_SCHEDULE: { value: SkipScheduleAdjustment; label: string }[] = [
  { value: "push_end", label: "Push end date" },
  { value: "rebalance", label: "Rebalance remaining" },
  { value: "shorten", label: "Shorten (increase installments)" },
];

function fmtMoney(n: number) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(n);
}

export default function LoanTypesSettings() {
  const { loanTypes, isLoading, upsertLoanType, removeLoanType, seedDefaultLoanTypes } = useLoanTypes();
  const { data: stats } = useLoanTypeStats();
  const [editing, setEditing] = useState<LoanType | null>(null);
  const [open, setOpen] = useState(false);

  const typesMissingGl = useMemo(
    () => loanTypes.filter(
      (t) => t.is_active && (!t.gl_receivable_account_id || !t.gl_disbursement_clearing_account_id),
    ).length,
    [loanTypes],
  );
  const typesInUse = useMemo(
    () => loanTypes.filter((t) => stats?.activeLoansByType?.[t.id]).length,
    [loanTypes, stats],
  );
  const runsAtRisk =
    (stats?.readinessFindings.loan_type_gl_missing || 0) +
    (stats?.readinessFindings.loan_schedule_missing || 0) +
    (stats?.readinessFindings.loan_writeoff_missing || 0);

  const startNew = () => {
    setEditing({
      id: "" as any,
      organization_id: "" as any,
      business_id: null,
      code: "",
      name: "",
      kind: "loan",
      description: null,
      requires_interest: false,
      requires_schedule: true,
      requires_approval: true,
      requires_dual_approval: false,
      requires_collateral: false,
      requires_consent: true,
      allow_topup: false,
      allow_restructure: false,
      dual_control_writeoff: false,
      default_repayment_method: "fixed_installment",
      default_installments: 12,
      default_max_pct_of_net: 33,
      default_min_net_pay_floor: null,
      interest_method: "none",
      min_installments: null,
      max_installments: null,
      min_principal: null,
      max_principal: null,
      min_tenure_months: null,
      max_tenure_months: null,
      deduction_priority: 100,
      allow_skip: false,
      max_skips_per_loan: null,
      max_skips_per_calendar_year: null,
      min_gap_between_skips_days: null,
      interest_treatment_on_skip: null,
      schedule_adjustment_on_skip: null,
      gl_receivable_account_id: null,
      gl_disbursement_clearing_account_id: null,
      interest_income_account_id: null,
      writeoff_account_id: null,
      salary_rule_code: null,
      is_active: true,
      dynamic_field_schema: { fields: [] },
    });
    setOpen(true);
  };

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Loan Types</h1>
          <p className="text-sm text-muted-foreground">
            Organizational lending policy — governs approvals, payroll deduction, GL posting, and skip caps.
          </p>
        </div>
        <div className="flex gap-2">
          {loanTypes.length === 0 && !isLoading && (
            <Button variant="outline" onClick={() => seedDefaultLoanTypes()}>
              <Sparkles className="mr-2 h-4 w-4" /> Seed defaults
            </Button>
          )}
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <Button onClick={startNew}><Plus className="mr-2 h-4 w-4" /> New type</Button>
            </SheetTrigger>
            <SheetContent className="w-full sm:max-w-3xl overflow-y-auto">
              <SheetHeader>
                <SheetTitle>{editing?.id ? "Edit loan type" : "New loan type"}</SheetTitle>
              </SheetHeader>
              {editing && (
                <LoanTypeForm
                  value={editing}
                  onChange={setEditing}
                  onSave={async () => {
                    await upsertLoanType({ ...editing, id: editing.id || undefined });
                    setOpen(false);
                  }}
                  onCancel={() => setOpen(false)}
                />
              )}
            </SheetContent>
          </Sheet>
        </div>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Kpi label="Active types" value={loanTypes.filter((t) => t.is_active).length} icon={<CheckCircle2 className="h-4 w-4" />} />
        <Kpi label="Types missing GL" value={typesMissingGl} tone={typesMissingGl > 0 ? "warn" : "ok"} icon={<AlertTriangle className="h-4 w-4" />} />
        <Kpi label="Types in use" value={typesInUse} icon={<Users className="h-4 w-4" />} />
        <Kpi label="Total outstanding" value={fmtMoney(stats?.totalOutstanding || 0)} icon={<Wallet className="h-4 w-4" />} />
        <Kpi label="Runs at risk" value={runsAtRisk} tone={runsAtRisk > 0 ? "warn" : "ok"} icon={<AlertTriangle className="h-4 w-4" />} />
      </div>

      <div className="grid gap-3">
        {isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}
        {!isLoading && loanTypes.length === 0 && (
          <Card><CardContent className="p-6 text-sm text-muted-foreground">
            No loan types yet. Click <b>Seed defaults</b> to install the standard set, or <b>New type</b> to create one.
          </CardContent></Card>
        )}
        {loanTypes.map((lt) => {
          const active = stats?.activeLoansByType?.[lt.id] || 0;
          const pending = stats?.pendingLoansByType?.[lt.id] || 0;
          const outstanding = stats?.outstandingByType?.[lt.id] || 0;
          const glOk = !!lt.gl_receivable_account_id && !!lt.gl_disbursement_clearing_account_id;
          const interestOk = !lt.requires_interest || !!lt.interest_income_account_id;
          const writeOffOk = !!lt.writeoff_account_id;

          return (
            <Card key={lt.id} className="cursor-pointer hover:bg-muted/30"
                  onClick={() => { setEditing(lt); setOpen(true); }}>
              <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0 pb-2">
                <div className="min-w-0">
                  <CardTitle className="text-base flex items-center gap-2 flex-wrap">
                    {lt.name}
                    <span className="text-muted-foreground font-normal">— {lt.code}</span>
                    <Badge variant={lt.is_active ? "default" : "secondary"}>{lt.is_active ? "Active" : "Inactive"}</Badge>
                    <Badge variant="outline">{lt.kind}</Badge>
                    <PolicyChip glOk={glOk} interestOk={interestOk} writeOffOk={writeOffOk} lt={lt} />
                  </CardTitle>
                  <p className="text-xs text-muted-foreground mt-1">{lt.description || "—"}</p>
                </div>
                <Button size="icon" variant="ghost" onClick={(e) => { e.stopPropagation(); removeLoanType(lt.id); }}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="text-xs text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
                  <span>Method: <b className="text-foreground">{lt.default_repayment_method}</b></span>
                  {lt.default_installments != null && <span>Default installments: <b className="text-foreground">{lt.default_installments}</b></span>}
                  {lt.default_max_pct_of_net != null && <span>Cap: <b className="text-foreground">{lt.default_max_pct_of_net}% of net</b></span>}
                  {lt.deduction_priority != null && <span>Priority: <b className="text-foreground">{lt.deduction_priority}</b></span>}
                  {lt.interest_method && <span>Interest: <b className="text-foreground">{lt.interest_method}</b></span>}
                </div>
                <div className="flex flex-wrap gap-2 text-xs">
                  <Badge variant="outline"><Users className="h-3 w-3 mr-1" />{active} active</Badge>
                  <Badge variant="outline"><Wallet className="h-3 w-3 mr-1" />{fmtMoney(outstanding)} outstanding</Badge>
                  <Badge variant={pending > 0 ? "default" : "outline"}><Clock className="h-3 w-3 mr-1" />{pending} pending</Badge>
                  {lt.requires_approval && <Badge variant="secondary"><ShieldCheck className="h-3 w-3 mr-1" />Approval required</Badge>}
                  {lt.requires_dual_approval && <Badge variant="secondary">Dual approval</Badge>}
                  {lt.dual_control_writeoff && <Badge variant="secondary">Dual-control write-off</Badge>}
                  {lt.allow_skip && (
                    <Badge variant="outline">
                      Skip caps: {lt.max_skips_per_loan ?? "∞"}/loan · {lt.max_skips_per_calendar_year ?? "∞"}/yr
                    </Badge>
                  )}
                </div>
                <div className="flex flex-wrap gap-2 pt-1" onClick={(e) => e.stopPropagation()}>
                  <QuickLink to="/hr/payroll/loans" label="View loans" />
                  <QuickLink to="/hr/payroll/loan-skip-overrides" label="Skip overrides" />
                  <QuickLink to="/hr/payroll/account-mapping" label="GL mapping" />
                  <QuickLink to="/finance/journal-entries" label="Journal entries" />
                  <QuickLink to="/hr/payroll/setup" label="Readiness" />
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function Kpi({ label, value, icon, tone = "ok" }: { label: string; value: string | number; icon?: React.ReactNode; tone?: "ok" | "warn" }) {
  return (
    <Card>
      <CardContent className="p-3">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{label}</span>
          <span className={tone === "warn" ? "text-amber-600" : "text-muted-foreground"}>{icon}</span>
        </div>
        <div className={`text-2xl font-semibold mt-1 ${tone === "warn" && Number(value) > 0 ? "text-amber-600" : ""}`}>{value}</div>
      </CardContent>
    </Card>
  );
}

function PolicyChip({ glOk, interestOk, writeOffOk, lt }: { glOk: boolean; interestOk: boolean; writeOffOk: boolean; lt: LoanType }) {
  const problems: string[] = [];
  if (!glOk) problems.push("GL");
  if (!interestOk) problems.push("Interest income");
  if (lt.dual_control_writeoff && !writeOffOk) problems.push("Write-off");
  if (problems.length === 0) return <Badge className="bg-emerald-100 text-emerald-900 hover:bg-emerald-100">Policy OK</Badge>;
  return <Badge variant="destructive">Missing: {problems.join(", ")}</Badge>;
}

function QuickLink({ to, label }: { to: string; label: string }) {
  return (
    <Link to={to} className="inline-flex items-center gap-1 text-xs text-primary underline-offset-2 hover:underline">
      {label} <ExternalLink className="h-3 w-3" />
    </Link>
  );
}

function LoanTypeForm({
  value, onChange, onSave, onCancel,
}: {
  value: LoanType;
  onChange: (v: LoanType) => void;
  onSave: () => Promise<void> | void;
  onCancel: () => void;
}) {
  const { accounts } = useAccounts();
  const assets   = useMemo(() => accounts.filter((a) => a.account_type === "asset"), [accounts]);
  const clearing = useMemo(() => accounts.filter((a) => a.account_type === "liability" || a.account_type === "asset"), [accounts]);
  const income   = useMemo(() => accounts.filter((a) => a.account_type === "income"  || a.account_type === "revenue"), [accounts]);
  const expense  = useMemo(() => accounts.filter((a) => a.account_type === "expense"), [accounts]);

  const fields = value.dynamic_field_schema?.fields ?? [];
  const setFields = (next: LoanTypeFieldSpec[]) =>
    onChange({ ...value, dynamic_field_schema: { ...(value.dynamic_field_schema ?? {}), fields: next } });

  return (
    <div className="space-y-5 py-4">
      {/* Identity */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>Code</Label>
          <Input value={value.code} onChange={(e) => onChange({ ...value, code: e.target.value.toUpperCase() })} placeholder="LOAN" />
        </div>
        <div>
          <Label>Name</Label>
          <Input value={value.name} onChange={(e) => onChange({ ...value, name: e.target.value })} placeholder="Employee Loan" />
        </div>
        <div>
          <Label>Kind</Label>
          <Select value={value.kind} onValueChange={(v) => onChange({ ...value, kind: v as LoanKind })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{KINDS.map((k) => <SelectItem key={k.value} value={k.value}>{k.label}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div>
          <Label>Default repayment method</Label>
          <Select value={value.default_repayment_method} onValueChange={(v) => onChange({ ...value, default_repayment_method: v as RepaymentMethod })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{METHODS.map((m) => <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>)}</SelectContent>
          </Select>
          <p className="text-[11px] text-muted-foreground mt-1">{METHODS.find((m) => m.value === value.default_repayment_method)?.helper}</p>
        </div>
      </div>

      <div>
        <Label>Description</Label>
        <Textarea value={value.description ?? ""} onChange={(e) => onChange({ ...value, description: e.target.value })} rows={2} />
      </div>

      {/* Defaults */}
      <div className="grid grid-cols-4 gap-3">
        <div>
          <Label>Default installments</Label>
          <NumericInput min={0} allowDecimals={false} value={typeof value.default_installments === "number" ? value.default_installments : null} onValueChange={(n) => onChange({ ...value, default_installments: n })} />
        </div>
        <div>
          <Label>Max % of net</Label>
          <NumericInput min={0} max={100} value={typeof value.default_max_pct_of_net === "number" ? value.default_max_pct_of_net : null} onValueChange={(n) => onChange({ ...value, default_max_pct_of_net: n })} />
        </div>
        <div>
          <Label>Min net pay floor</Label>
          <NumericInput min={0} value={typeof value.default_min_net_pay_floor === "number" ? value.default_min_net_pay_floor : null} onValueChange={(n) => onChange({ ...value, default_min_net_pay_floor: n })} />
        </div>
        <div>
          <Label>Deduction priority</Label>
          <NumericInput min={1} max={10000} allowDecimals={false}
            value={typeof value.deduction_priority === "number" ? value.deduction_priority : null}
            onValueChange={(n) => onChange({ ...value, deduction_priority: n })} />
          <p className="text-[11px] text-muted-foreground mt-1">Lower runs first.</p>
        </div>
      </div>

      {/* Policy bounds */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Policy bounds (enforced server-side)</CardTitle>
          <p className="text-[11px] text-muted-foreground">Blank = no limit. Applies to every request path (wizard, RPC, import).</p>
        </CardHeader>
        <CardContent className="grid grid-cols-3 gap-3">
          <div><Label>Min installments</Label>
            <NumericInput min={1} allowDecimals={false} value={value.min_installments ?? null} onValueChange={(n) => onChange({ ...value, min_installments: n })} /></div>
          <div><Label>Max installments</Label>
            <NumericInput min={1} allowDecimals={false} value={value.max_installments ?? null} onValueChange={(n) => onChange({ ...value, max_installments: n })} /></div>
          <div><Label>Min tenure (months)</Label>
            <NumericInput min={1} allowDecimals={false} value={value.min_tenure_months ?? null} onValueChange={(n) => onChange({ ...value, min_tenure_months: n })} /></div>
          <div><Label>Max tenure (months)</Label>
            <NumericInput min={1} allowDecimals={false} value={value.max_tenure_months ?? null} onValueChange={(n) => onChange({ ...value, max_tenure_months: n })} /></div>
          <div><Label>Min principal</Label>
            <NumericInput min={0} value={value.min_principal ?? null} onValueChange={(n) => onChange({ ...value, min_principal: n })} /></div>
          <div><Label>Max principal</Label>
            <NumericInput min={0} value={value.max_principal ?? null} onValueChange={(n) => onChange({ ...value, max_principal: n })} /></div>
        </CardContent>
      </Card>

      {/* Behaviour toggles */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Behaviour</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-2 gap-x-6 gap-y-3">
          <Toggle label="Requires interest" checked={value.requires_interest} onChange={(v) => onChange({ ...value, requires_interest: v })} />
          <Toggle label="Requires schedule" checked={value.requires_schedule} onChange={(v) => onChange({ ...value, requires_schedule: v })} />
          <Toggle label="Requires approval" checked={value.requires_approval} onChange={(v) => onChange({ ...value, requires_approval: v })} />
          <Toggle label="Requires dual approval" checked={!!value.requires_dual_approval} onChange={(v) => onChange({ ...value, requires_dual_approval: v })} />
          <Toggle label="Requires collateral" checked={!!value.requires_collateral} onChange={(v) => onChange({ ...value, requires_collateral: v })} />
          <Toggle label="Requires consent" checked={!!value.requires_consent} onChange={(v) => onChange({ ...value, requires_consent: v })} />
          <Toggle label="Allow top-up" checked={!!value.allow_topup} onChange={(v) => onChange({ ...value, allow_topup: v })} />
          <Toggle label="Allow restructure" checked={!!value.allow_restructure} onChange={(v) => onChange({ ...value, allow_restructure: v })} />
          <Toggle label="Dual-control write-off" checked={!!value.dual_control_writeoff} onChange={(v) => onChange({ ...value, dual_control_writeoff: v })} />
          <Toggle label="Active" checked={value.is_active} onChange={(v) => onChange({ ...value, is_active: v })} />
        </CardContent>
      </Card>

      {/* Interest */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Interest</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-2 gap-3">
          <div>
            <Label>Interest method</Label>
            <Select value={value.interest_method ?? "none"} onValueChange={(v) => onChange({ ...value, interest_method: v as InterestMethod })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{INTEREST_METHODS.map((m) => <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div>
            <Label>Interest income account</Label>
            <Select value={value.interest_income_account_id ?? ""} onValueChange={(v) => onChange({ ...value, interest_income_account_id: v || null })}>
              <SelectTrigger><SelectValue placeholder="Select account" /></SelectTrigger>
              <SelectContent>{income.map((a) => <SelectItem key={a.id} value={a.id}>{a.code} — {a.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Skip policy */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Skip policy (caps enforced by DB trigger)</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3">
          <Toggle label="Allow skip requests" checked={!!value.allow_skip} onChange={(v) => onChange({ ...value, allow_skip: v })} />
          <div />
          <div><Label>Max skips per loan</Label>
            <NumericInput min={0} allowDecimals={false} value={value.max_skips_per_loan ?? null} onValueChange={(n) => onChange({ ...value, max_skips_per_loan: n })} disabled={!value.allow_skip} /></div>
          <div><Label>Max skips per calendar year</Label>
            <NumericInput min={0} allowDecimals={false} value={value.max_skips_per_calendar_year ?? null} onValueChange={(n) => onChange({ ...value, max_skips_per_calendar_year: n })} disabled={!value.allow_skip} /></div>
          <div><Label>Min gap between skips (days)</Label>
            <NumericInput min={0} allowDecimals={false} value={value.min_gap_between_skips_days ?? null} onValueChange={(n) => onChange({ ...value, min_gap_between_skips_days: n })} disabled={!value.allow_skip} /></div>
          <div>
            <Label>Interest treatment on skip</Label>
            <Select value={value.interest_treatment_on_skip ?? ""} onValueChange={(v) => onChange({ ...value, interest_treatment_on_skip: (v || null) as SkipInterestTreatment | null })} disabled={!value.allow_skip}>
              <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
              <SelectContent>{SKIP_INTEREST.map((m) => <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="col-span-2">
            <Label>Schedule adjustment on skip</Label>
            <Select value={value.schedule_adjustment_on_skip ?? ""} onValueChange={(v) => onChange({ ...value, schedule_adjustment_on_skip: (v || null) as SkipScheduleAdjustment | null })} disabled={!value.allow_skip}>
              <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
              <SelectContent>{SKIP_SCHEDULE.map((m) => <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* GL accounts */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">GL accounts</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-2 gap-3">
          <div>
            <Label>Loan receivable (asset)</Label>
            <Select value={value.gl_receivable_account_id ?? ""} onValueChange={(v) => onChange({ ...value, gl_receivable_account_id: v || null })}>
              <SelectTrigger><SelectValue placeholder="Select account" /></SelectTrigger>
              <SelectContent>{assets.map((a) => <SelectItem key={a.id} value={a.id}>{a.code} — {a.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div>
            <Label>Disbursement clearing</Label>
            <Select value={value.gl_disbursement_clearing_account_id ?? ""} onValueChange={(v) => onChange({ ...value, gl_disbursement_clearing_account_id: v || null })}>
              <SelectTrigger><SelectValue placeholder="Select account" /></SelectTrigger>
              <SelectContent>{clearing.map((a) => <SelectItem key={a.id} value={a.id}>{a.code} — {a.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div>
            <Label>Write-off account (expense)</Label>
            <Select value={value.writeoff_account_id ?? ""} onValueChange={(v) => onChange({ ...value, writeoff_account_id: v || null })}>
              <SelectTrigger><SelectValue placeholder="Select account (falls back to default mapping)" /></SelectTrigger>
              <SelectContent>{expense.map((a) => <SelectItem key={a.id} value={a.id}>{a.code} — {a.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div>
            <Label>Salary rule code (optional)</Label>
            <Input value={value.salary_rule_code ?? ""} onChange={(e) => onChange({ ...value, salary_rule_code: e.target.value || null })} placeholder="loan_repayment_emergency" />
            <p className="text-[11px] text-muted-foreground mt-1">Payslip deduction line key. Must be snake_case.</p>
          </div>
        </CardContent>
      </Card>

      {/* Dynamic fields */}
      <Card>
        <CardHeader className="pb-2 flex flex-row items-center justify-between">
          <CardTitle className="text-sm">Dynamic fields shown on the loan wizard</CardTitle>
          <Button type="button" size="sm" variant="outline"
                  onClick={() => setFields([...(fields ?? []), { key: "", label: "", type: "text" }])}>
            <Plus className="mr-1 h-3 w-3" /> Add field
          </Button>
        </CardHeader>
        <CardContent className="space-y-2">
          {(fields ?? []).length === 0 && <p className="text-xs text-muted-foreground">No extra fields.</p>}
          {(fields ?? []).map((f, i) => (
            <div key={i} className="grid grid-cols-12 gap-2 items-end">
              <div className="col-span-3"><Label>Key</Label><Input value={f.key} onChange={(e) => { const next = [...fields]; next[i] = { ...f, key: e.target.value }; setFields(next); }} /></div>
              <div className="col-span-4"><Label>Label</Label><Input value={f.label} onChange={(e) => { const next = [...fields]; next[i] = { ...f, label: e.target.value }; setFields(next); }} /></div>
              <div className="col-span-2"><Label>Type</Label>
                <Select value={f.type} onValueChange={(v) => { const next = [...fields]; next[i] = { ...f, type: v as any }; setFields(next); }}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="text">Text</SelectItem>
                    <SelectItem value="number">Number</SelectItem>
                    <SelectItem value="date">Date</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="col-span-2 flex items-center gap-2">
                <Switch checked={f.required ?? false} onCheckedChange={(v) => { const next = [...fields]; next[i] = { ...f, required: v }; setFields(next); }} />
                <span className="text-xs">Required</span>
              </div>
              <div className="col-span-1">
                <Button size="icon" variant="ghost" onClick={() => setFields(fields.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="flex justify-end gap-2 pt-2">
        <Button variant="outline" onClick={onCancel}>Cancel</Button>
        <Button onClick={onSave}>Save</Button>
      </div>
    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <Switch checked={checked} onCheckedChange={onChange} /> {label}
    </label>
  );
}
