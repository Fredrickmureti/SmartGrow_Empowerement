/**
 * Finance App Routes
 * 
 * Odoo-style: If the "finance" app is enabled, ALL Finance pages are accessible.
 * Only cross-cutting premium features (business_intelligence) remain as feature gates.
 */

import { lazy, Suspense } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { RouteLoadingFallback } from "@/components/common/RouteLoadingFallback";
import { InstitutionRoute } from "@/components/auth/InstitutionRoute";
import { FinanceLayout } from "./FinanceLayout";



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
const FixedAssets = lazy(() => import("@/pages/FixedAssets"));
const Banking = lazy(() => import("@/pages/Banking"));
const BankReconciliation = lazy(() => import("@/pages/BankReconciliation"));
const StartReconciliationPage = lazy(() => import("@/features/finance/reconciliation/StartReconciliationPage"));
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
const ManagementReports = lazy(() => import("@/pages/reports/ManagementReports"));
const Reports = lazy(() => import("@/pages/Reports"));
const JournalReport = lazy(() => import("@/pages/reports/JournalReport"));
// Analytic accounting reports (Phase 5 consumers).

const DepreciationReport = lazy(() => import("@/pages/reports/DepreciationReport"));
const CashFlowReport = lazy(() => import("@/pages/reports/CashFlowReport"));
const AuditTrailReport = lazy(() => import("@/pages/reports/AuditTrail"));
const ReportRunHistory = lazy(() => import("@/pages/reports/ReportRunHistory"));
const ControlAccountReconciliation = lazy(() => import("@/pages/reports/ControlAccountReconciliation"));
const BankReconciliationReport = lazy(() => import("@/pages/reports/BankReconciliationReport"));

