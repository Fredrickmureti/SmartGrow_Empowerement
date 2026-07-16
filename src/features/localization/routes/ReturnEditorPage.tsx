/**
 * ReturnEditorPage — shared full-page mount for the statutory return
 * template editor. Mirrors `CertificateEditorPage` so admin and tenant
 * cannot drift: the admin route wires up a pack-row adapter, the future
 * tenant override route mounts the SAME shell with an override-writing
 * adapter. The page owns chrome + loading; the underlying editor is
 * `<ReturnTemplateEditor />`.
 *
 * This replaces the previous behavior where return templates opened
 * inside a right-side drawer via `LocalizationFormShell` — a 1000-line
 * columnar editor deserves the whole viewport, exactly like
 * certificates.
 */
import { Link } from "react-router-dom";
import { ArrowLeft, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ReturnTemplateEditor,
  type ReturnTemplateMetadata,
} from "../components/ReturnTemplateEditor";
import type { EditorMode } from "../types";

export interface ReturnEditorInitial {
  template_code: string;
  body: any;
  layout: string | null;
  notes: string | null;
  metadata?: Partial<ReturnTemplateMetadata> | null;
}

export interface ReturnEditorSaveInput {
  body: any;
  layout: string | null;
  notes: string | null;
  metadata?: ReturnTemplateMetadata;
}

export interface ReturnEditorHeader {
  templateName: string;
  templateCode: string;
  packName?: string | null;
  countryCode?: string | null;
  packVersion?: string | null;
  statusBadge?: React.ReactNode;
}

interface Props {
  mode: EditorMode;
  packId: string;
  backHref: string;
  onCancel: () => void;
  loading: boolean;
  notFound: boolean;
  header: ReturnEditorHeader | null;
  initial: ReturnEditorInitial | null;
  ruleCodeSuggestions?: string[];
  onSave: (next: ReturnEditorSaveInput) => Promise<void>;
}

export function ReturnEditorPage({
  mode,
  packId,
  backHref,
  onCancel,
  loading,
  notFound,
  header,
  initial,
  ruleCodeSuggestions,
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
              {header?.templateName ?? "Statutory return template"}
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
          <ReturnTemplateEditor
            mode={mode}
            packId={packId}
            templateCode={initial.template_code}
            initial={initial}
            ruleCodeSuggestions={ruleCodeSuggestions}
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

export default ReturnEditorPage;
