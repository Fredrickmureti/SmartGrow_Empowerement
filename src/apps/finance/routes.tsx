/**
 * Finance App Routes
 * 
 * Odoo-style: If the "finance" app is enabled, ALL Finance pages are accessible.
 * Only cross-cutting premium features (business_intelligence) remain as feature gates.
 */

import { lazy, Suspense } from "react";
import { Routes, Route, Navigate, useSearchParams } from "react-router-dom";
import { RouteLoadingFallback } from "@/components/common/RouteLoadingFallback";
import { SubscriptionProtectedRoute } from "@/components/subscription/SubscriptionProtectedRoute";
import { FinanceLayout } from "./FinanceLayout";

// Redirect /finance/contact?id=X → /contacts-app/profile?id=X
function ContactRedirect() {
  const [searchParams] = useSearchParams();
  const id = searchParams.get("id") || "";
  return <Navigate to={`/contacts-app/profile?id=${id}`} replace />;
}

// Redirect legacy /finance/pos-posting-queue → /finance/operations/accounting-events
// Preserves ?shift=… (POS deep-link) so bookmarks and email links keep working.
function LegacyPosQueueRedirect() {
  const [searchParams] = useSearchParams();
  const qs = searchParams.toString();
  return <Navigate to={`/finance/operations/accounting-events${qs ? `?${qs}` : ""}`} replace />;
}

// Eager imports for commonly accessed pages
import Accounts from "@/pages/Accounts";
const AccountCreatePage = lazy(() => import("@/features/finance/accounts/AccountCreatePage"));
const AccountEditPage = lazy(() => import("@/features/finance/accounts/AccountEditPage"));
const FinanceDashboard = lazy(() => import("@/pages/finance/FinanceDashboard"));
const AccountRegister = lazy(() => import("@/pages/finance/AccountRegister"));
const ReportCenter = lazy(() => import("@/pages/finance/ReportCenter"));
// ContactDetail removed — unified into /contacts-app/profile via ContactRedirect (see route below)
const AccountsReceivable = lazy(() => import("@/pages/finance/AccountsReceivable"));
const AccountsPayable = lazy(() => import("@/pages/finance/AccountsPayable"));
const CustomerCredits = lazy(() => import("@/pages/finance/CustomerCredits"));
const CustomerStatements = lazy(() => import("@/pages/CustomerStatements"));

// Lazy imports for less frequently accessed pages
const JournalEntries = lazy(() => import("@/pages/JournalEntries"));
const JournalEntryDetailPage = lazy(() => import("@/features/finance/journal-entries/JournalEntryDetailPage"));
const JournalEntryCreatePage = lazy(() => import("@/features/finance/journal-entries/JournalEntryCreatePage"));
const JournalEntryEditPage = lazy(() => import("@/features/finance/journal-entries/JournalEntryEditPage"));
const BusinessTransactionCreatePage = lazy(() => import("@/features/finance/business-transactions/BusinessTransactionCreatePage"));
const RecurringJournalCreatePage = lazy(() => import("@/features/finance/recurring-journals/RecurringJournalCreatePage"));
const AccountDetailRedirect = lazy(() => import("@/pages/finance/AccountDetailRedirect"));
const FiscalPeriods = lazy(() => import("@/pages/FiscalPeriods"));
const FiscalPeriodDetail = lazy(() => import("@/pages/finance/FiscalPeriodDetail"));
const YearEndClosePage = lazy(() => import("@/features/finance/year-end-close/YearEndClosePage"));
const Budgets = lazy(() => import("@/pages/Budgets"));
const BudgetCreatePage = lazy(() => import("@/features/finance/budgets/BudgetCreatePage"));
const BudgetEditPage = lazy(() => import("@/features/finance/budgets/BudgetEditPage"));
const FixedAssets = lazy(() => import("@/pages/FixedAssets"));
const AnalyticAccounts = lazy(() => import("@/pages/AnalyticAccounts"));
const Banking = lazy(() => import("@/pages/Banking"));
const BankReconciliation = lazy(() => import("@/pages/BankReconciliation"));
const StartReconciliationPage = lazy(() => import("@/features/finance/reconciliation/StartReconciliationPage"));
const ApplyCreditWizardPage = lazy(() => import("@/features/finance/customer-credits/ApplyCreditWizardPage"));
const ProcessRefundWizardPage = lazy(() => import("@/features/finance/customer-credits/ProcessRefundWizardPage"));
const VendorCredits = lazy(() => import("@/pages/finance/VendorCredits"));
const AssetCreatePage = lazy(() => import("@/features/finance/fixed-assets/AssetCreatePage"));
const AssetEditPage = lazy(() => import("@/features/finance/fixed-assets/AssetEditPage"));
const BankFeeds = lazy(() => import("@/pages/BankFeeds"));
const RulesListPage = lazy(() => import("@/features/finance/banking/rules/RulesListPage"));
const RuleCreatePage = lazy(() => import("@/features/finance/banking/rules/RuleCreatePage"));
const RuleEditPage = lazy(() => import("@/features/finance/banking/rules/RuleEditPage"));
const ImportStatementWizardPage = lazy(() => import("@/features/finance/banking/import/ImportStatementWizardPage"));
const BankAccountCreatePage = lazy(() => import("@/features/finance/banking/BankAccountCreatePage"));
const BankAccountEditPage = lazy(() => import("@/features/finance/banking/BankAccountEditPage"));

