/**
 * CertificatePreviewPane — WYSIWYG PDF preview for the certificate
 * editor. Uses the same section-based `renderCertificatePdf` that runs
 * server-side, so publishers see the exact PDF the tenant will
 * receive. Debounced (300 ms) on every body change; renderer chunk is
 * lazy-loaded so it doesn't hit the main bundle.
 *
 * The renderer is browser-safe (pdf-lib only) and shipped in
 * `src/features/localization/lib/pdf/`. See the parity test.
 */
import { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, FileText, AlertTriangle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { KE_CERTIFICATE_PREVIEW_PAYLOAD, buildPreviewTemplate } from "../lib/fixtures/kePayrollFixture";

interface Props {
  templateCode: string;
  displayName?: string | null;
  body: unknown;
  meta?: {
    legal_reference?: string | null;
    regulation_citation?: string | null;
    effective_date?: string | null;
  } | null;
}

export function CertificatePreviewPane({ templateCode, displayName, body, meta }: Props) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);
  const lastUrl = useRef<string | null>(null);

  useEffect(() => {
    const handle = window.setTimeout(async () => {
      setRendering(true);
      setError(null);
      try {
        const { renderCertificatePdf } = await import("../lib/pdf/certificateRenderer");
        const tpl = buildPreviewTemplate(
          templateCode,
          displayName || templateCode,
          body,
          meta,
        );
        const bytes = await renderCertificatePdf(tpl, KE_CERTIFICATE_PREVIEW_PAYLOAD);
        const blob = new Blob([bytes], { type: "application/pdf" });
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
    // Re-render on every body/meta/name change.
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
            title="Certificate PDF preview"
            src={url}
            className="w-full h-[820px] rounded border bg-white"
          />
        ) : (
          <div className="text-xs text-muted-foreground p-4">Rendering preview…</div>
        )}
        <div className="text-[10px] text-muted-foreground pt-2">
          Rendered against a synthetic KE payroll fixture. The tenant will
          see the same layout, populated with their own payroll data.
        </div>
      </CardContent>
    </Card>
  );
}