// ADR 0143 — inventory reports are dual-hosted: same page components, mounted
// under both /finance/reports/* and /inventory-app/reports/*.
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
            <InstitutionRoute allowReadOnly>
              <LazyRoute module="Finance Dashboard">
                <FinanceDashboard />
              </LazyRoute>
            </InstitutionRoute>
          }
        />
        
        {/* Accounts Receivable */}
        <Route
          path="receivables"
          element={
            <InstitutionRoute allowReadOnly>
              <LazyRoute module="Accounts Receivable">
                <AccountsReceivable />
              </LazyRoute>
            </InstitutionRoute>
          }
        />

        {/* Accounts Payable */}
        <Route
          path="payables"
          element={
            <InstitutionRoute allowReadOnly>
              <LazyRoute module="Accounts Payable">
                <AccountsPayable />
              </LazyRoute>
            </InstitutionRoute>
          }
        />

        {/* Customer Credits — apply + refund wizards (list route below). */}

        {/* Customer Credits */}

        {/* Vendor Credits — AP mirror of Customer Credits (ADR 0028). */}

        {/* Customer Statements */}

        {/* Chart of Accounts */}
        <Route
          path="accounts"
          element={
            <InstitutionRoute allowReadOnly>
              <Accounts />
            </InstitutionRoute>
          }
        />

        {/* Chart of Accounts — routed create/edit on RecordFormShell.
            MUST come BEFORE `accounts/register` and `accounts/:id` to avoid shadowing. */}
        <Route
          path="accounts/new"
          element={
            <InstitutionRoute>
              <LazyRoute module="New Account">
                <AccountCreatePage />
              </LazyRoute>
            </InstitutionRoute>
          }
        />
        <Route
          path="accounts/:id/edit"
          element={
            <InstitutionRoute>
              <LazyRoute module="Edit Account">
                <AccountEditPage />
              </LazyRoute>
            </InstitutionRoute>
          }
        />

        {/* Account Register (single account transaction view) */}
        <Route
          path="accounts/register"
          element={
            <InstitutionRoute allowReadOnly>
              <LazyRoute module="Account Register">
                <AccountRegister />
              </LazyRoute>
            </InstitutionRoute>
          }
        />

        {/* Per-record account detail route (deep-linkable, drill-down target).
            MUST come AFTER static `accounts/register` to avoid shadowing it. */}
        <Route
          path="accounts/:id"
          element={
            <InstitutionRoute allowReadOnly>
              <LazyRoute module="Account Detail">
                <AccountDetailRedirect />
              </LazyRoute>
            </InstitutionRoute>
          }
        />
        
        {/* Contact Detail - Redirect to unified profile */}
        {/* Journal Entries */}
        <Route
          path="journal-entries"
          element={
            <InstitutionRoute allowReadOnly>
              <LazyRoute module="Journal Entries">
                <JournalEntries />
              </LazyRoute>
            </InstitutionRoute>
          }
        />

        {/* Journal Entry — routed create/edit on RecordFormShell.
            MUST come BEFORE `journal-entries/:id` to avoid shadowing. */}
        <Route
          path="journal-entries/new"
          element={
            <InstitutionRoute>
              <LazyRoute module="New Journal Entry">
                <JournalEntryCreatePage />
              </LazyRoute>
            </InstitutionRoute>
          }
        />
        <Route
          path="journal-entries/:id/edit"
          element={
            <InstitutionRoute>
              <LazyRoute module="Edit Journal Entry">
                <JournalEntryEditPage />
              </LazyRoute>
            </InstitutionRoute>
          }
        />

        {/* Per-record JE detail route (deep-linkable, drill-down target). */}
        <Route
          path="journal-entries/:id"
          element={
            <InstitutionRoute allowReadOnly>
              <LazyRoute module="Journal Entry">
                <JournalEntryDetailPage />
              </LazyRoute>
            </InstitutionRoute>
          }
        />

        {/* Business Transaction — routed guided-post on RecordFormShell. */}
        <Route
          path="business-transactions/new"
          element={
            <InstitutionRoute>
              <LazyRoute module="New Business Transaction">
                <BusinessTransactionCreatePage />
              </LazyRoute>
            </InstitutionRoute>
          }
        />

        {/* Recurring Journal — routed create on RecordFormShell. */}
        <Route
          path="recurring-journals/new"
          element={
            <InstitutionRoute>
              <LazyRoute module="New Recurring Journal">
                <RecurringJournalCreatePage />
              </LazyRoute>
            </InstitutionRoute>
          }
        />
        
        {/* Fiscal Periods */}
        <Route
          path="fiscal-periods"
          element={
            <InstitutionRoute allowReadOnly>
              <LazyRoute module="Fiscal Periods">
                <FiscalPeriods />
              </LazyRoute>
            </InstitutionRoute>
          }
        />
        <Route
          path="fiscal-periods/close"
          element={
            <InstitutionRoute>
              <LazyRoute module="Year-End Closing">
                <YearEndClosePage />
              </LazyRoute>
            </InstitutionRoute>
          }
        />
        <Route
          path="fiscal-periods/:periodId"
          element={
            <InstitutionRoute allowReadOnly>
              <LazyRoute module="Fiscal Period Detail">
                <FiscalPeriodDetail />
              </LazyRoute>
            </InstitutionRoute>
          }
        />
        
        {/* Budgets */}
        {/* /new + /:id/edit MUST precede the list to avoid the list
            swallowing "new" as a param. */}
        
        {/* Analytic Accounts */}
        
        {/* Fixed Assets — /new + /:id/edit routes must precede the list. */}
        <Route
          path="fixed-assets/new"
          element={
            <InstitutionRoute>
              <LazyRoute module="New Fixed Asset">
                <AssetCreatePage />
              </LazyRoute>
            </InstitutionRoute>
          }
        />
        <Route
          path="fixed-assets/:id/edit"
          element={
            <InstitutionRoute>
              <LazyRoute module="Edit Fixed Asset">
                <AssetEditPage />
              </LazyRoute>
            </InstitutionRoute>
          }
        />
        <Route
          path="fixed-assets"
          element={
            <InstitutionRoute allowReadOnly>
              <LazyRoute module="Fixed Assets">
                <FixedAssets />
              </LazyRoute>
            </InstitutionRoute>
          }
        />
        
        {/* Banking */}
        <Route
          path="banking"
          element={
            <InstitutionRoute allowReadOnly>
              <LazyRoute module="Banking">
                <Banking />
              </LazyRoute>
            </InstitutionRoute>
          }
        />

        {/* Bank Account — routed create/edit on RecordFormShell.
            MUST come BEFORE `banking/rules` sibling routes are declared
            already above with concrete prefixes, so ordering here is safe. */}
        <Route
          path="banking/accounts/new"
          element={
            <InstitutionRoute>
              <LazyRoute module="Add Bank Account">
                <BankAccountCreatePage />
              </LazyRoute>
            </InstitutionRoute>
          }
        />
        <Route
          path="banking/accounts/:id/edit"
          element={
            <InstitutionRoute>
              <LazyRoute module="Edit Bank Account">
                <BankAccountEditPage />
              </LazyRoute>
            </InstitutionRoute>
          }
        />

        {/* Transaction Rules — /new + /:id/edit must precede the list. */}
        <Route
          path="banking/rules/new"
          element={
            <InstitutionRoute>
              <LazyRoute module="New Transaction Rule">
                <RuleCreatePage />
              </LazyRoute>
            </InstitutionRoute>
          }
        />
        <Route
          path="banking/rules/:id/edit"
          element={
            <InstitutionRoute>
              <LazyRoute module="Edit Transaction Rule">
                <RuleEditPage />
              </LazyRoute>
            </InstitutionRoute>
          }
        />
        <Route
          path="banking/rules"
          element={
            <InstitutionRoute allowReadOnly>
              <LazyRoute module="Transaction Rules">
                <RulesListPage />
              </LazyRoute>
            </InstitutionRoute>
          }
        />

        {/* Bank Statement Import — routed WizardShell. */}
        <Route
          path="banking/import"
          element={
            <InstitutionRoute>
              <LazyRoute module="Import Bank Statement">
                <ImportStatementWizardPage />
              </LazyRoute>
            </InstitutionRoute>
          }
        />
        
        
        {/* Bank Reconciliation — routed start form (must come BEFORE `reconciliation` to avoid shadowing). */}
        <Route
          path="reconciliation/new"
          element={
            <InstitutionRoute>
              <LazyRoute module="Start Reconciliation">
                <StartReconciliationPage />
              </LazyRoute>
            </InstitutionRoute>
          }
        />
        <Route
          path="reconciliation"
          element={
            <InstitutionRoute allowReadOnly>
              <LazyRoute module="Bank Reconciliation">
                <BankReconciliation />
              </LazyRoute>
            </InstitutionRoute>
          }
        />
        
        
        {/* Bank Feeds */}
        <Route
          path="bank-feeds"
          element={
            <InstitutionRoute allowReadOnly>
              <LazyRoute module="Bank Feeds">
                <BankFeeds />
              </LazyRoute>
            </InstitutionRoute>
          }
        />
        
        {/* Financial Reports Section - All sub-pages */}
        <Route
          path="reports"
          element={
            <InstitutionRoute allowReadOnly>
              <LazyRoute module="Report Center">
                <ReportCenter />
              </LazyRoute>
            </InstitutionRoute>
          }
        />
        
        <Route
          path="reports/financial"
          element={
            <InstitutionRoute allowReadOnly>
              <LazyRoute module="Financial Reports">
                <FinancialReports />
              </LazyRoute>
            </InstitutionRoute>
          }
        />
        
        <Route
          path="reports/trial-balance"
          element={
            <InstitutionRoute allowReadOnly>
              <LazyRoute module="Trial Balance">
                <TrialBalance />
              </LazyRoute>
            </InstitutionRoute>
          }
        />


        


        <Route
          path="reports/general-ledger"
          element={
            <InstitutionRoute allowReadOnly>
              <LazyRoute module="General Ledger">
                <GeneralLedger />
              </LazyRoute>
            </InstitutionRoute>
          }
        />
        
        <Route
          path="reports/aging"
          element={
            <InstitutionRoute allowReadOnly>
              <LazyRoute module="Aging Reports">
                <AgingReport />
              </LazyRoute>
            </InstitutionRoute>
          }
        />
        
        

        {/* Cross-company comparative P&L — side-by-side, never summed */}

        <Route
          path="reports/management"
          element={
            <InstitutionRoute allowReadOnly>
              <LazyRoute module="Management Reports">
                <ManagementReports />
              </LazyRoute>
            </InstitutionRoute>
          }
        />
        
        

        {/* Inventory reports — Finance mount (ADR 0143 dual host) */}
        
        {/* Business Intelligence — premium cross-cutting feature */}
        
        {/* Partner Ledger */}
        
        {/* Journal Report */}
        <Route
          path="reports/journal-report"
          element={
            <InstitutionRoute allowReadOnly>
              <LazyRoute module="Journal Report">
                <JournalReport />
              </LazyRoute>
            </InstitutionRoute>
          }
        />
        
        {/* Budget vs Actual */}
        
        {/* Analytic accounting reports — management dimension of the GL */}



        {/* Depreciation Report */}
        <Route
          path="reports/depreciation"
          element={
            <InstitutionRoute allowReadOnly>
              <LazyRoute module="Depreciation Report">
                <DepreciationReport />
              </LazyRoute>
            </InstitutionRoute>
          }
        />
        
        {/* Cash Flow Report */}
        <Route
          path="reports/cash-flow"
          element={
            <InstitutionRoute allowReadOnly>
              <LazyRoute module="Cash Flow Report">
                <CashFlowReport />
              </LazyRoute>
            </InstitutionRoute>
          }
        />
        
        {/* Audit Trail */}
        <Route
          path="reports/audit-trail"
          element={
            <InstitutionRoute allowReadOnly>
              <LazyRoute module="Audit Trail">
                <AuditTrailReport />
              </LazyRoute>
            </InstitutionRoute>
          }
        />
        
        {/* Report Run History — reader for report_run_log (Phase G) */}
        <Route
          path="reports/run-history"
          element={
            <InstitutionRoute allowReadOnly>
              <LazyRoute module="Report Run History">
                <ReportRunHistory />
              </LazyRoute>
            </InstitutionRoute>
          }
        />

        {/* Inventory ⇄ GL Reconciliation (Phase B1) */}

        {/* Control Account Reconciliation (Phase B2) */}
        <Route
          path="reports/control-account-reconciliation"
          element={
            <InstitutionRoute allowReadOnly>
              <LazyRoute module="Control Account Reconciliation">
                <ControlAccountReconciliation />
              </LazyRoute>
            </InstitutionRoute>
          }
        />

        {/* Bank Reconciliation Report (Phase B3) */}
        <Route
          path="reports/bank-reconciliation"
          element={
            <InstitutionRoute allowReadOnly>
              <LazyRoute module="Bank Reconciliation Report">
                <BankReconciliationReport />
              </LazyRoute>
            </InstitutionRoute>
          }
        />

        {/* POS Shift GL Integrity report removed — superseded by the producer-agnostic
            Accounting Events workspace (/finance/operations/accounting-events), which
            reads from the authoritative `accounting_events` sub-ledger rather than
            legacy per-product accounts or outbox-row state. */}


        {/* Stock Adjustments Report (Phase B5) */}

        {/* Stock Transfers Report (Phase B5) */}

        {/* FX Revaluation Report (Phase B6) */}
        <Route
          path="reports/fx-revaluation"
          element={
            <InstitutionRoute allowReadOnly>
              <LazyRoute module="FX Revaluation Report">
                <FxRevaluationReport />
              </LazyRoute>
            </InstitutionRoute>
          }
        />

        {/* FX Exposure Report (Currency & FX Step G) */}
        <Route
          path="reports/fx-exposure"
          element={
            <InstitutionRoute allowReadOnly>
              <LazyRoute module="FX Exposure Report">
                <FxExposureReport />
              </LazyRoute>
            </InstitutionRoute>
          }
        />

        {/* Realized FX Gain/Loss Report (Currency & FX Step 4) */}
        <Route
          path="reports/fx-realized"
          element={
            <InstitutionRoute allowReadOnly>
              <LazyRoute module="Realized FX Gain/Loss Report">
                <FxRealizedReport />
              </LazyRoute>
            </InstitutionRoute>
          }
        />





        {/* Finance Settings */}
        <Route
          path="settings"
          element={
            <InstitutionRoute allowReadOnly>
              <LazyRoute module="Finance Settings">
                <FinanceSettingsPage />
              </LazyRoute>
            </InstitutionRoute>
          }
        />

        {/* Phase 6: Finance Integrity */}
        <Route
          path="integrity"
          element={
            <InstitutionRoute allowReadOnly>
              <LazyRoute module="Finance Integrity">
                <FinanceIntegrity />
              </LazyRoute>
            </InstitutionRoute>
          }
        />

        {/* Accounting Events Workspace (B4) — producer-agnostic sub-ledger
            operational surface. Supersedes the POS Posting Queue. */}
        {/* Phase 5.4: cross-module reversal register */}
        <Route
          path="reversal-register"
          element={
            <InstitutionRoute allowReadOnly>
              <LazyRoute module="Reversal Register">
                <ReversalRegister />
              </LazyRoute>
            </InstitutionRoute>
          }
        />

        <Route
          path="operations/accounting-events"
          element={
            <InstitutionRoute>
              <LazyRoute module="Accounting Events">
                <AccountingEventsWorkspace />
              </LazyRoute>
            </InstitutionRoute>
          }
        />

        {/* Legacy POS Posting Queue URL — 301-style client redirect to the
            new producer-agnostic workspace. Preserves ?shift=… so existing
            deep-links from POS ops keep working. */}



        {/* Catch all - redirect to accounts */}
        <Route path="*" element={<Navigate to="dashboard" replace />} />
      </Routes>
    </FinanceLayout>
  );
}

export default FinanceApp;
