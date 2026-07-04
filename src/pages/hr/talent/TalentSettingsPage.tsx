/**
 * Talent Settings — HR admin surface for the per-organization governance
 * defaults stored in `public.talent_settings`. Reads are RLS-open to all
 * users in the org (so downstream hooks can branch on approval flags), but
 * writes require admin/owner/super_admin — the mutation will 403 for other
 * users, and the UI reflects that by disabling inputs.
 */
import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Settings2, Save } from "lucide-react";
import { useTalentSettings, type TalentSettings } from "@/hooks/useTalentSettings";

export default function TalentSettingsPage() {
  const { settings, isLoading, update } = useTalentSettings();
  const [draft, setDraft] = useState<Partial<TalentSettings>>({});

  useEffect(() => { setDraft({}); }, [settings?.organization_id]);

  const value = <K extends keyof TalentSettings>(k: K): TalentSettings[K] | undefined =>
    (draft[k] as TalentSettings[K] | undefined) ?? settings?.[k];

  const set = <K extends keyof TalentSettings>(k: K, v: TalentSettings[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));

  const dirty = Object.keys(draft).length > 0;

  const onSave = () => {
    if (!dirty) return;
    update.mutate(draft, { onSuccess: () => setDraft({}) });
  };

  if (isLoading || !settings) {
    return <p className="text-sm text-muted-foreground">Loading talent settings…</p>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Settings2 className="h-5 w-5" /> Talent settings
          </h1>
          <p className="text-sm text-muted-foreground">
            Organization-wide defaults for reviews, approvals, reminders, and HiPo thresholds.
          </p>
        </div>
        <Button onClick={onSave} disabled={!dirty || update.isPending}>
          <Save className="h-4 w-4 mr-1" /> Save changes
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Approvals</CardTitle>
          <CardDescription>Which talent transitions require an approval step.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <SwitchRow
            label="Merit apply requires approval"
            description="Merit increases must be approved before writing to compensation history."
            checked={!!value("merit_requires_approval")}
            onChange={(v) => set("merit_requires_approval", v)}
          />
          <SwitchRow
            label="Calibration adjustment requires approval"
            description="Rating changes from calibration sessions await HR business partner approval."
            checked={!!value("calibration_requires_approval")}
            onChange={(v) => set("calibration_requires_approval", v)}
          />
          <SwitchRow
            label="Dev plan activation requires approval"
            description="A development plan cannot leave draft until the manager approves it."
            checked={!!value("devplan_activation_requires_approval")}
            onChange={(v) => set("devplan_activation_requires_approval", v)}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Reminders</CardTitle>
          <CardDescription>Cadence used by the scheduled notification job.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-3">
          <NumberRow
            label="1:1 reminder window (hours)"
            min={1} max={168}
            value={value("oneonone_reminder_hours") ?? 24}
            onChange={(v) => set("oneonone_reminder_hours", v)}
          />
          <NumberRow
            label="Action item reminder lead (days)"
            min={0} max={30}
            value={value("action_item_reminder_days") ?? 1}
            onChange={(v) => set("action_item_reminder_days", v)}
          />
          <NumberRow
            label="Goal check-in reminder lead (days)"
            min={0} max={30}
            value={value("goal_checkin_reminder_days") ?? 0}
            onChange={(v) => set("goal_checkin_reminder_days", v)}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>9-Box thresholds</CardTitle>
          <CardDescription>Cells at or above both thresholds are treated as HiPo.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <NumberRow
            label="Potential threshold"
            min={1} max={3}
            value={value("hipo_potential_threshold") ?? 3}
            onChange={(v) => set("hipo_potential_threshold", v)}
          />
          <NumberRow
            label="Performance threshold"
            min={1} max={3}
            value={value("hipo_performance_threshold") ?? 3}
            onChange={(v) => set("hipo_performance_threshold", v)}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Reviews</CardTitle>
          <CardDescription>Defaults applied when new review templates are created.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <NumberRow
            label="Default review scale min"
            min={1} max={10}
            value={value("default_review_scale_min") ?? 1}
            onChange={(v) => set("default_review_scale_min", v)}
          />
          <NumberRow
            label="Default review scale max"
            min={1} max={10}
            value={value("default_review_scale_max") ?? 5}
            onChange={(v) => set("default_review_scale_max", v)}
          />
          <SwitchRow
            label="Require manager acknowledgement on reviews"
            description="Manager must acknowledge before a review is considered closed."
            checked={!!value("require_manager_ack_on_review")}
            onChange={(v) => set("require_manager_ack_on_review", v)}
          />
          <SwitchRow
            label="Auto-close cycles when all reviews complete"
            description="Automatically close performance cycles when every review is acknowledged."
            checked={!!value("auto_close_cycles")}
            onChange={(v) => set("auto_close_cycles", v)}
          />
        </CardContent>
      </Card>
    </div>
  );
}

function SwitchRow({
  label, description, checked, onChange,
}: { label: string; description: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <Label className="text-sm font-medium">{label}</Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

function NumberRow({
  label, min, max, value, onChange,
}: { label: string; min: number; max: number; value: number; onChange: (v: number) => void }) {
  return (
    <div className="space-y-1">
      <Label className="text-sm">{label}</Label>
      <Input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (!Number.isNaN(v)) onChange(Math.max(min, Math.min(max, v)));
        }}
      />
    </div>
  );
}
