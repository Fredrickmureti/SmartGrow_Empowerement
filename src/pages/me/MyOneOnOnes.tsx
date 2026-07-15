/**
 * MyOneOnOnes — list of the employee's upcoming and past 1:1s, with the
 * manager. Also surfaces the manager view if the current user manages
 * other employees (combined list, role-tagged per row).
 */
import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useCurrentEmployee } from "@/hooks/useCurrentEmployee";
import { useOneOnOnes } from "@/hooks/useContinuousPerformance";
import { useEmployees } from "@/hooks/useEmployees";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CalendarClock, Plus, ChevronRight } from "lucide-react";
import { PageHeader, PageBody, EmptyState } from "@/design-system";

export default function MyOneOnOnes() {
  const { currentEmployee } = useCurrentEmployee();
  const { directReports } = useCurrentEmployee();
  const { employees } = useEmployees();

  const asEmployee = useOneOnOnes({ employeeId: currentEmployee?.id });
  const asManager = useOneOnOnes({ managerId: currentEmployee?.id });

  const combined = useMemo(() => {
    const seen = new Set<string>();
    const all: { role: "as_employee" | "as_manager"; meeting: any }[] = [];
    for (const m of asEmployee.oneOnOnes) { if (!seen.has(m.id)) { all.push({ role: "as_employee", meeting: m }); seen.add(m.id); } }
    for (const m of asManager.oneOnOnes) { if (!seen.has(m.id)) { all.push({ role: "as_manager", meeting: m }); seen.add(m.id); } }
    return all.sort((a, b) => new Date(b.meeting.scheduled_at).getTime() - new Date(a.meeting.scheduled_at).getTime());
  }, [asEmployee.oneOnOnes, asManager.oneOnOnes]);

  const name = (id: string) => {
    const e = employees.find((x: any) => x.id === id);
    return e ? `${e.first_name} ${e.last_name}` : id.slice(0, 8);
  };

  if (!currentEmployee) {
    return (
      <>
        <PageHeader title="1:1 meetings" description="1:1 meetings need a linked employee record." />
        <PageBody><EmptyState icon={CalendarClock} title="No linked employee record" description="Ask your HR admin to link your account." /></PageBody>
      </>
    );
  }

  const upcoming = combined.filter(({ meeting }) => meeting.status === "scheduled" && new Date(meeting.scheduled_at).getTime() >= Date.now() - 1000 * 60 * 60);
  const past = combined.filter(({ meeting }) => meeting.status !== "scheduled" || new Date(meeting.scheduled_at).getTime() < Date.now() - 1000 * 60 * 60);

  return (
    <>
      <PageHeader
        title="1:1 meetings"
        description="Recurring conversations between you and your manager — and your direct reports."
        actions={directReports.length > 0 ? (
          <Button asChild size="sm">
            <Link to="/me/one-on-ones/new"><Plus className="h-4 w-4 mr-1" /> Schedule 1:1</Link>
          </Button>
        ) : null}
      />
      <PageBody>
      <Card>
        <CardHeader><CardTitle className="text-base">Upcoming</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {upcoming.length === 0 ? <p className="text-sm text-muted-foreground">No upcoming 1:1s.</p> :
            upcoming.map(({ role, meeting }) => <Row key={meeting.id} meeting={meeting} role={role} otherName={role === "as_employee" ? name(meeting.manager_id) : name(meeting.employee_id)} />)}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Past</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {past.length === 0 ? <p className="text-sm text-muted-foreground">No past 1:1s.</p> :
            past.slice(0, 30).map(({ role, meeting }) => <Row key={meeting.id} meeting={meeting} role={role} otherName={role === "as_employee" ? name(meeting.manager_id) : name(meeting.employee_id)} />)}
        </CardContent>
      </Card>
      </PageBody>
    </>
  );
}

function Row({ meeting, role, otherName }: { meeting: any; role: "as_employee" | "as_manager"; otherName: string }) {
  return (
    <Link to={`/me/one-on-ones/${meeting.id}`} className="flex items-center gap-3 rounded-md border px-3 py-2 hover:bg-accent">
      <div className="flex-1 min-w-0">
        <p className="font-medium truncate">With {otherName}</p>
        <p className="text-xs text-muted-foreground">{new Date(meeting.scheduled_at).toLocaleString()} · {meeting.duration_minutes} min</p>
      </div>
      <Badge variant="outline" className="text-[10px]">{role === "as_manager" ? "You're the manager" : "Your manager"}</Badge>
      <Badge variant="secondary">{meeting.status}</Badge>
      <ChevronRight className="h-4 w-4 text-muted-foreground" />
    </Link>
  );
}

function ScheduleDialog({ reports, onScheduled }: { reports: any[]; onScheduled?: () => void }) {
  const [open, setOpen] = useState(false);
  const { schedule } = useOneOnOnes();
  const [emp, setEmp] = useState("");
  const [when, setWhen] = useState("");
  const [duration, setDuration] = useState(30);
  const [recurrence, setRecurrence] = useState<"none" | "weekly" | "biweekly" | "monthly">("biweekly");

  async function submit() {
    await schedule.mutateAsync({ employee_id: emp, scheduled_at: when, duration_minutes: duration, recurrence });
    setOpen(false); setEmp(""); setWhen("");
    onScheduled?.();
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="sm"><Plus className="h-4 w-4 mr-1" /> Schedule 1:1</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Schedule 1:1</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>With (direct report)</Label>
            <Select value={emp} onValueChange={setEmp}>
              <SelectTrigger><SelectValue placeholder="Pick a report" /></SelectTrigger>
              <SelectContent>{reports.map((r: any) => <SelectItem key={r.id} value={r.id}>{r.first_name} {r.last_name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><Label>When</Label><Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></div>
            <div><Label>Duration (min)</Label><Input type="number" min={5} max={480} value={duration} onChange={(e) => setDuration(Number(e.target.value))} /></div>
          </div>
          <div>
            <Label>Recurrence</Label>
            <Select value={recurrence} onValueChange={(v) => setRecurrence(v as any)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None (one-off)</SelectItem>
                <SelectItem value="weekly">Weekly</SelectItem>
                <SelectItem value="biweekly">Bi-weekly</SelectItem>
                <SelectItem value="monthly">Monthly</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={submit} disabled={!emp || !when || schedule.isPending}>
            {schedule.isPending ? "Scheduling…" : "Schedule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}