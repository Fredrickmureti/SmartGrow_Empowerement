/**
 * EmployeeCompensationChangeDialog — atomic compensation change.
 *
 * Migrated to the WorkflowSheet design standard.
 */
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useCurrency } from "@/hooks/useCurrency";
import type { Employee } from "@/hooks/useEmployees";
import { normalizeError } from "@/services/resilience";
import { Banknote, Loader2 } from "lucide-react";
import {
  WorkflowSheet,
  WorkflowSheetGrid,
  WorkflowSheetSection,
  WorkflowField,
} from "@/components/workflow/WorkflowSheet";

const CHANGE_TYPES = [
  { v: "raise", l: "Raise" },
  { v: "promotion", l: "Promotion" },
  { v: "demotion", l: "Demotion" },
  { v: "adjustment", l: "Adjustment" },
  { v: "correction", l: "Correction" },
];

export function EmployeeCompensationChangeDialog({
  employee, open, onOpenChange, onSuccess,
}: {
  employee: Employee;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSuccess?: () => void;
}) {
  const { toast } = useToast();
  const { formatCurrency } = useCurrency();
  const current = Number(employee.basic_salary || 0);

  const [effectiveDate, setEffectiveDate] = useState(new Date().toISOString().slice(0, 10));
  const [newSalary, setNewSalary] = useState<string>(String(current));
  const [housing, setHousing] = useState<string>(String((employee as any).housing_allowance ?? 0));
  const [transport, setTransport] = useState<string>(String((employee as any).transport_allowance ?? 0));
  const [other, setOther] = useState<string>(String((employee as any).other_allowances ?? 0));
  const [changeType, setChangeType] = useState("raise");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const delta = Number(newSalary || 0) - current;

  const submit = async () => {
    setBusy(true);
    try {
      const { error } = await supabase.rpc("change_compensation" as any, {
        p_employee_id: employee.id,
        p_effective_date: effectiveDate,
        p_new_basic_salary: Number(newSalary || 0),
        p_allowances: {
          housing_allowance: Number(housing || 0),
          transport_allowance: Number(transport || 0),
          other_allowances: Number(other || 0),
        },
        p_change_type: changeType,
        p_reason: reason || null,
      });
      if (error) throw error;
      toast({ title: "Compensation updated" });
      onSuccess?.();
      onOpenChange(false);
    } catch (e: any) {
      toast({ title: "Update failed", description: normalizeError(e).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <WorkflowSheet
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={
        <span className="flex items-center gap-2">
          <Banknote className="h-4 w-4" />
          Compensation change — {employee.first_name} {employee.last_name}
        </span>
      }
      description="Appends a new row to compensation history and updates the current contract atomically."
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || !newSalary}>
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Record change
          </Button>
        </>
      }
    >
      <WorkflowSheetGrid>
        <WorkflowSheetSection
          number={1}
          title="Change metadata"
          subtitle="When the change applies and what kind of move it is."
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <WorkflowField label="Effective date" required>
              <Input type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} />
            </WorkflowField>
            <WorkflowField label="Change type" required>
              <Select value={changeType} onValueChange={setChangeType}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CHANGE_TYPES.map((c) => <SelectItem key={c.v} value={c.v}>{c.l}</SelectItem>)}
                </SelectContent>
              </Select>
            </WorkflowField>
          </div>
        </WorkflowSheetSection>

        <WorkflowSheetSection
          number={2}
          title="Basic salary"
          subtitle="Sets the new contractual base. The delta from the current value is highlighted."
        >
          <WorkflowField
            label="New basic salary"
            required
            hint={
              <>
                Current: {formatCurrency(current)}
                {delta !== 0 && (
                  <span className={delta > 0 ? "ml-2 text-emerald-600" : "ml-2 text-destructive"}>
                    {delta > 0 ? "+" : ""}{formatCurrency(delta)}
                  </span>
                )}
              </>
            }
          >
            <Input type="number" min="0" step="0.01" value={newSalary} onChange={(e) => setNewSalary(e.target.value)} />
          </WorkflowField>
        </WorkflowSheetSection>
      </WorkflowSheetGrid>

      <WorkflowSheetSection
        number={3}
        title="Allowances"
        subtitle="Recurring allowances paid alongside basic salary on every regular run."
      >
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <WorkflowField label="Housing">
            <Input type="number" min="0" step="0.01" value={housing} onChange={(e) => setHousing(e.target.value)} />
          </WorkflowField>
          <WorkflowField label="Transport">
            <Input type="number" min="0" step="0.01" value={transport} onChange={(e) => setTransport(e.target.value)} />
          </WorkflowField>
          <WorkflowField label="Other">
            <Input type="number" min="0" step="0.01" value={other} onChange={(e) => setOther(e.target.value)} />
          </WorkflowField>
        </div>
      </WorkflowSheetSection>

      <WorkflowSheetSection
        number={4}
        title="Reason"
        subtitle="Visible on the compensation history timeline."
      >
        <Textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={2}
          placeholder="Annual review, promotion, market adjustment…"
        />
      </WorkflowSheetSection>
    </WorkflowSheet>
  );
}
