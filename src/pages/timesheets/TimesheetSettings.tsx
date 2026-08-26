/**
 * TimesheetSettings — admin UI for the org-level timesheet_settings row.
 * Every toggle here is consumed at runtime by the entry form, the hook,
 * or server-side triggers / RPCs. Nothing is decorative.
 */
import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { useTimesheetSettings } from "@/hooks/timesheets";

const FREQUENCIES = ["daily", "weekly", "biweekly", "monthly"] as const;
const WEEK_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Used when the org has no timesheet_settings row yet; saving persists these. */
const DEFAULT_SETTINGS = {
  submission_frequency: "weekly",
  week_start_day: 1,
  require_project: false,
  require_task: false,
  require_approval: true,
  default_billable: false,
  minimum_hours_per_day: null,
  maximum_hours_per_day: null,
  overtime_threshold_daily: null,
  overtime_threshold_weekly: null,
  
  block_on_time_off_overlap: false,
};

export default function TimesheetSettings() {
  const { settings, isLoading, save } = useTimesheetSettings();
  const [draft, setDraft] = useState<any>(null);

  useEffect(() => {
    if (isLoading) return;
    setDraft({ ...DEFAULT_SETTINGS, ...(settings ?? {}) });
  }, [settings, isLoading]);

  if (isLoading || !draft) {
    return <div className="p-8 text-center text-sm text-muted-foreground">Loading settings…</div>;
  }

  const set = (k: string, v: any) => setDraft((d: any) => ({ ...d, [k]: v }));

  return (
    <div className="space-y-4 p-4 sm:p-6 lg:p-8 max-w-4xl xl:max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Timesheet Settings</h1>
        <p className="text-sm text-muted-foreground">
          These rules are enforced both in the entry form and on the server.
        </p>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Submission</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <Label>Frequency</Label>
            <Select
              value={draft.submission_frequency}
              onValueChange={(v) => set("submission_frequency", v)}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {FREQUENCIES.map((f) => <SelectItem key={f} value={f}>{f}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Week starts on</Label>
            <Select
              value={String(draft.week_start_day ?? 1)}
              onValueChange={(v) => set("week_start_day", Number(v))}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {WEEK_DAYS.map((d, i) => <SelectItem key={d} value={String(i)}>{d}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <Toggle label="Approval required" checked={!!draft.require_approval} onChange={(v) => set("require_approval", v)} />
          <Toggle label="Project required" checked={!!draft.require_project} onChange={(v) => set("require_project", v)} />
          <Toggle label="Task required" checked={!!draft.require_task} onChange={(v) => set("require_task", v)} />
          <Toggle label="Default new entries to billable" checked={!!draft.default_billable} onChange={(v) => set("default_billable", v)} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Limits & overtime</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <NumberField label="Min hours per day" value={draft.minimum_hours_per_day} onChange={(v) => set("minimum_hours_per_day", v)} />
          <NumberField label="Max hours per day" value={draft.maximum_hours_per_day} onChange={(v) => set("maximum_hours_per_day", v)} />
          <NumberField label="Overtime threshold (daily)" value={draft.overtime_threshold_daily} onChange={(v) => set("overtime_threshold_daily", v)} />
          <NumberField label="Overtime threshold (weekly)" value={draft.overtime_threshold_weekly} onChange={(v) => set("overtime_threshold_weekly", v)} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Approvals & overlaps</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <Toggle
            label="Allow self-approval"
            description="If off, the server will refuse approval requests on a user's own submissions."
            checked={!!draft.allow_self_approval}
            onChange={(v) => set("allow_self_approval", v)}
          />
          <Toggle
            label="Block entries overlapping approved time off"
            description="If off, overlap is only flagged in the UI. If on, the entry will be rejected on save."
            checked={!!draft.block_on_time_off_overlap}
            onChange={(v) => set("block_on_time_off_overlap", v)}
          />
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={() => save(draft)}>Save settings</Button>
      </div>
    </div>
  );
}

function Toggle({
  label, description, checked, onChange,
}: { label: string; description?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border p-3">
      <div>
        <div className="text-sm font-medium">{label}</div>
        {description && <div className="text-xs text-muted-foreground mt-0.5">{description}</div>}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

function NumberField({
  label, value, onChange,
}: { label: string; value: number | null; onChange: (v: number | null) => void }) {
  return (
    <div>
      <Label>{label}</Label>
      <Input
        type="number"
        step="0.25"
        min="0"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
      />
    </div>
  );
}
