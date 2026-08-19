/**
 * useBankMoney — the one currency seam for the banking / reconciliation domain.
 *
 * A bank transaction's authoritative currency is the currency of the bank
 * account it belongs to (`bank_accounts.currency`). It is never the workspace
 * base currency by assumption, and never a literal (ADR 0136: a missing
 * currency is an absence, not a guess).
 *
 * Every banking surface formats money through this hook so the account →
 * transaction → reconciliation → rendered-currency chain cannot be broken by a
 * component supplying no currency and inheriting a formatter default.
 */
import { useCallback, useMemo } from "react";
import { useBankAccounts } from "@/hooks/useBankAccounts";
import { useCurrency } from "@/contexts/CurrencyContext";

export function useBankMoney() {
  const { accounts, isLoading } = useBankAccounts();
  const { formatCurrency, baseCurrency } = useCurrency();

  const byId = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const a of accounts ?? []) map.set(a.id, a.currency ?? null);
    return map;
  }, [accounts]);

  /** Currency of a bank account, or null when unknown / not yet loaded. */
  const currencyOf = useCallback(
    (bankAccountId?: string | null): string | null =>
      (bankAccountId ? byId.get(bankAccountId) ?? null : null),
    [byId],
  );

  /**
   * Format an amount that belongs to a bank account. When the account's
   * currency is not yet known the shared formatter renders it without a
   * borrowed symbol rather than defaulting to the workspace currency.
   */
  const formatBankAmount = useCallback(
    (amount: number, bankAccountId?: string | null): string =>
      formatCurrency(amount, currencyOf(bankAccountId) ?? undefined),
    [formatCurrency, currencyOf],
  );

  /**
   * Format a document (invoice / bill / expense / journal) amount in the
   * document's own currency. A document carries its currency; we never
   * re-denominate it into the bank account's currency on the client.
   */
  const formatDocumentAmount = useCallback(
    (amount: number, documentCurrency?: string | null): string =>
      formatCurrency(amount, documentCurrency ?? undefined),
    [formatCurrency],
  );

  return {
    accounts,
    isLoadingAccounts: isLoading,
    baseCurrency,
    currencyOf,
    formatBankAmount,
    formatDocumentAmount,
    formatCurrency,
  };
}
