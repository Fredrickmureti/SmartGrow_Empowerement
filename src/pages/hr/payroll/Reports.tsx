/**
 * Backward-compat re-export.
 *
 * The Payroll Reports module was redesigned into a full Reporting Centre
 * (Overview / Library / Scheduled / History) plus a dedicated viewer
 * route per report at `/hr/payroll/reports/:reportKey`. The old
 * `PayrollReportsPage` name is preserved here so the existing route
 * loader in `PayrollRoutes.tsx` keeps working; the actual implementation
 * lives in `./reports/ReportingCentre`.
 *
 * See docs/adr/0062-payroll-reporting-centre.md for the architecture.
 */
export { PayrollReportingCentre as PayrollReportsPage } from "./reports/ReportingCentre";
export { default } from "./reports/ReportingCentre";
