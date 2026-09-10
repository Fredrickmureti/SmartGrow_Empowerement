/**
 * BranchDayControl — the supported way to switch the branch trading day on.
 *
 * `branches.day_control_from` is the branch's go-live date for day control:
 * while it is empty the branch cannot open a day at all, and money entries are
 * not tied to a day. Setting it is a real accounting decision, so it goes
 * through `set_branch_day_control`, which owns every rule (who may change it,
 * no back-dating, no switching off with a day still open, audit trail). This
 * card only shows the state and calls it.
 */
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  useBranchDayControl,
  useSetBranchDayControl,
  useOpenBranchDay,
  todayIso,
} from "@/hooks/useBranchDay";
import { usePermissions } from "@/hooks/usePermissions";

interface Props {
  branchId: string;
  branchName: string;
}

function longDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString(undefined, {
        day: "numeric",
        month: "long",
        year: "numeric",
      });
}

export function BranchDayControl({ branchId, branchName }: Props) {
  const { canEditSettings } = usePermissions();
  const control = useBranchDayControl(branchId);
  const openDay = useOpenBranchDay(branchId);
  const save = useSetBranchDayControl();

  const current = control.data?.day_control_from ?? null;
  const [startDate, setStartDate] = useState(todayIso());
  const [tolerance, setTolerance] = useState("0");
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (!control.data) return;
    setStartDate(control.data.day_control_from ?? todayIso());
    setTolerance(String(control.data.day_variance_tolerance ?? 0));
  }, [control.data]);

  const busy = save.isPending;
  const hasOpenDay = !!openDay.data;

  const activate = () =>
    save.mutate({
      branchId,
      dayControlFrom: startDate,
      varianceTolerance: Number(tolerance || 0),
      reason: reason || null,
    });

  const switchOff = () =>
    save.mutate({
      branchId,
      dayControlFrom: null,
      varianceTolerance: Number(tolerance || 0),
      reason: reason || null,
    });

  if (control.isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading day control…
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Day control
          {current ? (
            <Badge variant="default">On since {longDate(current)}</Badge>
          ) : (
            <Badge variant="outline">Not switched on</Badge>
          )}
        </CardTitle>
        <CardDescription>
          With day control on, staff at {branchName} must open the branch each
          morning with a cash count, every payment they record carries that
          day's date, and the day is closed against a physical count. Until it
          is on, no day can be opened here.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!canEditSettings && (
          <Alert>
            <AlertDescription>
              You can see these settings but not change them. Ask an
              administrator to switch day control on for this branch.
            </AlertDescription>
          </Alert>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="day-control-from">Day control starts</Label>
            <Input
              id="day-control-from"
              type="date"
              min={todayIso()}
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              disabled={!canEditSettings || busy || !!current}
            />
            <p className="text-xs text-muted-foreground">
              Today or a future date. It cannot be back-dated, because days
              before it were never counted.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="day-variance-tolerance">
              Allowed cash difference at close
            </Label>
            <Input
              id="day-variance-tolerance"
              type="number"
              min="0"
              step="0.01"
              value={tolerance}
              onChange={(e) => setTolerance(e.target.value)}
              disabled={!canEditSettings || busy}
            />
            <p className="text-xs text-muted-foreground">
              A bigger difference than this needs a manager to approve the
              close.
            </p>
          </div>
        </div>

        {current && (
          <div className="space-y-1.5">
            <Label htmlFor="day-control-reason">
              Why are you changing this?
            </Label>
            <Textarea
              id="day-control-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Recorded in the audit trail"
              disabled={!canEditSettings || busy}
            />
          </div>
        )}

        {current && hasOpenDay && (
          <Alert>
            <AlertDescription>
              A day is still open at {branchName}. Close it before switching day
              control off.
            </AlertDescription>
          </Alert>
        )}

        <div className="flex flex-wrap gap-2">
          {!current ? (
            <Button onClick={activate} disabled={!canEditSettings || busy || !startDate}>
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Switch day control on
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                onClick={activate}
                disabled={!canEditSettings || busy}
              >
                {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Save allowed difference
              </Button>
              <Button
                variant="destructive"
                onClick={switchOff}
                disabled={!canEditSettings || busy || hasOpenDay || !reason.trim()}
              >
                Switch day control off
              </Button>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export default BranchDayControl;