// Report pages (all lazy-loaded)
const FinancialReports = lazy(() => import("@/pages/reports/FinancialReports"));
const TrialBalance = lazy(() => import("@/pages/reports/TrialBalance"));
const GeneralLedger = lazy(() => import("@/pages/reports/GeneralLedger"));
const AgingReport = lazy(() => import("@/pages/reports/AgingReport"));
const SalesReports = lazy(() => import("@/pages/reports/SalesReports"));
const PurchaseReports = lazy(() => import("@/pages/reports/PurchaseReports"));
const ManagementReports = lazy(() => import("@/pages/reports/ManagementReports"));
const CrossCompanyComparative = lazy(() => import("@/pages/reports/Consolidation"));
const TaxReports = lazy(() => import("@/pages/reports/TaxReports"));
const StockReports = lazy(() => import("@/pages/reports/StockReports"));
const BusinessIntelligence = lazy(() => import("@/pages/BusinessIntelligence"));
const Reports = lazy(() => import("@/pages/Reports"));
const PartnerLedger = lazy(() => import("@/pages/reports/PartnerLedger"));
const JournalReport = lazy(() => import("@/pages/reports/JournalReport"));
const BudgetReport = lazy(() => import("@/pages/reports/BudgetReport"));
// Analytic accounting reports (Phase 5 consumers).
const AnalyticAccountStatement = lazy(() => import("@/pages/reports/AnalyticAccountStatement"));
const AnalyticProfitAndLoss = lazy(() => import("@/pages/reports/AnalyticProfitAndLoss"));
const AnalyticBudgetVsActual = lazy(() => import("@/pages/reports/AnalyticBudgetVsActual"));

const DepreciationReport = lazy(() => import("@/pages/reports/DepreciationReport"));
const CashFlowReport = lazy(() => import("@/pages/reports/CashFlowReport"));
const AuditTrailReport = lazy(() => import("@/pages/reports/AuditTrail"));
const ReportRunHistory = lazy(() => import("@/pages/reports/ReportRunHistory"));
const InventoryGLReconciliation = lazy(() => import("@/pages/reports/InventoryGLReconciliation"));
const ControlAccountReconciliation = lazy(() => import("@/pages/reports/ControlAccountReconciliation"));
const BankReconciliationReport = lazy(() => import("@/pages/reports/BankReconciliationReport"));

const StockAdjustmentsReport = lazy(() => import("@/pages/reports/StockAdjustmentsReport"));
// ADR 0143 — inventory reports are dual-hosted: same page components, mounted
// under both /finance/reports/* and /inventory-app/reports/*.
const InventoryValuationReport = lazy(() => import("@/pages/reports/InventoryValuationReport"));
const StockLedgerReport = lazy(() => import("@/pages/reports/StockLedgerReport"));
const StockAgingReport = lazy(() => import("@/pages/reports/StockAgingReport"));
const LotTraceabilityReport = lazy(() => import("@/pages/reports/LotTraceabilityReport"));
const StockTransfersReport = lazy(() => import("@/pages/reports/StockTransfersReport"));
const FxRevaluationReport = lazy(() => import("@/pages/reports/FxRevaluationReport"));
const FxExposureReport = lazy(() => import("@/pages/reports/FxExposureReport"));
const FxRealizedReport = lazy(() => import("@/pages/reports/FxRealizedReport"));


const FinanceSettingsPage = lazy(() => import("@/pages/finance/FinanceSettings"));
const FinanceIntegrity = lazy(() => import("@/pages/finance/FinanceIntegrity"));
const ReversalRegister = lazy(() => import("@/pages/finance/ReversalRegister"));
// Legacy PosPostingQueue page is superseded by AccountingEventsWorkspace (B4).
// It stays in the codebase until B7 (legacy cleanup) but is no longer routed.
const AccountingEventsWorkspace = lazy(() => import("@/pages/finance/AccountingEventsWorkspace"));


