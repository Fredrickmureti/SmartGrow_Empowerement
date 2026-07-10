/**
 * Scrap reason catalogue.
 *
 * Reason codes here map 1:1 to the offset-account resolver
 * (`resolve_adjustment_offset_account`) in the DB, so every reason posts a
 * real inventory-loss expense entry with no silent fallback.
 *
 * When per-reason default_account_settings rows are introduced (Phase D of
 * the adjustment-GL work), the resolver switches to a settings lookup and
 * this file becomes purely presentational — the codes stay stable.
 */

export interface ScrapReason {
  code: string;
  label: string;
  description: string;
  requiresAttachment?: boolean;
  qualityHold?: boolean;
  insuranceEligible?: boolean;
}

export const SCRAP_REASONS: readonly ScrapReason[] = [
  {
    code: "scrap_damaged",
    label: "Damaged",
    description: "Physical damage in storage or handling.",
  },
  {
    code: "scrap_expired",
    label: "Expired",
    description: "Past expiry / best-before date.",
    requiresAttachment: true,
  },
  {
    code: "scrap_defective",
    label: "Defective",
    description: "Manufacturing or vendor defect.",
    qualityHold: true,
  },
  {
    code: "scrap_obsolete",
    label: "Obsolete",
    description: "Superseded, discontinued, or unsellable stock.",
  },
  {
    code: "scrap_quality",
    label: "Quality reject",
    description: "Failed inbound or in-process quality check.",
    qualityHold: true,
  },
  {
    code: "scrap_theft",
    label: "Theft / shrinkage",
    description: "Loss due to theft or unexplained shrinkage.",
    insuranceEligible: true,
  },
  {
    code: "scrap_other",
    label: "Other",
    description: "Other write-off (specify in notes).",
  },
] as const;

export function scrapReasonLabel(code?: string | null): string {
  if (!code) return "—";
  return (
    SCRAP_REASONS.find((r) => r.code === code)?.label ??
    code
      .replace(/^scrap_/, "")
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase())
  );
}
