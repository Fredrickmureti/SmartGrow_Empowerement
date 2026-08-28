// SCOPE-TRIGGER-EXEMPT: data-entry field that assigns a branch/company to a record; not the active-scope switcher
/**
 * EmployeeTransferDialog — atomic transfer across business / branch /
 * department / position / manager.
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
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranches } from "@/hooks/useBranches";
import { useDepartments } from "@/hooks/useDepartments";
import { useJobPositions } from "@/hooks/useJobPositions";
import { useEmployees, type Employee } from "@/hooks/useEmployees";
import { normalizeError } from "@/services/resilience";
import { ArrowRightLeft, Loader2 } from "lucide-react";
import {
  WorkflowSheet,
  WorkflowSheetGrid,
  WorkflowSheetSection,
  WorkflowField,
} from "@/components/workflow/WorkflowSheet";

const NONE = "__none__";

export function EmployeeTransferDialog({
  employee, open, onOpenChange, onSuccess,
}: {
  employee: Employee;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSuccess?: () => void;
}) {
  const { toast } = useToast();
  const { businesses } = useBusinesses();
  const { branches } = useBranches();
  const { activeDepartments } = useDepartments();
  const { activePositions } = useJobPositions();
  const { activeEmployees } = useEmployees();

  const [effectiveDate, setEffectiveDate] = useState(new Date().toISOString().slice(0, 10));
  const [businessId, setBusinessId] = useState<string>((employee as any).business_id ?? NONE);
  const [branchId, setBranchId] = useState<string>((employee as any).branch_id ?? NONE);
  const [departmentId, setDepartmentId] = useState<string>(employee.department_id ?? NONE);
  const [positionId, setPositionId] = useState<string>((employee as any).job_position_id ?? NONE);
  const [managerId, setManagerId] = useState<string>(employee.manager_id ?? NONE);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      const { error } = await supabase.rpc("transfer_employee" as any, {
        p_employee_id: employee.id,
        p_effective_date: effectiveDate,
        p_new_business_id: businessId === NONE ? null : businessId,
        p_new_branch_id: branchId === NONE ? null : branchId,
        p_new_department_id: departmentId === NONE ? null : departmentId,
        p_new_job_position_id: positionId === NONE ? null : positionId,
        p_new_manager_id: managerId === NONE ? null : managerId,
        p_reason: reason || null,
      });
      if (error) throw error;
      toast({ title: "Transfer recorded" });
      onSuccess?.();
      onOpenChange(false);
    } catch (e: any) {
      toast({ title: "Transfer failed", description: normalizeError(e).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const branchOptions = branches.filter(
    (b) => !businessId || businessId === NONE || (b as any).business_id === businessId,
  );
  const managerOptions = activeEmployees.filter((e) => e.id !== employee.id);

  return (
    <WorkflowSheet
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={
        <span className="flex items-center gap-2">
          <ArrowRightLeft className="h-4 w-4" />
          Transfer / Promote — {employee.first_name} {employee.last_name}
        </span>
      }
      description="Move the employee across business unit, branch, department, position, or manager. Writes an immutable history row."
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Record transfer
          </Button>
        </>
      }
    >
      <WorkflowSheetGrid>
        <WorkflowSheetSection
          number={1}
          title="Effective date"
          subtitle="When the new assignment takes effect on the org chart."
        >
          <WorkflowField label="Effective date" required>
            <Input type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} />
          </WorkflowField>
        </WorkflowSheetSection>

        <WorkflowSheetSection
          number={2}
          title="Reporting line"
          subtitle="New direct manager after the move."
        >
          <WorkflowField label="Manager">
            <Select value={managerId} onValueChange={setManagerId}>
              <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>—</SelectItem>
                {managerOptions.map((m) => (
                  <SelectItem key={m.id} value={m.id}>{m.first_name} {m.last_name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </WorkflowField>
        </WorkflowSheetSection>
      </WorkflowSheetGrid>

      <WorkflowSheetSection
        number={3}
        title="Org placement"
        subtitle="New business, branch, department and position. Branch list filters by the selected business."
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <WorkflowField label="Business">
            <Select value={businessId} onValueChange={(v) => { setBusinessId(v); setBranchId(NONE); }}>
              <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>—</SelectItem>
                {businesses.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </WorkflowField>
          <WorkflowField label="Branch">
            <Select value={branchId} onValueChange={setBranchId}>
              <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>—</SelectItem>
                {branchOptions.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </WorkflowField>
          <WorkflowField label="Department">
            <Select value={departmentId} onValueChange={setDepartmentId}>
              <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>—</SelectItem>
                {activeDepartments.map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </WorkflowField>
          <WorkflowField label="Position">
            <Select value={positionId} onValueChange={setPositionId}>
              <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>—</SelectItem>
                {activePositions.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </WorkflowField>
        </div>
      </WorkflowSheetSection>

      <WorkflowSheetSection
        number={4}
        title="Reason"
        subtitle="Surfaces on the employee history timeline and the audit log."
      >
        <Textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={2}
          placeholder="Promotion, lateral move, restructuring…"
        />
      </WorkflowSheetSection>
    </WorkflowSheet>
  );
}
