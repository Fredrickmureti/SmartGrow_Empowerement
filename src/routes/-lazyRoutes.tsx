import { lazy } from "react";

export const Studio = lazy(() => import("@/pages/Studio"));
export const Compliance = lazy(() => import("@/pages/Compliance"));
export const FiscalComplianceWorkspace = lazy(() => import("@/pages/FiscalComplianceWorkspace"));
export const AuditLogs = lazy(() => import("@/pages/AuditLogs"));
export const BillingHistory = lazy(() => import("@/pages/BillingHistory"));
