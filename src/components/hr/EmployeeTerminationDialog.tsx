import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  Loader2,
  Lock,
  PackageCheck,
  UserX,
  Wallet,
} from "lucide-react";
import { format } from "date-fns";
import { Employee } from "@/hooks/useEmployees";
import { useCurrency } from "@/hooks/useCurrency";
import {
  ExitClearanceItem,
  useEmployeeBlockers,
  useExitClearance,
} from "@/hooks/useExitClearance";
import { cn } from "@/lib/utils";
import { toast } from "sonner";


interface TerminationFormData {
  termination_date: string;
  termination_reason: string;
  termination_type: "voluntary" | "involuntary" | "end_of_contract" | "retirement" | "redundancy";
  final_settlement_notes: string;
}

interface Props {
  employee: Employee;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onTerminate: (
    employeeId: string,
    data: { termination_date: string; is_active: boolean },
    exitData: {
      termination_type: string;
      termination_reason: string;
      exit_checklist: Record<string, boolean>;
      final_settlement_notes: string;
      clearance_id?: string;
    },
  ) => Promise<void>;
}

const TYPE_TO_EXIT_TYPE: Record<TerminationFormData["termination_type"], string> = {
  voluntary: "resignation",
  involuntary: "dismissal",
  end_of_contract: "end_of_contract",
  retirement: "retirement",
  redundancy: "redundancy",
};

