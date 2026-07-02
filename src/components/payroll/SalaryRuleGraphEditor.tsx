/**
 * Stage D — Salary rule graph editor.
 *
 * Dialog-based editor for `payroll_salary_rules` rows belonging to a single
 * salary structure. Pairs with `useSalaryRules` and the sandboxed
 * expression validator. Replaces the flat `salary_components` model when a
 * structure has `use_structure_engine=true`.
 */
import { useMemo, useState } from "react";
import { Plus, Edit2, Trash2, Loader2, Eye, EyeOff, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { WorkflowSheet, WorkflowSheetGrid, WorkflowSheetSection, WorkflowField } from "@/components/workflow/WorkflowSheet";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useSalaryRules, type SalaryRuleInput, type SalaryRule } from "@/hooks/payroll/useSalaryRules";
import { validateExpression } from "@/lib/payroll/expressionValidator";

const CATEGORIES = [
  { value: "basic", label: "Basic" },
  { value: "allowance", label: "Allowance" },
  { value: "deduction", label: "Deduction" },
  { value: "employer_contribution", label: "Employer contribution" },
  { value: "gross", label: "Gross (subtotal)" },
  { value: "net", label: "Net (subtotal)" },
  { value: "other", label: "Other" },
] as const;

const BASES = ["BASIC", "GROSS", "TAXABLE", "NET"] as const;

const EMPTY: SalaryRuleInput = {
  code: "",
  name: "",
  sequence: 100,
  category: "allowance",
  parent_rule_id: null,
  condition_select: "always",
  condition_expression: null,
  amount_select: "fixed",
  amount_fixed: 0,
  amount_percentage: null,
  amount_base: null,
  amount_expression: null,
  statutory_rule_id: null,
  appears_on_payslip: true,
  accounting_debit_account_id: null,
  accounting_credit_account_id: null,
  accounting_tag: null,
  is_active: true,
};

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  structureId: string;
  structureName: string;
}

