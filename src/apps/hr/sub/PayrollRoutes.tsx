/**
 * Payroll Sub-App Routes — PlatformShell migration.
 *
 * Drops the old `HrAppShell` + inner `PayrollWorkspace`/`PayrollSidebar`
 * double-sidebar stack. Payroll now runs on the same platform-wide
 * rail + sidebar as every other app via `PlatformShell` + `PAYROLL_NAV`.
 *
 * Remittances surface (mounted at /hr/remittances) shares the same nav
 * so an operator can switch between Payroll and Remittances without
 * losing the workspace chrome.
 */
import { lazy } from "react";
import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { PermissionProtectedRoute } from "@/components/auth/PermissionProtectedRoute";
import { PAYROLL_APP } from "@/lib/apps/registry";
import { PlatformShell } from "@/components/layout/shell/PlatformShell";
import { LazyRoute, PortalOrSubscriptionGate } from "../shared/guards";
import { PAYROLL_NAV } from "../shared/navs";

const Overview = lazy(() => import("@/pages/hr/payroll/Overview"));
const Runs = lazy(() => import("@/pages/hr/payroll/Runs"));
const PayrollControlCenter = lazy(() => import("@/pages/hr/payroll/PayrollControlCenter"));
const PayrollBatchRegister = lazy(() => import("@/pages/hr/payroll/PayrollBatchRegister"));
const PayrollStatutoryRules = lazy(() => import("@/pages/hr/PayrollStatutoryRules"));
const EmployeeLoans = lazy(() => import("@/pages/hr/EmployeeLoans"));
const RemittanceTracking = lazy(() => import("@/pages/hr/RemittanceTracking"));
const LoanTypesSettings = lazy(() => import("@/pages/hr/payroll/LoanTypesSettings"));
const WorkEntryTypes = lazy(() => import("@/pages/hr/payroll/WorkEntryTypes"));
const VariableInputTypes = lazy(() => import("@/pages/hr/payroll/VariableInputTypes"));
const Garnishments = lazy(() => import("@/pages/hr/payroll/Garnishments"));
const LoanSkipOverrides = lazy(() => import("@/pages/hr/payroll/LoanSkipOverrides"));
const CustomDeductionTypes = lazy(() => import("@/pages/hr/payroll/CustomDeductionTypes"));
const CustomDeductions = lazy(() => import("@/pages/hr/payroll/CustomDeductions"));
const LegalOrderRemittanceBatch = lazy(() => import("@/pages/hr/payroll/LegalOrderRemittanceBatch"));
const LegalRecipients = lazy(() => import("@/pages/hr/payroll/LegalRecipients"));
const LegalOrdersWorkspace = lazy(() => import("@/pages/hr/payroll/LegalOrdersWorkspace"));
const LegalOrdersTasks = lazy(() => import("@/pages/hr/payroll/LegalOrdersTasks"));
const LegalOrderPacks = lazy(() => import("@/pages/hr/payroll/LegalOrderPacks"));
const LegalOrderRemittanceBatches = lazy(() => import("@/pages/hr/payroll/LegalOrderRemittanceBatches"));
const LegalOrdersAudit = lazy(() => import("@/pages/hr/payroll/LegalOrdersAudit"));
const LegalOrdersReports = lazy(() => import("@/pages/hr/payroll/LegalOrdersReports"));

interface PayrollAppProps {
  surface: "payroll" | "remittances";
}

function gate(node: React.ReactNode, permission: string) {
  return (
    <PermissionProtectedRoute permission={permission as any} fallbackPath="/hr/payroll">
      <PortalOrSubscriptionGate>{node}</PortalOrSubscriptionGate>
    </PermissionProtectedRoute>
  );
}

function RedirectToRemittances() {
  const { search } = useLocation();
  return <Navigate to={`/hr/remittances${search}`} replace />;
}

