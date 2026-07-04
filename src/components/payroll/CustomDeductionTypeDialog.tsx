/**
 * RuleTypeDefinitionDialog (formerly CustomDeductionTypeDialog)
 * ─────────────────────────────────────────────────────────────────────────
 * Create / edit a tenant-owned rule type definition
 * (`payroll_rule_types`). Persists `label`, `parameter_schema`, and — as
 * of Slice 1 of the audit cleanup — `computation_method` directly on the
 * row (previously round-tripped by sniffing parameter keys, which was
 * fragile). Bracket-shaped types can now be authored here too; the old
 * dialog silently hard-coded `is_bracket=false`, hiding half the table's
 * capability from the workspace that claimed to expose it.
 *
 * The dialog does NOT create employee deductions. It only defines the
 * shape a Statutory Rules author picks in the rule editor.
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { WorkflowSheet, WorkflowSheetGrid, WorkflowSheetSection, WorkflowField } from "@/components/workflow/WorkflowSheet";
import { Calculator, Loader2 } from "lucide-react";
import { normalizeError } from "@/services/resilience";
import type { ParameterField, RuleType, RuleTypeComputationMethod } from "@/hooks/usePayrollRuleTypes";

interface MethodSpec {
  value: RuleTypeComputationMethod;
  label: string;
  description: string;
  is_bracket: boolean;
  schema: ParameterField[];
}

/**
 * Preset schemas per method. The engine (`compute-payroll`) only reads
 * `payroll_statutory_rules.parameters` + `computation_method`; the schema
 * here drives *form rendering* in the Statutory Rules editor. Keep the
 * keys aligned with the parameter names the engine expects for that
 * method so a rule authored via the picker Just Works.
 */
export const RULE_TYPE_METHODS: MethodSpec[] = [
  {
    value: "flat_amount",
    label: "Flat amount",
    description: "Fixed amount per period regardless of earnings (e.g. personal relief, uniform deduction).",
    is_bracket: false,
    schema: [
      { key: "amount", label: "Amount", type: "number" },
      { key: "currency", label: "Currency", type: "text", optional: true },
      { key: "notes", label: "Notes", type: "text", optional: true },
    ],
  },
  {
    value: "percentage_of_gross",
    label: "Percentage of pay",
    description: "Percentage of a base (gross/basic) applied each period (e.g. housing levy, SACCO contribution).",
    is_bracket: false,
    schema: [
      { key: "rate", label: "Rate (decimal)", type: "number", placeholder: "e.g. 0.015" },
      { key: "base", label: "Base", type: "text", optional: true, placeholder: "gross_pay | basic_salary" },
      { key: "ceiling", label: "Cap on base", type: "number", optional: true },
      { key: "notes", label: "Notes", type: "text", optional: true },
    ],
  },
  {
    value: "bracket_progressive",
    label: "Progressive bracket",
    description: "Multiple sorted brackets with lower/upper limits and per-bracket rate (e.g. PAYE income tax).",
    is_bracket: true,
    schema: [
      { key: "lower", label: "Lower limit", type: "number", placeholder: "e.g. 0" },
      { key: "upper", label: "Upper limit (blank = no limit)", type: "number", optional: true },
      { key: "rate", label: "Rate (decimal)", type: "number", placeholder: "e.g. 0.10", step: "0.001" },
    ],
  },
  {
    value: "tiered_brackets",
    label: "Tiered brackets (flat per tier)",
    description: "Sorted tiers each contributing a fixed amount (e.g. SHIF/NHIF bracket table).",
    is_bracket: true,
    schema: [
      { key: "lower", label: "Lower limit (gross)", type: "number" },
      { key: "upper", label: "Upper limit (gross)", type: "number" },
      { key: "amount", label: "Contribution amount", type: "number" },
    ],
  },
  {
    value: "per_employee_flat",
    label: "Per-employee flat",
    description: "Fixed amount per active employee (e.g. training levy).",
    is_bracket: false,
    schema: [
      { key: "amount", label: "Amount", type: "number" },
      { key: "notes", label: "Notes", type: "text", optional: true },
    ],
  },
];

/**
 * Backwards-compatible re-export. External test / storybook code may
 * still import CUSTOM_TYPE_METHODS; keep the alias.
 */
export const CUSTOM_TYPE_METHODS = RULE_TYPE_METHODS;

