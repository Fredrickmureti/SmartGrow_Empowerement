/**
 * AdminPlanForm — shared create/edit workspace form for subscription
 * plans. Replaces the legacy 2xl `<Dialog>` previously rendered by
 * `src/components/admin/SubscriptionPlansSettings.tsx`.
 *
 * All submit / mutation logic (base + per-user pricing, KES prices,
 * limits, trial/grace, marketing bullets) is preserved bit-for-bit —
 * only the presentation moved from a dialog to a routed workspace.
 */
import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Section } from "@/design-system";
import { AdminRecordForm, AdminFieldGrid, AdminFieldCell } from "@/apps/platform-admin";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Users } from "lucide-react";
import { useSubscriptionPlans, type SubscriptionPlan } from "@/hooks/useSubscriptionPlans";
import { useToast } from "@/hooks/use-toast";

export interface PlanFormData {
  name: string;
  description: string;
  price_monthly: string;
  price_yearly: string;
  price_per_user_monthly: string;
  price_per_user_yearly: string;
  price_monthly_kes: string;
  price_yearly_kes: string;
  features: string;
  max_users: string;
  max_organizations: string;
  max_storage_mb: string;
  grace_period_days: string;
  trial_period_days: string;
  is_popular: boolean;
  is_default: boolean;
  sort_order: string;
}

const DEFAULT_FORM: PlanFormData = {
  name: "",
  description: "",
  price_monthly: "",
  price_yearly: "",
  price_per_user_monthly: "",
  price_per_user_yearly: "",
  price_monthly_kes: "",
  price_yearly_kes: "",
  features: "",
  max_users: "",
  max_organizations: "1",
  max_storage_mb: "",
  grace_period_days: "7",
  trial_period_days: "14",
  is_popular: false,
  is_default: false,
  sort_order: "0",
};

function planToForm(plan: SubscriptionPlan): PlanFormData {
  return {
    name: plan.name,
    description: plan.description || "",
    price_monthly: plan.price_monthly.toString(),
    price_yearly: plan.price_yearly?.toString() || "",
    price_per_user_monthly: (plan as any).price_per_user_monthly?.toString() || "",
    price_per_user_yearly: (plan as any).price_per_user_yearly?.toString() || "",
    price_monthly_kes: plan.price_monthly_kes?.toString() || "",
    price_yearly_kes: plan.price_yearly_kes?.toString() || "",
    features: plan.features.join("\n"),
    max_users: plan.max_users?.toString() || "",
    max_organizations: (plan.max_organizations ?? 1).toString(),
    max_storage_mb: plan.max_storage_mb?.toString() || "",
    grace_period_days: plan.grace_period_days?.toString() || "7",
    trial_period_days: plan.trial_period_days?.toString() || "14",
    is_popular: plan.is_popular,
    is_default: plan.is_default,
    sort_order: plan.sort_order?.toString() || "0",
  };
}

function formToPlan(formData: PlanFormData): Partial<SubscriptionPlan> {
  const planData: Partial<SubscriptionPlan> = {
    name: formData.name,
    description: formData.description || null,
    price_monthly: parseFloat(formData.price_monthly) || 0,
    price_yearly: formData.price_yearly ? parseFloat(formData.price_yearly) : null,
    price_monthly_kes: formData.price_monthly_kes ? parseFloat(formData.price_monthly_kes) : null,
    price_yearly_kes: formData.price_yearly_kes ? parseFloat(formData.price_yearly_kes) : null,
    features: formData.features.split("\n").filter((f) => f.trim()),
    max_users: formData.max_users ? parseInt(formData.max_users) : null,
    max_organizations: parseInt(formData.max_organizations) || 1,
    max_storage_mb: formData.max_storage_mb ? parseInt(formData.max_storage_mb) : null,
    grace_period_days: formData.grace_period_days ? parseInt(formData.grace_period_days) : null,
    is_popular: formData.is_popular,
    is_default: formData.is_default,
    trial_period_days: formData.trial_period_days ? parseInt(formData.trial_period_days) : 14,
    sort_order: parseInt(formData.sort_order) || 0,
  };
  (planData as any).price_per_user_monthly = formData.price_per_user_monthly ? parseFloat(formData.price_per_user_monthly) : 0;
  (planData as any).price_per_user_yearly = formData.price_per_user_yearly ? parseFloat(formData.price_per_user_yearly) : 0;
  (planData as any).max_invoices_per_month = (parseFloat(formData.price_monthly) || 0) === 0 ? 50 : null;
  return planData;
}

