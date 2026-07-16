/**
 * CertificateEditorPage — shared full-page mount for the certificate
 * template editor. Consumed by BOTH the platform-admin route
 * (`/admin-management/localization-packs/:packId/certificates/:templateId/edit`)
 * and the tenant route (Phase 2 wire-up). Callers supply the mode and a
 * persistence adapter; this component owns the page chrome, loading
 * states, and the mount of `<CertificateTemplateEditor />`.
 *
 * Keeping the shell here — not on the admin page — makes the "one editor
 * surface for both roles" invariant enforceable: tenant Phase 2 just adds
 * a route that mounts this same component with `mode="tenant"` and an
 * override-writing adapter. No parallel page shell.
 */
import { Link } from "react-router-dom";
import { ArrowLeft, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  CertificateTemplateEditor,
  type CertificateTemplateMetadata,
} from "../components/CertificateTemplateEditor";
import type { EditorMode } from "../types";

export interface CertificateEditorInitial {
  template_code: string;
  body: any;
  layout: string | null;
  notes: string | null;
  metadata?: Partial<CertificateTemplateMetadata> | null;
}

export interface CertificateEditorSaveInput {
  body: any;
  layout: string | null;
  notes: string | null;
  metadata?: CertificateTemplateMetadata;
}

export interface CertificateEditorHeader {
  /** Template display name shown as the page title. */
  templateName: string;
  /** Machine code shown in the meta strip. */
  templateCode: string;
  /** Pack display name shown in the meta strip. */
  packName?: string | null;
  /** ISO country code badge, e.g. "KE". */
  countryCode?: string | null;
  /** Pack semver, shown as "vX.Y.Z". */
  packVersion?: string | null;
  /** Extra chip (e.g. "Customized · v2") appended to the meta strip. */
  statusBadge?: React.ReactNode;
}

interface Props {
  mode: EditorMode;
  packId: string;
  /** URL to return to when the user cancels or hits Back. */
  backHref: string;
  /** Called on cancel — usually `() => navigate(backHref)`. */
  onCancel: () => void;
  loading: boolean;
  notFound: boolean;
  header: CertificateEditorHeader | null;
  initial: CertificateEditorInitial | null;
  onSave: (next: CertificateEditorSaveInput) => Promise<void>;
}

export function CertificateEditorPage({
  mode,
  packId,
  backHref,
  onCancel,
  loading,
  notFound,
  header,
  initial,
  onSave,
}: Props) {
  return (
    <div className="flex h-screen min-h-0 flex-col bg-background">
      <header className="flex items-center justify-between gap-3 border-b bg-card/60 px-4 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <Button asChild variant="ghost" size="sm" className="h-8">
            <Link to={backHref}>
              <ArrowLeft className="mr-1 h-4 w-4" />
              Back
            </Link>
          </Button>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">
              {header?.templateName ?? "Certificate template"}
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {header?.countryCode && (
                <Badge variant="outline" className="text-[10px]">
                  {header.countryCode}
                </Badge>
              )}
              {header?.packName && <span className="truncate">{header.packName}</span>}
              {header?.packVersion && (
                <>
                  <span>·</span>
                  <span>v{header.packVersion}</span>
                </>
              )}
              {header?.templateCode && (
                <>
                  <span>·</span>
                  <code className="text-[10px]">{header.templateCode}</code>
                </>
              )}
              {header?.statusBadge && (
                <>
                  <span>·</span>
                  {header.statusBadge}
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
            Template not found.{" "}
            <Link className="ml-2 underline" to={backHref}>
              Return
            </Link>
          </div>
        )}
        {!loading && !notFound && initial && (
          <CertificateTemplateEditor
            mode={mode}
            packId={packId}
            templateCode={initial.template_code}
            initial={initial}
            onCancel={onCancel}
            onSave={async (next) => {
              await onSave({
                body: next.body,
                layout: next.layout,
                notes: next.notes,
                metadata: next.metadata,
              });
            }}
          />
        )}
      </main>
    </div>
  );
}
