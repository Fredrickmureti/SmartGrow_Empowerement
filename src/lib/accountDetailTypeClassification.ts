/**
 * Account Detail Type → Report Classification Map
 * 
 * This is the single source of truth for how accounts are classified
 * in financial reports. Maps every known detail_type to its correct
 * IAS 1 / IFRS report sub-type and behavioral flags.
 * 
 * Architecture: detail_type is the authoritative classification source.
 * Code-range inference (AccountClassification.ts) is the fallback
 * for legacy accounts with NULL detail_type.
 */

import type { AccountSubType } from "@/services/reports/AccountClassification";

export interface DetailTypeClassification {
  /** IAS 1 report sub-type (current_asset, non_current_asset, etc.) */
  subType: AccountSubType;
  /** Cash flow statement category */
  cashFlowCategory?: "operating" | "investing" | "financing";
  /** Behavioral flags for feature-level logic */
  isReceivable?: boolean;
  isPayable?: boolean;
  isBank?: boolean;
  isCash?: boolean;
  isInventory?: boolean;
  isFixedAsset?: boolean;
  isContraAsset?: boolean;
  isContraRevenue?: boolean;
}

/**
 * Master classification map: detail_type value → classification metadata.
 * Every detail_type from accountDetailTypes.ts MUST be present here.
 */
