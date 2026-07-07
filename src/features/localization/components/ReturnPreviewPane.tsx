/**
 * ReturnPreviewPane — WYSIWYG PDF preview for the ReturnTemplateEditor
 * when the template opts into the v2 section-based renderer
 * (`body.renderer === "v2-returns"`). Debounced 300 ms; renderer chunk
 * lazy-loaded.
 *
 * Mirrors CertificatePreviewPane. The renderer is browser-safe (pdf-lib
 * only) and shipped in `src/features/localization/lib/pdf/`.
 */
import { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, FileText, AlertTriangle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { KE_RETURN_PREVIEW_PAYLOAD, buildPreviewReturnTemplate } from "../lib/fixtures/keReturnFixture";

interface Props {
  templateCode: string;
  displayName?: string | null;
  body: unknown;
  meta?: {
    legal_reference?: string | null;
    regulation_citation?: string | null;
    authority_name?: string | null;
  } | null;
}

export function ReturnPreviewPane({ templateCode, displayName, body, meta }: Props) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);
  const lastUrl = useRef<string | null>(null);

  useEffect(() => {
    const handle = window.setTimeout(async () => {
      setRendering(true);
      setError(null);
      try {
        const { renderReturnPdf } = await import("../lib/pdf/returnRenderer");
        const tpl = buildPreviewReturnTemplate(templateCode, displayName || templateCode, body, meta);
        const bytes = await renderReturnPdf(tpl, KE_RETURN_PREVIEW_PAYLOAD);
        const blob = new Blob([bytes as BlobPart], { type: "application/pdf" });
        const next = URL.createObjectURL(blob);
        if (lastUrl.current) URL.revokeObjectURL(lastUrl.current);
        lastUrl.current = next;
        setUrl(next);
      } catch (e: any) {
        setError(e?.message ?? String(e));
      } finally {
        setRendering(false);
      }
    }, 300);
    return () => window.clearTimeout(handle);
  }, [templateCode, displayName, body, meta]);

  useEffect(() => {
    return () => {
      if (lastUrl.current) URL.revokeObjectURL(lastUrl.current);
    };
  }, []);

  return (
    <Card className="h-full flex flex-col">
      <CardHeader className="pb-2 flex-row items-center justify-between space-y-0">
        <CardTitle className="text-sm flex items-center gap-2">
          <FileText className="h-4 w-4" />
          Live preview
        </CardTitle>
        {rendering && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
      </CardHeader>
      <CardContent className="flex-1 p-2">
        {error ? (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription className="text-xs break-all">{error}</AlertDescription>
          </Alert>
        ) : url ? (
          <iframe
            title="Statutory return PDF preview"
            src={url}
            className="w-full h-[820px] rounded border bg-white"
          />
        ) : (
          <div className="text-xs text-muted-foreground p-4">Rendering preview…</div>
        )}
        <div className="text-[10px] text-muted-foreground pt-2">
          Rendered against a synthetic KE payroll fixture. The tenant will
          see the same layout, populated with their own return data.
        </div>
      </CardContent>
    </Card>
  );
}
