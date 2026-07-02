import { useEffect, useState } from "react";
import { useHRPolicies } from "@/hooks/hr/useHRPolicies";
import { useOnboardingTemplates } from "@/hooks/useOnboarding";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Save } from "lucide-react";
import { ConfigPageHeader } from "./_ConfigShell";

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

export default function HRPoliciesPage() {
  const { policies, isLoading, save } = useHRPolicies();
  const { templates } = useOnboardingTemplates();
  const onboardingTpls = templates.filter((t) => t.template_type === "onboarding");
  const offboardingTpls = templates.filter((t) => t.template_type === "offboarding");

  const [form, setForm] = useState({
    probation_period_months: 3,
    notice_period_days: 30,
    leave_year_start_month: 1,
    employee_number_format: "EMP-{seq:0000}",
    employee_number_next_seq: 1,
    default_onboarding_template_id: null as string | null,
    default_offboarding_template_id: null as string | null,
    retire_age: null as number | null,
  });

  useEffect(() => {
    if (policies) {
      setForm({
        probation_period_months: policies.probation_period_months,
        notice_period_days: policies.notice_period_days,
        leave_year_start_month: policies.leave_year_start_month,
        employee_number_format: policies.employee_number_format,
        employee_number_next_seq: policies.employee_number_next_seq,
        default_onboarding_template_id: policies.default_onboarding_template_id,
        default_offboarding_template_id: policies.default_offboarding_template_id,
        retire_age: policies.retire_age,
      });
    }
  }, [policies]);

  if (isLoading) return <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin" /></div>;

  return (
    <div className="space-y-4">
      <ConfigPageHeader
        title="HR defaults"
        subtitle="Business-wide defaults that pre-fill contracts, employee number generation, and the auto-applied onboarding checklist."
        action={<Button size="sm" onClick={() => save.mutate(form)} disabled={save.isPending}>
          <Save className="h-4 w-4 mr-1" /> Save
        </Button>}
      />

      <div className="grid md:grid-cols-2 gap-4">
        <Card><CardContent className="p-4 space-y-3">
          <h3 className="text-sm font-semibold">Employment defaults</h3>
          <Field label="Probation period (months)">
            <Input type="number" min={0} max={24} value={form.probation_period_months}
              onChange={(e) => setForm((f) => ({ ...f, probation_period_months: +e.target.value || 0 }))} />
          </Field>
          <Field label="Notice period (days)">
            <Input type="number" min={0} max={365} value={form.notice_period_days}
              onChange={(e) => setForm((f) => ({ ...f, notice_period_days: +e.target.value || 0 }))} />
          </Field>
          <Field label="Retirement age (optional)">
            <Input type="number" min={50} max={100} value={form.retire_age ?? ""}
              onChange={(e) => setForm((f) => ({ ...f, retire_age: e.target.value ? +e.target.value : null }))} />
          </Field>
        </CardContent></Card>

        <Card><CardContent className="p-4 space-y-3">
          <h3 className="text-sm font-semibold">Leave & calendar</h3>
          <Field label="Leave year starts on">
            <Select value={String(form.leave_year_start_month)} onValueChange={(v) => setForm((f) => ({ ...f, leave_year_start_month: +v }))}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{MONTHS.map((m, i) => <SelectItem key={i} value={String(i+1)}>{m}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
        </CardContent></Card>

        <Card><CardContent className="p-4 space-y-3">
          <h3 className="text-sm font-semibold">Employee numbering</h3>
          <Field label="Format" hint="Use {seq:0000} for a zero-padded sequence.">
            <Input value={form.employee_number_format}
              onChange={(e) => setForm((f) => ({ ...f, employee_number_format: e.target.value }))} placeholder="EMP-{seq:0000}" />
          </Field>
          <Field label="Next sequence number">
            <Input type="number" min={1} value={form.employee_number_next_seq}
              onChange={(e) => setForm((f) => ({ ...f, employee_number_next_seq: +e.target.value || 1 }))} />
          </Field>
        </CardContent></Card>

        <Card><CardContent className="p-4 space-y-3">
          <h3 className="text-sm font-semibold">Default templates</h3>
          <p className="text-xs text-muted-foreground">
            New hires automatically receive the default onboarding checklist. Exit clearance uses the offboarding template.
          </p>
          <Field label="Default onboarding template">
            <Select value={form.default_onboarding_template_id ?? "none"}
              onValueChange={(v) => setForm((f) => ({ ...f, default_onboarding_template_id: v === "none" ? null : v }))}>
              <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">— none —</SelectItem>
                {onboardingTpls.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Default offboarding template">
            <Select value={form.default_offboarding_template_id ?? "none"}
              onValueChange={(v) => setForm((f) => ({ ...f, default_offboarding_template_id: v === "none" ? null : v }))}>
              <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">— none —</SelectItem>
                {offboardingTpls.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
        </CardContent></Card>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
