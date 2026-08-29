import { useState, useEffect } from "react";
import { useEmployeeContracts, ContractFormData } from "@/hooks/useEmployeeContracts";
import { usePermissions } from "@/hooks/usePermissions";
import { useCurrency } from "@/hooks/useCurrency";
import { useSalaryStructures } from "@/hooks/useSalaryStructures";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { WorkflowSheet, WorkflowSheetSection, WorkflowSheetGrid, WorkflowField } from "@/components/workflow/WorkflowSheet";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,

  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Loader2, Plus, FileText, Play, X, AlertCircle } from "lucide-react";
import { format } from "date-fns";

interface EmployeeContractsTabProps {
  employeeId: string;
  canEdit: boolean;
}

const STATUS_COLORS: Record<string, string> = {
  new: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  running: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  expired: "bg-muted text-muted-foreground",
  cancelled: "bg-destructive/10 text-destructive",
};

export function EmployeeContractsTab({ employeeId, canEdit }: EmployeeContractsTabProps) {
  const {
    contracts, isLoading, createContract, activateContract, cancelContract,
  } = useEmployeeContracts(employeeId);
  const { canManageTeam } = usePermissions();
  const { formatCurrency } = useCurrency();
  const { structures } = useSalaryStructures();
  const [showCreate, setShowCreate] = useState(false);
  const [formData, setFormData] = useState<ContractFormData>({
    employee_id: employeeId,
    name: "",
    start_date: format(new Date(), "yyyy-MM-dd"),
    wage: 0,
    housing_allowance: 0,
    transport_allowance: 0,
    working_schedule: "full_time",
    compensation_mode: "flat_wage",
    salary_structure_id: null,
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [cancelTargetId, setCancelTargetId] = useState<string | null>(null);
  const [isCancelling, setIsCancelling] = useState(false);
  const [employeeDates, setEmployeeDates] = useState<{ hire_date: string | null; termination_date: string | null }>({ hire_date: null, termination_date: null });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("v_employees_canonical")
        .select("hire_date, termination_date")
        .eq("id", employeeId)
        .maybeSingle();
      if (!cancelled && data) {
        setEmployeeDates({ hire_date: data.hire_date ?? null, termination_date: data.termination_date ?? null });
      }
    })();
    return () => { cancelled = true; };
  }, [employeeId]);

  const dateError = (() => {
    if (employeeDates.hire_date && formData.start_date < employeeDates.hire_date) {
      return `Start date cannot be before the employee's hire date (${employeeDates.hire_date}).`;
    }
    if (formData.end_date && formData.end_date < formData.start_date) {
      return "End date cannot be before start date.";
    }
    if (employeeDates.termination_date && formData.end_date && formData.end_date > employeeDates.termination_date) {
      return `End date cannot be after termination date (${employeeDates.termination_date}).`;
    }
    return null;
  })();

  const handleCreate = async () => {
    if (dateError) return;
    setIsSubmitting(true);
    try {
      await createContract(formData);
      setShowCreate(false);
      setFormData({
        employee_id: employeeId, name: "", start_date: format(new Date(), "yyyy-MM-dd"),
        wage: 0, housing_allowance: 0, transport_allowance: 0, working_schedule: "full_time",
        compensation_mode: "flat_wage", salary_structure_id: null,
      });
    } catch (err: any) {
      const msg: string = err?.message ?? "";
      if (msg.includes("contract_start_before_hire_date")) {
        toast.error("Contract start date is before the employee's hire date.");
      } else if (msg.includes("contract_end_after_termination_date")) {
        toast.error("Contract end date is after the employee's termination date.");
      } else if (msg.includes("contract_end_before_start")) {
        toast.error("Contract end date cannot be before start date.");
      } else if (msg.includes("contract_overlaps_existing")) {
        toast.error("This contract overlaps another active contract for this employee.");
      } else {
        console.error(err);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleActivate = async (id: string) => {
    try {
      await activateContract(id);
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to activate contract");
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-32">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Employment Contracts</h3>
        {canManageTeam && (
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4 mr-1" /> New Contract
          </Button>
        )}
      </div>

      {contracts.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground">
            <FileText className="h-10 w-10 mx-auto mb-3 opacity-40" />
            <p>No contracts found for this employee.</p>
            {canManageTeam && (
              <Button variant="outline" size="sm" className="mt-3" onClick={() => setShowCreate(true)}>
                Create First Contract
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {contracts.map((contract) => (
            <Card key={contract.id}>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm font-medium">
                    {contract.contract_reference} — {contract.name}
                  </CardTitle>
                  <Badge className={STATUS_COLORS[contract.status] || ""}>
                    {contract.status}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                  <div>
                    <span className="text-muted-foreground">Start</span>
                    <p className="font-medium">{format(new Date(contract.start_date), "MMM d, yyyy")}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">End</span>
                    <p className="font-medium">{contract.end_date ? format(new Date(contract.end_date), "MMM d, yyyy") : "Open-ended"}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Basic Wage</span>
                    <p className="font-medium">{formatCurrency(contract.wage)}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Schedule</span>
                    <p className="font-medium capitalize">{contract.working_schedule.replace("_", " ")}</p>
                  </div>
                </div>
                {(contract.housing_allowance > 0 || contract.transport_allowance > 0) && (
                  <div className="flex gap-4 mt-2 text-sm text-muted-foreground">
                    {contract.housing_allowance > 0 && <span>Housing: {formatCurrency(contract.housing_allowance)}</span>}
                    {contract.transport_allowance > 0 && <span>Transport: {formatCurrency(contract.transport_allowance)}</span>}
                  </div>
                )}
                {canManageTeam && (
                  <div className="flex gap-2 mt-3">
                    {contract.status === "new" && (
                      <Button size="sm" variant="outline" onClick={() => handleActivate(contract.id)}>
                        <Play className="h-3 w-3 mr-1" /> Activate
                      </Button>
                    )}
                    {contract.status === "running" && (
                      <Button size="sm" variant="outline" className="text-destructive" onClick={() => setCancelTargetId(contract.id)}>
                        <X className="h-3 w-3 mr-1" /> Cancel
                      </Button>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <WorkflowSheet
        open={showCreate}
        onOpenChange={setShowCreate}
        size="lg"
        title="New Contract"
        description="Create a new employment contract. Activating it will sync compensation to the employee record."
        footer={
          <>
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button
              onClick={handleCreate}
              disabled={
                isSubmitting ||
                !formData.name ||
                !formData.wage ||
                !!dateError ||
                (formData.compensation_mode === "structure" && !formData.salary_structure_id)
              }
            >
              {isSubmitting && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              Create Contract
            </Button>
          </>
        }
      >
        <WorkflowSheetGrid>
          <WorkflowSheetSection number={1} title="Identity" subtitle="Internal name used on payroll documents.">
            <WorkflowField label="Contract Name" required>
              <Input value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })} placeholder="e.g. Permanent Employment" />
            </WorkflowField>
            <WorkflowField label="Working Schedule">
              <Select value={formData.working_schedule} onValueChange={(v) => setFormData({ ...formData, working_schedule: v as any })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="full_time">Full Time</SelectItem>
                  <SelectItem value="part_time">Part Time</SelectItem>
                  <SelectItem value="contract">Contract</SelectItem>
                  <SelectItem value="freelance">Freelance</SelectItem>
                </SelectContent>
              </Select>
            </WorkflowField>
          </WorkflowSheetSection>

          <WorkflowSheetSection number={2} title="Period" subtitle="Bounded by the employee's hire and termination dates.">
            <WorkflowField label="Start Date" required>
              <Input
                type="date"
                value={formData.start_date}
                min={employeeDates.hire_date ?? undefined}
                max={employeeDates.termination_date ?? undefined}
                onChange={(e) => setFormData({ ...formData, start_date: e.target.value })}
              />
            </WorkflowField>
            <WorkflowField label="End Date">
              <Input
                type="date"
                value={formData.end_date || ""}
                min={formData.start_date || employeeDates.hire_date || undefined}
                max={employeeDates.termination_date ?? undefined}
                onChange={(e) => setFormData({ ...formData, end_date: e.target.value || null })}
              />
            </WorkflowField>
            {dateError && (
              <div className="flex items-start gap-2 rounded-md bg-destructive/10 p-2 text-sm text-destructive">
                <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                <span>{dateError}</span>
              </div>
            )}
          </WorkflowSheetSection>
        </WorkflowSheetGrid>

        <WorkflowSheetSection
          number={3}
          title="Compensation"
          subtitle="Activation is blocked until compensation is fully configured."
          fullWidth
        >
          <WorkflowField label="Compensation Method" required>
            <Select
              value={formData.compensation_mode ?? "flat_wage"}
              onValueChange={(v) =>
                setFormData({
                  ...formData,
                  compensation_mode: v as "structure" | "flat_wage",
                  salary_structure_id: v === "flat_wage" ? null : formData.salary_structure_id,
                })
              }
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="flat_wage">Flat wage + allowances</SelectItem>
                <SelectItem value="structure">Salary structure (components & rules)</SelectItem>
              </SelectContent>
            </Select>
          </WorkflowField>
          {formData.compensation_mode === "structure" && (
            <WorkflowField label="Salary Structure" required>
              <Select
                value={formData.salary_structure_id ?? ""}
                onValueChange={(v) => setFormData({ ...formData, salary_structure_id: v })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a salary structure" />
                </SelectTrigger>
                <SelectContent>
                  {structures.filter((s) => s.is_active).map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}{s.code ? ` (${s.code})` : ""}
                    </SelectItem>
                  ))}
                  {structures.filter((s) => s.is_active).length === 0 && (
                    <div className="px-2 py-1.5 text-xs text-muted-foreground">
                      No active structures — create one in HR → Payroll → Salary Structures.
                    </div>
                  )}
                </SelectContent>
              </Select>
            </WorkflowField>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <WorkflowField label="Basic Wage" required>
              <Input type="number" value={formData.wage} onChange={(e) => setFormData({ ...formData, wage: parseFloat(e.target.value) || 0 })} />
            </WorkflowField>
            <WorkflowField label="Housing Allow.">
              <Input type="number" value={formData.housing_allowance || 0} onChange={(e) => setFormData({ ...formData, housing_allowance: parseFloat(e.target.value) || 0 })} />
            </WorkflowField>
            <WorkflowField label="Transport Allow.">
              <Input type="number" value={formData.transport_allowance || 0} onChange={(e) => setFormData({ ...formData, transport_allowance: parseFloat(e.target.value) || 0 })} />
            </WorkflowField>
          </div>
        </WorkflowSheetSection>
      </WorkflowSheet>



      <AlertDialog open={!!cancelTargetId} onOpenChange={(o) => !o && setCancelTargetId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this active contract?</AlertDialogTitle>
            <AlertDialogDescription>
              This will deactivate the running contract. The employee will no longer have an
              active contract, which can block payroll runs and stop compensation sync. This
              action cannot be undone — you'll need to create a new contract to re-engage them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isCancelling}>Keep contract</AlertDialogCancel>
            <AlertDialogAction
              disabled={isCancelling}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={async (e) => {
                e.preventDefault();
                if (!cancelTargetId) return;
                setIsCancelling(true);
                try {
                  await cancelContract(cancelTargetId);
                  setCancelTargetId(null);
                } catch (err: any) {
                  toast.error(err?.message ?? "Failed to cancel contract");
                } finally {
                  setIsCancelling(false);
                }
              }}
            >
              {isCancelling && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              Yes, cancel contract
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
