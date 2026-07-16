/**
 * AdminLocalizationCertificateEdit — thin admin wrapper around the
 * shared `<CertificateEditorPage />` route (see
 * `src/features/localization/routes/CertificateEditorPage.tsx`).
 *
 * Owns only the admin-side data adapter: it reads the pack row directly
 * from `localization_pack_certificate_templates` and writes the same row
 * on save. Tenant editing mounts the SAME page shell with an
 * override-writing adapter (Phase 2).
 *
 * The old page shell (header + loading states) used to live here. It was
 * hoisted into the shared feature so admin and tenant cannot drift.
 */
import { useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { CertificateEditorPage } from "@/features/localization/routes";
import type { CertificateTemplateMetadata } from "@/features/localization/components/CertificateTemplateEditor";

const CERT_TABLE = "localization_pack_certificate_templates";

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
  revision_notes: string | null;
  issued_to: "employee" | "employer" | "both" | null;
  approval_required: boolean | null;
  outputs: any;
}

interface PackRow {
  id: string;
  name: string;
  country_code: string;
  version: string;
}

const META_KEYS: Array<keyof CertificateTemplateMetadata> = [
  "authority_id", "legal_reference", "regulation_citation",
  "effective_date", "sunset_date", "revision_notes", "issued_to",
  "approval_required", "outputs",
];

export default function AdminLocalizationCertificateEdit() {
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
    queryKey: ["pack-template", CERT_TABLE, templateId],
    enabled: !!templateId,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from(CERT_TABLE)
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
      metadata?: CertificateTemplateMetadata;
    }) => {
      const patch: Record<string, any> = { body: input.body, layout: input.layout };
      if (input.metadata) {
        for (const k of META_KEYS) {
          if (k in input.metadata) patch[k] = input.metadata[k] as any;
        }
      }
      const { error } = await (supabase as any)
        .from(CERT_TABLE)
        .update(patch)
        .eq("id", templateId);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pack-templates", CERT_TABLE, packId] });
      qc.invalidateQueries({ queryKey: ["pack-template", CERT_TABLE, templateId] });
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
        revision_notes: t.revision_notes ?? null,
        issued_to: (t.issued_to as any) ?? "employee",
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
    <CertificateEditorPage
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
