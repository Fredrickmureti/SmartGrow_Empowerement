/**
 * AdminFeatureForm — shared create/edit workspace form for entries in
 * the platform feature catalog. Mounted on `AdminRecordForm`.
 * Replaces the legacy inline `<Dialog>` previously rendered by
 * `src/components/admin/FeatureCatalogSettings.tsx`.
 */
import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Section } from "@/design-system";
import { AdminRecordForm, AdminFieldGrid, AdminFieldCell } from "@/apps/platform-admin";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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

export interface CatalogFeature {
  id: string;
  feature_key: string;
  label: string;
  category: string;
  description: string | null;
  sort_order: number;
}

export const FEATURE_CATEGORIES = [
  { value: "core", label: "Core Features" },
  { value: "pos", label: "Point of Sale" },
  { value: "reports", label: "Reports" },
  { value: "advanced", label: "Advanced Features" },
  { value: "operations", label: "Operations & HR" },
  { value: "sales", label: "Sales Documents" },
  { value: "purchasing", label: "Purchasing" },
  { value: "intelligence", label: "Intelligence" },
  { value: "limits", label: "Usage Limits" },
  { value: "erp", label: "ERP Suite" },
  { value: "extras", label: "Extras" },
];

const LIST_PATH = "/admin-management/plan-builder";

interface AdminFeatureFormProps {
  mode: "create" | "edit";
  feature?: CatalogFeature | null;
}

export function AdminFeatureForm({ mode, feature }: AdminFeatureFormProps) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [form, setForm] = useState({
    feature_key: feature?.feature_key ?? "",
    label: feature?.label ?? "",
    category: feature?.category ?? "core",
    description: feature?.description ?? "",
    sort_order: feature?.sort_order ?? 0,
  });
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (mode === "edit" && feature) {
      setForm({
        feature_key: feature.feature_key,
        label: feature.label,
        category: feature.category,
        description: feature.description ?? "",
        sort_order: feature.sort_order,
      });
    }
  }, [feature, mode]);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!form.feature_key.trim() || !form.label.trim()) {
      toast({
        title: "Key and label are required",
        variant: "destructive",
      });
      return;
    }
    setIsSubmitting(true);
    try {
      if (mode === "edit" && feature) {
        const { error } = await (supabase.from as any)("platform_feature_catalog")
          .update({
            label: form.label,
            category: form.category,
            description: form.description || null,
            sort_order: form.sort_order,
          })
          .eq("id", feature.id);
        if (error) throw error;
        toast({ title: "Feature updated" });
      } else {
        const { error } = await (supabase.from as any)("platform_feature_catalog")
          .insert({
            feature_key: form.feature_key,
            label: form.label,
            category: form.category,
            description: form.description || null,
            sort_order: form.sort_order,
          });
        if (error) throw error;
        toast({ title: "Feature created" });
      }
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
      mode={mode}
      entityLabel="Feature"
      recordRef={feature?.feature_key}
      meta={
        mode === "edit"
          ? "Update feature details. The feature key cannot be changed."
          : "Define a new feature for the platform catalog."
      }
      cancelHref={LIST_PATH}
      onSubmit={handleSubmit}
      isSubmitting={isSubmitting}
      submitLabel={mode === "edit" ? "Save changes" : "Create feature"}
    >
      <Section title="Identity" description="How this feature is referenced in code and shown to admins.">
        <AdminFieldGrid columns={2}>
          <div className="space-y-2">
            <Label htmlFor="feature-key">Feature key *</Label>
            <Input
              id="feature-key"
              placeholder="e.g. recurring_invoices"
              value={form.feature_key}
              onChange={(e) => setForm({ ...form, feature_key: e.target.value })}
              disabled={mode === "edit"}
              className="font-mono text-sm"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="feature-label">Display label *</Label>
            <Input
              id="feature-label"
              placeholder="e.g. Recurring Invoices"
              value={form.label}
              onChange={(e) => setForm({ ...form, label: e.target.value })}
              required
            />
          </div>
          <div className="space-y-2">
            <Label>Category</Label>
            <Select value={form.category} onValueChange={(v) => setForm({ ...form, category: v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {FEATURE_CATEGORIES.map((c) => (
                  <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="feature-order">Sort order</Label>
            <Input
              id="feature-order"
              type="number"
              value={form.sort_order}
              onChange={(e) =>
                setForm({ ...form, sort_order: parseInt(e.target.value) || 0 })
              }
            />
          </div>
          <AdminFieldCell span={2}>
            <div className="space-y-2">
              <Label htmlFor="feature-desc">Description</Label>
              <Textarea
                id="feature-desc"
                placeholder="Optional description"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                rows={3}
              />
            </div>
          </AdminFieldCell>
        </AdminFieldGrid>
      </Section>
    </AdminRecordForm>
  );
}