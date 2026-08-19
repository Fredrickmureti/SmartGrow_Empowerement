import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Utility fallback formatter. Prefer useCurrency().formatCurrency in React components. */
/**
 * Low-level money formatter. `currency` is REQUIRED and has no default:
 * a defaulted currency silently renders USD in a KES/EUR workspace
 * (ADR 0136 — a missing currency is an absence, never a guess).
 *
 * Prefer `useCurrency().formatCurrency` in React code — it resolves the
 * business base currency and the catalogue's decimal places. Use this
 * helper only where no React context is available, and always pass the
 * currency that authoritatively belongs to the amount.
 */
export function formatCurrency(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}


export function formatDate(date: string | Date): string {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(date));
}

/**
 * Format large numbers in compact notation (e.g., 1.2M, 5.8B)
 * Useful for dashboard cards where space is limited
 */
export function formatCompactNumber(amount: number, currency: string = "USD"): string {
  const absAmount = Math.abs(amount);
  
  // Only use compact notation for very large numbers (1 million+)
  if (absAmount >= 1_000_000) {
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency,
        notation: "compact",
        compactDisplay: "short",
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      }).format(amount);
    } catch {
      // Fallback for unsupported currencies
      if (absAmount >= 1_000_000_000) {
        return `${currency} ${(amount / 1_000_000_000).toFixed(1)}B`;
      }
      return `${currency} ${(amount / 1_000_000).toFixed(1)}M`;
    }
  }
  
  // For smaller numbers, use regular currency formatting
  return formatCurrency(amount, currency);
}
