/**
 * BaseCurrencyAmount — the ONE way finance screens render a base-currency
 * figure that the server could not state (ADR 0136).
 *
 * The reporting engines return SQL NULL for a base-currency amount when a
 * contributing document is denominated in a currency with no exchange rate on
 * file. That is an absence, not a zero: rendering it as `0.00` understates a
 * liability or a receivable and makes a broken tie-out look clean. This
 * component renders the honest state instead, and points the operator at the
 * one place that fixes it — the currency rate book.
 *
 * Mirrors the Collections / FX exposure treatment so the whole product says the
 * same thing in the same words.
 */
import { Link } from "react-router-dom";

interface BaseCurrencyAmountProps {
  /** `null` means the engine could not state this figure. */
  value: number | null | undefined;
  /** Base-currency formatter from `useCurrency()`. */
  format: (value: number) => string;
  /** How many documents have no rate on file (for the explanation). */
  unconvertibleCount?: number;
  /** Render a plain dash for zero-ish figures, as aging tables do. */
  dashWhenZero?: boolean;
  className?: string;
  /** Short label used inside the tooltip, e.g. "Total outstanding". */
  label?: string;
}

export function BaseCurrencyAmount({
  value,
  format,
  unconvertibleCount = 0,
  dashWhenZero = false,
  className,
  label,
}: BaseCurrencyAmountProps) {
  if (value === null || value === undefined) {
    const detail =
      unconvertibleCount > 0
        ? `${unconvertibleCount} document(s) are in a currency with no exchange rate on file, so ${
            label ? label.toLowerCase() : "this figure"
          } cannot be shown in base currency.`
        : `A document here is in a currency with no exchange rate on file, so ${
            label ? label.toLowerCase() : "this figure"
          } cannot be shown in base currency.`;
    return (
      <Link
        to="/settings/company?tab=currency"
        className="text-destructive underline underline-offset-2"
        title={detail}
      >
        No rate on file
      </Link>
    );
  }

  if (dashWhenZero && Math.abs(value) < 0.005) {
    return <span className={className}>—</span>;
  }

  return <span className={className}>{format(value)}</span>;
}

/** Plain-text variant for exports and strings, where no link can be rendered. */
export function formatBaseCurrencyAmount(
  value: number | null | undefined,
  format: (value: number) => string,
): string {
  return value === null || value === undefined ? "No rate on file" : format(value);
}
