/**
 * Industry profiles — the single place that turns the neutral, captured
 * `businesses.industry` value into concrete UX defaults.
 *
 * The ERP core stays vertical-neutral: nothing here HIDES functionality or
 * forces a vocabulary on the operator. Profiles only provide smarter
 * *defaults* (lot/expiry tracking pre-toggled, a recommended packaging
 * template) that the user can always override. This closes the
 * "industry captured but never consumed" gap without coupling the core to
 * any one vertical.
 *
 * `packTemplate` keys MUST match PACK_TEMPLATES in ProductPackagingEditor.tsx.
 * `industry` keys MUST match `industryTypes` values in src/lib/countryCurrency.ts.
 */

export type PackTemplateKey =
  | "pharmacy"
  | "retail"
  | "beverage"
  | "agriculture"
  | "hardware";

export interface IndustryProfile {
  /** Recommended one-click packaging hierarchy for this vertical. */
  packTemplate?: PackTemplateKey;
  /** Pre-toggle lot/batch tracking on new inventory products. */
  defaultLotTracking: boolean;
  /** Pre-toggle expiry tracking (implies lot tracking) on new products. */
  defaultExpiryTracking: boolean;
}

/** Neutral fallback: no opinions, no pre-toggled tracking. */
export const NEUTRAL_PROFILE: IndustryProfile = {
  defaultLotTracking: false,
  defaultExpiryTracking: false,
};

const INDUSTRY_PROFILES: Record<string, IndustryProfile> = {
  // Perishable / regulated stock — lots + expiry matter by default.
  healthcare: {
    packTemplate: "pharmacy",
    defaultLotTracking: true,
    defaultExpiryTracking: true,
  },
  agriculture: {
    packTemplate: "agriculture",
    defaultLotTracking: true,
    defaultExpiryTracking: true,
  },
  hospitality: {
    packTemplate: "beverage",
    defaultLotTracking: true,
    defaultExpiryTracking: true,
  },
  // Pack hierarchies common, but lots/expiry off by default.
  retail: {
    packTemplate: "retail",
    defaultLotTracking: false,
    defaultExpiryTracking: false,
  },
  manufacturing: {
    packTemplate: "hardware",
    defaultLotTracking: false,
    defaultExpiryTracking: false,
  },
  construction: {
    packTemplate: "hardware",
    defaultLotTracking: false,
    defaultExpiryTracking: false,
  },
};

/**
 * Resolve a business's industry value into a profile. Unknown / null
 * industries (technology, services, finance, etc.) get the neutral profile.
 */
export function getIndustryProfile(
  industry?: string | null,
): IndustryProfile {
  if (!industry) return NEUTRAL_PROFILE;
  return INDUSTRY_PROFILES[industry] ?? NEUTRAL_PROFILE;
}
