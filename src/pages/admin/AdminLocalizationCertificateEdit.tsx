/**
 * AdminLocalizationCertificateEdit — dedicated full-page route for editing
 * a single certificate template inside a localization pack.
 *
 * Phase 2.1 of the certificate publishing audit: the certificate editor
 * used to open inside a right-side `WorkflowSheet` drawer, which cramped
 * the Canvas + Inspector + Metadata into a modal panel. Publishers now
 * navigate to `/admin-management/localization-packs/:packId/certificates/:templateId/edit`
 * and get the whole viewport for the design surface, with a page-level
 * header and back link — the same treatment tenants get for creating an
 * invoice.
 *
 * The Sheet-based path is retained for return templates and non-admin
 * mounts; only admin-mode certificate editing routes here (see
 * `PackEntityTabs`).
 */
import { useMemo } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CertificateTemplateEditor, type CertificateTemplateMetadata } from "@/features/localization/components/CertificateTemplateEditor";

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

  return (
    <div className="flex h-screen min-h-0 flex-col bg-background">
      {/* Page header — this is a dedicated page, not a drawer. */}
      <header className="flex items-center justify-between gap-3 border-b bg-card/60 px-4 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <Button asChild variant="ghost" size="sm" className="h-8">
            <Link to={backHref}>
              <ArrowLeft className="mr-1 h-4 w-4" />
              Back to pack
            </Link>
          </Button>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">
              {templateQuery.data?.display_name ?? "Certificate template"}
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {packQuery.data && (
                <>
                  <Badge variant="outline" className="text-[10px]">
                    {packQuery.data.country_code}
                  </Badge>
                  <span className="truncate">{packQuery.data.name}</span>
                  <span>·</span>
                  <span>v{packQuery.data.version}</span>
                </>
              )}
              {templateQuery.data && (
                <>
                  <span>·</span>
                  <code className="text-[10px]">{templateQuery.data.code}</code>
                </>
              )}
            </div>
          </div>
        </div>
      </header>

      <main className="flex min-h-0 flex-1 flex-col">
        {loading && (
          <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading template…
          </div>
        )}
        {notFound && (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            Template not found. <Link className="ml-2 underline" to={backHref}>Return to pack</Link>
          </div>
        )}
        {!loading && !notFound && initial && (
          <CertificateTemplateEditor
            mode="admin"
            packId={packId}
            templateCode={initial.template_code}
            initial={initial}
            onCancel={() => navigate(backHref)}
            onSave={async (next) => {
              await update.mutateAsync({
                body: next.body,
                layout: next.layout,
                metadata: next.metadata,
              });
            }}
          />
        )}
      </main>
    </div>
  );
}
