/**
 * AdminLocalizationReturnEdit — admin adapter around the shared
 * `<ReturnEditorPage />` route. Full-viewport counterpart to
 * `AdminLocalizationCertificateEdit`; replaces the right-side drawer
 * that used to mount `<ReturnTemplateEditor />` for statutory returns.
 *
 * Reads/writes the pack row directly on
 * `localization_pack_return_templates`. Tenant override editing (Phase B
 * follow-up) will mount the same page with an override-writing adapter.
 */
import { useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { ReturnEditorPage } from "@/features/localization/routes";
import type { ReturnTemplateMetadata } from "@/features/localization/components/ReturnTemplateEditor";

const RETURN_TABLE = "localization_pack_return_templates";

interface TemplateRow {
  id: string;
  pack_id: string;
  code: string;
  display_name: string;
  body: any;
  layout: string | null;
  authority_id: string | null;
  legal_reference: string | null;
  regulation_citation: string | null;
  effective_date: string | null;
  sunset_date: string | null;
  submission_channel: string | null;
  submission_format: any;
  digital_signature_spec: any;
  acknowledgement_spec: any;
  api_endpoint_spec: any;
  approval_required: boolean | null;
  outputs: any;
}

interface PackRow {
  id: string;
  name: string;
  country_code: string;
  version: string;
}

const META_KEYS: Array<keyof ReturnTemplateMetadata> = [
  "authority_id", "legal_reference", "regulation_citation",
  "effective_date", "sunset_date", "submission_channel",
  "submission_format", "digital_signature_spec",
  "acknowledgement_spec", "api_endpoint_spec", "approval_required",
  "outputs",
];

export default function AdminLocalizationReturnEdit() {
  const { packId = "", templateId = "" } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const packQuery = useQuery({
    queryKey: ["admin-localization-pack", packId],
    enabled: !!packId,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("localization_packs")
        .select("id, name, country_code, version")
        .eq("id", packId)
        .maybeSingle();
      if (error) throw error;
      return data as PackRow | null;
    },
  });

  const templateQuery = useQuery({
    queryKey: ["pack-template", RETURN_TABLE, templateId],
    enabled: !!templateId,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from(RETURN_TABLE)
        .select("*")
        .eq("id", templateId)
        .maybeSingle();
      if (error) throw error;
      return data as TemplateRow | null;
    },
  });

  const update = useMutation({
    mutationFn: async (input: {
      body: any;
      layout: string | null;
      metadata?: ReturnTemplateMetadata;
    }) => {
      const patch: Record<string, any> = { body: input.body, layout: input.layout };
      if (input.metadata) {
        for (const k of META_KEYS) {
          if (k in input.metadata) patch[k] = input.metadata[k] as any;
        }
      }
      const { error } = await (supabase as any)
        .from(RETURN_TABLE)
        .update(patch)
        .eq("id", templateId);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pack-templates", RETURN_TABLE, packId] });
      qc.invalidateQueries({ queryKey: ["pack-template", RETURN_TABLE, templateId] });
      qc.invalidateQueries({ queryKey: ["pack-health", packId] });
      toast.success("Template saved");
    },
  });

  const backHref = `/admin-management/localization-packs?openPack=${packId}`;

  const initial = useMemo(() => {
    const t = templateQuery.data;
    if (!t) return null;
    return {
      template_code: t.code,
      body: t.body,
      layout: t.layout,
      notes: null,
      metadata: {
        authority_id: t.authority_id ?? null,
        legal_reference: t.legal_reference ?? null,
        regulation_citation: t.regulation_citation ?? null,
        effective_date: t.effective_date ?? null,
        sunset_date: t.sunset_date ?? null,
        submission_channel: t.submission_channel ?? null,
        submission_format: t.submission_format ?? null,
        digital_signature_spec: t.digital_signature_spec ?? null,
        acknowledgement_spec: t.acknowledgement_spec ?? null,
        api_endpoint_spec: t.api_endpoint_spec ?? null,
        approval_required: !!t.approval_required,
        outputs: t.outputs ?? null,
      },
    };
  }, [templateQuery.data]);

  const loading = packQuery.isLoading || templateQuery.isLoading;
  const notFound = !loading && (!packQuery.data || !templateQuery.data);

  const header = templateQuery.data && packQuery.data
    ? {
        templateName: templateQuery.data.display_name,
        templateCode: templateQuery.data.code,
        packName: packQuery.data.name,
        countryCode: packQuery.data.country_code,
        packVersion: packQuery.data.version,
      }
    : null;

  return (
    <ReturnEditorPage
      mode="admin"
      packId={packId}
      backHref={backHref}
      onCancel={() => navigate(backHref)}
      loading={loading}
      notFound={notFound}
      header={header}
      initial={initial}
      onSave={async (next) => {
        await update.mutateAsync({
          body: next.body,
          layout: next.layout,
          metadata: next.metadata,
        });
      }}
    />
  );
}
