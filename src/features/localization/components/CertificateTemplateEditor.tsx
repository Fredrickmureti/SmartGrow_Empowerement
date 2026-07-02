/**
 * CertificateTemplateEditor — publisher-facing editor for
 * `localization_pack_certificate_templates`. Composes the shared
 * block-based `TemplateEditor` with the `TemplateFieldInspector` so
 * publishers see, live, which of the tokens they reference will
 * resolve at render time. Save is blocked while any referenced token
 * is absent from `pack_token_registry` (platform-reserved + pack).
 *
 * Mounted from `PackEntityTabs` for `localization_pack_certificate_templates`
 * rows — replaces the generic `TemplateEditor` path for certificates so
 * the architecture-guard test can verify a first-class editor exists.
 */
import { useRef, useState } from "react";
import { TemplateEditor } from "./TemplateEditor";
import { TemplateFieldInspector } from "./TemplateFieldInspector";
import type { EditorMode } from "../types";

interface Props {
  mode: EditorMode;
  packId?: string | null;
  templateCode: string;
  initial: { template_code: string; body: any; layout?: string | null; notes?: string | null };
  onSave: (next: { body: any; layout: string | null; notes: string | null }) => Promise<void> | void;
  onCancel?: () => void;
}

export function CertificateTemplateEditor({ mode, packId, templateCode, initial, onSave, onCancel }: Props) {
  const [liveBody, setLiveBody] = useState<any>(initial.body);
  const unresolvedRef = useRef<string[]>([]);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <TemplateEditor
        mode={mode}
        packId={packId}
        templateCode={templateCode}
        initial={initial}
        onSave={onSave}
        onCancel={onCancel}
        onBodyChange={setLiveBody}
        canSave={() => unresolvedRef.current.length === 0}
      />
      <div className="space-y-3">
        <TemplateFieldInspector
          packId={packId}
          body={liveBody}
          onValidityChange={({ unresolved }) => {
            unresolvedRef.current = unresolved;
          }}
        />
      </div>
    </div>
  );
}