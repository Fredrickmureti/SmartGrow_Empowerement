/**
 * HardwarePolicies — Phase 4 (Wave 9d) admin surface.
 *
 * The `document_print_policies` editor was historically buried under
 * `Settings → Company → Printing`. Wave 9d makes `/platform/hardware/*`
 * the sole home for anything printer-related, so this route becomes the
 * canonical editor. `Settings → Company → Printing` now redirects here.
 *
 * The body is intentionally a thin wrapper around the existing
 * `<PrintingSettings />` component — no functional change, only a
 * relocation. `PrintingSettings.tsx` will be inlined and split in
 * Phase 6 when the legacy Company tab is deleted.
 */
import { PrintingSettings } from "@/components/settings/PrintingSettings";

export default function HardwarePolicies() {
  return (
    <div className="space-y-4 p-4 md:p-6">
      <div>
        <h1 className="text-lg font-semibold">Print policies</h1>
        <p className="text-sm text-muted-foreground">
          Per-document paper format, render mode, and auto-print routing.
          Branch overrides win over business defaults; if no policy exists
          the system default (A4 PDF) applies.
        </p>
      </div>
      <PrintingSettings />
    </div>
  );
}
