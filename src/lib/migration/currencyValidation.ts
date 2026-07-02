/**
 * Multi-currency validation utilities for migration.
 * Validates imported amounts against the organization's base currency
 * and provides exchange rate lookup.
 */

export interface CurrencyValidationResult {
  isValid: boolean;
  originalCurrency: string;
  baseCurrency: string;
  originalAmount: number;
  convertedAmount: number | null;
  exchangeRate: number | null;
  warning?: string;
}

/**
 * Validate a currency code against the organization's base currency.
 * Returns conversion info if different currencies are detected.
 */
export function validateCurrency(
  amount: number,
  rowCurrency: string | undefined,
  baseCurrency: string,
  exchangeRates?: Record<string, number>
): CurrencyValidationResult {
  const currency = (rowCurrency || "").trim().toUpperCase();
  const base = baseCurrency.toUpperCase();

  // No currency specified or same as base — no conversion needed
  if (!currency || currency === base) {
    return {
      isValid: true,
      originalCurrency: base,
      baseCurrency: base,
      originalAmount: amount,
      convertedAmount: amount,
      exchangeRate: 1,
    };
  }

  // Different currency — look up exchange rate
  const rate = exchangeRates?.[currency];
  if (!rate) {
    return {
      isValid: false,
      originalCurrency: currency,
      baseCurrency: base,
      originalAmount: amount,
      convertedAmount: null,
      exchangeRate: null,
      warning: `No exchange rate found for ${currency} → ${base}. Amount will be imported as-is in base currency.`,
    };
  }

  return {
    isValid: true,
    originalCurrency: currency,
    baseCurrency: base,
    originalAmount: amount,
    convertedAmount: Math.round(amount * rate * 100) / 100,
    exchangeRate: rate,
  };
}

/**
 * Validate all rows in a batch for currency consistency.
 * Returns summary of currencies found and any conversion issues.
 */
export function validateBatchCurrencies(
  rows: Array<{ amount: number; currency?: string }>,
  baseCurrency: string,
  exchangeRates?: Record<string, number>
): {
  currencies: Set<string>;
  hasMultipleCurrencies: boolean;
  hasMissingRates: boolean;
  missingCurrencies: string[];
  summary: string;
} {
  const currencies = new Set<string>();
  const missingCurrencies = new Set<string>();

  for (const row of rows) {
    const curr = (row.currency || baseCurrency).trim().toUpperCase();
    currencies.add(curr);

    if (curr !== baseCurrency.toUpperCase() && !exchangeRates?.[curr]) {
      missingCurrencies.add(curr);
    }
  }

  const hasMultipleCurrencies = currencies.size > 1;
  const hasMissingRates = missingCurrencies.size > 0;
  const missing = Array.from(missingCurrencies);

  let summary = "";
  if (!hasMultipleCurrencies) {
    summary = `All amounts in ${baseCurrency}`;
  } else if (hasMissingRates) {
    summary = `Multiple currencies detected (${Array.from(currencies).join(", ")}). Missing rates for: ${missing.join(", ")}`;
  } else {
    summary = `Multiple currencies detected (${Array.from(currencies).join(", ")}). All rates available.`;
  }

  return { currencies, hasMultipleCurrencies, hasMissingRates, missingCurrencies: missing, summary };
}
