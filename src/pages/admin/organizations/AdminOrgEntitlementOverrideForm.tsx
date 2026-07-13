/**
 * AdminOrgEntitlementOverrideForm — routed create/edit surface for
 * per-organization entitlement overrides. Composes `AdminRecordForm`
 * on `RecordFormShell`, matching every other admin CRUD workspace.
 *
 * Replaces the legacy inline `<Dialog>` mounted from
 * `src/components/admin/OrgEntitlementOverrides.tsx`, per the
 * Platform Admin four-pattern rule in
 * `docs/design-system/audit/platform-admin.md`.
 */
// @ts-nocheck — org_entitlement_overrides + platform_feature_catalog are admin-only tables
import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";
import {
  AdminRecordForm,
  AdminFieldGrid,
  AdminFieldCell,
} from "@/apps/platform-admin";
import { Section, LoadingState } from "@/design-system";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface Override {
  id: string;
  organization_id: string;
  override_type: "feature" | "app" | "limit";
  key: string;
  override_value: unknown;
  reason: string | null;
  expires_at: string | null;
  is_active: boolean;
}

interface AdminOrgEntitlementOverrideFormProps {
  mode: "create" | "edit";
}

const listPath = (orgId: string) =>
  `/admin-management/organizations/${orgId}`;

export function AdminOrgEntitlementOverrideForm({
  mode,
}: AdminOrgEntitlementOverrideFormProps) {
  const { id: organizationId, overrideId } = useParams<{
    id: string;
    overrideId?: string;
  }>();
  const navigate = useNavigate();

  // Load org name for context in the header.
  const { data: org } = useQuery({
    queryKey: ["admin-org-min", organizationId],
    enabled: !!organizationId,
    queryFn: async () => {
      const { data } = await (supabase.from as any)("organizations")
        .select("id,name")
        .eq("id", organizationId)
        .single();
      return data as { id: string; name: string } | null;
    },
  });

  // Load existing override for edit mode.
  const { data: existing, isLoading: existingLoading } = useQuery({
    queryKey: ["admin-org-entitlement-override", overrideId],
    enabled: mode === "edit" && !!overrideId,
    queryFn: async () => {
      const { data, error } = await (supabase.from as any)(
        "org_entitlement_overrides",
      )
        .select("*")
        .eq("id", overrideId)
        .single();
      if (error) throw error;
      return data as Override;
    },
  });

  // Known keys (features + apps) for autocomplete.
  const { data: knownKeys } = useQuery({
    queryKey: ["admin-known-entitlement-keys"],
    queryFn: async () => {
      const [{ data: featureData }, { data: appData }] = await Promise.all([
        (supabase.from as any)("platform_feature_catalog")
          .select("feature_key,label")
          .order("label"),
        (supabase.from as any)("plan_app_access").select("app_id"),
      ]);
      const uniqueApps = Array.from(
        new Set((appData ?? []).map((a: any) => a.app_id)),
      ).sort() as string[];
      return {
        features: (featureData ?? []).map((f: any) => ({
          key: f.feature_key,
          label: f.label,
        })) as Array<{ key: string; label: string }>,
        apps: uniqueApps,
      };
    },
  });

  const [overrideType, setOverrideType] = useState<
    "feature" | "app" | "limit"
  >("feature");
  const [key, setKey] = useState("");
  const [useCustomKey, setUseCustomKey] = useState(false);
  const [rawValue, setRawValue] = useState("true");
  const [reason, setReason] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (mode !== "edit" || !existing) return;
    setOverrideType(existing.override_type);
    setKey(existing.key);
    setUseCustomKey(true);
    if (existing.override_type === "limit") {
      const v = (existing.override_value as any)?.value ?? existing.override_value;
      setRawValue(String(v ?? ""));
    } else {
      const v =
        typeof existing.override_value === "boolean"
          ? existing.override_value
          : String(existing.override_value) === "true";
      setRawValue(v ? "true" : "false");
    }
    setReason(existing.reason ?? "");
    setExpiresAt(existing.expires_at ? existing.expires_at.slice(0, 16) : "");
  }, [mode, existing]);

  if (mode === "edit" && existingLoading) return <LoadingState />;

  const backHref = organizationId ? listPath(organizationId) : "/admin-management/organizations";

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!key.trim()) {
      toast.error("Key is required");
      return;
    }
    setIsSubmitting(true);
    try {
      let overrideValue: unknown;
      if (overrideType === "limit") {
        const parsed = parseInt(rawValue, 10);
        if (Number.isNaN(parsed)) {
          toast.error("Limit value must be a number");
          setIsSubmitting(false);
          return;
        }
        overrideValue = { value: parsed };
      } else {
        overrideValue = rawValue === "true";
      }

      if (mode === "edit" && overrideId) {
        const { error } = await (supabase.from as any)(
          "org_entitlement_overrides",
        )
          .update({
            override_type: overrideType,
            key: key.trim(),
            override_value: overrideValue,
            reason: reason || null,
            expires_at: expiresAt || null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", overrideId);
        if (error) throw error;
        toast.success("Override updated");
      } else {
        const { data: userRes } = await supabase.auth.getUser();
        const { error } = await (supabase.from as any)(
          "org_entitlement_overrides",
        ).insert({
          organization_id: organizationId,
          override_type: overrideType,
          key: key.trim(),
          override_value: overrideValue,
          reason: reason || null,
          expires_at: expiresAt || null,
          granted_by: userRes.user?.id,
        });
        if (error) throw error;
        toast.success("Override added");
      }
      navigate(backHref);
    } catch (err) {
      toast.error(normalizeError(err).message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AdminRecordForm
      mode={mode}
      entityLabel="Entitlement override"
      recordRef={
        mode === "edit" && existing ? existing.key : org?.name ?? undefined
      }
      meta={
        mode === "edit"
          ? `Update the exception applied to ${org?.name ?? "this organization"}.`
          : `Grant or revoke a specific feature, app, or limit for ${org?.name ?? "this organization"}.`
      }
      cancelHref={backHref}
      onSubmit={handleSubmit}
      isSubmitting={isSubmitting}
      submitLabel={mode === "edit" ? "Save changes" : "Add override"}
    >
      <Section
        title="Scope"
        description="Choose what kind of entitlement is being overridden."
      >
        <AdminFieldGrid columns={2}>
          <div className="space-y-2">
            <Label>Override type</Label>
            <Select
              value={overrideType}
              onValueChange={(v: any) => {
                setOverrideType(v);
                setKey("");
                setUseCustomKey(v === "limit");
                setRawValue(v === "limit" ? "" : "true");
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="feature">Feature</SelectItem>
                <SelectItem value="app">App</SelectItem>
                <SelectItem value="limit">Limit</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Key *</Label>
            {overrideType === "limit" || useCustomKey ? (
              <div className="space-y-1">
                <Input
                  value={key}
                  placeholder={
                    overrideType === "feature"
                      ? "e.g. payroll, crm"
                      : overrideType === "app"
                        ? "e.g. hr, pos"
                        : "e.g. max_users, max_invoices_per_month"
                  }
                  onChange={(e) => setKey(e.target.value)}
                  required
                />
                {overrideType !== "limit" && (
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="h-auto p-0 text-xs"
                    onClick={() => {
                      setUseCustomKey(false);
                      setKey("");
                    }}
                  >
                    ← Choose from known keys
                  </Button>
                )}
              </div>
            ) : (
              <div className="space-y-1">
                <Select value={key} onValueChange={setKey}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a key..." />
                  </SelectTrigger>
                  <SelectContent>
                    {overrideType === "feature" &&
                      (knownKeys?.features ?? []).map((f) => (
                        <SelectItem key={f.key} value={f.key}>
                          {f.label}
                          <span className="text-muted-foreground ml-1 text-xs">
                            ({f.key})
                          </span>
                        </SelectItem>
                      ))}
                    {overrideType === "app" &&
                      (knownKeys?.apps ?? []).map((appId) => (
                        <SelectItem key={appId} value={appId}>
                          {appId}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto p-0 text-xs"
                  onClick={() => setUseCustomKey(true)}
                >
                  Enter custom key →
                </Button>
              </div>
            )}
          </div>

          <AdminFieldCell span={2}>
            <div className="space-y-2">
              <Label>Value</Label>
              {overrideType === "limit" ? (
                <Input
                  type="number"
                  placeholder="e.g. 500"
                  value={rawValue}
                  onChange={(e) => setRawValue(e.target.value)}
                />
              ) : (
                <Select value={rawValue} onValueChange={setRawValue}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="true">Grant access</SelectItem>
                    <SelectItem value="false">Revoke access</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </div>
          </AdminFieldCell>
        </AdminFieldGrid>
      </Section>

      <Section
        title="Justification"
        description="Recorded on the audit trail for every entitlement decision."
      >
        <AdminFieldGrid columns={2}>
          <AdminFieldCell span={2}>
            <div className="space-y-2">
              <Label htmlFor="override-reason">Reason</Label>
              <Textarea
                id="override-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Enterprise deal, temporary unlock, grandfathered, etc."
                rows={3}
              />
            </div>
          </AdminFieldCell>
          <div className="space-y-2">
            <Label htmlFor="override-expires">Expires at (optional)</Label>
            <Input
              id="override-expires"
              type="datetime-local"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
            />
          </div>
        </AdminFieldGrid>
      </Section>
    </AdminRecordForm>
  );
}

export default AdminOrgEntitlementOverrideForm;
