/**
 * Institution brand constants for the public site.
 *
 * One source of truth so the marketing surface, page titles and footer never
 * drift apart again (the site previously shipped the inherited "AccrualFlow"
 * product name in a dozen places).
 */
export const BRAND = {
  name: "Smart Grow Empowerment",
  shortName: "Smart Grow",
  initials: "SG",
  tagline: "Small loans. Steady growth. Shared responsibility.",
  description:
    "A community microfinance institution serving small traders, farmers and " +
    "group savers with fair credit, savings and business training.",
  email: "info@smartgrowempowerment.org",
  phone: "+254 700 000 000",
} as const;
