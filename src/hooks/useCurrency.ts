import { useCurrencyContext } from "@/contexts/CurrencyContext";

// Re-export types from context
export type { Currency, ExchangeRate } from "@/contexts/CurrencyContext";

// This hook now just forwards to the context
// All pages using useCurrency() will automatically get the shared state
export function useCurrency() {
  return useCurrencyContext();
}