// Lazy wrappers for the named exports inside sections.tsx
const Readiness         = lazy(() => import("@/pages/hr/payroll/sections").then(m => ({ default: m.PayrollReadiness })));
const WorkEntries       = lazy(() => import("@/pages/hr/payroll/sections").then(m => ({ default: m.PayrollWorkEntriesPage })));
const RunDetail         = lazy(() => import("@/pages/hr/payroll/sections").then(m => ({ default: m.PayrollRunDetailPage })));
const Payslips          = lazy(() => import("@/pages/hr/payroll/sections").then(m => ({ default: m.PayslipsListPage })));
const PayslipDetail     = lazy(() => import("@/pages/hr/payroll/sections").then(m => ({ default: m.PayslipDetailPage })));
const Payments          = lazy(() => import("@/pages/hr/payroll/sections").then(m => ({ default: m.PayrollPaymentsPage })));
const PaymentsFailed    = lazy(() => import("@/pages/hr/payroll/PayrollPaymentsSubViews").then(m => ({ default: m.PayrollPaymentsFailedPage })));
const PaymentsFiles     = lazy(() => import("@/pages/hr/payroll/PayrollPaymentsSubViews").then(m => ({ default: m.PayrollBankExportFilesPage })));
const PaymentsRegister  = lazy(() => import("@/pages/hr/payroll/PayrollPaymentsSubViews").then(m => ({ default: m.PayrollPaymentsRegisterPage })));
const Configuration     = lazy(() => import("@/pages/hr/payroll/sections").then(m => ({ default: m.PayrollConfigurationPage })));
const Schedules         = lazy(() => import("@/pages/hr/payroll/sections").then(m => ({ default: m.PayrollSchedulesPage })));
const Reports           = lazy(() => import("@/pages/hr/payroll/reports/ReportingCentre").then(m => ({ default: m.PayrollReportingCentre })));
const ReportViewer      = lazy(() => import("@/pages/hr/payroll/reports/PayrollReportViewer").then(m => ({ default: m.PayrollReportViewer })));
const SalaryStructures  = lazy(() => import("@/pages/hr/payroll/sections").then(m => ({ default: m.PayrollSalaryStructuresPage })));
const AccountMapping    = lazy(() => import("@/pages/hr/payroll/sections").then(m => ({ default: m.PayrollAccountMappingPage })));
const Setup             = lazy(() => import("@/pages/hr/payroll/Setup").then(m => ({ default: m.PayrollSetupPage })));
const TaxCertificates   = lazy(() => import("@/pages/hr/payroll/TaxCertificates"));
const Templates         = lazy(() => import("@/pages/hr/payroll/Templates"));
const CertificateTemplateEdit = lazy(() => import("@/pages/hr/payroll/PayrollCertificateTemplateEdit"));
const ReturnTemplateEdit = lazy(() => import("@/pages/hr/payroll/PayrollReturnTemplateEdit"));
const Localization      = lazy(() => import("@/pages/hr/payroll/Localization"));

