/**
 * MyShifts (Turn E) — employee self-service view of own shift assignments
 * and ability to open a swap request. Lives at /me/shifts.
 */
import { useMemo, useState } from "react";
import { useCurrentEmployee } from "@/hooks/useCurrentEmployee";
import { useShiftAssignments, useShiftSwaps } from "@/hooks/useShifts";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { CalendarClock, ArrowLeftRight, Check, X } from "lucide-react";
import { EmployeeLinkRequired } from "@/components/me/EmployeeLinkRequired";
import { PageHeader, PageBody, DetailSheet, FooterActionBar, EmptyState } from "@/design-system";

function ymd(d: Date) {
  return d.toISOString().slice(0, 10);
}

export default function MyShifts() {
  const { currentEmployee, isLoading } = useCurrentEmployee();

  const today = new Date();
  const horizon = new Date();
  horizon.setDate(horizon.getDate() + 60);
  const past = new Date();
  past.setDate(past.getDate() - 14);

  const { assignments } = useShiftAssignments({
    from: ymd(past),
    to: ymd(horizon),
    employeeId: currentEmployee?.id,
  });
  const { swaps, create, respond } = useShiftSwaps(currentEmployee?.id);

  const [openSwap, setOpenSwap] = useState<{ open: boolean; assignmentId?: string }>({
    open: false,
  });
  const [reason, setReason] = useState("");

  const upcoming = useMemo(
    () =>
      assignments.filter(
        (a) => new Date(a.assignment_date) >= new Date(today.toDateString()),
      ),
    [assignments, today],
  );
  const past14 = useMemo(
    () =>
      assignments.filter(
        (a) => new Date(a.assignment_date) < new Date(today.toDateString()),
      ),
    [assignments, today],
  );

  if (isLoading) return <div className="p-4 text-sm text-muted-foreground">Loading…</div>;
  if (!currentEmployee) return <EmployeeLinkRequired />;

  return (
    <>
      <PageHeader
        title="My Shifts"
        description="Your upcoming roster and shift swap requests."
      />
      <PageBody>
        <Card>
        <CardHeader>
          <CardTitle>Upcoming shifts</CardTitle>
          <CardDescription>Next 60 days.</CardDescription>
        </CardHeader>
        <CardContent className={upcoming.length === 0 ? "min-h-[220px] flex items-center justify-center" : undefined}>
          {upcoming.length === 0 ? (
            <EmptyState
              icon={CalendarClock}
              title="No shifts scheduled"
              description="You have no assigned shifts in the next 60 days. Your roster will appear here once your manager publishes it."
            />
          ) : (
            <div className="space-y-2">
              {upcoming.map((a) => (
                <div
                  key={a.id}
                  className="flex items-center justify-between rounded border p-3"
                  style={{ borderLeftWidth: 4, borderLeftColor: a.shift?.color ?? "#3b82f6" }}
                >
                  <div>
                    <div className="font-medium">
                      {new Date(a.assignment_date).toLocaleDateString(undefined, {
                        weekday: "short",
                        month: "short",
                        day: "numeric",
                      })}{" "}
                      · {a.shift?.name}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {a.shift?.start_time?.slice(0, 5)}–{a.shift?.end_time?.slice(0, 5)} ·{" "}
                      {a.status}
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setOpenSwap({ open: true, assignmentId: a.id });
                      setReason("");
                    }}
                  >
                    <ArrowLeftRight className="h-4 w-4 mr-1" /> Request swap
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Swap requests</CardTitle>
        </CardHeader>
        <CardContent className={swaps.length === 0 ? "min-h-[220px] flex items-center justify-center" : undefined}>
          {swaps.length === 0 ? (
            <EmptyState
              icon={ArrowLeftRight}
              title="No swap requests"
              description="Swap requests you send or receive will show up here with their approval status."
            />
          ) : (
            <div className="space-y-2">
              {swaps.map((s) => {
                const isTarget = s.target_employee_id === currentEmployee.id;
                const canRespond = isTarget && s.status === "pending";
                return (
                  <div
                    key={s.id}
                    className="flex items-center justify-between rounded border p-3"
                  >
                    <div>
                      <div className="text-sm font-medium">Status: {s.status}</div>
                      {s.reason && (
                        <div className="text-xs text-muted-foreground">{s.reason}</div>
                      )}
                      <div className="text-xs text-muted-foreground">
                        Opened {new Date(s.created_at).toLocaleString()}
                      </div>
                    </div>
                    {canRespond && (
                      <div className="flex gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => respond.mutate({ id: s.id, accept: true })}
                        >
                          <Check className="h-4 w-4 mr-1" /> Accept
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => respond.mutate({ id: s.id, accept: false })}
                        >
                          <X className="h-4 w-4 mr-1" /> Decline
                        </Button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {past14.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Recent shifts (last 14 days)</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="text-sm space-y-1">
              {past14.map((a) => (
                <li key={a.id}>
                  {a.assignment_date} · {a.shift?.name} ·{" "}
                  <span className="text-muted-foreground">{a.status}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <DetailSheet
        open={openSwap.open}
        onOpenChange={(o) => setOpenSwap({ open: o })}
        size="sm"
        title="Request shift swap"
        description={
          openSwap.assignmentId
            ? `Swap request for the shift on ${assignments.find((a) => a.id === openSwap.assignmentId)?.assignment_date}. HR will be able to assign a target and approve it.`
            : "Swap requests are reviewed by HR before being applied."
        }
        footer={
          <FooterActionBar
            anchor="sheet"
            leading={
              <Button variant="ghost" onClick={() => setOpenSwap({ open: false })}>
                Cancel
              </Button>
            }
            trailing={
              <Button
                onClick={async () => {
                  if (!openSwap.assignmentId) return;
                  await create.mutateAsync({
                    requester_employee_id: currentEmployee.id,
                    requester_assignment_id: openSwap.assignmentId,
                    reason: reason || null,
                  });
                  setOpenSwap({ open: false });
                }}
              >
                Submit
              </Button>
            }
          />
        }
      >
        <div className="px-6 py-4">
          <Label>Reason (optional)</Label>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
      </DetailSheet>

      </PageBody>
    </>
  );
}
