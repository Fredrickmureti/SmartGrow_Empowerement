// @ts-nocheck - Admin tables not in auto-generated types
/**
 * AdminAppCatalogForm — edit workspace for a `platform_apps` entry.
 * Mounted on `AdminRecordForm` per `docs/design-system/audit/platform-admin.md`.
 *
 * The App Catalog list retains inline row switches for the frequent
 * single-field toggles (Available / Signup / Core / Plan / Category),
 * which the doc allows. This workspace is the destination when a user
 * needs to edit multiple fields at once (name, description, sort order,
 * trial config) — the enterprise-scale multi-field edit surface.
 */
import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Section } from "@/design-system";
import { AdminRecordForm, AdminFieldGrid, AdminFieldCell } from "@/apps/platform-admin";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";

export interface PlatformAppRecord {
  id: string;
  name: string;
  description: string | null;
  category: string;
  required_plan: string;
  is_available: boolean;
  is_core: boolean;
  is_visible_in_signup: boolean;
  is_free_trial: boolean;
  trial_days: number | null;
  sort_order: number;
}

const CATEGORY_OPTIONS = [
  { value: "core", label: "Core" },
  { value: "operations", label: "Operations" },
  { value: "analytics", label: "Analytics" },
  { value: "productivity", label: "Productivity" },
  { value: "integrations", label: "Integrations" },
  { value: "platform", label: "Platform" },
];

const PLAN_OPTIONS = [
  { value: "starter", label: "Starter" },
  { value: "professional", label: "Professional" },
  { value: "enterprise", label: "Enterprise" },
];

const LIST_PATH = "/admin-management/app-catalog";

interface Props {
  app: PlatformAppRecord;
}

export function AdminAppCatalogForm({ app }: Props) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [form, setForm] = useState({
    name: app.name,
    description: app.description ?? "",
    category: app.category,
    required_plan: app.required_plan,
    is_available: app.is_available,
    is_core: app.is_core,
    is_visible_in_signup: app.is_visible_in_signup,
    is_free_trial: app.is_free_trial,
    trial_days: app.trial_days ?? 0,
    sort_order: app.sort_order,
  });
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    setForm({
      name: app.name,
      description: app.description ?? "",
      category: app.category,
      required_plan: app.required_plan,
      is_available: app.is_available,
      is_core: app.is_core,
      is_visible_in_signup: app.is_visible_in_signup,
      is_free_trial: app.is_free_trial,
      trial_days: app.trial_days ?? 0,
      sort_order: app.sort_order,
    });
  }, [app]);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!form.name.trim()) {
      toast({ title: "Name is required", variant: "destructive" });
      return;
    }
    setIsSubmitting(true);
    try {
      const { error } = await (supabase.from("platform_apps") as any)
        .update({
          name: form.name,
          description: form.description || null,
          category: form.category,
          required_plan: form.required_plan,
          is_available: form.is_available,
          is_core: form.is_core,
          is_visible_in_signup: form.is_visible_in_signup,
          is_free_trial: form.is_free_trial,
          trial_days: form.is_free_trial ? form.trial_days : null,
          sort_order: form.sort_order,
        })
        .eq("id", app.id);
      if (error) throw error;
      toast({ title: "App updated" });
      navigate(LIST_PATH);
    } catch (err: any) {
      toast({
        title: "Error",
        description: normalizeError(err).message,
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AdminRecordForm
      mode="edit"
      entityLabel="App"
      recordRef={app.id}
      meta="Edit how this app appears in the catalog, its plan gating, and trial config. Individual toggles can also be flipped inline from the catalog list."
      cancelHref={LIST_PATH}
      onSubmit={handleSubmit}
      isSubmitting={isSubmitting}
      submitLabel="Save changes"
    >
      <Section title="Identity" description="Public label and description shown to tenants.">
        <AdminFieldGrid columns={2}>
          <div className="space-y-2">
            <Label htmlFor="app-name">Name *</Label>
            <Input
              id="app-name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="app-order">Sort order</Label>
            <Input
              id="app-order"
              type="number"
              value={form.sort_order}
              onChange={(e) =>
                setForm({ ...form, sort_order: parseInt(e.target.value) || 0 })
              }
            />
          </div>
          <AdminFieldCell span={2}>
            <div className="space-y-2">
              <Label htmlFor="app-desc">Description</Label>
              <Textarea
                id="app-desc"
                placeholder="Shown on the marketplace card"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                rows={3}
              />
            </div>
          </AdminFieldCell>
        </AdminFieldGrid>
      </Section>

      <Section title="Classification & gating" description="Where this app lives in the catalog and which plan it requires.">
        <AdminFieldGrid columns={2}>
          <div className="space-y-2">
            <Label>Category</Label>
            <Select
              value={form.category}
              onValueChange={(v) => setForm({ ...form, category: v })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CATEGORY_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Required plan</Label>
            <Select
              value={form.required_plan}
              onValueChange={(v) => setForm({ ...form, required_plan: v })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PLAN_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </AdminFieldGrid>
      </Section>

      <Section title="Visibility" description="Controls whether the app appears in the marketplace and during tenant signup.">
        <div className="space-y-4">
          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <Label htmlFor="tog-available" className="cursor-pointer">
                Available in marketplace
              </Label>
              <p className="text-xs text-muted-foreground">
                Tenants can install this app from their marketplace.
              </p>
            </div>
            <Switch
              id="tog-available"
              checked={form.is_available}
              onCheckedChange={(v) => setForm({ ...form, is_available: v })}
            />
          </div>
          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <Label htmlFor="tog-signup" className="cursor-pointer">
                Visible during signup
              </Label>
              <p className="text-xs text-muted-foreground">
                Suggested to new tenants in the onboarding wizard.
              </p>
            </div>
            <Switch
              id="tog-signup"
              checked={form.is_visible_in_signup}
              onCheckedChange={(v) =>
                setForm({ ...form, is_visible_in_signup: v })
              }
            />
          </div>
          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <Label htmlFor="tog-core" className="cursor-pointer">
                Core app
              </Label>
              <p className="text-xs text-muted-foreground">
                Auto-installed on every tenant. Cannot be uninstalled.
              </p>
            </div>
            <Switch
              id="tog-core"
              checked={form.is_core}
              onCheckedChange={(v) => setForm({ ...form, is_core: v })}
            />
          </div>
        </div>
      </Section>

      <Section title="Free trial" description="Optional trial window for tenants below the required plan.">
        <AdminFieldGrid columns={2}>
          <div className="flex items-center justify-between rounded-lg border p-3 sm:col-span-2">
            <div>
              <Label htmlFor="tog-trial" className="cursor-pointer">
                Offer free trial
              </Label>
              <p className="text-xs text-muted-foreground">
                Grants the app for a fixed number of days regardless of plan.
              </p>
            </div>
            <Switch
              id="tog-trial"
              checked={form.is_free_trial}
              onCheckedChange={(v) => setForm({ ...form, is_free_trial: v })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="trial-days">Trial length (days)</Label>
            <Input
              id="trial-days"
              type="number"
              min={0}
              disabled={!form.is_free_trial}
              value={form.trial_days}
              onChange={(e) =>
                setForm({ ...form, trial_days: parseInt(e.target.value) || 0 })
              }
            />
          </div>
        </AdminFieldGrid>
      </Section>
    </AdminRecordForm>
  );
}