export const DETAIL_TYPE_CLASSIFICATION: Record<string, DetailTypeClassification> = {
  // ─── ASSETS: Current ─────────────────────────────────────────────
  accounts_receivable:      { subType: "current_asset",     cashFlowCategory: "operating",  isReceivable: true },
  cash_and_cash_equivalents:{ subType: "current_asset",     cashFlowCategory: "operating",  isCash: true },
  cash_on_hand:             { subType: "current_asset",     cashFlowCategory: "operating",  isCash: true },
  checking:                 { subType: "current_asset",     cashFlowCategory: "operating",  isBank: true },
  savings:                  { subType: "current_asset",     cashFlowCategory: "operating",  isBank: true },
  money_market:             { subType: "current_asset",     cashFlowCategory: "operating",  isBank: true },
  mobile_money:             { subType: "current_asset",     cashFlowCategory: "operating",  isBank: true },
  trust_account:            { subType: "current_asset",     cashFlowCategory: "operating",  isBank: true },
  rents_held_in_trust:      { subType: "current_asset",     cashFlowCategory: "operating",  isBank: true },
  allowance_bad_debts:      { subType: "current_asset",     cashFlowCategory: "operating",  isContraAsset: true },
  assets_available_for_sale:{ subType: "current_asset",     cashFlowCategory: "operating" },
  development_costs:        { subType: "current_asset",     cashFlowCategory: "operating" },
  employee_advances:        { subType: "current_asset",     cashFlowCategory: "operating" },
  inventory:                { subType: "current_asset",     cashFlowCategory: "operating",  isInventory: true },
  investment_government:    { subType: "current_asset",     cashFlowCategory: "investing" },
  investment_tax_exempt:    { subType: "current_asset",     cashFlowCategory: "investing" },
  loans_to_officers:        { subType: "current_asset",     cashFlowCategory: "operating" },
  loans_to_others:          { subType: "current_asset",     cashFlowCategory: "operating" },
  loans_to_stockholders:    { subType: "current_asset",     cashFlowCategory: "operating" },
  prepaid_expenses:         { subType: "current_asset",     cashFlowCategory: "operating" },
  retainage:                { subType: "current_asset",     cashFlowCategory: "operating" },
  short_term_investments:   { subType: "current_asset",     cashFlowCategory: "investing" },
  undeposited_funds:        { subType: "current_asset",     cashFlowCategory: "operating",  isCash: true },
  other_current_asset:      { subType: "current_asset",     cashFlowCategory: "operating" },

  // ─── ASSETS: Non-Current (Fixed / Tangible) ──────────────────────
  accumulated_depreciation: { subType: "non_current_asset",  cashFlowCategory: "investing", isContraAsset: true },
  accumulated_depletion:    { subType: "non_current_asset",  cashFlowCategory: "investing", isContraAsset: true },
  buildings:                { subType: "non_current_asset",  cashFlowCategory: "investing", isFixedAsset: true },
  depletable_assets:        { subType: "non_current_asset",  cashFlowCategory: "investing", isFixedAsset: true },
  fixed_asset_computers:    { subType: "non_current_asset",  cashFlowCategory: "investing", isFixedAsset: true },
  fixed_asset_copiers:      { subType: "non_current_asset",  cashFlowCategory: "investing", isFixedAsset: true },
  fixed_asset_furniture:    { subType: "non_current_asset",  cashFlowCategory: "investing", isFixedAsset: true },
  fixed_asset_phone:        { subType: "non_current_asset",  cashFlowCategory: "investing", isFixedAsset: true },
  fixed_asset_photo_video:  { subType: "non_current_asset",  cashFlowCategory: "investing", isFixedAsset: true },
  fixed_asset_software:     { subType: "non_current_asset",  cashFlowCategory: "investing", isFixedAsset: true },
  fixed_asset_other_tools:  { subType: "non_current_asset",  cashFlowCategory: "investing", isFixedAsset: true },
  furniture_fixtures:       { subType: "non_current_asset",  cashFlowCategory: "investing", isFixedAsset: true },
  intangible_assets:        { subType: "non_current_asset",  cashFlowCategory: "investing" },
  land:                     { subType: "non_current_asset",  cashFlowCategory: "investing", isFixedAsset: true },
  leasehold_improvements:   { subType: "non_current_asset",  cashFlowCategory: "investing", isFixedAsset: true },
  machinery_equipment:      { subType: "non_current_asset",  cashFlowCategory: "investing", isFixedAsset: true },
  other_fixed_asset:        { subType: "non_current_asset",  cashFlowCategory: "investing", isFixedAsset: true },
  vehicles:                 { subType: "non_current_asset",  cashFlowCategory: "investing", isFixedAsset: true },

  // ─── ASSETS: Non-Current (Other) ──────────────────────────────────
  accumulated_amortization: { subType: "non_current_asset",  cashFlowCategory: "investing", isContraAsset: true },
  assets_held_for_sale:     { subType: "non_current_asset",  cashFlowCategory: "investing" },
  deferred_tax_asset:       { subType: "non_current_asset",  cashFlowCategory: "operating" },
  goodwill:                 { subType: "non_current_asset",  cashFlowCategory: "investing" },
  lease_buyout:             { subType: "non_current_asset",  cashFlowCategory: "investing" },
  licenses:                 { subType: "non_current_asset",  cashFlowCategory: "investing" },
  long_term_investments:    { subType: "non_current_asset",  cashFlowCategory: "investing" },
  organizational_costs:     { subType: "non_current_asset",  cashFlowCategory: "investing" },
  security_deposits:        { subType: "non_current_asset",  cashFlowCategory: "investing" },
  other_non_current_asset:  { subType: "non_current_asset",  cashFlowCategory: "investing" },

  // ─── LIABILITIES: Current ────────────────────────────────────────
  accounts_payable:         { subType: "current_liability",  cashFlowCategory: "operating",  isPayable: true },
  credit_card:              { subType: "current_liability",  cashFlowCategory: "financing" },
  accrued_liabilities:      { subType: "current_liability",  cashFlowCategory: "operating" },
  trust_accounts_liability_current: { subType: "current_liability", cashFlowCategory: "operating" },
  current_tax_liability:    { subType: "current_liability",  cashFlowCategory: "operating" },
  finance_lease_current:    { subType: "current_liability",  cashFlowCategory: "financing" },
  dividends_payable:        { subType: "current_liability",  cashFlowCategory: "financing" },
  insurance_payable:        { subType: "current_liability",  cashFlowCategory: "operating" },
  line_of_credit:           { subType: "current_liability",  cashFlowCategory: "financing" },
  loan_payable_current:     { subType: "current_liability",  cashFlowCategory: "financing" },
  payroll_clearing:         { subType: "current_liability",  cashFlowCategory: "operating" },
  payroll_liabilities:      { subType: "current_liability",  cashFlowCategory: "operating" },
  payroll_tax_payable:      { subType: "current_liability",  cashFlowCategory: "operating" },
  prepaid_expenses_payable: { subType: "current_liability",  cashFlowCategory: "operating" },
  rents_in_trust_liability: { subType: "current_liability",  cashFlowCategory: "operating" },
  sales_tax_payable:        { subType: "current_liability",  cashFlowCategory: "operating" },
  state_local_tax_payable:  { subType: "current_liability",  cashFlowCategory: "operating" },
  trust_accounts_liability: { subType: "current_liability",  cashFlowCategory: "operating" },
  unearned_revenue:         { subType: "current_liability",  cashFlowCategory: "operating" },
  other_current_liability:  { subType: "current_liability",  cashFlowCategory: "operating" },

  // ─── LIABILITIES: Non-Current ────────────────────────────────────
  accrued_holiday_payable:  { subType: "non_current_liability", cashFlowCategory: "operating" },
  accrued_non_current_liabilities: { subType: "non_current_liability", cashFlowCategory: "operating" },
  liabilities_held_for_sale:{ subType: "non_current_liability", cashFlowCategory: "financing" },
  long_term_borrowings:     { subType: "non_current_liability", cashFlowCategory: "financing" },
  lease_obligations:        { subType: "non_current_liability", cashFlowCategory: "financing" },
  notes_payable:            { subType: "non_current_liability", cashFlowCategory: "financing" },
  shareholder_notes_payable:{ subType: "non_current_liability", cashFlowCategory: "financing" },
  other_non_current_liability: { subType: "non_current_liability", cashFlowCategory: "financing" },

  // ─── EQUITY ──────────────────────────────────────────────────────
  accumulated_adjustment:   { subType: "reserves",            cashFlowCategory: "financing" },
  dividend_disbursed:       { subType: "reserves",            cashFlowCategory: "financing" },
  equity_in_subsidiaries:   { subType: "reserves",            cashFlowCategory: "financing" },
  share_capital:            { subType: "share_capital",       cashFlowCategory: "financing" },
  estimated_taxes:          { subType: "reserves",            cashFlowCategory: "financing" },
  health_insurance_premium: { subType: "reserves",            cashFlowCategory: "financing" },
  opening_balance_equity:   { subType: "reserves",            cashFlowCategory: "financing" },
  other_comprehensive_income: { subType: "reserves",          cashFlowCategory: "financing" },
  owner_contributions:      { subType: "share_capital",       cashFlowCategory: "financing" },
  owner_drawings:           { subType: "reserves",            cashFlowCategory: "financing" },
  owners_equity:            { subType: "share_capital",       cashFlowCategory: "financing" },
  paid_in_capital:          { subType: "share_capital",       cashFlowCategory: "financing" },
  personal_expense:         { subType: "reserves",            cashFlowCategory: "financing" },
  personal_income:          { subType: "reserves",            cashFlowCategory: "financing" },
  preferred_stock:          { subType: "share_capital",       cashFlowCategory: "financing" },
  retained_earnings:        { subType: "retained_earnings",   cashFlowCategory: "financing" },
  treasury_stock:           { subType: "share_capital",       cashFlowCategory: "financing" },
  other_equity:             { subType: "reserves",            cashFlowCategory: "financing" },

  // ─── INCOME: Revenue ─────────────────────────────────────────────
  discount_refund:          { subType: "revenue",            isContraRevenue: true },
  non_profit_income:        { subType: "revenue" },
  other_primary_income:     { subType: "revenue" },
  revenue_general:          { subType: "revenue" },
  sales_retail:             { subType: "revenue" },
  sales_wholesale:          { subType: "revenue" },
  sales_income:             { subType: "revenue" },
  service_income:           { subType: "revenue" },
  unapplied_cash_payment_income: { subType: "revenue" },

  // ─── INCOME: Other Income ────────────────────────────────────────
  dividend_income:          { subType: "other_income" },
  interest_income:          { subType: "other_income" },
  gain_on_asset_sales:      { subType: "other_income" },
  other_investment_income:  { subType: "other_income" },
  other_operating_income:   { subType: "other_income" },
  rental_income:            { subType: "other_income" },
  tax_exempt_interest:      { subType: "other_income" },
  unrealized_loss_securities: { subType: "other_income" },
  other_income:             { subType: "other_income" },

  // ─── EXPENSE: Cost of Sales ──────────────────────────────────────
  cost_of_labour:           { subType: "cost_of_sales" },
  cost_of_goods_sold:       { subType: "cost_of_sales" },
  equipment_rental_cos:     { subType: "cost_of_sales" },
  freight_delivery_cos:     { subType: "cost_of_sales" },
  supplies_materials_cos:   { subType: "cost_of_sales" },
  shipping_cos:             { subType: "cost_of_sales" },
  other_cos:                { subType: "cost_of_sales" },

  // ─── EXPENSE: Operating Expenses ─────────────────────────────────
  advertising:              { subType: "operating_expense" },
  amortization:             { subType: "operating_expense" },
  auto:                     { subType: "operating_expense" },
  bad_debts:                { subType: "operating_expense" },
  bank_charges:             { subType: "operating_expense" },
  charitable_contributions: { subType: "operating_expense" },
  commissions_fees:         { subType: "operating_expense" },
  cost_of_labour_expense:   { subType: "operating_expense" },
  dues_subscriptions:       { subType: "operating_expense" },
  entertainment:            { subType: "operating_expense" },
  entertainment_meals:      { subType: "operating_expense" },
  equipment_rental:         { subType: "operating_expense" },
  finance_costs:            { subType: "operating_expense" },
  income_tax_expense:       { subType: "tax_expense" },
  insurance_expense:        { subType: "operating_expense" },
  interest_paid:            { subType: "operating_expense" },
  loss_discontinued_operations: { subType: "operating_expense" },
  management_compensation:  { subType: "operating_expense" },
  legal_professional_fees:  { subType: "operating_expense" },
  meals_entertainment:      { subType: "operating_expense" },
  office_expenses:          { subType: "operating_expense" },
  other_business_expenses:  { subType: "operating_expense" },
  other_selling_expense:    { subType: "operating_expense" },
  other_misc_service_cost:  { subType: "operating_expense" },
  payroll_expense:          { subType: "operating_expense" },
  payroll_tax_expense:      { subType: "operating_expense" },
  payroll_wage_expense:     { subType: "operating_expense" },
  promotional_meals:        { subType: "operating_expense" },
  rent_expense:             { subType: "operating_expense" },
  repair_maintenance:       { subType: "operating_expense" },
  security_expenses:        { subType: "operating_expense" },
  shipping_delivery:        { subType: "operating_expense" },
  supplies:                 { subType: "operating_expense" },
  taxes_paid:               { subType: "tax_expense" },
  telephone_internet:       { subType: "operating_expense" },
  travel:                   { subType: "operating_expense" },
  travel_meals:             { subType: "operating_expense" },
  travel_selling:           { subType: "operating_expense" },
  unapplied_cash_bill_payment: { subType: "operating_expense" },
  utilities:                { subType: "operating_expense" },
  depreciation:             { subType: "operating_expense" },

  // ─── EXPENSE: Other Expenses ─────────────────────────────────────
  exchange_gain_loss:       { subType: "other_expense" },
  penalties:                { subType: "other_expense" },
  loss_on_asset_sales:      { subType: "other_expense" },
  other_expense:            { subType: "other_expense" },
};

