/**
 * Loan Types Settings — admin CRUD for `public.loan_types`.
 *
 * Mounted at `/hr/payroll/configuration/loan-types`. Each loan type defines:
 *   - kind, defaults (repayment method / installments / floor / cap)
 *   - GL accounts that drive `post-loan-disbursement` and `post-loan-settlement`
 *   - dynamic fields shown on the LoanWizard's "Type details" step
 *
 * Country-agnostic by design: no statutory tokens are referenced here.
 */
import { useMemo, useState } from "react";
import { useLoanTypes, type LoanType, type LoanTypeFieldSpec, type RepaymentMethod, type LoanKind } from "@/hooks/useLoanTypes";
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
import { Plus, Trash2, Sparkles } from "lucide-react";

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

export default function LoanTypesSettings() {
  const { loanTypes, isLoading, upsertLoanType, removeLoanType, seedDefaultLoanTypes } = useLoanTypes();
  const [editing, setEditing] = useState<LoanType | null>(null);
  const [open, setOpen] = useState(false);

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
      default_repayment_method: "fixed_installment",
      default_installments: 12,
      default_max_pct_of_net: 33,
      default_min_net_pay_floor: null,
      min_installments: null,
      max_installments: null,
      min_principal: null,
      max_principal: null,
      gl_receivable_account_id: null,
      gl_disbursement_clearing_account_id: null,
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
            Define how each kind of loan or advance is configured, deducted, and posted to the GL.
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
            <SheetContent className="w-full sm:max-w-2xl overflow-y-auto">
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

      <div className="grid gap-3">
        {isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}
        {!isLoading && loanTypes.length === 0 && (
          <Card><CardContent className="p-6 text-sm text-muted-foreground">
            No loan types yet. Click <b>Seed defaults</b> to install the standard set, or <b>New type</b> to create one.
          </CardContent></Card>
        )}
        {loanTypes.map((lt) => (
          <Card key={lt.id} className="cursor-pointer hover:bg-muted/30"
                onClick={() => { setEditing(lt); setOpen(true); }}>
            <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0 pb-2">
              <div>
                <CardTitle className="text-base">
                  {lt.name} <span className="text-muted-foreground font-normal">— {lt.code}</span>
                </CardTitle>
                <p className="text-xs text-muted-foreground mt-1">{lt.description || "—"}</p>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={lt.is_active ? "default" : "secondary"}>{lt.is_active ? "Active" : "Inactive"}</Badge>
                <Button size="icon" variant="ghost" onClick={(e) => { e.stopPropagation(); removeLoanType(lt.id); }}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
              <span>Kind: <b className="text-foreground">{lt.kind}</b></span>
              <span>Method: <b className="text-foreground">{lt.default_repayment_method}</b></span>
              {lt.default_installments != null && <span>Installments: <b className="text-foreground">{lt.default_installments}</b></span>}
              {lt.default_max_pct_of_net != null && <span>Cap: <b className="text-foreground">{lt.default_max_pct_of_net}% of net</b></span>}
              <span>GL: <b className="text-foreground">{lt.gl_receivable_account_id ? "configured" : "missing"}</b></span>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
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
  const assets = useMemo(() => accounts.filter((a) => a.account_type === "asset" && !a.parent_id), [accounts]);
  const clearing = useMemo(() => accounts.filter((a) => a.account_type === "liability" || a.account_type === "asset"), [accounts]);

  const fields = value.dynamic_field_schema?.fields ?? [];
  const setFields = (next: LoanTypeFieldSpec[]) =>
    onChange({ ...value, dynamic_field_schema: { ...(value.dynamic_field_schema ?? {}), fields: next } });

  return (
    <div className="space-y-5 py-4">
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

      <div className="grid grid-cols-3 gap-3">
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
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Policy bounds (employee request limits)</CardTitle>
          <p className="text-[11px] text-muted-foreground">
            Leave blank for no limit. HR can still override on approval.
          </p>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3">
          <div>
            <Label>Min installments</Label>
            <NumericInput min={1} allowDecimals={false}
              value={typeof value.min_installments === "number" ? value.min_installments : null}
              onValueChange={(n) => onChange({ ...value, min_installments: n })} />
          </div>
          <div>
            <Label>Max installments</Label>
            <NumericInput min={1} allowDecimals={false}
              value={typeof value.max_installments === "number" ? value.max_installments : null}
              onValueChange={(n) => onChange({ ...value, max_installments: n })} />
          </div>
          <div>
            <Label>Min principal</Label>
            <NumericInput min={0}
              value={typeof value.min_principal === "number" ? value.min_principal : null}
              onValueChange={(n) => onChange({ ...value, min_principal: n })} />
          </div>
          <div>
            <Label>Max principal</Label>
            <NumericInput min={0}
              value={typeof value.max_principal === "number" ? value.max_principal : null}
              onValueChange={(n) => onChange({ ...value, max_principal: n })} />
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-wrap gap-x-6 gap-y-3">
        <Toggle label="Requires interest" checked={value.requires_interest} onChange={(v) => onChange({ ...value, requires_interest: v })} />
        <Toggle label="Requires schedule" checked={value.requires_schedule} onChange={(v) => onChange({ ...value, requires_schedule: v })} />
        <Toggle label="Requires approval" checked={value.requires_approval} onChange={(v) => onChange({ ...value, requires_approval: v })} />
        <Toggle label="Active" checked={value.is_active} onChange={(v) => onChange({ ...value, is_active: v })} />
      </div>

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
          <div className="col-span-2">
            <Label>Salary rule code (optional)</Label>
            <Input value={value.salary_rule_code ?? ""} onChange={(e) => onChange({ ...value, salary_rule_code: e.target.value || null })} placeholder="loan_repayment_emergency" />
            <p className="text-[11px] text-muted-foreground mt-1">If set, this string is used as the deduction line key on the payslip.</p>
          </div>
        </CardContent>
      </Card>

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
