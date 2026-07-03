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
const FixedAssets = lazy(() => import("@/pages/FixedAssets"));
const AnalyticAccounts = lazy(() => import("@/pages/AnalyticAccounts"));
const Banking = lazy(() => import("@/pages/Banking"));
const BankReconciliation = lazy(() => import("@/pages/BankReconciliation"));
const BankFeeds = lazy(() => import("@/pages/BankFeeds"));

// Report pages (all lazy-loaded)
const FinancialReports = lazy(() => import("@/pages/reports/FinancialReports"));
const TrialBalance = lazy(() => import("@/pages/reports/TrialBalance"));
const GeneralLedger = lazy(() => import("@/pages/reports/GeneralLedger"));
const AgingReport = lazy(() => import("@/pages/reports/AgingReport"));
const SalesReports = lazy(() => import("@/pages/reports/SalesReports"));
const ManagementReports = lazy(() => import("@/pages/reports/ManagementReports"));
const TaxReports = lazy(() => import("@/pages/reports/TaxReports"));
const StockReports = lazy(() => import("@/pages/reports/StockReports"));
const BusinessIntelligence = lazy(() => import("@/pages/BusinessIntelligence"));
const Reports = lazy(() => import("@/pages/Reports"));
const PartnerLedger = lazy(() => import("@/pages/reports/PartnerLedger"));
const JournalReport = lazy(() => import("@/pages/reports/JournalReport"));
const BudgetReport = lazy(() => import("@/pages/reports/BudgetReport"));
const DepreciationReport = lazy(() => import("@/pages/reports/DepreciationReport"));
const CashFlowReport = lazy(() => import("@/pages/reports/CashFlowReport"));
const AuditTrailReport = lazy(() => import("@/pages/reports/AuditTrail"));
const InventoryGLReconciliation = lazy(() => import("@/pages/reports/InventoryGLReconciliation"));
const ControlAccountReconciliation = lazy(() => import("@/pages/reports/ControlAccountReconciliation"));
const BankReconciliationReport = lazy(() => import("@/pages/reports/BankReconciliationReport"));
const PosShiftGLIntegrity = lazy(() => import("@/pages/reports/PosShiftGLIntegrity"));
const StockAdjustmentsReport = lazy(() => import("@/pages/reports/StockAdjustmentsReport"));
const StockTransfersReport = lazy(() => import("@/pages/reports/StockTransfersReport"));
const FxRevaluationReport = lazy(() => import("@/pages/reports/FxRevaluationReport"));

const FinanceSettingsPage = lazy(() => import("@/pages/finance/FinanceSettings"));
const FinanceIntegrity = lazy(() => import("@/pages/finance/FinanceIntegrity"));

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
        
        {/* Fixed Assets */}
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
        
        {/* Bank Reconciliation */}
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

        {/* POS Shift GL Integrity (Phase B4) */}
        <Route
          path="reports/pos-shift-gl-integrity"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="POS Shift GL Integrity">
                <PosShiftGLIntegrity />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

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

        {/* Catch all - redirect to accounts */}
        <Route path="*" element={<Navigate to="dashboard" replace />} />
      </Routes>
    </FinanceLayout>
  );
}

export default FinanceApp;
