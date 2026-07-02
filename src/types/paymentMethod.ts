/**
 * Payment Method Types for Document Templates
 * Supports multiple payment options: Bank, Mobile Money, Online, Cash, Crypto
 */

export type PaymentMethodType = 'bank' | 'mobile_money' | 'online' | 'cash' | 'crypto';

/**
 * Bank details structure
 */
export interface BankPaymentDetails {
  bank_name?: string;
  account_name?: string;
  account_number?: string;
  branch?: string;
  swift_code?: string;
  iban?: string;
  routing_number?: string;
}

/**
 * Mobile Money details (M-Pesa, Airtel Money, etc.)
 */
export interface MobileMoneyDetails {
  provider: 'mpesa' | 'airtel_money' | 'tkash' | 'equitel' | 'other';
  provider_name?: string; // Custom name if 'other'
  paybill_number?: string;
  till_number?: string;
  account_number?: string;
  phone_number?: string;
}

/**
 * Online payment details (PayPal, Stripe, etc.)
 */
export interface OnlinePaymentDetails {
  provider: 'paypal' | 'stripe' | 'wise' | 'payoneer' | 'venmo' | 'cashapp' | 'other';
  provider_name?: string;
  email?: string;
  username?: string;
  payment_link?: string;
}

/**
 * Cash payment details
 */
export interface CashPaymentDetails {
  instructions?: string;
  accepted_currencies?: string[];
}

/**
 * Crypto payment details
 */
export interface CryptoPaymentDetails {
  currency: 'btc' | 'eth' | 'usdt' | 'usdc' | 'other';
  currency_name?: string;
  wallet_address: string;
  network?: string;
}

/**
 * Union type for all payment details
 */
export type PaymentMethodDetails = 
  | BankPaymentDetails 
  | MobileMoneyDetails 
  | OnlinePaymentDetails 
  | CashPaymentDetails 
  | CryptoPaymentDetails;

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
 * Payment method type configurations
 */
export const PAYMENT_METHOD_TYPES: Record<PaymentMethodType, {
  label: string;
  icon: string;
  description: string;
}> = {
  bank: {
    label: 'Bank Transfer',
    icon: '🏦',
    description: 'Traditional bank account transfer',
  },
  mobile_money: {
    label: 'Mobile Money',
    icon: '📱',
    description: 'M-Pesa, Airtel Money, etc.',
  },
  online: {
    label: 'Online Payment',
    icon: '💳',
    description: 'PayPal, Stripe, Wise, etc.',
  },
  cash: {
    label: 'Cash',
    icon: '💵',
    description: 'Cash payment instructions',
  },
  crypto: {
    label: 'Cryptocurrency',
    icon: '₿',
    description: 'Bitcoin, Ethereum, USDT, etc.',
  },
};

/**
 * Mobile money provider options
 */
export const MOBILE_MONEY_PROVIDERS = [
  { value: 'mpesa', label: 'M-Pesa' },
  { value: 'airtel_money', label: 'Airtel Money' },
  { value: 'tkash', label: 'T-Kash' },
  { value: 'equitel', label: 'Equitel' },
  { value: 'other', label: 'Other' },
] as const;

/**
 * Online payment provider options
 */
export const ONLINE_PAYMENT_PROVIDERS = [
  { value: 'paypal', label: 'PayPal' },
  { value: 'stripe', label: 'Stripe' },
  { value: 'wise', label: 'Wise (TransferWise)' },
  { value: 'payoneer', label: 'Payoneer' },
  { value: 'venmo', label: 'Venmo' },
  { value: 'cashapp', label: 'Cash App' },
  { value: 'other', label: 'Other' },
] as const;

/**
 * Crypto currency options
 */
export const CRYPTO_CURRENCIES = [
  { value: 'btc', label: 'Bitcoin (BTC)' },
  { value: 'eth', label: 'Ethereum (ETH)' },
  { value: 'usdt', label: 'Tether (USDT)' },
  { value: 'usdc', label: 'USD Coin (USDC)' },
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
