/**
 * Payment channel types for a Kenyan microfinance institution.
 *
 * Wave 2 of the Settings reconstruction removed the inherited ERP payment
 * catalogue: card acquiring (`online`: Stripe/PayPal/Wise/Payoneer/Venmo/
 * CashApp) and cryptocurrency (`crypto`: BTC/ETH/USDT/USDC) have no
 * legitimate role in this product and were deleted from the frontend, the
 * enum `public.payment_method_type` and the settings UI.
 *
 * The retained channels are exactly the ones a branch-based Kenyan MFI
 * collects and disburses through:
 *   - `cash`          — collected at the branch or the group meeting
 *   - `mobile_money`  — M-Pesa PayBill (Till is deliberately NOT supported)
 *   - `bank`          — bank transfer / branch deposit
 */

export type PaymentMethodType = 'bank' | 'mobile_money' | 'cash';

/**
 * Bank details structure
 */
export interface BankPaymentDetails {
  bank_name?: string;
  account_name?: string;
  account_number?: string;
  branch?: string;
  swift_code?: string;
}

/**
 * Mobile money details (M-Pesa PayBill and other Kenyan wallets).
 *
 * `till_number` is intentionally absent: an MFI collects to a PayBill with
 * the client/loan number as the account reference, which is what makes
 * automated reconciliation possible. A Till carries no account reference.
 */
export interface MobileMoneyDetails {
  provider: 'mpesa' | 'airtel_money' | 'tkash' | 'equitel' | 'other';
  provider_name?: string; // Custom name if 'other'
  paybill_number?: string;
  account_number?: string;
  phone_number?: string;
}

/**
 * Cash payment details
 */
export interface CashPaymentDetails {
  instructions?: string;
  accepted_currencies?: string[];
}

/**
 * Union type for all payment details
 */
export type PaymentMethodDetails =
  | BankPaymentDetails
  | MobileMoneyDetails
  | CashPaymentDetails;

/**
 * Organization Payment Method Interface
 */
export interface OrganizationPaymentMethod {
  id: string;
  organization_id: string;
  type: PaymentMethodType;
  label: string;
  details: PaymentMethodDetails;
  is_default: boolean;
  is_active: boolean;
  display_order: number;
  qr_code_enabled: boolean;
  bank_account_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Input for creating/updating payment methods
 */
export interface PaymentMethodInput {
  type: PaymentMethodType;
  label: string;
  details: PaymentMethodDetails;
  is_default?: boolean;
  is_active?: boolean;
  display_order?: number;
  qr_code_enabled?: boolean;
  bank_account_id?: string | null;
  /**
   * Optional branch scope. NULL = available company-wide; non-null = scoped
   * to a specific branch only. The DB trigger `enforce_branch_business_match`
   * validates that branch_id belongs to the same business_id.
   */
  branch_id?: string | null;
}

/**
 * Payment channel configurations
 */
export const PAYMENT_METHOD_TYPES: Record<PaymentMethodType, {
  label: string;
  icon: string;
  description: string;
}> = {
  bank: {
    label: 'Bank Transfer / Deposit',
    icon: '🏦',
    description: 'Transfer or deposit into an institution bank account',
  },
  mobile_money: {
    label: 'M-Pesa PayBill',
    icon: '📱',
    description: 'Mobile money collection with a client account reference',
  },
  cash: {
    label: 'Cash',
    icon: '💵',
    description: 'Cash collected at a branch or group meeting',
  },
};

/**
 * Mobile money provider options (Kenya)
 */
export const MOBILE_MONEY_PROVIDERS = [
  { value: 'mpesa', label: 'M-Pesa' },
  { value: 'airtel_money', label: 'Airtel Money' },
  { value: 'tkash', label: 'T-Kash' },
  { value: 'equitel', label: 'Equitel' },
  { value: 'other', label: 'Other' },
] as const;

/**
 * Get display text for a payment method
 */
export function getPaymentMethodDisplayText(method: OrganizationPaymentMethod): string {
  return method.label || PAYMENT_METHOD_TYPES[method.type].label;
}

/**
 * Get icon for a payment method type
 */
export function getPaymentMethodIcon(type: PaymentMethodType): string {
  return PAYMENT_METHOD_TYPES[type].icon;
}