/**
 * Resolves a detail_type to its classification metadata.
 * Returns undefined if the detail_type is unknown.
 */
export function getDetailTypeClassification(detailType: string | null | undefined): DetailTypeClassification | undefined {
  if (!detailType) return undefined;
  return DETAIL_TYPE_CLASSIFICATION[detailType];
}

/**
 * Resolves the AccountSubType from a detail_type.
 * Returns undefined if the detail_type is unknown.
 */
export function getSubTypeFromDetailType(detailType: string | null | undefined): AccountSubType | undefined {
  const classification = getDetailTypeClassification(detailType);
  return classification?.subType;
}

/**
 * Resolves the cash flow category from a detail_type.
 */
export function getCashFlowCategoryFromDetailType(detailType: string | null | undefined): string | null {
  const classification = getDetailTypeClassification(detailType);
  return classification?.cashFlowCategory || null;
}

/**
 * Validates that a detail_type belongs to the correct account_type.
 * Uses the ACCOUNT_DETAIL_TYPES from accountDetailTypes.ts.
 */
export function isValidDetailTypeForAccountType(detailType: string, accountType: string): boolean {
  // Import-safe: check if the detail_type exists in the classification map
  // and its subType is compatible with the account_type
  const classification = DETAIL_TYPE_CLASSIFICATION[detailType];
  if (!classification) return false;

  const subType = classification.subType;
  switch (accountType) {
    case "asset":
      return subType === "current_asset" || subType === "non_current_asset";
    case "liability":
      return subType === "current_liability" || subType === "non_current_liability";
    case "equity":
      return subType === "share_capital" || subType === "retained_earnings" || subType === "reserves";
    case "income":
      return subType === "revenue" || subType === "other_income";
    case "expense":
      return subType === "cost_of_sales" || subType === "operating_expense" || subType === "other_expense" || subType === "tax_expense";
    default:
      return false;
  }
}
