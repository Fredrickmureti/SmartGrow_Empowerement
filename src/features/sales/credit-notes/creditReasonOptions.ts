/**
 * Credit reason vocabulary — deliberately industry-neutral.
 *
 * A credit note is raised by product businesses, service businesses,
 * subscription businesses and agencies alike, so the list stays generic
 * (billing errors, service issues, cancellations) instead of assuming goods
 * moved. "Other" always exists, and the free-text explanation is always
 * available, so nothing here can box an operator in.
 */
export interface CreditReasonOption {
  value: string;
  label: string;
  description: string;
}

export const CREDIT_REASON_OPTIONS: CreditReasonOption[] = [
  {
    value: "Product return",
    label: "Product return",
    description: "Goods sent back by the customer",
  },
  {
    value: "Service issue",
    label: "Service issue",
    description: "Work not delivered, delayed or below the agreed standard",
  },
  {
    value: "Billing error",
    label: "Billing error",
    description: "Wrong price, quantity, tax or duplicate charge on the invoice",
  },
  {
    value: "Order cancelled",
    label: "Order cancelled",
    description: "The order or subscription was cancelled after invoicing",
  },
  {
    value: "Damaged or defective",
    label: "Damaged or defective",
    description: "What was supplied arrived damaged or did not work",
  },
  {
    value: "Discount or price adjustment",
    label: "Discount or price adjustment",
    description: "Agreed rebate, retro discount or negotiated correction",
  },
  {
    value: "Goodwill",
    label: "Goodwill",
    description: "Commercial gesture with no fault attached",
  },
  {
    value: "Duplicate invoice",
    label: "Duplicate invoice",
    description: "The same charge was invoiced more than once",
  },
  {
    value: "other",
    label: "Other (type your own)",
    description: "Anything not covered above",
  },
];

export const CREDIT_REASON_OTHER = "other";
