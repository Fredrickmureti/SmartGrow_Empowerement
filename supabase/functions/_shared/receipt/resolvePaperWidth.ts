/**
 * resolvePaperWidth — single source of truth for the thermal character grid.
 *
 * This is the industry-pattern fix for Bug 2 in `.lovable/plan.md`: today
 * paper width can arrive from FOUR places (request override, printer
 * profile, receipt-editor settings, print-policy default). When they
 * disagree the receipt overflows or under-uses the paper (the 58mm
 * emulator overflow the operator reported).
 *
 * Star / Epson / Odoo all model this as "the physical device wins" — the
 * paper you loaded into the printer is not something a tenant setting
 * can override at print time. We follow the same precedence:
 *
 *   1. `requestOverride`   — an explicit `paperFormat` on the request
 *      (test rigs, admin overrides). Highest so tooling can force a size.
 *   2. `profile.paper_size` — the bound printer_profile (or
 *      pos_registers.printer_profile). This is the physical hardware.
 *   3. `receiptSettings.paper_size` — the receipt editor's intent. Only
 *      used when NO physical profile is bound (dev / preview / test print
 *      with the "engine defaults" printer).
 *   4. `default`           — 80mm, the receipt-printer world's default.
 *
 * Returning ALSO reports which source won, so `generate-document` can
 * surface it in the `X-Print-Policy-Paper-Source` response header for
 * observability (Phase 5).
 */

export type ThermalWidth = "40mm" | "58mm" | "80mm";

export type PaperWidthSource =
  | "request-override"
  | "printer-profile"
  | "receipt-settings"
  | "policy-default"
  | "engine-default";

export interface ResolvePaperWidthInput {
  /** Explicit override from the request body (e.g. `body.paperFormat`). */
  requestOverride?: string | null;
  /** Merged printer profile (printer_profiles or pos_registers.printer_profile). */
  profile?: { paper_size?: string | null } | null;
  /** Receipt editor settings for the tenant (pos_receipt_settings). */
  receiptSettings?: { paper_size?: string | null } | null;
  /** Fallback from document_print_policies. */
  policyDefault?: string | null;
}

export interface ResolvedPaperWidth {
  width: ThermalWidth;
  source: PaperWidthSource;
}

const THERMAL: ReadonlySet<ThermalWidth> = new Set(["40mm", "58mm", "80mm"]);

function coerce(value: unknown): ThermalWidth | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  return THERMAL.has(v as ThermalWidth) ? (v as ThermalWidth) : null;
}

export function resolvePaperWidth(input: ResolvePaperWidthInput): ResolvedPaperWidth {
  const override = coerce(input.requestOverride);
  if (override) return { width: override, source: "request-override" };

  const profile = coerce(input.profile?.paper_size);
  if (profile) return { width: profile, source: "printer-profile" };

  const settings = coerce(input.receiptSettings?.paper_size);
  if (settings) return { width: settings, source: "receipt-settings" };

  const policy = coerce(input.policyDefault);
  if (policy) return { width: policy, source: "policy-default" };

  return { width: "80mm", source: "engine-default" };
}