export function EmployeeTerminationDialog({ employee, open, onOpenChange, onTerminate }: Props) {
  const { formatCurrency } = useCurrency();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [step, setStep] = useState<"details" | "checklist" | "confirm">("details");
  const [formData, setFormData] = useState<TerminationFormData>({
    termination_date: format(new Date(), "yyyy-MM-dd"),
    termination_reason: "",
    termination_type: "voluntary",
    final_settlement_notes: "",
  });

  const { blockers, loading: blockersLoading } = useEmployeeBlockers(
    open ? employee.id : null,
  );
  const {
    clearance,
    items,
    loading: clearanceLoading,
    ensureClearance,
    signItem,
    reopenItem,
    allBlockingSigned,
  } = useExitClearance(open ? employee.id : null);

  const [activeItemId, setActiveItemId] = useState<string | null>(null);
  const [itemNotes, setItemNotes] = useState("");
  const [ackBlockers, setAckBlockers] = useState(false);
  const [createFinalRun, setCreateFinalRun] = useState(true);
  


  // When entering the checklist step, make sure a clearance record exists.
  useEffect(() => {
    if (step !== "checklist" || clearance) return;
    void ensureClearance({
      lastWorkingDay: formData.termination_date,
      exitType: TYPE_TO_EXIT_TYPE[formData.termination_type],
      reason: formData.termination_reason,
    });
  }, [step, clearance, ensureClearance, formData]);

  const completedCount = items.filter(
    (i) => i.status === "completed" || i.status === "waived",
  ).length;
  const totalCount = items.length;

  const groupedItems = useMemo(() => {
    const map = new Map<string, ExitClearanceItem[]>();
    items.forEach((i) => {
      if (!map.has(i.department)) map.set(i.department, []);
      map.get(i.department)!.push(i);
    });
    return Array.from(map.entries());
  }, [items]);

  const hasHardBlockers =
    blockers.outstandingLoans > 0 || blockers.assignedAssets > 0;
  const canConfirm =
    (!hasHardBlockers || ackBlockers) && (totalCount === 0 || allBlockingSigned);

  const handleTerminate = async () => {
    setIsSubmitting(true);
    try {
      const checklist: Record<string, boolean> = {};
      items.forEach((i) => {
        checklist[`${i.department}:${i.task}`] =
          i.status === "completed" || i.status === "waived";
      });
      await onTerminate(
        employee.id,
        { termination_date: formData.termination_date, is_active: false },
        {
          termination_type: formData.termination_type,
          termination_reason: formData.termination_reason,
          exit_checklist: checklist,
          final_settlement_notes: formData.final_settlement_notes,
          clearance_id: clearance?.id,
        },
      );
      const { supabase } = await import("@/integrations/supabase/client");
      let finalRunId: string | null = null;
      let finalRunNumber: string | null = null;
      if (createFinalRun) {
        const lastDay = formData.termination_date;
        const monthStart = `${lastDay.slice(0, 7)}-01`;
        const number = `FS-${employee.employee_number || employee.id.slice(0, 6)}-${lastDay}`;
        const { data: runRow, error: runErr } = await supabase
          .from("payroll_runs")
          .insert({
            organization_id: (employee as any).organization_id,
            business_id: (employee as any).business_id,
            payroll_number: number,
            pay_period_start: monthStart,
            pay_period_end: lastDay,
            payment_date: lastDay,
            status: "draft",
            run_type: "final_settlement",
            is_final_settlement: true,
            final_settlement_employee_id: employee.id,
            notes: `Final settlement for ${employee.first_name} ${employee.last_name}. ${formData.final_settlement_notes || ""}`.trim(),
          } as any)
          .select("id, payroll_number")
          .single();
        if (runErr) {
          console.error("Final pay run create error:", runErr);
        } else if (runRow) {
          finalRunId = runRow.id;
          finalRunNumber = runRow.payroll_number;
          
        }
      }
      if (clearance?.id) {
        await supabase
          .from("employee_exit_clearance")
          .update({
            status: "completed",
            completed_at: new Date().toISOString(),
            ...(finalRunId ? { final_pay_run_id: finalRunId } : {}),
          })
          .eq("id", clearance.id);
      }

      if (finalRunNumber) {
        toast.success(`Final pay run ${finalRunNumber} created (draft). Compute payroll to populate.`);
      } else {
        toast.success("Employee terminated and clearance completed.");
      }
      onOpenChange(false);
      setStep("details");
    } catch (error) {
      console.error("Termination error:", error);
      toast.error("Failed to complete termination.");

    } finally {
      setIsSubmitting(false);
    }
  };

  const renderBlockersAlert = () => {
    if (blockersLoading) return null;
    if (!hasHardBlockers) {
      return (
        <Alert>
          <CheckCircle2 className="h-4 w-4" />
          <AlertTitle>No active blockers</AlertTitle>
          <AlertDescription>
            This employee has no outstanding loans or unreturned company assets on record.
          </AlertDescription>
        </Alert>
      );
    }
    return (
      <Alert variant="destructive">
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>Outstanding obligations</AlertTitle>
        <AlertDescription className="space-y-1">
          {blockers.outstandingLoans > 0 && (
            <div className="flex items-center gap-2 text-sm">
              <Wallet className="h-3.5 w-3.5" />
              {blockers.outstandingLoans} active loan(s) with balance{" "}
              <strong>{formatCurrency(blockers.outstandingLoanBalance)}</strong>
            </div>
          )}
          {blockers.assignedAssets > 0 && (
            <div className="flex items-center gap-2 text-sm">
              <PackageCheck className="h-3.5 w-3.5" />
              {blockers.assignedAssets} company asset(s) not yet returned
            </div>
          )}
          <div className="pt-1 text-xs">
            Resolve these in the Finance / Assets clearance tasks before final settlement.
          </div>
        </AlertDescription>
      </Alert>
    );
  };

  const renderDetailsStep = () => (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label>Employee</Label>
          <p className="text-sm font-medium mt-1">
            {employee.first_name} {employee.last_name} ({employee.employee_number})
          </p>
        </div>
        <div>
          <Label>Department</Label>
          <p className="text-sm text-muted-foreground mt-1">
            {employee.department_name || employee.department || "N/A"}
          </p>
        </div>
      </div>

      <div>
        <Label htmlFor="termination_type">Termination Type</Label>
        <Select
          value={formData.termination_type}
          onValueChange={(v) =>
            setFormData({
              ...formData,
              termination_type: v as TerminationFormData["termination_type"],
            })
          }
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="voluntary">Voluntary (Resignation)</SelectItem>
            <SelectItem value="involuntary">Involuntary (Dismissal)</SelectItem>
            <SelectItem value="end_of_contract">End of Contract</SelectItem>
            <SelectItem value="retirement">Retirement</SelectItem>
            <SelectItem value="redundancy">Redundancy</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div>
        <Label htmlFor="termination_date">Last Working Day</Label>
        <Input
          id="termination_date"
          type="date"
          value={formData.termination_date}
          onChange={(e) => setFormData({ ...formData, termination_date: e.target.value })}
        />
      </div>

      <div>
        <Label htmlFor="termination_reason">Reason for Termination</Label>
        <Textarea
          id="termination_reason"
          value={formData.termination_reason}
          onChange={(e) => setFormData({ ...formData, termination_reason: e.target.value })}
          placeholder="Provide details about the termination..."
          rows={3}
        />
      </div>

      {renderBlockersAlert()}

      <div>
        <Label>Estimated Final Settlement (last month)</Label>
        <div className="mt-2 space-y-1 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Basic Salary</span>
            <span>{formatCurrency(employee.basic_salary || 0)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Housing Allowance</span>
            <span>{formatCurrency(employee.housing_allowance || 0)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Transport Allowance</span>
            <span>{formatCurrency(employee.transport_allowance || 0)}</span>
          </div>
          <Separator />
          <div className="flex justify-between font-medium">
            <span>Estimated Gross</span>
            <span>
              {formatCurrency(
                (employee.basic_salary || 0) +
                  (employee.housing_allowance || 0) +
                  (employee.transport_allowance || 0),
              )}
            </span>
          </div>
          {blockers.outstandingLoanBalance > 0 && (
            <div className="flex justify-between text-destructive">
              <span>Less: Outstanding loan balance</span>
              <span>-{formatCurrency(blockers.outstandingLoanBalance)}</span>
            </div>
          )}
        </div>
      </div>

      <div>
        <Label htmlFor="final_settlement_notes">Settlement Notes</Label>
        <Textarea
          id="final_settlement_notes"
          value={formData.final_settlement_notes}
          onChange={(e) =>
            setFormData({ ...formData, final_settlement_notes: e.target.value })
          }
          placeholder="Notes about final settlement, leave encashment, gratuity, etc."
          rows={2}
        />
      </div>
    </div>
  );

  const renderChecklistStep = () => {
    if (clearanceLoading && items.length === 0) {
      return (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      );
    }
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">Department Clearance</p>
            <p className="text-xs text-muted-foreground">
              Each item is signed off by its department. Blocking items must be cleared
              before final settlement.
            </p>
          </div>
          <Badge variant={allBlockingSigned ? "default" : "secondary"}>
            {completedCount}/{totalCount}
          </Badge>
        </div>

        {renderBlockersAlert()}

        <div className="space-y-4">
          {groupedItems.map(([dept, deptItems]) => (
            <div key={dept} className="rounded-md border p-3">
              <div className="mb-2 text-sm font-semibold">{dept}</div>
              <div className="space-y-2">
                {deptItems.map((item) => {
                  const done =
                    item.status === "completed" || item.status === "waived";
                  return (
                    <div
                      key={item.id}
                      className={cn(
                        "flex items-start gap-3 rounded p-2 text-sm",
                        done ? "bg-muted/30" : "hover:bg-muted/40",
                      )}
                    >
                      <button
                        type="button"
                        className="mt-0.5"
                        onClick={() => {
                          if (done) void reopenItem(item.id);
                          else setActiveItemId(item.id);
                        }}
                        title={done ? "Reopen task" : "Sign off"}
                      >
                        {done ? (
                          <CheckCircle2 className="h-4 w-4 text-primary" />
                        ) : (
                          <Circle className="h-4 w-4 text-muted-foreground" />
                        )}
                      </button>
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <span className={cn(done && "line-through text-muted-foreground")}>
                            {item.task}
                          </span>
                          {item.is_blocking && (
                            <Lock className="h-3 w-3 text-muted-foreground" />
                          )}
                        </div>
                        {item.notes && (
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {item.notes}
                          </p>
                        )}
                        {activeItemId === item.id && !done && (
                          <div className="mt-2 space-y-2">
                            <Textarea
                              rows={2}
                              placeholder="Sign-off notes (optional)"
                              value={itemNotes}
                              onChange={(e) => setItemNotes(e.target.value)}
                            />
                            <div className="flex gap-2">
                              <Button
                                size="sm"
                                onClick={async () => {
                                  const ok = await signItem(item.id, {
                                    notes: itemNotes,
                                    status: "completed",
                                  });
                                  if (ok) {
                                    setActiveItemId(null);
                                    setItemNotes("");
                                  }
                                }}
                              >
                                Mark complete
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={async () => {
                                  const ok = await signItem(item.id, {
                                    notes: itemNotes,
                                    status: "waived",
                                  });
                                  if (ok) {
                                    setActiveItemId(null);
                                    setItemNotes("");
                                  }
                                }}
                              >
                                Waive
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => {
                                  setActiveItemId(null);
                                  setItemNotes("");
                                }}
                              >
                                Cancel
                              </Button>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const renderConfirmStep = () => (
    <div className="space-y-4">
      <Alert variant="destructive">
        <AlertTriangle className="h-4 w-4" />
        <AlertDescription>
          This action will deactivate{" "}
          <strong>
            {employee.first_name} {employee.last_name}
          </strong>
          's employee record and mark the clearance as complete. The user account, if
          linked, remains intact.
        </AlertDescription>
      </Alert>

      <div className="space-y-2 text-sm">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Type</span>
          <span className="capitalize">
            {formData.termination_type.replace("_", " ")}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Last Working Day</span>
          <span>{format(new Date(formData.termination_date), "MMM d, yyyy")}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Clearance</span>
          <Badge variant={allBlockingSigned ? "default" : "secondary"}>
            {completedCount}/{totalCount} complete
          </Badge>
        </div>
      </div>

      {hasHardBlockers && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Unresolved obligations</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>
              {blockers.outstandingLoans > 0 &&
                `${blockers.outstandingLoans} active loan(s) (${formatCurrency(
                  blockers.outstandingLoanBalance,
                )}). `}
              {blockers.assignedAssets > 0 &&
                `${blockers.assignedAssets} unreturned asset(s).`}
            </p>
            <label className="flex items-start gap-2 text-xs">
              <input
                type="checkbox"
                checked={ackBlockers}
                onChange={(e) => setAckBlockers(e.target.checked)}
              />
              I acknowledge these obligations will be handled in the final settlement
              and authorise termination to proceed.
            </label>
          </AlertDescription>
        </Alert>
      )}

      {!allBlockingSigned && totalCount > 0 && (
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            Some blocking clearance items are still pending. Resolve them before
            confirming.
          </AlertDescription>
        </Alert>
      )}

      <div className="rounded-md border p-3 space-y-2">
        <label className="flex items-start gap-2 text-sm font-medium">
          <input
            type="checkbox"
            className="mt-1"
            checked={createFinalRun}
            onChange={(e) => setCreateFinalRun(e.target.checked)}
          />
          <span>
            Create final settlement payroll run
            <p className="text-xs font-normal text-muted-foreground mt-0.5">
              Creates a draft off-cycle payroll run for this employee covering the
              termination month. Leave encashment, severance and notice pay queued
              by the system trigger will be picked up by Compute Payroll.
            </p>
          </span>
        </label>
      </div>
    </div>
  );


  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserX className="h-5 w-5 text-destructive" />
            Employee Termination
          </DialogTitle>
          <DialogDescription>
            {step === "details" &&
              "Enter termination details, review outstanding obligations and final settlement."}
            {step === "checklist" &&
              "Department-by-department offboarding clearance. Blocking items must be cleared."}
            {step === "confirm" && "Review and confirm the termination."}
          </DialogDescription>
        </DialogHeader>

        {step === "details" && renderDetailsStep()}
        {step === "checklist" && renderChecklistStep()}
        {step === "confirm" && renderConfirmStep()}

        <DialogFooter className="gap-2">
          {step === "details" && (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                onClick={() => setStep("checklist")}
                disabled={!formData.termination_date || !formData.termination_reason}
              >
                Next: Clearance
              </Button>
            </>
          )}
          {step === "checklist" && (
            <>
              <Button variant="outline" onClick={() => setStep("details")}>
                Back
              </Button>
              <Button onClick={() => setStep("confirm")}>Next: Review</Button>
            </>
          )}
          {step === "confirm" && (
            <>
              <Button variant="outline" onClick={() => setStep("checklist")}>
                Back
              </Button>
              <Button
                variant="destructive"
                onClick={handleTerminate}
                disabled={isSubmitting || !canConfirm}
              >
                {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Confirm Termination
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