function getPricingWarnings(form: PlanFormData): string[] {
  const warnings: string[] = [];
  const monthly = parseFloat(form.price_monthly) || 0;
  const yearly = parseFloat(form.price_yearly) || 0;
  if (yearly > 0 && yearly > monthly * 12) {
    warnings.push("Yearly price is higher than 12× monthly — customers won't choose yearly.");
  }
  if (monthly > 0 && yearly === 0) {
    warnings.push("No yearly price set. Consider offering a discount (e.g., 2 months free).");
  }
  if (monthly === 0 && yearly > 0) {
    warnings.push("Monthly is free but yearly is paid — this may confuse customers.");
  }
  return warnings;
}

const LIST_PATH = "/admin-management/plan-builder";

interface AdminPlanFormProps {
  mode: "create" | "edit";
  plan?: SubscriptionPlan | null;
}

export function AdminPlanForm({ mode, plan }: AdminPlanFormProps) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { createPlan, updatePlan, isSaving } = useSubscriptionPlans();

  const [formData, setFormData] = useState<PlanFormData>(
    plan ? planToForm(plan) : DEFAULT_FORM,
  );

  useEffect(() => {
    if (mode === "edit" && plan) setFormData(planToForm(plan));
  }, [plan, mode]);

  const warnings = getPricingWarnings(formData);

  const suggestYearly = () => {
    const m = parseFloat(formData.price_monthly) || 0;
    if (m > 0) setFormData((p) => ({ ...p, price_yearly: (m * 10).toFixed(0) }));
  };
  const suggestPerUserYearly = () => {
    const m = parseFloat(formData.price_per_user_monthly) || 0;
    if (m > 0) setFormData((p) => ({ ...p, price_per_user_yearly: (m * 10).toFixed(0) }));
  };
  const suggestYearlyKes = () => {
    const m = parseFloat(formData.price_monthly_kes) || 0;
    if (m > 0) setFormData((p) => ({ ...p, price_yearly_kes: (m * 10).toFixed(0) }));
  };

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!formData.name.trim()) {
      toast({ title: "Plan name is required", variant: "destructive" });
      return;
    }
    const payload = formToPlan(formData);
    if (mode === "edit" && plan) {
      await updatePlan(plan.id, payload);
    } else {
      await createPlan(payload);
    }
    navigate(LIST_PATH);
  };

  return (
    <AdminRecordForm
      mode={mode}
      entityLabel="Subscription plan"
      recordRef={plan?.name}
      meta="Set the plan details, pricing (base + per-user), and limits."
      cancelHref={LIST_PATH}
      onSubmit={handleSubmit}
      isSubmitting={isSaving}
      submitLabel={mode === "edit" ? "Update plan" : "Create plan"}
    >
      <Section title="Basic info">
        <AdminFieldGrid columns={2}>
          <div className="space-y-2">
            <Label htmlFor="name">Plan name *</Label>
            <Input id="name" value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })} placeholder="Professional" required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="sort_order">Sort order</Label>
            <Input id="sort_order" type="number" value={formData.sort_order} onChange={(e) => setFormData({ ...formData, sort_order: e.target.value })} placeholder="0" />
          </div>
          <AdminFieldCell span={2}>
            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Input id="description" value={formData.description} onChange={(e) => setFormData({ ...formData, description: e.target.value })} placeholder="Great for growing businesses" />
            </div>
          </AdminFieldCell>
        </AdminFieldGrid>
      </Section>

      <Section title="Base pricing — USD">
        <AdminFieldGrid columns={2}>
          <div className="space-y-2">
            <Label htmlFor="price_monthly">Monthly base price *</Label>
            <Input id="price_monthly" type="number" min="0" step="0.01" value={formData.price_monthly} onChange={(e) => setFormData({ ...formData, price_monthly: e.target.value })} placeholder="24" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="price_yearly">Yearly base price</Label>
            <div className="flex gap-2">
              <Input id="price_yearly" type="number" min="0" step="0.01" value={formData.price_yearly} onChange={(e) => setFormData({ ...formData, price_yearly: e.target.value })} placeholder="240" className="flex-1" />
              <Button type="button" variant="outline" size="sm" className="text-xs whitespace-nowrap" onClick={suggestYearly}>2mo free</Button>
            </div>
          </div>
        </AdminFieldGrid>
      </Section>

      <Section
        title="Per-user pricing — USD"
        description="Charged per active user beyond included."
      >
        <AdminFieldGrid columns={2}>
          <div className="space-y-2">
            <Label htmlFor="price_per_user_monthly" className="flex items-center gap-2">
              <Users className="h-3.5 w-3.5" /> Monthly per user
            </Label>
            <Input id="price_per_user_monthly" type="number" min="0" step="0.01" value={formData.price_per_user_monthly} onChange={(e) => setFormData({ ...formData, price_per_user_monthly: e.target.value })} placeholder="7" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="price_per_user_yearly">Yearly per user</Label>
            <div className="flex gap-2">
              <Input id="price_per_user_yearly" type="number" min="0" step="0.01" value={formData.price_per_user_yearly} onChange={(e) => setFormData({ ...formData, price_per_user_yearly: e.target.value })} placeholder="70" className="flex-1" />
              <Button type="button" variant="outline" size="sm" className="text-xs whitespace-nowrap" onClick={suggestPerUserYearly}>2mo free</Button>
            </div>
          </div>
        </AdminFieldGrid>
      </Section>

      <Section title="Pricing — KES (optional)">
        <AdminFieldGrid columns={2}>
          <div className="space-y-2">
            <Label htmlFor="price_monthly_kes">Monthly (KES)</Label>
            <Input id="price_monthly_kes" type="number" min="0" value={formData.price_monthly_kes} onChange={(e) => setFormData({ ...formData, price_monthly_kes: e.target.value })} placeholder="4500" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="price_yearly_kes">Yearly (KES)</Label>
            <div className="flex gap-2">
              <Input id="price_yearly_kes" type="number" min="0" value={formData.price_yearly_kes} onChange={(e) => setFormData({ ...formData, price_yearly_kes: e.target.value })} placeholder="43000" className="flex-1" />
              <Button type="button" variant="outline" size="sm" className="text-xs whitespace-nowrap" onClick={suggestYearlyKes}>2mo free</Button>
            </div>
          </div>
        </AdminFieldGrid>

        {warnings.length > 0 && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-800 p-3 space-y-1 mt-3">
            {warnings.map((w, i) => (
              <div key={i} className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400">
                <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <span>{w}</span>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Plan limits" description="Empty = unlimited. Invoices are unlimited for all paid plans; free plan is limited to 50/month.">
        <AdminFieldGrid columns={3}>
          <div className="space-y-2">
            <Label htmlFor="max_users">Max users</Label>
            <Input id="max_users" type="number" min="1" value={formData.max_users} onChange={(e) => setFormData({ ...formData, max_users: e.target.value })} placeholder="∞" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="max_organizations">Max organizations</Label>
            <Input id="max_organizations" type="number" min="1" value={formData.max_organizations} onChange={(e) => setFormData({ ...formData, max_organizations: e.target.value })} placeholder="1" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="max_storage_mb">Max storage (MB)</Label>
            <Input id="max_storage_mb" type="number" min="0" value={formData.max_storage_mb} onChange={(e) => setFormData({ ...formData, max_storage_mb: e.target.value })} placeholder="∞" />
          </div>
        </AdminFieldGrid>
      </Section>

      <Section title="Trial & grace period">
        <AdminFieldGrid columns={2}>
          <div className="space-y-2">
            <Label htmlFor="trial_period_days">Trial period (days)</Label>
            <Input id="trial_period_days" type="number" min="0" value={formData.trial_period_days} onChange={(e) => setFormData({ ...formData, trial_period_days: e.target.value })} placeholder="14" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="grace_period_days">Grace period (days)</Label>
            <Input id="grace_period_days" type="number" min="0" value={formData.grace_period_days} onChange={(e) => setFormData({ ...formData, grace_period_days: e.target.value })} placeholder="7" />
          </div>
        </AdminFieldGrid>
      </Section>

      <Section title="Marketing bullets" description="Shown on the pricing page. These do not enforce access — use Plan Limits and App Packaging for that.">
        <AdminFieldCell span={2}>
          <div className="space-y-2">
            <Label htmlFor="features">Feature bullets (one per line)</Label>
            <Textarea id="features" value={formData.features} onChange={(e) => setFormData({ ...formData, features: e.target.value })} placeholder={"Unlimited invoices\n10 team members\nPriority support"} rows={4} />
          </div>
          <div className="flex flex-col sm:flex-row gap-4 mt-3">
            <div className="flex items-center gap-2">
              <Switch id="is_popular" checked={formData.is_popular} onCheckedChange={(c) => setFormData({ ...formData, is_popular: c })} />
              <Label htmlFor="is_popular" className="text-sm">Popular badge</Label>
            </div>
            <div className="flex items-center gap-2">
              <Switch id="is_default" checked={formData.is_default} onCheckedChange={(c) => setFormData({ ...formData, is_default: c })} />
              <Label htmlFor="is_default" className="text-sm">Default plan</Label>
            </div>
          </div>
        </AdminFieldCell>
      </Section>
    </AdminRecordForm>
  );
}