/**
 * Payment Method Resolver — single source of truth for which POS payment
 * methods are actually usable on a given register at a given moment.
 *
 * The dialog must never decide on its own whether a method is available.
 * It consumes ResolvedPaymentMethod[] from this resolver, which combines:
 *   1. pos_payment_methods.is_enabled (operator opt-in)
 *   2. pos_registers.default_payment_methods (per-register allow-list)
 *   3. payment_provider_configs.is_active (real provider credentials)
 *   4. pos_payment_methods.debit_account_id (clearing GL account configured)
 *   5. cart context (customer present for credit, etc.)
 *
 * A method is `isReady` only if every applicable gate passes. Unready
 * methods are still returned so the UI can render them as disabled chips
 * with a `blockedReason` explaining what's missing — this is the
 * context-awareness the audit demanded.
 */

export interface ResolverPaymentMethod {
  method_key: string;
  display_name: string;
  is_enabled: boolean;
  requires_reference: boolean;
  icon: string | null;
  debit_account_id: string | null;
  branch_id?: string | null;
}

export interface ResolverProviderConfig {
  provider: string;
  is_active: boolean;
}

export interface ResolverInput {
  /** All payment methods configured for the org/branch (enabled + disabled). */
  enabledMethods: ResolverPaymentMethod[];
  /** pos_registers.default_payment_methods. null/empty = no restriction. */
  registerAllowList?: string[] | null;
  /** payment_provider_configs rows for the active company. */
  providerConfigs: ResolverProviderConfig[];
  /** True when a customer is selected on the cart (required for `credit`). */
  hasCustomer: boolean;
  /** True when at least one card terminal is registered for the active branch. */
  hasTerminalDevice?: boolean;
}

export type BlockedReasonCode =
  | "method_disabled"
  | "register_excluded"
  | "no_provider_configured"
  | "missing_debit_account"
  | "no_terminal_device"
  | "customer_required";

export interface ResolvedPaymentMethod {
  method_key: string;
  display_name: string;
  icon: string | null;
  requires_reference: boolean;
  /** True when every gate for this method passes. */
  isReady: boolean;
  /** Machine code for tests + analytics. */
  blockedReason: BlockedReasonCode | null;
  /** Human-friendly explanation suitable for tooltips. */
  blockedMessage: string | null;
}

const PROVIDER_GATES: Record<string, string[]> = {
  // mobile_money is satisfied by ANY active mobile-money provider.
  mobile_money: ["mpesa", "flutterwave", "paystack"],
  // card is satisfied by ANY active online card gateway when no physical
  // terminal is present. With a terminal device, the gate is the device.
  card: ["stripe", "flutterwave", "paystack"],
};

function blocked(
  m: ResolverPaymentMethod,
  reason: BlockedReasonCode,
  message: string,
): ResolvedPaymentMethod {
  return {
    method_key: m.method_key,
    display_name: m.display_name,
    icon: m.icon,
    requires_reference: m.requires_reference,
    isReady: false,
    blockedReason: reason,
    blockedMessage: message,
  };
}

function ready(m: ResolverPaymentMethod): ResolvedPaymentMethod {
  return {
    method_key: m.method_key,
    display_name: m.display_name,
    icon: m.icon,
    requires_reference: m.requires_reference,
    isReady: true,
    blockedReason: null,
    blockedMessage: null,
  };
}

export function resolvePaymentMethods(input: ResolverInput): ResolvedPaymentMethod[] {
  const {
    enabledMethods,
    registerAllowList,
    providerConfigs,
    hasCustomer,
    hasTerminalDevice = false,
  } = input;

  const allowSet =
    registerAllowList && registerAllowList.length > 0
      ? new Set(registerAllowList)
      : null;

  const activeProviders = new Set(
    providerConfigs.filter((p) => p.is_active).map((p) => p.provider),
  );

  return enabledMethods.map((m) => {
    if (!m.is_enabled) {
      return blocked(m, "method_disabled", `${m.display_name} is disabled in POS settings.`);
    }
    if (allowSet && !allowSet.has(m.method_key)) {
      return blocked(m, "register_excluded", `${m.display_name} isn't allowed on this register.`);
    }

    switch (m.method_key) {
      case "cash":
        return ready(m);

      case "credit":
        if (!hasCustomer) {
          return blocked(m, "customer_required", "Select a customer to charge to account.");
        }
        // Store credit posts to a customer's A/R balance — no clearing
        // account is needed because the GL debit is the customer.
        return ready(m);

      case "mobile_money": {
        const gates = PROVIDER_GATES.mobile_money;
        const hasProvider = gates.some((p) => activeProviders.has(p));
        if (!hasProvider) {
          return blocked(
            m,
            "no_provider_configured",
            "Configure an active mobile-money provider (e.g. M-Pesa) to accept this method.",
          );
        }
        if (!m.debit_account_id) {
          return blocked(
            m,
            "missing_debit_account",
            `${m.display_name} needs a clearing account so finance can reconcile settlements.`,
          );
        }
        return ready(m);
      }

      case "card": {
        const hasGateway = PROVIDER_GATES.card.some((p) => activeProviders.has(p));
        if (!hasGateway && !hasTerminalDevice) {
          return blocked(
            m,
            "no_provider_configured",
            "Connect a card terminal or configure an online card gateway.",
          );
        }
        if (!m.debit_account_id) {
          return blocked(
            m,
            "missing_debit_account",
            "Card payments need a clearing account so settlements can reconcile to the bank deposit.",
          );
        }
        return ready(m);
      }

      case "bank_transfer":
      case "voucher":
      default: {
        // Reference-based clearing methods always require a debit account.
        if (m.requires_reference && !m.debit_account_id) {
          return blocked(
            m,
            "missing_debit_account",
            `${m.display_name} needs a clearing account so finance can reconcile this payment.`,
          );
        }
        return ready(m);
      }
    }
  });
}

/** Convenience: how many ready methods exist (used for split-payment gating). */
export function countReady(methods: ResolvedPaymentMethod[]): number {
  return methods.filter((m) => m.isReady).length;
}
