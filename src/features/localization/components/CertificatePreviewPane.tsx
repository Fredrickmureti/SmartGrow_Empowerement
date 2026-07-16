/**
 * CertificatePreviewPane — WYSIWYG preview for the certificate editor.
 *
 * Renders the v3 AST through the SAME `compile()` → HTML + CSS Paged Media
 * → paged.js pipeline used to produce the filed PDF, so publishers see
 * exactly what a tenant will file. The "Save as PDF" action prints the
 * paginated document through the browser's native print engine (vector
 * output, KRA-accurate).
 */
import { useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { FileText, AlertTriangle, Printer } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  CertificateHtmlSurface,
  type CertificateHtmlSurfaceHandle,
} from "./CertificateHtmlSurface";
import { KE_P9_V3_PREVIEW_PAYLOAD } from "../lib/fixtures/keP9V3Fixture";
import type { CertificateTemplateV3 } from "../lib/engine/types";

interface Props {
  templateCode: string;
  displayName?: string | null;
  body: unknown;
  meta?: {
    legal_reference?: string | null;
    regulation_citation?: string | null;
    effective_date?: string | null;
  } | null;
  /** Currently-selected AST node id (`doc.<i>`, `hdr.<i>`, `ftr.<i>`). */
  selectedNodeId?: string | null;
  /** Fired when a publisher clicks a node in the rendered document. */
  onSelectNode?: (nodeId: string, type: string) => void;
  /** Direct-manipulation on top-level document nodes (see CertificateHtmlSurface). */
  onNodeAction?: (nodeId: string, action: "moveUp" | "moveDown" | "duplicate" | "delete") => void;
  onReorder?: (fromIndex: number, toIndex: number) => void;
  /** Inline WYSIWYG text-commit and gutter-insert callbacks. */
  onEditText?: (nodeId: string, editableKind: "heading" | "rich_text", text: string) => void;
  onInsertAfter?: (nodeId: string, nodeType?: string) => void;
}

function isV3Body(body: any): boolean {
  return body && Number(body.schema_version) >= 3 && Array.isArray(body.document);
}

export function CertificatePreviewPane({ templateCode, displayName, body, selectedNodeId, onSelectNode, onNodeAction, onReorder, onEditText, onInsertAfter }: Props) {
  const surfaceRef = useRef<CertificateHtmlSurfaceHandle>(null);
  const [error, setError] = useState<string | null>(null);
  const [unresolved, setUnresolved] = useState<string[]>([]);

  if (!isV3Body(body)) {
    return (
      <Card className="h-full flex flex-col">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <FileText className="h-4 w-4" /> Live preview
          </CardTitle>
        </CardHeader>
        <CardContent className="flex-1">
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription className="text-xs">
              This template is not yet on the Engine v3 document model. Switch
              the schema to “Engine AST v3” to author and preview it with the
              new renderer.
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  const b = body as any;
  const template: CertificateTemplateV3 = {
    schema_version: (Number(b.schema_version) === 4 ? 4 : 3),
    code: templateCode,
    display_name: displayName || templateCode,
    paper_format: b.paper_format,
    page_master: b.page_master,
    document: b.document,
    theme: b.theme,
  };

  return (
    <Card className="flex h-full min-h-0 w-full flex-col overflow-hidden border-0 shadow-none">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b px-2 py-1">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <FileText className="h-3.5 w-3.5" /> Live preview
        </div>
        <div className="flex items-center gap-1.5">
          {unresolved.length > 0 && (
            <Badge variant="destructive" className="h-5 px-1.5 text-[10px]">
              {unresolved.length} unresolved
            </Badge>
          )}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-xs"
            onClick={() => surfaceRef.current?.print()}
          >
            <Printer className="h-3 w-3 mr-1" /> PDF
          </Button>
        </div>
      </div>
      <CardContent className="flex min-h-0 flex-1 flex-col overflow-auto p-2">
        {error ? (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription className="text-xs break-all">{error}</AlertDescription>
          </Alert>
        ) : (
          <CertificateHtmlSurface
            ref={surfaceRef}
            template={template}
            payload={KE_P9_V3_PREVIEW_PAYLOAD}
            currency="KES"
            onError={setError}
            onUnresolved={setUnresolved}
            selectedNodeId={selectedNodeId ?? null}
            onSelectNode={onSelectNode}
            onNodeAction={onNodeAction}
            onReorder={onReorder}
            onEditText={onEditText}
            onInsertAfter={onInsertAfter}
          />
        )}
        <div className="shrink-0 pt-2 text-[10px] text-muted-foreground">
          Click any element in the preview to jump to its editor on the right —
          the rendered document is the source of truth for what you're editing.
        </div>
      </CardContent>
    </Card>
  );
}
