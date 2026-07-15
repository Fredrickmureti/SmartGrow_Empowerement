/**
 * MyOneOnOneNew — routed `/me/one-on-ones/new` surface for a manager to
 * schedule a 1:1 with a direct report. Renders on the platform's
 * `RecordFormShell` primitive so it matches every other record-create
 * surface (Employee, Invoice, Purchase Order, …). Replaces the legacy
 * in-page `ScheduleDialog`.
 */
import { useMemo, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  RecordFormShell,
  Section,
  FieldGrid,
  FieldCell,
} from "@/design-system";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCurrentEmployee } from "@/hooks/useCurrentEmployee";
import { useOneOnOnes } from "@/hooks/useContinuousPerformance";
import { EmployeeLinkRequired } from "@/components/me/EmployeeLinkRequired";

export default function MyOneOnOneNew() {
  const navigate = useNavigate();
  const { currentEmployee, directReports } = useCurrentEmployee();
  const { schedule } = useOneOnOnes();

  const [emp, setEmp] = useState("");
  const [when, setWhen] = useState("");
  const [duration, setDuration] = useState(30);
  const [recurrence, setRecurrence] = useState<"none" | "weekly" | "biweekly" | "monthly">("biweekly");

  const reports = useMemo(() => directReports ?? [], [directReports]);

  if (!currentEmployee) return <EmployeeLinkRequired />;

  const canSubmit = !!emp && !!when && !schedule.isPending;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    try {
      await schedule.mutateAsync({
        employee_id: emp,
        scheduled_at: when,
        duration_minutes: duration,
        recurrence,
      });
      toast.success("1:1 scheduled");
      navigate("/me/one-on-ones");
    } catch (e: any) {
      toast.error(e?.message || "Could not schedule 1:1");
    }
  }

  return (
    <RecordFormShell
      mode="create"
      entityLabel="1:1 meeting"
      cancelHref="/me/one-on-ones"
      onSubmit={onSubmit}
      isSubmitting={schedule.isPending}
      submitDisabled={!canSubmit}
      submitLabel="Schedule"
    >
      <Section title="Meeting details" description="Pick a direct report and when you want to meet.">
        <FieldGrid>
          <FieldCell span={2}>
            <Label>With (direct report)</Label>
            <Select value={emp} onValueChange={setEmp}>
              <SelectTrigger><SelectValue placeholder="Pick a report" /></SelectTrigger>
              <SelectContent>
                {reports.map((r: any) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.first_name} {r.last_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldCell>
          <FieldCell>
            <Label>When</Label>
            <Input
              type="datetime-local"
              value={when}
              onChange={(e) => setWhen(e.target.value)}
            />
          </FieldCell>
          <FieldCell>
            <Label>Duration (minutes)</Label>
            <Input
              type="number"
              min={5}
              max={480}
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value))}
            />
          </FieldCell>
          <FieldCell span={2}>
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
          </FieldCell>
        </FieldGrid>
      </Section>

    </RecordFormShell>
  );
}
