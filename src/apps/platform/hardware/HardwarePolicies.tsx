/**
 * HardwarePolicies — Phase 4 (Wave 9d) admin surface.
 *
 * The `document_print_policies` editor was historically buried under
 * `Settings → Company → Printing`. Wave 9d makes `/platform/hardware/*`
 * the sole home for anything printer-related, so this route becomes the
 * canonical editor. `Settings → Company → Printing` now redirects here.
 *
 * The body renders the canonical `<PrintPoliciesEditor />` (Phase 6
 * Step C — moved out of `src/components/settings/` so the editor lives
 * next to the rest of the hardware app tree). `Settings → Company →
 * Printing` is removed entirely.
 */
import PrintPoliciesEditor from "@/apps/platform/hardware/PrintPoliciesEditor";

export default function HardwarePolicies() {
  return (
    <div className="space-y-4 p-4 md:p-6">
      <div>
        <h1 className="text-lg font-semibold">Output policies</h1>
        <p className="text-sm text-muted-foreground">
          Per-document paper format, trigger, and semantic printer role.
          Physical device is chosen at runtime by the role's per-branch
          bindings (see <em>Printer roles</em>). Branch overrides win over
          business defaults; without a policy the system default (A4 PDF,
          manual) applies.
        </p>
      </div>
      <PrintPoliciesEditor />
    </div>
  );
}
