/**
 * CustomDeductionDialog — catalog authoring surface for a single
 * `custom_deduction_types` row.
 *
 * Every field on this form maps 1:1 to a database column that a
 * downstream consumer (compute-payroll, post-payroll-gl, readiness,
 * payslip renderer) reads. No cosmetic fields.
 */
import { useEffect, useState } from "react";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { AccountCombobox } from "@/components/finance/AccountCombobox";
import { useAccounts } from "@/hooks/useAccounts";
import {
  useCustomDeductionTypeMutations,
  type CustomDeductionType,
  type CustomDeductionTypeInput,
  type CustomDeductionKind,
  type CustomDeductionTaxTreatment,
  type CustomDeductionComputationMethod,
} from "@/hooks/payroll/useCustomDeductionTypes";

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  editing?: CustomDeductionType | null;
}

const KINDS: { value: CustomDeductionKind; label: string; hint: string }[] = [
  { value: "recurring",   label: "Recurring",   hint: "Applied every payroll run in the effective window (e.g. gym membership)." },
  { value: "one_time",    label: "One-time",    hint: "Applied in a single run then auto-completes." },
  { value: "voluntary",   label: "Voluntary",   hint: "Employee-authorised (SACCO, charity). Respects min-net floor." },
  { value: "involuntary", label: "Involuntary", hint: "Employer-driven (uniform, damages). Bypasses min-net floor consent but NOT court-ordered — use Garnishments for that." },
];

const METHODS: { value: CustomDeductionComputationMethod; label: string }[] = [
  { value: "flat_amount",          label: "Flat amount" },
  { value: "percentage_of_gross",  label: "% of gross" },
  { value: "percentage_of_basic",  label: "% of basic" },
  { value: "formula",              label: "Formula (advanced — deferred)" },
];