export function PayrollApp({ surface }: PayrollAppProps) {
  return (
    <PlatformShell app={PAYROLL_APP} nav={PAYROLL_NAV}>
      {surface === "payroll" ? (
        <Routes>
          <Route index                       element={gate(<LazyRoute module="Payroll Overview"><Overview /></LazyRoute>, "viewPayroll")} />
          <Route path="readiness"            element={gate(<LazyRoute module="Readiness"><Readiness /></LazyRoute>, "viewPayroll")} />
          <Route path="work-entries"         element={gate(<LazyRoute module="Work Entries"><WorkEntries /></LazyRoute>, "viewPayroll")} />
          <Route path="runs"                 element={gate(<LazyRoute module="Payroll Runs"><Runs /></LazyRoute>, "viewPayroll")} />
          <Route path="control-center"       element={gate(<LazyRoute module="Payroll Control Center"><PayrollControlCenter /></LazyRoute>, "viewPayroll")} />
          {/* Legacy redirect: /hr/payroll/run-groups was renamed to /control-center (ADR-0045). */}
          <Route path="run-groups"           element={<Navigate to="/hr/payroll/control-center" replace />} />
          <Route path="batch-register"       element={gate(<LazyRoute module="Payroll Batch Register"><PayrollBatchRegister /></LazyRoute>, "viewPayroll")} />
          <Route path="runs/:runId"          element={gate(<LazyRoute module="Run Detail"><RunDetail /></LazyRoute>, "viewPayroll")} />

          <Route path="payslips"             element={gate(<LazyRoute module="Payslips"><Payslips /></LazyRoute>, "viewPayroll")} />
          <Route path="payslips/:payslipId"  element={gate(<LazyRoute module="Payslip"><PayslipDetail /></LazyRoute>, "viewPayroll")} />
          <Route path="payments"             element={gate(<LazyRoute module="Payments"><Payments /></LazyRoute>, "viewPayroll")} />
          <Route path="payments/failed"      element={gate(<LazyRoute module="Failed Payments"><PaymentsFailed /></LazyRoute>, "viewPayroll")} />
          <Route path="payments/files"       element={gate(<LazyRoute module="Bank Export Files"><PaymentsFiles /></LazyRoute>, "viewPayroll")} />
          <Route path="payments/register"    element={gate(<LazyRoute module="Payments Register"><PaymentsRegister /></LazyRoute>, "viewPayroll")} />
          <Route path="reports"              element={gate(<LazyRoute module="Reporting Centre"><Reports /></LazyRoute>, "viewPayroll")} />
          <Route path="reports/:reportKey"   element={gate(<LazyRoute module="Report Viewer"><ReportViewer /></LazyRoute>, "viewPayroll")} />
          <Route path="tax-certificates"     element={gate(<LazyRoute module="Tax Certificates"><TaxCertificates /></LazyRoute>, "viewPayroll")} />
          <Route path="statutory-remittances" element={<RedirectToRemittances />} />
          <Route path="statutory-remittances/*" element={<RedirectToRemittances />} />
          <Route path="remittances"          element={<RedirectToRemittances />} />
          <Route path="remittances/*"        element={<RedirectToRemittances />} />
          <Route path="configuration/templates" element={gate(<LazyRoute module="Templates"><Templates /></LazyRoute>, "managePayroll")} />
          <Route path="configuration/templates/certificates/:code/edit" element={gate(<LazyRoute module="Certificate Template Editor"><CertificateTemplateEdit /></LazyRoute>, "managePayroll")} />
          <Route path="configuration/templates/returns/:code/edit" element={gate(<LazyRoute module="Return Template Editor"><ReturnTemplateEdit /></LazyRoute>, "managePayroll")} />
          <Route path="configuration/localization" element={gate(<LazyRoute module="Localization"><Localization /></LazyRoute>, "managePayroll")} />
          <Route path="configuration"        element={gate(<LazyRoute module="Configuration"><Configuration /></LazyRoute>, "managePayroll")} />
          <Route path="setup"                element={gate(<LazyRoute module="Setup"><Setup /></LazyRoute>, "managePayroll")} />
          <Route path="configuration/schedules" element={gate(<LazyRoute module="Schedules"><Schedules /></LazyRoute>, "managePayroll")} />
          <Route path="configuration/structures" element={gate(<LazyRoute module="Salary Structures"><SalaryStructures /></LazyRoute>, "managePayroll")} />
          <Route path="configuration/accounts" element={gate(<LazyRoute module="GL Account Mapping"><AccountMapping /></LazyRoute>, "managePayroll")} />
          <Route path="configuration/loan-types" element={gate(<LazyRoute module="Loan Types"><LoanTypesSettings /></LazyRoute>, "managePayroll")} />
          <Route path="configuration/input-types" element={gate(<LazyRoute module="Variable Input Types"><VariableInputTypes /></LazyRoute>, "managePayroll")} />
          <Route path="configuration/work-entry-types" element={gate(<LazyRoute module="Work Entry Types"><WorkEntryTypes /></LazyRoute>, "managePayroll")} />
          <Route path="configuration/rule-types" element={gate(<LazyRoute module="Rule Type Definitions"><CustomDeductionTypes /></LazyRoute>, "manageStatutoryRules")} />
          <Route path="configuration/custom-deductions" element={gate(<LazyRoute module="Custom Deductions"><CustomDeductions /></LazyRoute>, "managePayroll")} />
          {/* Legacy path — redirect to preserve any existing bookmarks/links. */}
          <Route path="configuration/deduction-types" element={<Navigate to="/hr/payroll/configuration/rule-types" replace />} />
          <Route path="loans"                element={gate(<LazyRoute module="Employee Loans"><EmployeeLoans /></LazyRoute>, "manageEmployeeLoans")} />
          <Route path="statutory-rules"      element={gate(<LazyRoute module="Statutory Rules"><PayrollStatutoryRules /></LazyRoute>, "manageStatutoryRules")} />
          {/* Phase 4: unified operator workspace shell with tabs. */}
          <Route path="legal-orders" element={gate(<LazyRoute module="Legal Orders"><LegalOrdersWorkspace /></LazyRoute>, "managePayroll")}>
            <Route index element={<LazyRoute module="Legal Orders Tasks"><LegalOrdersTasks /></LazyRoute>} />
            <Route path="orders" element={<LazyRoute module="Legal Orders Register"><Garnishments /></LazyRoute>} />
            <Route path="packs" element={<LazyRoute module="Legal Order Packs"><LegalOrderPacks /></LazyRoute>} />
            <Route path="recipients" element={<LazyRoute module="Legal Recipients"><LegalRecipients /></LazyRoute>} />
            <Route path="remittance-batch" element={<LazyRoute module="Legal Order Remittance Batches"><LegalOrderRemittanceBatch /></LazyRoute>} />
            <Route path="batches" element={<LazyRoute module="Legal Order Batches"><LegalOrderRemittanceBatches /></LazyRoute>} />
            <Route path="reports" element={<LazyRoute module="Legal Orders Reports"><LegalOrdersReports /></LazyRoute>} />
            <Route path="audit" element={<LazyRoute module="Legal Orders Audit"><LegalOrdersAudit /></LazyRoute>} />
          </Route>
          {/* Legacy path kept for existing bookmarks. */}
          <Route path="garnishments" element={<Navigate to="/hr/payroll/legal-orders/orders" replace />} />
          <Route path="loan-skip-overrides"  element={gate(<LazyRoute module="Loan Skip Overrides"><LoanSkipOverrides /></LazyRoute>, "runPayroll")} />
        </Routes>
      ) : (
        <Routes>
          <Route path="*" element={gate(<LazyRoute module="Remittance Tracking"><RemittanceTracking /></LazyRoute>, "viewRemittances")} />
        </Routes>
      )}
    </PlatformShell>
  );
}

export default PayrollApp;
