/**
 * Country-aware tax terminology mapping.
 * 
 * Inspired by Odoo's fiscal localization approach: the tax term
 * displayed in the UI is derived from the organization's country,
 * not hardcoded to "VAT" everywhere.
 */

export interface TaxTerminology {
  /** Short name: "VAT", "GST", "Sales Tax", "Tax" */
  shortName: string;
  /** Label for the input/purchase tax account: "Input VAT", "Input GST", etc. */
  inputLabel: string;
  /** Label for the output/sales tax account: "Output VAT", "Output GST", etc. */
  outputLabel: string;
  /** Description for input tax: "Tax paid on purchases (VAT receivable)" */
  inputDescription: string;
  /** Description for output tax: "Tax collected on sales (VAT payable)" */
  outputDescription: string;
}

/** Countries that use "GST" (Goods and Services Tax) */
const GST_COUNTRIES = new Set([
  "IN", // India
  "AU", // Australia
  "NZ", // New Zealand
  "SG", // Singapore
  "MY", // Malaysia
  "CA", // Canada (GST + provincial)
]);

/** Countries that use "Sales Tax" */
const SALES_TAX_COUNTRIES = new Set([
  "US", // United States
]);

/** Countries that use "Consumption Tax" */
const CONSUMPTION_TAX_COUNTRIES = new Set([
  "JP", // Japan
]);

/**
 * Returns tax terminology labels appropriate for the given country.
 * 
 * - GST countries (India, Australia, NZ, Singapore, Malaysia, Canada)
 * - Sales Tax countries (USA)
 * - Consumption Tax countries (Japan)
 * - VAT countries (EU, UK, Kenya, most of Africa, Middle East, etc.)
 * - Fallback: generic "Tax"
 */
export function getTaxTerminology(countryCode: string | null | undefined): TaxTerminology {
  const code = countryCode?.toUpperCase();

  if (code && GST_COUNTRIES.has(code)) {
    return {
      shortName: "GST",
      inputLabel: "Input GST",
      outputLabel: "Output GST",
      inputDescription: "Tax paid on purchases (GST receivable)",
      outputDescription: "Tax collected on sales (GST payable)",
    };
  }

  if (code && SALES_TAX_COUNTRIES.has(code)) {
    return {
      shortName: "Sales Tax",
      inputLabel: "Sales Tax Receivable",
      outputLabel: "Sales Tax Payable",
      inputDescription: "Tax paid on purchases",
      outputDescription: "Tax collected on sales",
    };
  }

  if (code && CONSUMPTION_TAX_COUNTRIES.has(code)) {
    return {
      shortName: "Consumption Tax",
      inputLabel: "Input Consumption Tax",
      outputLabel: "Output Consumption Tax",
      inputDescription: "Tax paid on purchases (consumption tax receivable)",
      outputDescription: "Tax collected on sales (consumption tax payable)",
    };
  }

  // VAT is the most common worldwide — use it when we know the country
  if (code) {
    return {
      shortName: "VAT",
      inputLabel: "Input VAT",
      outputLabel: "Output VAT",
      inputDescription: "Tax paid on purchases (VAT receivable)",
      outputDescription: "Tax collected on sales (VAT payable)",
    };
  }

  // No country set — use generic "Tax"
  return {
    shortName: "Tax",
    inputLabel: "Input Tax",
    outputLabel: "Output Tax",
    inputDescription: "Tax paid on purchases (tax receivable)",
    outputDescription: "Tax collected on sales (tax payable)",
  };
}
