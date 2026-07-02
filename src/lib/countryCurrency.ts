/**
 * @deprecated — Use `useCountries()` hook from `@/hooks/useCountries` instead.
 * This file is kept temporarily for backwards compatibility during migration.
 * Country data now comes from the `countries` database table.
 */

// Business types (not country-specific — kept here)
export const businessTypes = [
  { value: "freelancer", label: "Freelancer / Sole Proprietor" },
  { value: "small_business", label: "Small Business" },
  { value: "startup", label: "Startup" },
  { value: "agency", label: "Agency" },
  { value: "enterprise", label: "Enterprise" },
  { value: "nonprofit", label: "Non-Profit Organization" },
  { value: "other", label: "Other" },
];

// Industry types (not country-specific — kept here)
export const industryTypes = [
  { value: "technology", label: "Technology & Software" },
  { value: "retail", label: "Retail & E-commerce" },
  { value: "services", label: "Professional Services" },
  { value: "consulting", label: "Consulting" },
  { value: "manufacturing", label: "Manufacturing" },
  { value: "healthcare", label: "Healthcare" },
  { value: "education", label: "Education" },
  { value: "finance", label: "Finance & Banking" },
  { value: "real_estate", label: "Real Estate" },
  { value: "hospitality", label: "Hospitality & Tourism" },
  { value: "construction", label: "Construction" },
  { value: "agriculture", label: "Agriculture" },
  { value: "media", label: "Media & Entertainment" },
  { value: "logistics", label: "Logistics & Transportation" },
  { value: "other", label: "Other" },
];
