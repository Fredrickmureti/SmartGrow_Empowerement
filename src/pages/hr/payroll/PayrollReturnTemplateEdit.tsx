/**
 * Tenant statutory-return template editor — thin wrapper around the
 * shared `<ReturnEditorPage />` route with `mode="tenant"` and an
 * override-writing adapter. Mirrors `PayrollCertificateTemplateEdit`
 * so tenant and admin now share the SAME full-page editor shell for
 * BOTH artefact types.
 *
 * Phase A of the localization preview consolidation (see
 * .lovable/plan.md): replaces the inline `WorkflowSheet` mount that
 * previously opened `ReturnTemplateEditor` in a 2xl dialog.
 */
import { useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { ReturnEditorPage } from "@/features/localization/routes";
import {
  useTemplateOverrides,
  useSaveTemplateOverride,
} from "@/hooks/payroll/useTemplateOverrides";
import { normalizeError } from "@/services/resilience";

interface PackTemplateRow {
  id: string;
  pack_id: string | null;
  code: string;
  display_name: string;
  description: string | null;
  body: any;
  updated_at: string;
}

interface PackRow {
  id: string;
  name: string;
  country_code: string;
  version: string;
}

export default function PayrollReturnTemplateEdit() {
  const { code = "" } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const overridesQ = useTemplateOverrides("return");
  const save = useSaveTemplateOverride("return");

  const backHref = "/hr/payroll/configuration/templates";

  const packTemplateQ = useQuery({
    queryKey: ["tenant-return-template-by-code", code],
    enabled: !!code,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("localization_pack_return_templates")
        .select("id, pack_id, code, display_name, description, body, updated_at")
        .eq("code", code)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data as PackTemplateRow | null;
    },
  });

  const packQ = useQuery({
    queryKey: ["tenant-return-template-pack", packTemplateQ.data?.pack_id],
    enabled: !!packTemplateQ.data?.pack_id,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("localization_packs")
        .select("id, name, country_code, version")
        .eq("id", packTemplateQ.data!.pack_id)
        .maybeSingle();
      if (error) throw error;
      return data as PackRow | null;
    },
  });

  const override = useMemo(
    () => (overridesQ.data ?? []).find((o) => o.template_code === code) ?? null,
    [overridesQ.data, code],
  );

  const stale =
    override?.base_template_updated_at &&
    packTemplateQ.data?.updated_at &&
    new Date(override.base_template_updated_at).getTime() !==
      new Date(packTemplateQ.data.updated_at).getTime();

  const initial = useMemo(() => {
    const p = packTemplateQ.data;
    if (!p) return null;
    return {
      template_code: p.code,
      body: override?.body ?? p.body,
      layout: null,
      notes: override?.notes ?? "",
      // Tenants can't edit legal metadata — omit to hide the panel.
      metadata: undefined,
    };
  }, [packTemplateQ.data, override]);

  const loading = packTemplateQ.isLoading || overridesQ.isLoading;
  const notFound = !loading && !packTemplateQ.data;

  const statusBadge = !packTemplateQ.data ? null : !override ? (
    <Badge variant="secondary" className="text-[10px]">Pack default</Badge>
  ) : stale ? (
    <Badge variant="destructive" className="gap-1 text-[10px]">
      <AlertTriangle className="h-3 w-3" /> Out of date · v{override.override_version}
    </Badge>
  ) : (
    <Badge className="text-[10px]">Customized · v{override.override_version}</Badge>
  );

  const header = packTemplateQ.data
    ? {
        templateName: packTemplateQ.data.display_name,
        templateCode: packTemplateQ.data.code,
        packName: packQ.data?.name ?? null,
        countryCode: packQ.data?.country_code ?? null,
        packVersion: packQ.data?.version ?? null,
        statusBadge,
      }
    : null;

  return (
    <ReturnEditorPage
      mode="tenant"
      packId={packTemplateQ.data?.pack_id ?? ""}
      backHref={backHref}
      onCancel={() => navigate(backHref)}
      loading={loading}
      notFound={notFound}
      header={header}
      initial={initial}
      onSave={async (next) => {
        const p = packTemplateQ.data;
        if (!p) return;
        const reason = (next.notes ?? "").trim();
        if (reason.length < 10) {
          toast.error("Reason (notes) must be at least 10 characters — used for the audit log.");
          throw new Error("Reason too short");
        }
        try {
          await save.mutateAsync({
            template_code: p.code,
            body: next.body,
            layout: null,
            notes: reason,
            base_pack_id: p.pack_id,
            base_template_updated_at: p.updated_at,
          });
          qc.invalidateQueries({ queryKey: ["payroll", "template-overrides", "return"] });
          toast.success("Override saved");
        } catch (e: any) {
          toast.error(normalizeError(e).message ?? "Failed to save override");
          throw e;
        }
      }}
    />
  );
}