/**
 * ReturnPreviewPane — WYSIWYG PDF preview for the ReturnTemplateEditor.
 *
 * Renders through the SAME HTML + CSS Paged Media → paged.js pipeline
 * the certificate engine uses. The return `body` is adapted to a
 * country-agnostic `CertificateTemplateV3` (see `returnToAst`) and the
 * sample payload comes from the shared `samplePayload.ts`. No pdf-lib,
 * no KE fixture — retiring the pre-registry rendering path so returns
 * and certificates share one renderer (mem://features/certificate-
 * rendering: no pdf-lib in localization previews).
 */
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FileText } from "lucide-react";
import { CertificateHtmlSurface } from "./CertificateHtmlSurface";
import { buildReturnAstTemplate } from "../lib/preview/returnToAst";
import { SAMPLE_RETURN_PAYLOAD } from "../lib/preview/samplePayload";

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
  const template = buildReturnAstTemplate(
    templateCode,
    displayName || templateCode,
    body as any,
    meta ?? null,
  );

  return (
    <Card className="flex h-full min-h-0 w-full flex-col overflow-hidden border-0 shadow-none">
      <CardHeader className="shrink-0 pb-2 flex-row items-center justify-between space-y-0">
        <CardTitle className="text-sm flex items-center gap-2">
          <FileText className="h-4 w-4" />
          Live preview — PDF paper return
        </CardTitle>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col p-2">
        <CertificateHtmlSurface
          template={template}
          payload={SAMPLE_RETURN_PAYLOAD as any}
          className="min-h-0 flex-1"
        />
        <div className="shrink-0 pt-2 text-[10px] text-muted-foreground">
          Rendered against a country-agnostic sample payload. Real returns are populated with the tenant's own data.
        </div>
      </CardContent>
    </Card>
  );
}