export function RuleTypeDefinitionDialog({
  open,
  onOpenChange,
  editingType,
  orgId,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  editingType: RuleType | null;
  orgId: string;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [code, setCode] = useState("");
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [sortOrder, setSortOrder] = useState(10);
  const [method, setMethod] = useState<RuleTypeComputationMethod>("flat_amount");

  const handleOpenChange = (v: boolean) => {
    if (v && editingType) {
      setCode(editingType.code);
      setLabel(editingType.label);
      setDescription(editingType.description ?? "");
      setSortOrder(editingType.sort_order);
      setMethod(editingType.computation_method ?? "flat_amount");
    } else if (v) {
      setCode("");
      setLabel("");
      setDescription("");
      setSortOrder(10);
      setMethod("flat_amount");
    }
    onOpenChange(v);
  };

  const selectedSpec =
    RULE_TYPE_METHODS.find((m) => m.value === method) ?? RULE_TYPE_METHODS[0];

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        organization_id: orgId,
        code: code.trim().toLowerCase().replace(/\s+/g, "_"),
        label: label.trim(),
        description: description.trim() || null,
        is_bracket: selectedSpec.is_bracket,
        computation_method: selectedSpec.value,
        sort_order: sortOrder,
        parameter_schema: selectedSpec.schema,
        is_active: true,
        is_system: false,
      };
      if (editingType) {
        const { error } = await supabase
          .from("payroll_rule_types" as any)
          .update({ ...payload, is_system: editingType.is_system })
          .eq("id", editingType.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("payroll_rule_types" as any)
          .insert(payload);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["payroll-rule-types"] });
      toast({ title: editingType ? "Rule type updated" : "Rule type created" });
      onOpenChange(false);
    },
    onError: (err: any) => {
      toast({ title: "Error", description: normalizeError(err).message, variant: "destructive" });
    },
  });

  return (
    <WorkflowSheet
      open={open}
      onOpenChange={handleOpenChange}
      title={editingType ? "Edit rule type definition" : "Create rule type definition"}
      description="Defines the label + parameter shape + computation method that the Statutory Rules editor exposes in its type picker. Does NOT create an employee deduction — for that use Loans, Advances, Garnishments, or Salary Structures."
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending || !code.trim() || !label.trim()}>
            {saveMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {editingType ? "Update" : "Create"}
          </Button>
        </>
      }
    >
      <WorkflowSheetSection number={1} title="Identity" fullWidth>
        <WorkflowSheetGrid>
          <WorkflowField label="Code (machine name)" hint="Lowercase, underscores. Cannot be changed for system types.">
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="e.g. sacco_contribution"
              disabled={!!editingType?.is_system}
            />
          </WorkflowField>
          <WorkflowField label="Display label">
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. SACCO Contribution" />
          </WorkflowField>
        </WorkflowSheetGrid>
        <WorkflowField label="Description">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Brief explanation of this rule type" />
        </WorkflowField>
        <WorkflowField label="Sort order">
          <Input type="number" min={0} value={sortOrder} onChange={(e) => setSortOrder(Number(e.target.value))} className="max-w-[140px]" />
        </WorkflowField>
      </WorkflowSheetSection>

      <WorkflowSheetSection
        number={2}
        title={<span className="flex items-center gap-1"><Calculator className="h-4 w-4" /> Computation method</span>}
        fullWidth
      >
        <Select value={method} onValueChange={(v: any) => setMethod(v)}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {RULE_TYPE_METHODS.map((m) => (
              <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{selectedSpec.description}</p>
        <div className="text-xs font-medium pt-2">Rule input fields</div>
        <div className="flex flex-wrap gap-1">
          {selectedSpec.schema.map((f) => (
            <span key={f.key} className="text-xs border rounded px-1.5 py-0.5">
              <code className="text-[11px]">{f.key}</code>
              <span className="text-muted-foreground ml-1">{f.type}{f.optional ? " · optional" : ""}</span>
            </span>
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground pt-1">
          These are the fields users will fill when creating a statutory rule of this type. The
          engine (<code>compute-payroll</code>) reads the resulting parameters plus this
          computation method directly.
        </p>
      </WorkflowSheetSection>
    </WorkflowSheet>
  );
}

/**
 * Back-compat alias: old imports use `CustomDeductionTypeDialog`. Keep
 * the export so file-rename churn doesn't cascade.
 */
export const CustomDeductionTypeDialog = RuleTypeDefinitionDialog;