// Wrapper for lazy routes
const LazyRoute = ({ children, module }: { children: React.ReactNode; module?: string }) => (
  <Suspense fallback={<RouteLoadingFallback module={module} />}>
    {children}
  </Suspense>
);

/**
 * Finance App Component
 */
export function FinanceApp() {
  return (
    <FinanceLayout>
      <Routes>
        {/* Default redirect to dashboard */}
        <Route index element={<Navigate to="dashboard" replace />} />
        
        {/* Finance Dashboard */}
        <Route
          path="dashboard"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Finance Dashboard">
                <FinanceDashboard />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        
        {/* Accounts Receivable */}
        <Route
          path="receivables"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Accounts Receivable">
                <AccountsReceivable />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Accounts Payable */}
        <Route
          path="payables"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Accounts Payable">
                <AccountsPayable />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Customer Credits — apply + refund wizards (list route below). */}
        <Route
          path="customer-credits/:id/apply"
          element={
            <SubscriptionProtectedRoute>
              <LazyRoute module="Apply Customer Credit">
                <ApplyCreditWizardPage />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        <Route
          path="customer-credits/:id/refund"
          element={
            <SubscriptionProtectedRoute>
              <LazyRoute module="Process Credit Refund">
                <ProcessRefundWizardPage />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Customer Credits */}
        <Route
          path="customer-credits"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Customer Credits">
                <CustomerCredits />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Vendor Credits — AP mirror of Customer Credits (ADR 0028). */}
        <Route
          path="vendor-credits"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Vendor Credits">
                <VendorCredits />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Customer Statements */}
        <Route
          path="statements"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Customer Statements">
                <CustomerStatements />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Chart of Accounts */}
        <Route
          path="accounts"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <Accounts />
            </SubscriptionProtectedRoute>
          }
        />

        {/* Chart of Accounts — routed create/edit on RecordFormShell.
            MUST come BEFORE `accounts/register` and `accounts/:id` to avoid shadowing. */}
        <Route
          path="accounts/new"
          element={
            <SubscriptionProtectedRoute>
              <LazyRoute module="New Account">
                <AccountCreatePage />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        <Route
          path="accounts/:id/edit"
          element={
            <SubscriptionProtectedRoute>
              <LazyRoute module="Edit Account">
                <AccountEditPage />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Account Register (single account transaction view) */}
        <Route
          path="accounts/register"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Account Register">
                <AccountRegister />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Per-record account detail route (deep-linkable, drill-down target).
            MUST come AFTER static `accounts/register` to avoid shadowing it. */}
        <Route
          path="accounts/:id"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Account Detail">
                <AccountDetailRedirect />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        
        {/* Contact Detail - Redirect to unified profile */}
        <Route
          path="contact"
          element={
            <ContactRedirect />
          }
        />
        {/* Journal Entries */}
        <Route
          path="journal-entries"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Journal Entries">
                <JournalEntries />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Journal Entry — routed create/edit on RecordFormShell.
            MUST come BEFORE `journal-entries/:id` to avoid shadowing. */}
        <Route
          path="journal-entries/new"
          element={
            <SubscriptionProtectedRoute>
              <LazyRoute module="New Journal Entry">
                <JournalEntryCreatePage />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        <Route
          path="journal-entries/:id/edit"
          element={
            <SubscriptionProtectedRoute>
              <LazyRoute module="Edit Journal Entry">
                <JournalEntryEditPage />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Per-record JE detail route (deep-linkable, drill-down target). */}
        <Route
          path="journal-entries/:id"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Journal Entry">
                <JournalEntryDetailPage />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Business Transaction — routed guided-post on RecordFormShell. */}
        <Route
          path="business-transactions/new"
          element={
            <SubscriptionProtectedRoute>
              <LazyRoute module="New Business Transaction">
                <BusinessTransactionCreatePage />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Recurring Journal — routed create on RecordFormShell. */}
        <Route
          path="recurring-journals/new"
          element={
            <SubscriptionProtectedRoute>
              <LazyRoute module="New Recurring Journal">
                <RecurringJournalCreatePage />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        
        {/* Fiscal Periods */}
        <Route
          path="fiscal-periods"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Fiscal Periods">
                <FiscalPeriods />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        <Route
          path="fiscal-periods/close"
          element={
            <SubscriptionProtectedRoute>
              <LazyRoute module="Year-End Closing">
                <YearEndClosePage />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        <Route
          path="fiscal-periods/:periodId"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Fiscal Period Detail">
                <FiscalPeriodDetail />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        
        {/* Budgets */}
        {/* /new + /:id/edit MUST precede the list to avoid the list
            swallowing "new" as a param. */}
        <Route
          path="budgets/new"
          element={
            <SubscriptionProtectedRoute>
              <LazyRoute module="New Budget">
                <BudgetCreatePage />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        <Route
          path="budgets/:id/edit"
          element={
            <SubscriptionProtectedRoute>
              <LazyRoute module="Edit Budget">
                <BudgetEditPage />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        <Route
          path="budgets"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Budgets">
                <Budgets />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        
        {/* Analytic Accounts */}
        <Route
          path="analytic-accounts"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Analytic Accounts">
                <AnalyticAccounts />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        
        {/* Fixed Assets — /new + /:id/edit routes must precede the list. */}
        <Route
          path="fixed-assets/new"
          element={
            <SubscriptionProtectedRoute>
              <LazyRoute module="New Fixed Asset">
                <AssetCreatePage />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        <Route
          path="fixed-assets/:id/edit"
          element={
            <SubscriptionProtectedRoute>
              <LazyRoute module="Edit Fixed Asset">
                <AssetEditPage />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        <Route
          path="fixed-assets"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Fixed Assets">
                <FixedAssets />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        
        {/* Banking */}
        <Route
          path="banking"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Banking">
                <Banking />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Bank Account — routed create/edit on RecordFormShell.
            MUST come BEFORE `banking/rules` sibling routes are declared
            already above with concrete prefixes, so ordering here is safe. */}
        <Route
          path="banking/accounts/new"
          element={
            <SubscriptionProtectedRoute>
              <LazyRoute module="Add Bank Account">
                <BankAccountCreatePage />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        <Route
          path="banking/accounts/:id/edit"
          element={
            <SubscriptionProtectedRoute>
              <LazyRoute module="Edit Bank Account">
                <BankAccountEditPage />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Transaction Rules — /new + /:id/edit must precede the list. */}
        <Route
          path="banking/rules/new"
          element={
            <SubscriptionProtectedRoute>
              <LazyRoute module="New Transaction Rule">
                <RuleCreatePage />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        <Route
          path="banking/rules/:id/edit"
          element={
            <SubscriptionProtectedRoute>
              <LazyRoute module="Edit Transaction Rule">
                <RuleEditPage />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        <Route
          path="banking/rules"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Transaction Rules">
                <RulesListPage />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Bank Statement Import — routed WizardShell. */}
        <Route
          path="banking/import"
          element={
            <SubscriptionProtectedRoute>
              <LazyRoute module="Import Bank Statement">
                <ImportStatementWizardPage />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        
        
        {/* Bank Reconciliation — routed start form (must come BEFORE `reconciliation` to avoid shadowing). */}
        <Route
          path="reconciliation/new"
          element={
            <SubscriptionProtectedRoute>
              <LazyRoute module="Start Reconciliation">
                <StartReconciliationPage />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        <Route
          path="reconciliation"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Bank Reconciliation">
                <BankReconciliation />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        
        
        {/* Bank Feeds */}
        <Route
          path="bank-feeds"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Bank Feeds">
                <BankFeeds />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        
        {/* Financial Reports Section - All sub-pages */}
        <Route
          path="reports"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Report Center">
                <ReportCenter />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        
        <Route
          path="reports/financial"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Financial Reports">
                <FinancialReports />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        
        <Route
          path="reports/trial-balance"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Trial Balance">
                <TrialBalance />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        
        <Route
          path="reports/general-ledger"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="General Ledger">
                <GeneralLedger />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        
        <Route
          path="reports/aging"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Aging Reports">
                <AgingReport />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        
        <Route
          path="reports/sales"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Sales Reports">
                <SalesReports />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        
        <Route
          path="reports/purchases"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Purchase Reports">
                <PurchaseReports />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Cross-company comparative P&L — side-by-side, never summed */}
        <Route
          path="reports/cross-company"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Cross-Company Comparative">
                <CrossCompanyComparative />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        <Route
          path="reports/management"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Management Reports">
                <ManagementReports />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        
        <Route
          path="reports/tax"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Tax Reports">
                <TaxReports />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        
        <Route
          path="reports/stock"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Stock Reports">
                <StockReports />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Inventory reports — Finance mount (ADR 0143 dual host) */}
        <Route
          path="reports/inventory-valuation"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Inventory Valuation">
                <InventoryValuationReport />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        <Route
          path="reports/stock-ledger"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Stock Ledger">
                <StockLedgerReport />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        <Route
          path="reports/stock-aging"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Stock Aging">
                <StockAgingReport />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        <Route
          path="reports/lot-traceability"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Lot Traceability">
                <LotTraceabilityReport />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        
        {/* Business Intelligence — premium cross-cutting feature */}
        <Route
          path="reports/intelligence"
          element={
            <SubscriptionProtectedRoute requiredFeature="business_intelligence" allowReadOnly>
              <LazyRoute module="Business Intelligence">
                <BusinessIntelligence />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        
        {/* Partner Ledger */}
        <Route
          path="reports/partner-ledger"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Partner Ledger">
                <PartnerLedger />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        
        {/* Journal Report */}
        <Route
          path="reports/journal-report"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Journal Report">
                <JournalReport />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        
        {/* Budget vs Actual */}
        <Route
          path="reports/budget"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Budget vs Actual">
                <BudgetReport />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        
        {/* Analytic accounting reports — management dimension of the GL */}
        <Route
          path="reports/analytic-statement"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Analytic Account Statement">
                <AnalyticAccountStatement />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        <Route
          path="reports/analytic-profit-and-loss"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Analytic Profit & Loss">
                <AnalyticProfitAndLoss />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        <Route
          path="reports/analytic-budget-vs-actual"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Analytic Budget vs Actual">
                <AnalyticBudgetVsActual />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Depreciation Report */}
        <Route
          path="reports/depreciation"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Depreciation Report">
                <DepreciationReport />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        
        {/* Cash Flow Report */}
        <Route
          path="reports/cash-flow"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Cash Flow Report">
                <CashFlowReport />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        
        {/* Audit Trail */}
        <Route
          path="reports/audit-trail"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Audit Trail">
                <AuditTrailReport />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        
        {/* Report Run History — reader for report_run_log (Phase G) */}
        <Route
          path="reports/run-history"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Report Run History">
                <ReportRunHistory />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Inventory ⇄ GL Reconciliation (Phase B1) */}
        <Route
          path="reports/inventory-gl-reconciliation"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Inventory ⇄ GL Reconciliation">
                <InventoryGLReconciliation />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Control Account Reconciliation (Phase B2) */}
        <Route
          path="reports/control-account-reconciliation"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Control Account Reconciliation">
                <ControlAccountReconciliation />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Bank Reconciliation Report (Phase B3) */}
        <Route
          path="reports/bank-reconciliation"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Bank Reconciliation Report">
                <BankReconciliationReport />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* POS Shift GL Integrity report removed — superseded by the producer-agnostic
            Accounting Events workspace (/finance/operations/accounting-events), which
            reads from the authoritative `accounting_events` sub-ledger rather than
            legacy per-product accounts or outbox-row state. */}


        {/* Stock Adjustments Report (Phase B5) */}
        <Route
          path="reports/stock-adjustments"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Stock Adjustments Report">
                <StockAdjustmentsReport />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Stock Transfers Report (Phase B5) */}
        <Route
          path="reports/stock-transfers"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Stock Transfers Report">
                <StockTransfersReport />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* FX Revaluation Report (Phase B6) */}
        <Route
          path="reports/fx-revaluation"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="FX Revaluation Report">
                <FxRevaluationReport />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* FX Exposure Report (Currency & FX Step G) */}
        <Route
          path="reports/fx-exposure"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="FX Exposure Report">
                <FxExposureReport />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Realized FX Gain/Loss Report (Currency & FX Step 4) */}
        <Route
          path="reports/fx-realized"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Realized FX Gain/Loss Report">
                <FxRealizedReport />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />





        {/* Finance Settings */}
        <Route
          path="settings"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Finance Settings">
                <FinanceSettingsPage />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Phase 6: Finance Integrity */}
        <Route
          path="integrity"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Finance Integrity">
                <FinanceIntegrity />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Accounting Events Workspace (B4) — producer-agnostic sub-ledger
            operational surface. Supersedes the POS Posting Queue. */}
        {/* Phase 5.4: cross-module reversal register */}
        <Route
          path="reversal-register"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Reversal Register">
                <ReversalRegister />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        <Route
          path="operations/accounting-events"
          element={
            <SubscriptionProtectedRoute>
              <LazyRoute module="Accounting Events">
                <AccountingEventsWorkspace />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Legacy POS Posting Queue URL — 301-style client redirect to the
            new producer-agnostic workspace. Preserves ?shift=… so existing
            deep-links from POS ops keep working. */}
        <Route
          path="pos-posting-queue"
          element={<LegacyPosQueueRedirect />}
        />



        {/* Catch all - redirect to accounts */}
        <Route path="*" element={<Navigate to="dashboard" replace />} />
      </Routes>
    </FinanceLayout>
  );
}

export default FinanceApp;