export function SalaryRuleGraphEditor({ open, onOpenChange, structureId, structureName }: Props) {
  const { rules, isLoading, upsert, remove } = useSalaryRules(structureId);
  const [editing, setEditing] = useState<SalaryRule | null>(null);
  const [form, setForm] = useState<SalaryRuleInput>(EMPTY);
  const [editorOpen, setEditorOpen] = useState(false);

  const condErr = form.condition_select === "expression" && form.condition_expression
    ? validateExpression(form.condition_expression)
    : { ok: true as const };
  const amtErr = form.amount_select === "expression" && form.amount_expression
    ? validateExpression(form.amount_expression)
    : { ok: true as const };

  const validationErrors = useMemo(() => {
    const e: string[] = [];
    if (!form.code.trim()) e.push("Code is required.");
    if (!/^[A-Z][A-Z0-9_]*$/.test(form.code.trim())) e.push("Code must be uppercase letters/digits/underscore.");
    if (!form.name.trim()) e.push("Name is required.");
    if (form.amount_select === "percentage" && !form.amount_base) e.push("Percentage rules need a base.");
    if (condErr.ok === false) e.push(`Condition expression: ${condErr.message}`);
    if (amtErr.ok === false) e.push(`Amount expression: ${amtErr.message}`);
    return e;
  }, [form, condErr, amtErr]);

  function openCreate() {
    setEditing(null);
    setForm({ ...EMPTY, sequence: (rules[rules.length - 1]?.sequence ?? 0) + 10 });
    setEditorOpen(true);
  }
  function openEdit(r: SalaryRule) {
    setEditing(r);
    setForm({ ...r });
    setEditorOpen(true);
  }
  function handleSave() {
    upsert.mutate(editing ? { ...form, id: editing.id } : form, {
      onSuccess: () => setEditorOpen(false),
    });
  }

  return (
    <WorkflowSheet
      open={open}
      onOpenChange={onOpenChange}
      title={`Rule graph — ${structureName}`}
      description="Odoo-style ordered rule graph. The structure engine walks rules by sequence, evaluates conditions, and computes amounts via fixed values, percentages, sandboxed expressions, or statutory references."
      size="2xl"
    >
      <WorkflowSheetSection
        number={1}
        title="Rules"
        subtitle={`${rules.length} rule${rules.length === 1 ? "" : "s"} · Engine: structure`}
        fullWidth
        right={
          <Button size="sm" onClick={openCreate}>
            <Plus className="h-4 w-4 mr-1" /> New rule
          </Button>
        }
      >

        {isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground p-8 justify-center">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading rules…
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-16">Seq</TableHead>
                <TableHead>Code</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Condition</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead className="w-12">Visible</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rules.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                    No rules yet. Create one to start the rule graph.
                  </TableCell>
                </TableRow>
              )}
              {rules.map((r) => (
                <TableRow key={r.id} className={!r.is_active ? "opacity-50" : ""}>
                  <TableCell className="tabular-nums text-xs">{r.sequence}</TableCell>
                  <TableCell className="font-mono text-xs">{r.code}</TableCell>
                  <TableCell>
                    {r.parent_rule_id && <span className="text-muted-foreground">↳ </span>}
                    {r.name}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-xs">{r.category}</Badge>
                  </TableCell>
                  <TableCell className="text-xs">
                    {r.condition_select === "always" ? "always" : <code>{r.condition_expression}</code>}
                  </TableCell>
                  <TableCell className="text-xs">
                    {r.amount_select === "fixed" && <>{r.amount_fixed}</>}
                    {r.amount_select === "percentage" && <>{r.amount_percentage}% of {r.amount_base}</>}
                    {r.amount_select === "expression" && <code>{r.amount_expression}</code>}
                    {r.amount_select === "statutory_ref" && <span className="italic">statutory</span>}
                  </TableCell>
                  <TableCell>
                    {r.appears_on_payslip
                      ? <Eye className="h-4 w-4 text-muted-foreground" />
                      : <EyeOff className="h-4 w-4 text-muted-foreground" />}
                  </TableCell>
                  <TableCell className="text-right space-x-1">
                    <Button size="icon" variant="ghost" onClick={() => openEdit(r)}>
                      <Edit2 className="h-4 w-4" />
                    </Button>
                    <Button size="icon" variant="ghost" onClick={() => remove.mutate(r.id)}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

      </WorkflowSheetSection>

      <WorkflowSheet
        open={editorOpen}
        onOpenChange={setEditorOpen}
        title={editing ? "Edit rule" : "New rule"}
        description={<>Sandboxed expressions: scalars (BASIC, GROSS, TAXABLE, NET), <code>employee.*</code>, <code>contract.*</code>, <code>worked_hours['CODE']</code>, <code>result['rule_code']</code>, helpers <code>min/max/round/if</code>.</>}
        size="xl"
        footer={
          <>
            <Button variant="outline" onClick={() => setEditorOpen(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={upsert.isPending || validationErrors.length > 0}>
              {upsert.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {editing ? "Save changes" : "Create rule"}
            </Button>
          </>
        }
      >
        <WorkflowSheetGrid>
          <WorkflowSheetSection number={1} title="Identity">
            <WorkflowField label="Code" required>
              <Input
                value={form.code}
                onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))}
                placeholder="HRA"
                disabled={!!editing}
              />
            </WorkflowField>
            <WorkflowField label="Name" required>
              <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
            </WorkflowField>
            <div className="grid grid-cols-2 gap-3">
              <WorkflowField label="Sequence">
                <Input
                  type="number"
                  value={form.sequence}
                  onChange={(e) => setForm((f) => ({ ...f, sequence: Number(e.target.value) || 0 }))}
                />
              </WorkflowField>
              <WorkflowField label="Category">
                <Select value={form.category} onValueChange={(v) => setForm((f) => ({ ...f, category: v as any }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CATEGORIES.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </WorkflowField>
            </div>
          </WorkflowSheetSection>

          <WorkflowSheetSection number={2} title="Accounting & parent">
            <WorkflowField label="Accounting tag">
              <Input
                value={form.accounting_tag ?? ""}
                onChange={(e) => setForm((f) => ({ ...f, accounting_tag: e.target.value || null }))}
                placeholder="e.g. PAYE_PAYABLE"
              />
            </WorkflowField>
            <WorkflowField label="Parent rule (optional)">
              <Select
                value={form.parent_rule_id ?? "_none"}
                onValueChange={(v) => setForm((f) => ({ ...f, parent_rule_id: v === "_none" ? null : v }))}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="_none">— none —</SelectItem>
                  {rules.filter((r) => !editing || r.id !== editing.id).map((r) => (
                    <SelectItem key={r.id} value={r.id}>{r.code} — {r.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </WorkflowField>
            <div className="grid grid-cols-2 gap-3 pt-2 border-t">
              <label className="flex items-center gap-2 text-sm">
                <Switch
                  checked={form.appears_on_payslip}
                  onCheckedChange={(v) => setForm((f) => ({ ...f, appears_on_payslip: v }))}
                />
                Appears on payslip
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Switch
                  checked={form.is_active}
                  onCheckedChange={(v) => setForm((f) => ({ ...f, is_active: v }))}
                />
                Active
              </label>
            </div>
          </WorkflowSheetSection>
        </WorkflowSheetGrid>

        <WorkflowSheetSection number={3} title="Condition" fullWidth>
          <Select value={form.condition_select} onValueChange={(v) => setForm((f) => ({ ...f, condition_select: v as any }))}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="always">Always apply</SelectItem>
              <SelectItem value="expression">Expression</SelectItem>
            </SelectContent>
          </Select>
          {form.condition_select === "expression" && (
            <>
              <Textarea
                rows={2}
                placeholder="e.g. employee.dependants > 0"
                value={form.condition_expression ?? ""}
                onChange={(e) => setForm((f) => ({ ...f, condition_expression: e.target.value }))}
                className="font-mono text-xs"
              />
              {condErr.ok === false && (
                <p className="text-xs text-destructive flex items-center gap-1">
                  <AlertCircle className="h-3 w-3" /> {condErr.message} (offset {condErr.offset})
                </p>
              )}
            </>
          )}
        </WorkflowSheetSection>

        <WorkflowSheetSection number={4} title="Amount" fullWidth>
          <Select value={form.amount_select} onValueChange={(v) => setForm((f) => ({ ...f, amount_select: v as any }))}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="fixed">Fixed amount</SelectItem>
              <SelectItem value="percentage">Percentage of base</SelectItem>
              <SelectItem value="expression">Expression</SelectItem>
              <SelectItem value="statutory_ref">Statutory reference</SelectItem>
            </SelectContent>
          </Select>
          {form.amount_select === "fixed" && (
            <Input
              type="number"
              step="0.01"
              value={form.amount_fixed ?? 0}
              onChange={(e) => setForm((f) => ({ ...f, amount_fixed: Number(e.target.value) || 0 }))}
            />
          )}
          {form.amount_select === "percentage" && (
            <div className="grid grid-cols-2 gap-2">
              <Input
                type="number"
                step="0.01"
                placeholder="%"
                value={form.amount_percentage ?? 0}
                onChange={(e) => setForm((f) => ({ ...f, amount_percentage: Number(e.target.value) || 0 }))}
              />
              <Select
                value={form.amount_base ?? ""}
                onValueChange={(v) => setForm((f) => ({ ...f, amount_base: v }))}
              >
                <SelectTrigger><SelectValue placeholder="Base" /></SelectTrigger>
                <SelectContent>
                  {BASES.map((b) => <SelectItem key={b} value={b}>{b}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}
          {form.amount_select === "expression" && (
            <>
              <Textarea
                rows={3}
                placeholder="e.g. min(BASIC * 0.05, 1500)"
                value={form.amount_expression ?? ""}
                onChange={(e) => setForm((f) => ({ ...f, amount_expression: e.target.value }))}
                className="font-mono text-xs"
              />
              {amtErr.ok === false && (
                <p className="text-xs text-destructive flex items-center gap-1">
                  <AlertCircle className="h-3 w-3" /> {amtErr.message} (offset {amtErr.offset})
                </p>
              )}
            </>
          )}
          {form.amount_select === "statutory_ref" && (
            <Input
              placeholder="payroll_statutory_rules.id"
              value={form.statutory_rule_id ?? ""}
              onChange={(e) => setForm((f) => ({ ...f, statutory_rule_id: e.target.value || null }))}
            />
          )}
        </WorkflowSheetSection>

        {validationErrors.length > 0 && (
          <Alert variant="destructive">
            <AlertDescription>
              <ul className="list-disc pl-4 text-xs space-y-1">
                {validationErrors.map((e, i) => <li key={i}>{e}</li>)}
              </ul>
            </AlertDescription>
          </Alert>
        )}
      </WorkflowSheet>
    </WorkflowSheet>
  );
}
