/**
 * Readiness matrix for resolvePaymentMethods — locks the rules described in
 * docs/adr/0009-pos-payment-state-model.md.
 */
import { describe, it, expect } from "vitest";
import {
  resolvePaymentMethods,
  countReady,
  type ResolverPaymentMethod,
} from "@/lib/pos/paymentMethodResolver";

const m = (
  key: string,
  overrides: Partial<ResolverPaymentMethod> = {},
): ResolverPaymentMethod => ({
  method_key: key,
  display_name: key,
  is_enabled: true,
  requires_reference: false,
  icon: null,
  debit_account_id: "acct-1",
  ...overrides,
});

describe("paymentMethodResolver", () => {
  it("cash is always ready", () => {
    const [r] = resolvePaymentMethods({
      enabledMethods: [m("cash", { debit_account_id: null })],
      providerConfigs: [],
      hasCustomer: false,
    });
    expect(r.isReady).toBe(true);
  });

  it("disabled method reports method_disabled", () => {
    const [r] = resolvePaymentMethods({
      enabledMethods: [m("cash", { is_enabled: false })],
      providerConfigs: [],
      hasCustomer: false,
    });
    expect(r.isReady).toBe(false);
    expect(r.blockedReason).toBe("method_disabled");
  });

  it("register allow-list excludes methods not on the list", () => {
    const [r] = resolvePaymentMethods({
      enabledMethods: [m("cash")],
      registerAllowList: ["card"],
      providerConfigs: [],
      hasCustomer: false,
    });
    expect(r.isReady).toBe(false);
    expect(r.blockedReason).toBe("register_excluded");
  });

  it("credit requires a customer", () => {
    const noCust = resolvePaymentMethods({
      enabledMethods: [m("credit")],
      providerConfigs: [],
      hasCustomer: false,
    })[0];
    expect(noCust.blockedReason).toBe("customer_required");

    const withCust = resolvePaymentMethods({
      enabledMethods: [m("credit")],
      providerConfigs: [],
      hasCustomer: true,
    })[0];
    expect(withCust.isReady).toBe(true);
  });

  it("mobile_money: provider then clearing-account gates", () => {
    // No provider
    let r = resolvePaymentMethods({
      enabledMethods: [m("mobile_money")],
      providerConfigs: [],
      hasCustomer: false,
    })[0];
    expect(r.blockedReason).toBe("no_provider_configured");

    // Provider but no clearing account
    r = resolvePaymentMethods({
      enabledMethods: [m("mobile_money", { debit_account_id: null })],
      providerConfigs: [{ provider: "mpesa", is_active: true }],
      hasCustomer: false,
    })[0];
    expect(r.blockedReason).toBe("missing_debit_account");

    // All set
    r = resolvePaymentMethods({
      enabledMethods: [m("mobile_money")],
      providerConfigs: [{ provider: "mpesa", is_active: true }],
      hasCustomer: false,
    })[0];
    expect(r.isReady).toBe(true);
  });

  it("card: gateway OR terminal device + clearing account", () => {
    let r = resolvePaymentMethods({
      enabledMethods: [m("card")],
      providerConfigs: [],
      hasCustomer: false,
    })[0];
    expect(r.blockedReason).toBe("no_provider_configured");

    r = resolvePaymentMethods({
      enabledMethods: [m("card", { debit_account_id: null })],
      providerConfigs: [],
      hasCustomer: false,
      hasTerminalDevice: true,
    })[0];
    expect(r.blockedReason).toBe("missing_debit_account");

    r = resolvePaymentMethods({
      enabledMethods: [m("card")],
      providerConfigs: [{ provider: "stripe", is_active: true }],
      hasCustomer: false,
    })[0];
    expect(r.isReady).toBe(true);
  });

  it("reference-based clearing methods need a debit account", () => {
    const r = resolvePaymentMethods({
      enabledMethods: [
        m("bank_transfer", { requires_reference: true, debit_account_id: null }),
        m("voucher", { requires_reference: true, debit_account_id: null }),
      ],
      providerConfigs: [],
      hasCustomer: false,
    });
    expect(r[0].blockedReason).toBe("missing_debit_account");
    expect(r[1].blockedReason).toBe("missing_debit_account");
  });

  it("countReady counts only ready entries", () => {
    const r = resolvePaymentMethods({
      enabledMethods: [m("cash"), m("credit"), m("mobile_money")],
      providerConfigs: [],
      hasCustomer: false,
    });
    expect(countReady(r)).toBe(1); // only cash
  });
});