/**
 * Region-specific configuration constants.
 * Used to conditionally render country-specific UI elements (Odoo-style).
 */

/** Countries where M-Pesa is a supported payment provider */
export const MPESA_SUPPORTED_COUNTRIES = new Set([
  "KE", // Kenya
  "TZ", // Tanzania
  "UG", // Uganda
  "RW", // Rwanda
  "MZ", // Mozambique
  "GH", // Ghana
]);

/** Check if M-Pesa should be shown for a given country code */
export function isMpesaSupported(countryCode: string | undefined | null): boolean {
  return !!countryCode && MPESA_SUPPORTED_COUNTRIES.has(countryCode.toUpperCase());
}

/**
 * Tax compliance provider descriptions — data-driven, not hardcoded per country.
 * Add entries here when onboarding new countries' tax authorities.
 */
export const TAX_COMPLIANCE_DESCRIPTIONS: Record<string, string> = {
  KE: "KRA eTIMS OSCU integration for real-time invoice transmission to Kenya Revenue Authority.",
  // Future:
  // UG: "URA EFRIS integration for electronic fiscal receipting and invoicing.",
  // TZ: "TRA EFD integration for electronic fiscal device compliance.",
};