export function CustomDeductionDialog({ open, onOpenChange, editing }: Props) {
  const { create, update } = useCustomDeductionTypeMutations();
  const { accounts = [] } = useAccounts();

  const [form, setForm] = useState<CustomDeductionTypeInput>({
    code: "",
    label: "",
    description: "",
    deduction_kind: "recurring",
    tax_treatment: "post_tax",
    is_taxable: false,
    is_employer_contribution: false,
    computation_method: "flat_amount",
    parameters: { amount: 0 },
    gl_liability_account_id: null,
    gl_expense_account_id: null,
    payslip_group: "other_deductions",
    sort_order: 100,
    requires_approval: false,
    is_active: true,
    payroll_rule_code: null,
  });

  useEffect(() => {
    if (editing) {
      setForm({
        code: editing.code,
        label: editing.label,
        description: editing.description ?? "",
        deduction_kind: editing.deduction_kind,
        tax_treatment: editing.tax_treatment,
        is_taxable: editing.is_taxable,
        is_employer_contribution: editing.is_employer_contribution,
        computation_method: editing.computation_method,
        parameters: (editing.parameters as Record<string, unknown>) ?? {},
        gl_liability_account_id: editing.gl_liability_account_id,
        gl_expense_account_id: editing.gl_expense_account_id,
        payslip_group: editing.payslip_group,
        sort_order: editing.sort_order,
        requires_approval: editing.requires_approval,
        is_active: editing.is_active,
        payroll_rule_code: editing.payroll_rule_code ?? null,
      });
    }
  }, [editing]);

  const liabilityAccounts = accounts.filter((a) => a.account_type === "liability" && a.is_active);
  const expenseAccounts = accounts.filter((a) => a.account_type === "expense" && a.is_active);

  const setParam = (k: string, v: unknown) =>
    setForm((f) => ({ ...f, parameters: { ...f.parameters, [k]: v } }));

  const submit = async () => {
    if (!form.code.trim() || !form.label.trim()) return;
    if (editing) {
      await update.mutateAsync({ id: editing.id, patch: form });
    } else {
      await create.mutateAsync(form);
    }
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit custom deduction type" : "New custom deduction type"}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Code</Label>
              <Input
                value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value.toLowerCase().replace(/\s+/g, "_") })}
                placeholder="gym_membership"
                disabled={!!editing}
              />
              <p className="text-xs text-muted-foreground mt-1">
                Reserved: paye, shif, nssf, loan, advance, garnishment.
              </p>
            </div>
            <div>
              <Label>Label</Label>
              <Input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Gym membership" />
            </div>
          </div>

          <div>
            <Label>Description</Label>
            <Textarea
              value={form.description ?? ""}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              rows={2}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Kind</Label>
              <Select
                value={form.deduction_kind}
                onValueChange={(v) => setForm({ ...form, deduction_kind: v as CustomDeductionKind })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {KINDS.map((k) => <SelectItem key={k.value} value={k.value}>{k.label}</SelectItem>)}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground mt-1">
                {KINDS.find((k) => k.value === form.deduction_kind)?.hint}
              </p>
            </div>
            <div>
              <Label>Tax treatment</Label>
              <Select
                value={form.tax_treatment}
                onValueChange={(v) => setForm({ ...form, tax_treatment: v as CustomDeductionTaxTreatment })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="post_tax">Post-tax (after PAYE)</SelectItem>
                  <SelectItem value="pre_tax">Pre-tax (reduces PAYE base) — engine support pending</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Computation method</Label>
              <Select
                value={form.computation_method}
                onValueChange={(v) => setForm({ ...form, computation_method: v as CustomDeductionComputationMethod })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {METHODS.map((m) => <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              {form.computation_method === "flat_amount" && (
                <>
                  <Label>Default amount</Label>
                  <Input
                    type="number" step="0.01"
                    value={String((form.parameters as any).amount ?? 0)}
                    onChange={(e) => setParam("amount", Number(e.target.value))}
                  />
                </>
              )}
              {form.computation_method.startsWith("percentage_") && (
                <>
                  <Label>Rate (0-1, e.g. 0.05 = 5%)</Label>
                  <Input
                    type="number" step="0.0001"
                    value={String((form.parameters as any).rate ?? 0)}
                    onChange={(e) => setParam("rate", Number(e.target.value))}
                  />
                </>
              )}
              {form.computation_method === "formula" && (
                <>
                  <Label>Formula (deferred)</Label>
                  <Input value="Not yet supported by the engine" disabled />
                </>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 border-t pt-3">
            <div>
              <Label>GL liability account *</Label>
              <AccountCombobox
                accounts={liabilityAccounts}
                value={form.gl_liability_account_id ?? ""}
                onValueChange={(v) => setForm({ ...form, gl_liability_account_id: v || null })}
                placeholder="Select liability account"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Required before payroll posting. Amount owed until remitted.
              </p>
            </div>
            <div>
              <Label>GL expense account {form.is_employer_contribution ? "*" : "(employer only)"}</Label>
              <AccountCombobox
                accounts={expenseAccounts}
                value={form.gl_expense_account_id ?? ""}
                onValueChange={(v) => setForm({ ...form, gl_expense_account_id: v || null })}
                placeholder={form.is_employer_contribution ? "Required" : "Not required for employee deductions"}
              />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3 border-t pt-3">
            <div className="flex items-center justify-between rounded-md border p-2">
              <div>
                <Label>Taxable</Label>
                <p className="text-xs text-muted-foreground">Reported to tax authority</p>
              </div>
              <Switch checked={form.is_taxable} onCheckedChange={(v) => setForm({ ...form, is_taxable: v })} />
            </div>
            <div className="flex items-center justify-between rounded-md border p-2">
              <div>
                <Label>Employer</Label>
                <p className="text-xs text-muted-foreground">Contribution, not deduction</p>
              </div>
              <Switch checked={form.is_employer_contribution} onCheckedChange={(v) => setForm({ ...form, is_employer_contribution: v })} />
            </div>
            <div className="flex items-center justify-between rounded-md border p-2">
              <div>
                <Label>Requires approval</Label>
                <p className="text-xs text-muted-foreground">Assignment starts pending</p>
              </div>
              <Switch checked={form.requires_approval} onCheckedChange={(v) => setForm({ ...form, requires_approval: v })} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Payslip group</Label>
              <Input
                value={form.payslip_group}
                onChange={(e) => setForm({ ...form, payslip_group: e.target.value })}
              />
            </div>
            <div>
              <Label>Sort order</Label>
              <Input
                type="number"
                value={form.sort_order}
                onChange={(e) => setForm({ ...form, sort_order: Number(e.target.value) })}
              />
            </div>
          </div>

          <div className="border-t pt-3 space-y-3">
            <div>
              <Label>Statutory scheme binding</Label>
              <Select
                value={form.scheme_component_id ?? NONE}
                onValueChange={(v) => {
                  if (v === NONE) {
                    setForm({ ...form, scheme_component_id: null, payroll_rule_code: null });
                    return;
                  }
                  const comp = components.find((c) => c.id === v);
                  setForm({
                    ...form,
                    scheme_component_id: v,
                    payroll_rule_code: comp?.rule_code ?? form.payroll_rule_code,
                  });
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="None — ordinary employer-defined deduction" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>None — ordinary employer-defined deduction</SelectItem>
                  {components.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.display_name} · {c.rule_code}
                      {c.authority_name ? ` · ${c.authority_name}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground mt-1">
                {components.length === 0
                  ? "No localization pack scheme components are installed for this business. Leave unbound."
                  : "Bind this deduction to a component published by your localization pack (e.g. Kenya HELB, NSSF Type-105) so its payslip lines are emitted under the pack's rule code, remitted to the scheme's authority, and picked up by that scheme's statutory return. Leave as None for gym, SACCO, parking and similar deductions."}
              </p>
            </div>

            <div>
              <Label>Pack rule code (advanced)</Label>
              <Input
                value={form.payroll_rule_code ?? ""}
                disabled={!!form.scheme_component_id}
                onChange={(e) => {
                  const v = e.target.value.toLowerCase().replace(/\s+/g, "_").trim();
                  setForm({ ...form, payroll_rule_code: v === "" ? null : v });
                }}
                placeholder="e.g. nssf_voluntary — leave blank unless bound to a pack return column"
              />
              <p className="text-xs text-muted-foreground mt-1">
                {form.scheme_component_id
                  ? "Set automatically from the selected scheme component."
                  : "Optional escape hatch for packs whose scheme components are not yet published. Must be lowercase snake_case and must not start with "}
                {!form.scheme_component_id && <code>custom_</code>}
              </p>
            </div>
          </div>

        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={create.isPending || update.isPending}>
            {editing ? "Save changes" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
