/**
 * Employee Benefits tab — current and historical benefit enrollments.
 * HR can enroll/terminate; employees see read-only.
 */
import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  WorkflowSheet,
  WorkflowSheetSection,
  WorkflowField,
} from "@/components/workflow/WorkflowSheet";
import {

  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useCurrency } from "@/hooks/useCurrency";
import { HeartHandshake, Plus, X } from "lucide-react";
import { format } from "date-fns";
import { useBenefitPlans, useEmployeeBenefits } from "@/hooks/useBenefitPlans";

export function EmployeeBenefitsTab({
  employeeId,
  canEdit = false,
}: {
  employeeId: string;
  canEdit?: boolean;
}) {
  const { formatCurrency } = useCurrency();
  const { plans } = useBenefitPlans();
  const { benefits, isLoading, enrollBenefit, terminateBenefit } =
    useEmployeeBenefits(employeeId);

  const [enrollOpen, setEnrollOpen] = useState(false);
  const [planId, setPlanId] = useState<string>("");
  const [enrollDate, setEnrollDate] = useState(
    new Date().toISOString().slice(0, 10),
  );
  const [notes, setNotes] = useState("");

  const activeIds = useMemo(
    () =>
      new Set(
        benefits
          .filter((b) => b.status === "active" && !b.end_date)
          .map((b) => b.benefit_plan_id),
      ),
    [benefits],
  );
  const availablePlans = useMemo(
    () => plans.filter((p) => p.is_active && !activeIds.has(p.id)),
    [plans, activeIds],
  );

  const handleEnroll = async () => {
    if (!planId) return;
    await enrollBenefit.mutateAsync({
      benefit_plan_id: planId,
      enrollment_date: enrollDate,
      notes: notes || undefined,
    });
    setEnrollOpen(false);
    setPlanId("");
    setNotes("");
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2">
          <HeartHandshake className="h-4 w-4" /> Benefits & Insurance
        </CardTitle>
        {canEdit && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setEnrollOpen(true)}
            disabled={availablePlans.length === 0}
          >
            <Plus className="mr-1 h-3.5 w-3.5" /> Enroll
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : benefits.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4">
            No benefit enrollments.
          </p>
        ) : (
          <div className="space-y-2">
            {benefits.map((b) => {
              const active = b.status === "active" && !b.end_date;
              const plan = b.benefit_plan;
              return (
                <div
                  key={b.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium">{plan?.name ?? "Plan"}</span>
                      <Badge variant={active ? "default" : "secondary"}>
                        {active ? "Active" : b.status}
                      </Badge>
                      {plan?.benefit_type && (
                        <Badge variant="outline">{plan.benefit_type}</Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      {plan?.provider && `${plan.provider} · `}
                      Enrolled {format(new Date(b.enrollment_date), "MMM d, yyyy")}
                      {b.end_date && ` · Ended ${format(new Date(b.end_date), "MMM d, yyyy")}`}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="text-right text-xs">
                      <div className="text-muted-foreground">
                        Employer{" "}
                        <span className="font-medium text-foreground">
                          {formatCurrency(plan?.employer_contribution || 0)}
                          {plan?.contribution_type === "percentage" ? "%" : ""}
                        </span>
                      </div>
                      <div className="text-muted-foreground">
                        Employee{" "}
                        <span className="font-medium text-foreground">
                          {formatCurrency(plan?.employee_contribution || 0)}
                          {plan?.contribution_type === "percentage" ? "%" : ""}
                        </span>
                      </div>
                    </div>
                    {canEdit && active && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => terminateBenefit.mutate(b.id)}
                        title="Terminate enrollment"
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>

      <WorkflowSheet
        open={enrollOpen}
        onOpenChange={setEnrollOpen}
        size="md"
        title="Enroll in Benefit Plan"
        description="Pick a plan and effective date. Contributions are pulled from the plan and applied during the next payroll run."
        footer={
          <>
            <Button variant="outline" onClick={() => setEnrollOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleEnroll} disabled={!planId || enrollBenefit.isPending}>
              Enroll
            </Button>
          </>
        }
      >
        <WorkflowSheetSection number={1} title="Plan" subtitle="Only plans the employee is eligible for are listed.">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <WorkflowField label="Benefit Plan" required>
              <Select value={planId} onValueChange={setPlanId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a plan" />
                </SelectTrigger>
                <SelectContent>
                  {availablePlans.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name} — {p.benefit_type}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </WorkflowField>
            <WorkflowField label="Enrollment Date" required>
              <Input
                type="date"
                value={enrollDate}
                onChange={(e) => setEnrollDate(e.target.value)}
              />
            </WorkflowField>
          </div>
        </WorkflowSheetSection>
        <WorkflowSheetSection number={2} title="Notes" subtitle="Optional context surfaced on the enrollment history.">
          <Textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            placeholder="Optional"
          />
        </WorkflowSheetSection>
      </WorkflowSheet>

    </Card>
  );
}
