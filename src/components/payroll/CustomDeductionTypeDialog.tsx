/**
 * CustomDeductionTypeDialog
 * ─────────────────────────────────────────────────────────────────────────
 * Create / edit a tenant-owned custom deduction type
 * (`payroll_rule_types`).
 *
 * Stage B contract: tenant-authored types MUST declare one of two
 * engine-known computation methods (`flat_amount` | `percentage_of_gross`)
 * so any rule built against them is something compute-payroll can
 * actually run. Anything richer (brackets, graduated tables) belongs to
 * a localization pack or to salary structures.
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
import type { ParameterField, RuleType } from "@/hooks/usePayrollRuleTypes";

export const CUSTOM_TYPE_METHODS: Array<{
  value: "flat_amount" | "percentage_of_gross";
  label: string;
  description: string;
  schema: ParameterField[];
}> = [
  {
    value: "flat_amount",
    label: "Flat amount",
    description: "Fixed amount per period regardless of earnings (e.g. uniform deduction, gym fee).",
    schema: [
      { key: "amount", label: "Amount", type: "number" },
      { key: "currency", label: "Currency", type: "text", optional: true },
      { key: "notes", label: "Notes", type: "text", optional: true },
    ],
  },
  {
    value: "percentage_of_gross",
    label: "Percentage of pay",
    description: "Percentage of a base (gross/basic) deducted each period (e.g. SACCO contribution).",
    schema: [
      { key: "rate", label: "Rate (%)", type: "number" },
      { key: "base", label: "Base", type: "text", optional: true, placeholder: "gross_pay | basic_salary" },
      { key: "ceiling", label: "Cap on base", type: "number", optional: true },
      { key: "notes", label: "Notes", type: "text", optional: true },
    ],
  },
];

export function methodForSchema(schema: ParameterField[]): "flat_amount" | "percentage_of_gross" {
  const keys = new Set(schema.map((f) => f.key));
  if (keys.has("rate")) return "percentage_of_gross";
  return "flat_amount";
}

export function CustomDeductionTypeDialog({
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
  const [method, setMethod] = useState<"flat_amount" | "percentage_of_gross">("flat_amount");

  const handleOpenChange = (v: boolean) => {
    if (v && editingType) {
      setCode(editingType.code);
      setLabel(editingType.label);
      setDescription(editingType.description ?? "");
      setSortOrder(editingType.sort_order);
      setMethod(methodForSchema(editingType.parameter_schema ?? []));
    } else if (v) {
      setCode("");
      setLabel("");
      setDescription("");
      setSortOrder(10);
      setMethod("flat_amount");
    }
    onOpenChange(v);
  };

  const selectedSpec = CUSTOM_TYPE_METHODS.find((m) => m.value === method)!;

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        organization_id: orgId,
        code: code.trim().toLowerCase().replace(/\s+/g, "_"),
        label: label.trim(),
        description: description.trim() || null,
        is_bracket: false,
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
      title={editingType ? "Edit custom deduction type" : "Create custom deduction type"}
      description="Custom non-statutory deductions (loans, advances, SACCO, gym fees…). Statutory rules (PAYE, social security, levies) are configured separately in the Statutory Rules workspace and use the engine-defined computation methods directly."
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
          <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Brief explanation of this deduction type" />
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
            {CUSTOM_TYPE_METHODS.map((m) => (
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
          These are the fields users will fill when creating a rule of this type. For richer
          shapes (brackets, tiered tables) use a localization pack or salary-structure rule instead.
        </p>
      </WorkflowSheetSection>
    </WorkflowSheet>
  );
}
