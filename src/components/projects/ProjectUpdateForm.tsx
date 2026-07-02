/**
 * ProjectUpdateForm — post a status update for a project (Odoo "Project Update").
 *
 * Pass 6 — Projects: migrated from `Dialog` to `WorkflowSheet` so the
 * presentation matches the New Payroll Run standard. Submit payload and
 * parent wiring are untouched.
 */
import { useState } from "react";
import {
  WorkflowSheet,
  WorkflowSheetGrid,
  WorkflowSheetSection,
  WorkflowField,
} from "@/components/workflow/WorkflowSheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CalendarIcon } from "lucide-react";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import { useProjectUpdates, ProjectUpdateStatus } from "@/hooks/projects";

interface ProjectUpdateFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
}

export function ProjectUpdateForm({ open, onOpenChange, projectId }: ProjectUpdateFormProps) {
  const { create } = useProjectUpdates(projectId);

  const [status, setStatus] = useState<ProjectUpdateStatus>("on_track");
  const [summary, setSummary] = useState("");
  const [progress, setProgress] = useState("");
  const [periodStart, setPeriodStart] = useState<Date | undefined>();
  const [periodEnd, setPeriodEnd] = useState<Date | undefined>();
  const [submitting, setSubmitting] = useState(false);

  const reset = () => {
    setStatus("on_track");
    setSummary("");
    setProgress("");
    setPeriodStart(undefined);
    setPeriodEnd(undefined);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!summary.trim()) return;
    setSubmitting(true);
    try {
      await create({
        status,
        summary,
        progress_pct: progress ? Math.max(0, Math.min(100, parseInt(progress, 10))) : null,
        period_start: periodStart ? format(periodStart, "yyyy-MM-dd") : null,
        period_end: periodEnd ? format(periodEnd, "yyyy-MM-dd") : null,
      });
      reset();
      onOpenChange(false);
    } catch {
      // toast handled in hook
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <WorkflowSheet
      open={open}
      onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }}
      size="md"
      title="Post project update"
      description="Share where the project stands. Updates show on the project Overview and trigger stakeholder notifications."
      onSubmit={handleSubmit}
      footer={
        <>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" disabled={submitting || !summary.trim()}>
            {submitting ? "Posting…" : "Post update"}
          </Button>
        </>
      }
    >
      <WorkflowSheetSection number={1} title="Status">
        <WorkflowSheetGrid>
          <WorkflowField label="Status" required>
            <Select value={status} onValueChange={(v: ProjectUpdateStatus) => setStatus(v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="on_track">🟢 On track</SelectItem>
                <SelectItem value="at_risk">🟡 At risk</SelectItem>
                <SelectItem value="off_track">🔴 Off track</SelectItem>
              </SelectContent>
            </Select>
          </WorkflowField>
          <WorkflowField label="Progress %" htmlFor="upd-progress">
            <Input
              id="upd-progress"
              type="number"
              min={0}
              max={100}
              value={progress}
              onChange={(e) => setProgress(e.target.value)}
              placeholder="0–100"
            />
          </WorkflowField>
        </WorkflowSheetGrid>
      </WorkflowSheetSection>

      <WorkflowSheetSection number={2} title="Update">
        <WorkflowField label="Summary" htmlFor="upd-summary" required>
          <Textarea
            id="upd-summary"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            rows={5}
            placeholder="What was achieved this period, what's next, any blockers…"
            required
            autoFocus
          />
        </WorkflowField>
      </WorkflowSheetSection>

      <WorkflowSheetSection number={3} title="Reporting period" subtitle="Optional — the date range this update covers.">
        <WorkflowSheetGrid>
          <WorkflowField label="Period start">
            <Popover>
              <PopoverTrigger asChild>
                <Button type="button" variant="outline"
                  className={cn("w-full justify-start text-left font-normal", !periodStart && "text-muted-foreground")}>
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {periodStart ? format(periodStart, "MMM d, yyyy") : "Optional"}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar mode="single" selected={periodStart} onSelect={setPeriodStart} initialFocus />
              </PopoverContent>
            </Popover>
          </WorkflowField>
          <WorkflowField label="Period end">
            <Popover>
              <PopoverTrigger asChild>
                <Button type="button" variant="outline"
                  className={cn("w-full justify-start text-left font-normal", !periodEnd && "text-muted-foreground")}>
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {periodEnd ? format(periodEnd, "MMM d, yyyy") : "Optional"}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar mode="single" selected={periodEnd} onSelect={setPeriodEnd} initialFocus />
              </PopoverContent>
            </Popover>
          </WorkflowField>
        </WorkflowSheetGrid>
      </WorkflowSheetSection>
    </WorkflowSheet>
  );
}
