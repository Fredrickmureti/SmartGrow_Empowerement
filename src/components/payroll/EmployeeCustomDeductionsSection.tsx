/**
 * EmployeeCustomDeductionsSection — per-employee assignment surface.
 *
 * Renders on the employee profile Payroll tab. Assignments transition
 * status via explicit action buttons (never a raw dropdown) so the DB
 * event trigger records intent into `employee_custom_deduction_events`.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";
import { Plus, History, Check, Pause, Play, X, Loader2 } from "lucide-react";
import {
  useCustomDeductionTypes,
} from "@/hooks/payroll/useCustomDeductionTypes";
import {
  useEmployeeCustomDeductions,
  useEmployeeCustomDeductionMutations,
  useCustomDeductionEvents,
  type EmployeeCustomDeduction,
  type EmployeeCustomDeductionStatus,
} from "@/hooks/payroll/useEmployeeCustomDeductions";

const STATUS_VARIANT: Record<EmployeeCustomDeductionStatus, "default" | "secondary" | "destructive" | "outline"> = {
  pending: "outline",
  approved: "default",
  active: "default",
  suspended: "secondary",
  cancelled: "destructive",
  completed: "outline",
};

export function EmployeeCustomDeductionsSection({ employeeId }: { employeeId: string }) {
  const { data: types = [] } = useCustomDeductionTypes();
  const { data: assignments = [], isLoading } = useEmployeeCustomDeductions(employeeId);
  const { assign, transition } = useEmployeeCustomDeductionMutations();

  const [assignOpen, setAssignOpen] = useState(false);
  const [timelineFor, setTimelineFor] = useState<EmployeeCustomDeduction | null>(null);

  const [typeId, setTypeId] = useState<string>("");
  const [from, setFrom] = useState<string>(() => new Date().toISOString().slice(0, 10));
  const [to, setTo] = useState<string>("");
  const [amountOverride, setAmountOverride] = useState<string>("");
  const [rateOverride, setRateOverride] = useState<string>("");
  const [cumulativeCap, setCumulativeCap] = useState<string>("");
  const [minNetFloor, setMinNetFloor] = useState<string>("");
  const [reference, setReference] = useState<string>("");
  const [notes, setNotes] = useState<string>("");

  const selectedType = types.find((t) => t.id === typeId);

  const submitAssign = async () => {
    if (!typeId) return;
    await assign.mutateAsync({
      employee_id: employeeId,
      deduction_type_id: typeId,
      effective_from: from,
      effective_to: to || null,
      amount_override: amountOverride ? Number(amountOverride) : null,
      rate_override: rateOverride ? Number(rateOverride) : null,
      cumulative_cap: cumulativeCap ? Number(cumulativeCap) : null,
      min_net_floor: minNetFloor ? Number(minNetFloor) : null,
      reference: reference || null,
      notes: notes || null,
      requires_approval: selectedType?.requires_approval ?? false,
    });
    setAssignOpen(false);
    setTypeId(""); setAmountOverride(""); setRateOverride("");
    setCumulativeCap(""); setMinNetFloor(""); setReference(""); setNotes("");
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle>Custom deductions</CardTitle>
          <CardDescription>
            Ad-hoc recurring or one-time deductions. Loans, advances, garnishments and
            statutory items are managed in their own modules.
          </CardDescription>
        </div>
        <Button size="sm" onClick={() => setAssignOpen(true)} disabled={types.length === 0}>
          <Plus className="h-4 w-4 mr-1" /> Assign
        </Button>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : assignments.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">No custom deductions assigned.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Type</TableHead>
                <TableHead>Effective</TableHead>
                <TableHead>Recovered</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {assignments.map((a) => {
                const pct = a.cumulative_cap && a.cumulative_cap > 0
                  ? Math.min(100, (a.cumulative_recovered / a.cumulative_cap) * 100)
                  : null;
                return (
                  <TableRow key={a.id}>
                    <TableCell>
                      <div className="font-medium">{a.deduction_type?.label ?? "—"}</div>
                      <div className="text-xs text-muted-foreground font-mono">{a.deduction_type?.code}</div>
                    </TableCell>
                    <TableCell className="text-xs">
                      {a.effective_from}{a.effective_to ? ` → ${a.effective_to}` : ""}
                    </TableCell>
                    <TableCell>
                      <div className="text-xs">
                        {a.cumulative_recovered.toFixed(2)}
                        {a.cumulative_cap ? ` / ${a.cumulative_cap.toFixed(2)}` : ""}
                      </div>
                      {pct !== null && <Progress value={pct} className="h-1 mt-1" />}
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[a.status]}>{a.status}</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {a.status === "pending" && (
                        <Button size="sm" variant="ghost" onClick={() => transition.mutate({ id: a.id, to: "approved" })}>
                          <Check className="h-3 w-3" />
                        </Button>
                      )}
                      {(a.status === "approved" || a.status === "active") && (
                        <Button size="sm" variant="ghost" onClick={() => transition.mutate({ id: a.id, to: "suspended" })}>
                          <Pause className="h-3 w-3" />
                        </Button>
                      )}
                      {a.status === "suspended" && (
                        <Button size="sm" variant="ghost" onClick={() => transition.mutate({ id: a.id, to: "active" })}>
                          <Play className="h-3 w-3" />
                        </Button>
                      )}
                      {!["completed", "cancelled"].includes(a.status) && (
                        <Button size="sm" variant="ghost" onClick={() => transition.mutate({ id: a.id, to: "cancelled" })}>
                          <X className="h-3 w-3" />
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" onClick={() => setTimelineFor(a)}>
                        <History className="h-3 w-3" />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <Dialog open={assignOpen} onOpenChange={setAssignOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Assign custom deduction</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Deduction type</Label>
              <Select value={typeId} onValueChange={setTypeId}>
                <SelectTrigger><SelectValue placeholder="Select type" /></SelectTrigger>
                <SelectContent>
                  {types.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.label} <span className="text-xs text-muted-foreground">({t.code})</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedType?.requires_approval && (
                <p className="text-xs text-amber-600 mt-1">This type requires approval — assignment starts in pending.</p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label>Effective from</Label>
                <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              </div>
              <div>
                <Label>Effective to (optional)</Label>
                <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
              </div>
            </div>

            {selectedType?.computation_method === "flat_amount" && (
              <div>
                <Label>Amount override (leave blank to use default)</Label>
                <Input type="number" step="0.01" value={amountOverride} onChange={(e) => setAmountOverride(e.target.value)} />
              </div>
            )}
            {selectedType && selectedType.computation_method.startsWith("percentage_") && (
              <div>
                <Label>Rate override (0-1)</Label>
                <Input type="number" step="0.0001" value={rateOverride} onChange={(e) => setRateOverride(e.target.value)} />
              </div>
            )}

            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label>Cumulative cap</Label>
                <Input type="number" step="0.01" value={cumulativeCap} onChange={(e) => setCumulativeCap(e.target.value)} />
              </div>
              <div>
                <Label>Min net floor</Label>
                <Input type="number" step="0.01" value={minNetFloor} onChange={(e) => setMinNetFloor(e.target.value)} />
              </div>
            </div>

            <div>
              <Label>Reference</Label>
              <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="e.g. Membership #12345" />
            </div>
            <div>
              <Label>Notes</Label>
              <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAssignOpen(false)}>Cancel</Button>
            <Button onClick={submitAssign} disabled={!typeId || assign.isPending}>Assign</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Sheet open={!!timelineFor} onOpenChange={(o) => !o && setTimelineFor(null)}>
        <SheetContent side="right" className="w-96 sm:max-w-md">
          <SheetHeader><SheetTitle>Lifecycle</SheetTitle></SheetHeader>
          {timelineFor && <TimelineList assignmentId={timelineFor.id} />}
        </SheetContent>
      </Sheet>
    </Card>
  );
}

function TimelineList({ assignmentId }: { assignmentId: string }) {
  const { data: events = [], isLoading } = useCustomDeductionEvents(assignmentId);
  if (isLoading) return <Loader2 className="h-4 w-4 animate-spin mt-4 mx-auto" />;
  if (events.length === 0) return <p className="text-sm text-muted-foreground mt-4">No events yet.</p>;
  return (
    <div className="mt-4 space-y-3">
      {events.map((e) => (
        <div key={e.id} className="border-l-2 border-primary/40 pl-3 pb-2">
          <div className="text-sm font-medium">{e.event_type}</div>
          <div className="text-xs text-muted-foreground">
            {e.from_status ? `${e.from_status} → ` : ""}{e.to_status ?? ""}
          </div>
          {e.amount !== null && <div className="text-xs">Amount: {e.amount}</div>}
          {e.notes && <div className="text-xs italic">{e.notes}</div>}
          <div className="text-[10px] text-muted-foreground mt-1">{new Date(e.created_at).toLocaleString()}</div>
        </div>
      ))}
    </div>
  );
}
