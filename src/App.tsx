import { Suspense, lazy } from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, HashRouter, Routes, Route, Navigate, useParams } from "react-router-dom";
import { isElectron } from "@/lib/environment";
import { AuthProvider } from "@/contexts/AuthContext";
import { PlatformIdentityProvider } from "@/contexts/PlatformIdentityContext";
import { SessionProvider } from "@/contexts/SessionContext";
import { OrganizationProvider } from "@/hooks/useOrganization";
import { BusinessProvider } from "@/contexts/BusinessContext";
import { BranchProvider } from "@/contexts/BranchContext";
import { CurrencyProvider } from "@/contexts/CurrencyContext";
import { ReportContextProvider } from "@/contexts/ReportContext";

import { NavigationModeProvider } from "@/contexts/NavigationModeContext";
import { ThemeProvider } from "@/components/theme/ThemeProvider";
import { ProtectedRoute } from "@/components/auth/ProtectedRoute";
import { NonVendorRoute } from "@/components/auth/NonVendorRoute";
import { PortalUserRoute } from "@/components/auth/PortalUserRoute";
import { AdminLayoutRoute } from "@/components/admin/AdminLayoutRoute";
import { AdminAuthOnlyRoute } from "@/components/auth/AdminAuthOnlyRoute";
import { RedirectIfAuthenticated } from "@/components/auth/RedirectIfAuthenticated";
import { SubscriptionProtectedRoute } from "@/components/subscription/SubscriptionProtectedRoute";
import { PermissionProtectedRoute } from "@/components/auth/PermissionProtectedRoute";
import { AppInstalledGate } from "@/components/apps/AppInstalledGate";
import { InstalledAppsHydration } from "@/components/apps/InstalledAppsHydration";
import { SentryErrorBoundary } from "@/components/error/SentryErrorBoundary";
import { RouteLoadingFallback } from "@/components/common/RouteLoadingFallback";
import { RealtimeSyncProvider } from "./providers/RealtimeSyncProvider";
import { GlobalAIAssistant } from "./components/ai/GlobalAIAssistant";
import { MissingMappingsDialog } from "./components/payroll/MissingMappingsDialog";
import { AIAssistantProvider } from "@/contexts/AIAssistantContext";
import { SubscriptionAccessProvider } from "@/contexts/SubscriptionAccessContext";
import { ReadOnlyModeProvider } from "@/contexts/ReadOnlyModeContext";
import { AuthenticatedShell } from "@/components/auth/AuthenticatedShell";
import { OnboardingGate } from "@/components/auth/OnboardingGate";
import { CommandPaletteProvider } from "@/providers/CommandPaletteProvider";
import { DocumentPreviewProvider } from "@/components/documents/DocumentPreviewProvider";
import { ConnectivityProvider } from "@/contexts/ConnectivityContext";
import { ElectronHydratorMount } from "@/components/hardware/ElectronHydratorMount";
import { EdgeRelayMount } from "@/components/hardware/EdgeRelayMount";
import { HardwareExecContextMount } from "@/components/hardware/HardwareExecContextMount";
import { BusinessSagaContextMount } from "@/components/events/BusinessSagaContextMount";
import { ConnectivityBanner } from "@/components/system/ConnectivityBanner";
import { AuthExpiryBridge } from "@/components/system/AuthExpiryBridge";

// Legacy redirect system
import { getLegacyRedirectRoutes } from "@/routes/-LegacyRedirects";

// ============================================
// EAGER IMPORTS (Core pages - fast navigation)
// ============================================
import Index from "./pages/Index";
import Login from "./pages/Login";
import Signup from "./pages/Signup";
import VerifyEmail from "./pages/VerifyEmail";
import AuthCallback from "./pages/AuthCallback";
import AcceptInvitation from "./pages/AcceptInvitation";
import AcceptOwnership from "./pages/AcceptOwnership";
import ForgotPassword from "./pages/ForgotPassword";
import ResetPassword from "./pages/ResetPassword";
import Dashboard from "./pages/Dashboard";
import Team from "./pages/Team";
import Settings from "./pages/Settings";
const WorkspaceSettings = lazy(() => import("./pages/settings/WorkspaceSettings"));
const ScannerSettings = lazy(() => import("./pages/settings/ScannerSettings"));
const CompanySettings = lazy(() => import("./pages/settings/CompanySettings"));
const GovernanceSoD = lazy(() => import("./pages/settings/GovernanceSoD"));
import AdminLogin from "./pages/admin/AdminLogin";
import AdminProfile from "./pages/admin/AdminProfile";
import AdminAcceptInvitation from "./pages/admin/AdminAcceptInvitation";
import Demo from "./pages/Demo";
const ResourcesIndex = lazy(() => import("./pages/resources/ResourcesIndex"));
const ResourceDetail = lazy(() => import("./pages/resources/ResourceDetail"));
import OnboardingSetup from "./pages/OnboardingSetup";
import NotFound from "./pages/NotFound";
import HelpCenter from "./pages/HelpCenter";
import Documentation from "./pages/Documentation";
import About from "./pages/About";
import Careers from "./pages/Careers";
import Blog from "./pages/Blog";
import Features from "./pages/Features";
import Contact from "./pages/Contact";
import Upgrade from "./pages/Upgrade";
import Notifications from "./pages/Notifications";
import Home from "./pages/Home";
import Downloads from "./pages/Downloads";
const PrivacyPolicyPage = lazy(() => import("./pages/legal/PrivacyPolicy"));
const TermsOfServicePage = lazy(() => import("./pages/legal/TermsOfService"));
const CookiePolicyPage = lazy(() => import("./pages/legal/CookiePolicy"));
import SelectOrganization from "./pages/SelectOrganization";

// Vendor Portal (lazy)
const VendorDashboard = lazy(() => import("@/pages/vendor-portal/VendorDashboard"));
const VendorPurchaseOrders = lazy(() => import("@/pages/vendor-portal/VendorPurchaseOrders"));
const VendorRFQs = lazy(() => import("@/pages/vendor-portal/VendorRFQs"));
const VendorProfile = lazy(() => import("@/pages/vendor-portal/VendorProfile"));
const VendorPortalAccept = lazy(() => import("@/pages/vendor-portal/VendorPortalAccept"));
const VendorPODetail = lazy(() => import("@/pages/vendor-portal/VendorPODetail"));
const VendorRFQDetail = lazy(() => import("@/pages/vendor-portal/VendorRFQDetail"));

// ============================================
// LAZY IMPORTS (Only standalone modules that stay standalone)
// ============================================
import {
  // Admin
  AdminManagement,
  AdminOrganizations,
  AdminUsers,
  AdminInvoices,
  AdminAnalytics,
  AdminReports,
  AdminSettings,
  AdminEmailCenter,
  AdminDemoRequests,
  AdminLocalizationPacks,
  AdminLocalizationCertificateEdit,
  AdminLocalizationReturnEdit,
  AdminInfrastructure,
  AdminOrganizationDetail,
  AdminOrganizationSubscription,
  AdminOrganizationDelete,

  AdminPlanBuilder,
  AdminAppCatalog,
  AdminAppCatalogEditPage,
  AdminPayments,
  AdminAuditLog,
  HardwareOpsPage,
  AdminMfaSetup,
  AdminTeam,
  AdminGroups,
  AdminGroupCreatePage,
  AdminGroupEditPage,
  AdminTeamInvitePage,
  AdminTeamMemberEditPage,
  AdminPlanCreatePage,
  AdminPlanEditPage,
  AdminFeatureCreatePage,
  AdminFeatureEditPage,
  AdminLocalizationPackCreatePage,
  AdminLocalizationPackDetailPage,
  AdminEmailComposePage,
  AdminEmailCampaignCreatePage,
  AdminEmailTemplateCreatePage,
  AdminEmailTemplateEditPage,
  AdminEmailAutomationEditPage,
  AdminDemoRequestReplyPage,
  AdminOrgEntitlementOverrideCreatePage,
  AdminOrgEntitlementOverrideEditPage,
  AdminOrgLocalizationInstallPage,
  AdminDemoVideoCreatePage,
  AdminDemoVideoEditPage,
  AdminLocalizationPackPublishPage,
  // Studio & Compliance (platform-level, stay standalone)
  Studio,
  Compliance,
  FiscalComplianceWorkspace,
  AuditLogs,
  // Billing
  BillingHistory,
} from "./routes/-lazyRoutes";

// ============================================
// APP MODULES (Odoo-style app navigation)
// ============================================
const MigrationPage = lazy(() => import("@/pages/settings/MigrationPage"));
const ConsolidationReport = lazy(() => import("@/pages/reports/Consolidation"));
const ConsolidatedTrialBalanceReport = lazy(() => import("@/pages/reports/ConsolidatedTrialBalance"));
const BranchNullDiagnostic = lazy(() => import("@/pages/diagnostics/BranchNullDiagnostic"));
const PrintLatencyDiagnostic = lazy(() => import("@/pages/diagnostics/PrintLatency"));
const UserProfilePage = lazy(() => import("@/pages/settings/UserProfilePage"));
const CarriersSettings = lazy(() => import("@/pages/settings/Carriers"));
const AppsAndSubscriptions = lazy(() => import("@/pages/settings/AppsAndSubscriptions"));
const FinanceApp = lazy(() => import("@/apps/finance/routes"));
const SalesApp = lazy(() => import("@/apps/sales/routes"));
const ContactsApp = lazy(() => import("@/apps/contacts/routes"));
const PurchasesApp = lazy(() => import("@/apps/purchases/routes"));
const InventoryApp = lazy(() => import("@/apps/inventory/routes"));
const WarehouseApp = lazy(() => import("@/apps/warehouse/routes"));
const WarehouseMobileApp = lazy(() => import("@/apps/warehouse-mobile/routes"));
const POSApp = lazy(() => import("@/apps/pos/routes"));
// Wave 5 (Phase 3): hardware lifted out of POS to platform.
const PlatformHardwareApp = lazy(() => import("@/apps/platform/hardware/routes"));
const HRApp = lazy(() => import("@/apps/hr/routes"));
// My Workspace — employee self-service shell (not an installable app, gated by employment)
const MeApp = lazy(() => import("@/apps/me/MeApp"));
const CRMApp = lazy(() => import("@/apps/crm/routes"));
const ProjectsApp = lazy(() => import("@/apps/projects/routes"));
const SmsAppRoutes = lazy(() => import("@/apps/sms/SmsApp").then(m => ({ default: m.SmsApp })));
const TimesheetsApp = lazy(() => import("@/apps/timesheets/routes"));
const AttendanceKioskStandalone = lazy(() => import("@/pages/kiosk/AttendanceKioskStandalone"));
// Scanner pairing page — mounted at top level (NOT under /pos/*) so that
// non-POS modules (Inventory, Sales, Purchases, etc.) can pair a phone
// without the POS subscription gate redirecting the phone to /dashboard.
// See .lovable/plan.md "Move scanner pairing route out of POS subscription gate".
const MobileScannerPage = lazy(() => import("@/pages/pos/MobileScannerPage"));
const LocalizationPreviewWindow = lazy(
  () => import("@/features/localization/components/LocalizationPreviewWindow"),
);

// Pop-out preview window for the Localization Editor. Opened via
// window.open() from AuthoringWorkspace. Runs in the same origin so it
// inherits localStorage + BroadcastChannel from the opener; no auth
// gate needed (it only re-renders what the opener already broadcasts).
const LocalizationPreviewRoute = () => {
  const { kind, templateCode } = useParams<{ kind: string; templateCode: string }>();
  return (
    <Suspense fallback={<div style={{ padding: 24, fontFamily: "system-ui" }}>Loading preview…</div>}>
      <LocalizationPreviewWindow kind={kind ?? ""} templateCode={templateCode ?? ""} />
    </Suspense>
  );
};


import { VendorPortalLayout } from "@/components/vendor-portal/VendorPortalLayout";

// Apps Marketplace Page
const Apps = lazy(() => import("@/pages/Apps"));
const AppActivate = lazy(() => import("@/pages/apps/AppActivate"));
const AppSetup = lazy(() => import("@/pages/apps/AppSetup"));
const AppSetupIndex = lazy(() => import("@/pages/apps/AppSetupIndex"));

// Create QueryClient outside of the component to prevent recreation on re-renders
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      retry: 1,
      staleTime: 5 * 60 * 1000,
    },
  },
});

// Use HashRouter for Electron (file:// protocol), BrowserRouter for web
const Router = isElectron() ? HashRouter : BrowserRouter;

// Wrapper for lazy-loaded routes with Suspense
const LazyRoute = ({ 
  children, 
  module 
}: { 
  children: React.ReactNode; 
  module?: string;
}) => (
  <Suspense fallback={<RouteLoadingFallback module={module} />}>
    {children}
  </Suspense>
);

// Legacy /pos/scan/:token QRs (pre-2026-06 audit) redirect to /scan/:token
// so they bypass the POS subscription gate. Token is preserved verbatim.
const LegacyScanRedirect = () => {
  const { token } = useParams<{ token: string }>();
  return <Navigate to={`/scan/${token ?? ""}`} replace />;
};

const App = () => (
  <SentryErrorBoundary>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <ConnectivityProvider>
        <AuthProvider>
          <PlatformIdentityProvider>
          <SessionProvider>
            <InstalledAppsHydration />
            <OrganizationProvider>
              <BusinessProvider>
                <BranchProvider>
                  <CurrencyProvider>
                    <ReportContextProvider>
                    <NavigationModeProvider>

                      <SubscriptionAccessProvider>
                        <ReadOnlyModeProvider>
                          <RealtimeSyncProvider>
                            <TooltipProvider>
                              <Toaster />
                              <Sonner />
                              <ConnectivityBanner />
                              {/* Phase 2 hardware platform: mirror device_assignments → Electron SQLite cache. No-op in browser. */}
                              <ElectronHydratorMount />
                              {/* AccrualFlow Edge: hydrate browser runtime from device_assignments (station-scoped rows) and route HTTPS-origin jobs through Supabase. */}
                              <EdgeRelayMount />
                              {/* Phase 3 hardware platform: feed active org/business into the exec-log writer. */}
                              <HardwareExecContextMount />
                              {/* Track 1 event fabric: drain business_event_outbox → BusinessSaga handlers (labels, GRN, transfers, shipping). */}
                              <BusinessSagaContextMount />
                              <AIAssistantProvider>
                              <Router>
                            <AuthExpiryBridge />
                            <AuthenticatedShell>
                            <CommandPaletteProvider>
                            <DocumentPreviewProvider>
                            <OnboardingGate>
                            <Routes>
                            {/* ============================================== */}
                            {/* PUBLIC ROUTES (Eager loaded)                   */}
                            {/* ============================================== */}
                            <Route path="/" element={<Index />} />
                            <Route path="/login" element={<RedirectIfAuthenticated><Login /></RedirectIfAuthenticated>} />
                            <Route path="/signup" element={<RedirectIfAuthenticated><Signup /></RedirectIfAuthenticated>} />
                            <Route path="/verify-email" element={<VerifyEmail />} />
                            <Route path="/auth/callback" element={<AuthCallback />} />
                            <Route path="/onboarding-setup" element={<OnboardingSetup />} />
                            <Route path="/demo" element={<Demo />} />
                            {/* Localization pop-out preview — public route (same-origin
                                localStorage/BroadcastChannel from the opener is the auth). */}
                            <Route path="/localization/preview/:kind/:templateCode" element={<LocalizationPreviewRoute />} />

                           {/* Public: the learning library shows videos the platform
                               admin published for a public audience (RLS enforces
                               that); signed-in users additionally see internal ones. */}
                           <Route path="/resources" element={<Suspense fallback={<RouteLoadingFallback />}><ResourcesIndex /></Suspense>} />
                           <Route path="/resources/:id" element={<Suspense fallback={<RouteLoadingFallback />}><ResourceDetail /></Suspense>} />
                           <Route path="/forgot-password" element={<RedirectIfAuthenticated><ForgotPassword /></RedirectIfAuthenticated>} />

                            <Route path="/reset-password" element={<RedirectIfAuthenticated allowRecoveryHash><ResetPassword /></RedirectIfAuthenticated>} />
                            <Route path="/accept-invitation" element={<AcceptInvitation />} />
                            <Route path="/accept-ownership/:token" element={<AcceptOwnership />} />
                            <Route path="/select-organization" element={<ProtectedRoute><SelectOrganization /></ProtectedRoute>} />
                            <Route path="/help" element={<HelpCenter />} />
                            <Route path="/docs" element={<Documentation />} />
                           <Route path="/about" element={<About />} />
                           <Route path="/careers" element={<Careers />} />
                            <Route path="/blog" element={<Blog />} />
                            <Route path="/features" element={<Features />} />
                            <Route path="/contact" element={<Contact />} />
                            <Route path="/downloads" element={<Downloads />} />
                            <Route path="/install" element={<Navigate to="/downloads" replace />} />
                            <Route path="/privacy" element={<LazyRoute module="Legal"><PrivacyPolicyPage /></LazyRoute>} />
                            <Route path="/terms" element={<LazyRoute module="Legal"><TermsOfServicePage /></LazyRoute>} />
                            <Route path="/cookies" element={<LazyRoute module="Legal"><CookiePolicyPage /></LazyRoute>} />

                            {/* Scanner pairing — universal infrastructure, NOT POS-only.
                                Must live outside /pos/* so SubscriptionProtectedRoute
                                doesn't bounce non-POS pairings (Inventory, Sales, …)
                                to /dashboard. Only needs ProtectedRoute (auth). */}
                            <Route
                              path="/scan/:token"
                              element={
                                <ProtectedRoute>
                                  <Suspense fallback={<RouteLoadingFallback module="Scanner" />}>
                                    <MobileScannerPage />
                                  </Suspense>
                                </ProtectedRoute>
                              }
                            />
                            {/* Back-compat: legacy QRs in the wild still use /pos/scan/:token.
                                Declared at top level so it wins over the /pos/* subtree
                                (react-router v6 picks the more-specific match) and dodges
                                the POS subscription gate. */}
                            <Route
                              path="/pos/scan/:token"
                              element={<LegacyScanRedirect />}
                            />


                            
                            {/* Auth-only routes (no subscription check) */}
                            <Route path="/upgrade" element={<ProtectedRoute><NonVendorRoute><PortalUserRoute><Upgrade /></PortalUserRoute></NonVendorRoute></ProtectedRoute>} />
                            <Route path="/billing" element={<ProtectedRoute><NonVendorRoute><PortalUserRoute><Suspense fallback={<RouteLoadingFallback />}><BillingHistory /></Suspense></PortalUserRoute></NonVendorRoute></ProtectedRoute>} />
                            <Route path="/reports/consolidation" element={<ProtectedRoute><NonVendorRoute><PortalUserRoute><LazyRoute module="Consolidation"><ConsolidationReport /></LazyRoute></PortalUserRoute></NonVendorRoute></ProtectedRoute>} />
                            <Route path="/reports/consolidated-trial-balance" element={<ProtectedRoute><NonVendorRoute><PortalUserRoute><LazyRoute module="ConsolidatedTrialBalance"><ConsolidatedTrialBalanceReport /></LazyRoute></PortalUserRoute></NonVendorRoute></ProtectedRoute>} />
                           <Route path="/settings" element={<ProtectedRoute><NonVendorRoute><Settings /></NonVendorRoute></ProtectedRoute>} />
                           <Route path="/settings/workspace" element={<ProtectedRoute><NonVendorRoute><PortalUserRoute><Suspense fallback={<RouteLoadingFallback />}><WorkspaceSettings /></Suspense></PortalUserRoute></NonVendorRoute></ProtectedRoute>} />
                           <Route path="/settings/company" element={<ProtectedRoute><NonVendorRoute><PortalUserRoute><Suspense fallback={<RouteLoadingFallback />}><CompanySettings /></Suspense></PortalUserRoute></NonVendorRoute></ProtectedRoute>} />
                            <Route path="/settings/team" element={<SubscriptionProtectedRoute requiredFeature="team_management" allowReadOnly><PortalUserRoute><Team /></PortalUserRoute></SubscriptionProtectedRoute>} />
                            <Route path="/settings/studio" element={<ProtectedRoute><NonVendorRoute><PortalUserRoute><LazyRoute module="Studio"><Studio /></LazyRoute></PortalUserRoute></NonVendorRoute></ProtectedRoute>} />
                            <Route path="/settings/audit-logs" element={<SubscriptionProtectedRoute allowReadOnly><PortalUserRoute><LazyRoute module="Audit Logs"><AuditLogs /></LazyRoute></PortalUserRoute></SubscriptionProtectedRoute>} />
                            <Route path="/settings/compliance" element={<SubscriptionProtectedRoute allowReadOnly><PortalUserRoute><LazyRoute module="Compliance"><Compliance /></LazyRoute></PortalUserRoute></SubscriptionProtectedRoute>} />
                            <Route path="/settings/governance/sod" element={<ProtectedRoute><NonVendorRoute><PortalUserRoute><Suspense fallback={<RouteLoadingFallback />}><GovernanceSoD /></Suspense></PortalUserRoute></NonVendorRoute></ProtectedRoute>} />
                            <Route path="/settings/migration" element={<ProtectedRoute><NonVendorRoute><PortalUserRoute><LazyRoute module="Migration"><MigrationPage /></LazyRoute></PortalUserRoute></NonVendorRoute></ProtectedRoute>} />
                            <Route path="/settings/diagnostics/branch-null" element={<ProtectedRoute><NonVendorRoute><PortalUserRoute><LazyRoute module="Branch-NULL Diagnostic"><BranchNullDiagnostic /></LazyRoute></PortalUserRoute></NonVendorRoute></ProtectedRoute>} />
                            <Route path="/settings/diagnostics/print-latency" element={<ProtectedRoute><NonVendorRoute><PortalUserRoute><LazyRoute module="Print Latency Diagnostic"><PrintLatencyDiagnostic /></LazyRoute></PortalUserRoute></NonVendorRoute></ProtectedRoute>} />
                            <Route path="/settings/profile" element={<ProtectedRoute><LazyRoute module="Profile"><UserProfilePage /></LazyRoute></ProtectedRoute>} />
                            <Route path="/settings/apps" element={<ProtectedRoute><NonVendorRoute><PortalUserRoute><Suspense fallback={<RouteLoadingFallback />}><AppsAndSubscriptions /></Suspense></PortalUserRoute></NonVendorRoute></ProtectedRoute>} />
                            <Route path="/settings/carriers" element={<ProtectedRoute><NonVendorRoute><PortalUserRoute><LazyRoute module="Carriers"><CarriersSettings /></LazyRoute></PortalUserRoute></NonVendorRoute></ProtectedRoute>} />
                            <Route path="/settings/scanner" element={<ProtectedRoute><NonVendorRoute><PortalUserRoute><Suspense fallback={<RouteLoadingFallback />}><ScannerSettings /></Suspense></PortalUserRoute></NonVendorRoute></ProtectedRoute>} />
                            <Route path="/notifications" element={<ProtectedRoute><NonVendorRoute><Notifications /></NonVendorRoute></ProtectedRoute>} />
                            {/* Chrome-less attendance kiosk for shared devices.
                                Mounted at top level so the global app sidebar / topbar
                                are NOT rendered. Branch is resolved from a localStorage
                                "device pin" set inside the page. */}
                            <Route
                              path="/kiosk/attendance"
                              element={
                                <ProtectedRoute>
                                  <LazyRoute module="Attendance Kiosk">
                                    <AttendanceKioskStandalone />
                                  </LazyRoute>
                                </ProtectedRoute>
                              }
                            />
                            {/* Legacy redirect — printed QR codes pointed at the old
                                /hr/attendance/kiosk path. Keep them working. */}
                            <Route path="/hr/attendance/kiosk" element={<Navigate to="/kiosk/attendance" replace />} />

                            {/* ============================================== */}
                            {/* CORE STANDALONE ROUTES (kept as-is)            */}
                            {/* ============================================== */}
                            <Route
                              path="/home"
                              element={<SubscriptionProtectedRoute><PortalUserRoute><Home /></PortalUserRoute></SubscriptionProtectedRoute>}
                            />
                            {/* App marketplace — visible to ALL authenticated tenant users
                                (Odoo pattern: anyone can browse, only admins can install).
                                Install/trial/subscribe gestures inside the marketplace check
                                `manageApps` themselves and surface a "Request from admin" CTA
                                for non-admins. */}
                            <Route
                              path="/apps"
                              element={
                                <SubscriptionProtectedRoute>
                                  <PortalUserRoute><LazyRoute module="Apps"><Apps /></LazyRoute></PortalUserRoute>
                                </SubscriptionProtectedRoute>
                              }
                            />
                            {/* App activation — also visible to non-admins, who see a
                                "request access from your admin" surface instead of being
                                bounced to /home with no explanation. */}
                            <Route
                              path="/apps/:appId/activate"
                              element={
                                <SubscriptionProtectedRoute>
                                  <PortalUserRoute><LazyRoute module="App Activation"><AppActivate /></LazyRoute></PortalUserRoute>
                                </SubscriptionProtectedRoute>
                              }
                            />
                            {/* App setup overview — installed apps + status */}
                            <Route
                              path="/apps/setup"
                              element={
                                <SubscriptionProtectedRoute allowReadOnly>
                                  <PortalUserRoute><LazyRoute module="App Setup"><AppSetupIndex /></LazyRoute></PortalUserRoute>
                                </SubscriptionProtectedRoute>
                              }
                            />
                            {/* Per-app setup checklist — driven by app_setup_status.blocking_reasons */}
                            <Route
                              path="/apps/:appId/setup"
                              element={
                                <SubscriptionProtectedRoute allowReadOnly>
                                  <PortalUserRoute><LazyRoute module="App Setup"><AppSetup /></LazyRoute></PortalUserRoute>
                                </SubscriptionProtectedRoute>
                              }
                            />
                            <Route
                              path="/dashboard"
                              element={<SubscriptionProtectedRoute><PortalUserRoute><Dashboard /></PortalUserRoute></SubscriptionProtectedRoute>}
                            />
                            <Route
                              path="/team"
                              element={<SubscriptionProtectedRoute requiredFeature="team_management" allowReadOnly><Team /></SubscriptionProtectedRoute>}
                            />

                            {/* ============================================== */}
                            {/* LEGACY REDIRECTS (flat routes → app routes)    */}
                            {/* ============================================== */}
                            {getLegacyRedirectRoutes()}

                            {/* ============================================== */}
                            {/* STANDALONE UTILITY APPS (not part of ERP apps) */}
                            {/* ============================================== */}

                            {/* Documents app retired — Sign + Spreadsheets retired earlier. */}

                            {/* Studio */}
                            <Route
                              path="/studio/*"
                              element={
                                <ProtectedRoute>
                                  <NonVendorRoute>
                                    <AppInstalledGate appId="studio">
                                      <LazyRoute module="Studio"><Studio /></LazyRoute>
                                    </AppInstalledGate>
                                  </NonVendorRoute>
                                </ProtectedRoute>
                              }
                            />

                            {/* Compliance */}
                            <Route
                              path="/compliance"
                              element={
                                <SubscriptionProtectedRoute allowReadOnly>
                                  <LazyRoute module="Compliance"><Compliance /></LazyRoute>
                                </SubscriptionProtectedRoute>
                              }
                            />
                            <Route
                              path="/compliance/etims"
                              element={
                                <SubscriptionProtectedRoute allowReadOnly>
                                  <LazyRoute module="FiscalComplianceWorkspace">
                                    <FiscalComplianceWorkspace />
                                  </LazyRoute>
                                </SubscriptionProtectedRoute>
                              }
                            />


                            {/* ============================================== */}
                            {/* APP-BASED ROUTES (Odoo-style navigation)       */}
                            {/* ============================================== */}
                            
                            {/* Finance App */}
                            <Route
                              path="/finance/*"
                              element={
                                <SubscriptionProtectedRoute allowReadOnly>
                                  <PortalUserRoute>
                                    <LazyRoute module="Finance">
                                      <FinanceApp />
                                    </LazyRoute>
                                  </PortalUserRoute>
                                </SubscriptionProtectedRoute>
                              }
                            />
                            
                            {/* Sales App */}
                            <Route
                              path="/sales/*"
                              element={
                                <SubscriptionProtectedRoute allowReadOnly>
                                  <PortalUserRoute>
                                    <AppInstalledGate appId="sales">
                                      <LazyRoute module="Sales">
                                        <SalesApp />
                                      </LazyRoute>
                                    </AppInstalledGate>
                                  </PortalUserRoute>
                                </SubscriptionProtectedRoute>
                              }
                            />
                            
                            {/* Contacts App */}
                            <Route
                              path="/contacts-app/*"
                              element={
                                <SubscriptionProtectedRoute allowReadOnly>
                                  <PortalUserRoute>
                                    <LazyRoute module="Contacts">
                                      <ContactsApp />
                                    </LazyRoute>
                                  </PortalUserRoute>
                                </SubscriptionProtectedRoute>
                              }
                            />
                            
                            {/* Purchases App */}
                            <Route
                              path="/purchases/*"
                              element={
                                <SubscriptionProtectedRoute allowReadOnly>
                                  <PortalUserRoute>
                                    <AppInstalledGate appId="purchases">
                                      <LazyRoute module="Purchases">
                                        <PurchasesApp />
                                      </LazyRoute>
                                    </AppInstalledGate>
                                  </PortalUserRoute>
                                </SubscriptionProtectedRoute>
                              }
                            />
                            
                            {/* Inventory App */}
                            <Route
                              path="/inventory-app/*"
                              element={
                                <SubscriptionProtectedRoute allowReadOnly>
                                  <PortalUserRoute>
                                    <AppInstalledGate appId="inventory">
                                      <LazyRoute module="Inventory">
                                        <InventoryApp />
                                      </LazyRoute>
                                    </AppInstalledGate>
                                  </PortalUserRoute>
                                </SubscriptionProtectedRoute>
                              }
                            />

                            {/* Warehouse App (WMS execution layer — ADR 0079) */}
                            <Route
                              path="/warehouse-app/*"
                              element={
                                <SubscriptionProtectedRoute allowReadOnly>
                                  <PortalUserRoute>
                                    <AppInstalledGate appId="warehouse">
                                      <LazyRoute module="Warehouse">
                                        <WarehouseApp />
                                      </LazyRoute>
                                    </AppInstalledGate>
                                  </PortalUserRoute>
                                </SubscriptionProtectedRoute>
                              }
                            />

                            {/* Warehouse mobile / RF shell (Phase 13) */}
                            <Route
                              path="/wm/*"
                              element={
                                <SubscriptionProtectedRoute allowReadOnly>
                                  <PortalUserRoute>
                                    <AppInstalledGate appId="warehouse">
                                      <LazyRoute module="WarehouseMobile">
                                        <WarehouseMobileApp />
                                      </LazyRoute>
                                    </AppInstalledGate>
                                  </PortalUserRoute>
                                </SubscriptionProtectedRoute>
                              }
                            />
                            
                            
                            {/* HR App */}
                            <Route
                              path="/hr/*"
                              element={
                                <SubscriptionProtectedRoute allowReadOnly>
                                  <PortalUserRoute>
                                    <LazyRoute module="HR">
                                      <HRApp />
                                    </LazyRoute>
                                  </PortalUserRoute>
                                </SubscriptionProtectedRoute>
                              }
                            />

                            {/* My Workspace — employee self-service (no subscription gate; available to any employee) */}
                            <Route
                              path="/me/*"
                              element={
                                <LazyRoute module="My Workspace">
                                  <MeApp />
                                </LazyRoute>
                              }
                            />
                            
                            {/* CRM App */}
                            <Route
                              path="/crm-app/*"
                              element={
                                <SubscriptionProtectedRoute requiredFeature="crm" allowReadOnly>
                                  <PortalUserRoute>
                                    <AppInstalledGate appId="crm">
                                      <LazyRoute module="CRM">
                                        <CRMApp />
                                      </LazyRoute>
                                    </AppInstalledGate>
                                  </PortalUserRoute>
                                </SubscriptionProtectedRoute>
                              }
                            />
                            
                            {/* Projects App */}
                            <Route
                              path="/projects-app/*"
                              element={
                                <SubscriptionProtectedRoute requiredFeature="projects" allowReadOnly>
                                  <PortalUserRoute>
                                    <AppInstalledGate appId="projects">
                                      <LazyRoute module="Projects">
                                        <ProjectsApp />
                                      </LazyRoute>
                                    </AppInstalledGate>
                                  </PortalUserRoute>
                                </SubscriptionProtectedRoute>
                              }
                            />

                            {/* POS App (unified route) */}
                            <Route
                              path="/pos/*"
                              element={
                                <SubscriptionProtectedRoute requiredFeature="pos" allowReadOnly>
                                  <AppInstalledGate appId="pos">
                                    <LazyRoute module="POS">
                                      <POSApp />
                                    </LazyRoute>
                                  </AppInstalledGate>
                                </SubscriptionProtectedRoute>
                              }
                            />

                            {/* Wave 5 (Phase 3): platform-owned Hardware surface.
                                Hardware is not a POS-only concern (Inventory, Warehouse, HR,
                                Manufacturing all consume devices), so the registry lives at the
                                platform level. Legacy /pos/hardware-* paths redirect here. */}
                            <Route
                              path="/platform/hardware/*"
                              element={
                                <ProtectedRoute>
                                  <NonVendorRoute>
                                    <LazyRoute module="Hardware">
                                      <PlatformHardwareApp />
                                    </LazyRoute>
                                  </NonVendorRoute>
                                </ProtectedRoute>
                              }
                            />
                            <Route path="/pos/hardware-devices" element={<Navigate to="/platform/hardware/devices" replace />} />
                            <Route path="/pos/hardware-diagnostics" element={<Navigate to="/platform/hardware/diagnostics" replace />} />


                            {/* SMS App */}
                            <Route
                              path="/sms/*"
                              element={
                                <SubscriptionProtectedRoute requiredFeature="sms" allowReadOnly>
                                  <PortalUserRoute>
                                    <AppInstalledGate appId="sms">
                                      <LazyRoute module="SMS">
                                        <SmsAppRoutes />
                                      </LazyRoute>
                                    </AppInstalledGate>
                                  </PortalUserRoute>
                                </SubscriptionProtectedRoute>
                              }
                            />

                            {/* Timesheets App */}
                            <Route
                              path="/timesheets/*"
                              element={
                                <SubscriptionProtectedRoute allowReadOnly>
                                  <PortalUserRoute>
                                    <AppInstalledGate appId="timesheets">
                                      <LazyRoute module="Timesheets">
                                        <TimesheetsApp />
                                      </LazyRoute>
                                    </AppInstalledGate>
                                  </PortalUserRoute>
                                </SubscriptionProtectedRoute>
                              }
                            />
                            
                            {/* ============================================== */}
                            {/* ADMIN ROUTES                                   */}
                            {/* ============================================== */}
                            <Route path="/admin-management/login" element={<RedirectIfAuthenticated><AdminLogin /></RedirectIfAuthenticated>} />
                            <Route path="/admin-management/accept-invitation" element={<AdminAcceptInvitation />} />
                            <Route
                              path="/admin-management/mfa-setup"
                              element={
                                <AdminAuthOnlyRoute>
                                  <LazyRoute module="MFA Setup"><AdminMfaSetup /></LazyRoute>
                                </AdminAuthOnlyRoute>
                              }
                            />
                            <Route path="/admin-management" element={<AdminLayoutRoute />}>
                              <Route index element={<LazyRoute module="Admin Dashboard"><AdminManagement /></LazyRoute>} />
                              <Route path="profile" element={<AdminProfile />} />
                              <Route path="organizations" element={<LazyRoute module="Organizations"><AdminOrganizations /></LazyRoute>} />
                              <Route path="organizations/:id" element={<LazyRoute module="Organization Detail"><AdminOrganizationDetail /></LazyRoute>} />
                              <Route path="organizations/:id/subscription" element={<LazyRoute module="Manage Subscription"><AdminOrganizationSubscription /></LazyRoute>} />
                              <Route path="organizations/:id/delete" element={<LazyRoute module="Delete Organization"><AdminOrganizationDelete /></LazyRoute>} />
                              <Route path="organizations/:id/entitlements/new" element={<LazyRoute module="Add Entitlement Override"><AdminOrgEntitlementOverrideCreatePage /></LazyRoute>} />
                              <Route path="organizations/:id/entitlements/:overrideId/edit" element={<LazyRoute module="Edit Entitlement Override"><AdminOrgEntitlementOverrideEditPage /></LazyRoute>} />
                              <Route path="organizations/:id/localization/install" element={<LazyRoute module="Install Localization Pack"><AdminOrgLocalizationInstallPage /></LazyRoute>} />

                              <Route path="users" element={<LazyRoute module="Users"><AdminUsers /></LazyRoute>} />
                              <Route path="invoices" element={<LazyRoute module="Invoices"><AdminInvoices /></LazyRoute>} />
                              <Route path="analytics" element={<LazyRoute module="Analytics"><AdminAnalytics /></LazyRoute>} />
                              <Route path="reports" element={<LazyRoute module="Reports"><AdminReports /></LazyRoute>} />
                              <Route path="settings" element={<LazyRoute module="Settings"><AdminSettings /></LazyRoute>} />
                              <Route path="settings/demo-videos/new" element={<LazyRoute module="Add Demo Video"><AdminDemoVideoCreatePage /></LazyRoute>} />
                              <Route path="settings/demo-videos/:id/edit" element={<LazyRoute module="Edit Demo Video"><AdminDemoVideoEditPage /></LazyRoute>} />
                              <Route path="email-center" element={<LazyRoute module="Email Center"><AdminEmailCenter /></LazyRoute>} />
                              <Route path="email-center/compose" element={<LazyRoute module="Compose Email"><AdminEmailComposePage /></LazyRoute>} />
                              <Route path="email-center/campaigns/new" element={<LazyRoute module="Create Campaign"><AdminEmailCampaignCreatePage /></LazyRoute>} />
                              <Route path="email-center/templates/new" element={<LazyRoute module="Create Email Template"><AdminEmailTemplateCreatePage /></LazyRoute>} />
                              <Route path="email-center/templates/:id/edit" element={<LazyRoute module="Edit Email Template"><AdminEmailTemplateEditPage /></LazyRoute>} />
                              <Route path="email-center/automations/:id" element={<LazyRoute module="Edit Automation"><AdminEmailAutomationEditPage /></LazyRoute>} />
                              <Route path="demo-requests" element={<LazyRoute module="Demo Requests"><AdminDemoRequests /></LazyRoute>} />
                              <Route path="demo-requests/:id/reply" element={<LazyRoute module="Reply to Demo Request"><AdminDemoRequestReplyPage /></LazyRoute>} />
                              <Route path="localization-packs" element={<LazyRoute module="Localization Packs"><AdminLocalizationPacks /></LazyRoute>} />
                              <Route path="localization-packs/new" element={<LazyRoute module="Create Localization Pack"><AdminLocalizationPackCreatePage /></LazyRoute>} />
                              <Route path="localization-packs/:id" element={<LazyRoute module="Localization Pack"><AdminLocalizationPackDetailPage /></LazyRoute>} />
                              <Route path="localization-packs/:id/publish" element={<LazyRoute module="Publish Localization Pack Version"><AdminLocalizationPackPublishPage /></LazyRoute>} />
                              <Route path="localization-packs/:packId/certificates/:templateId/edit" element={<LazyRoute module="Certificate Template Editor"><AdminLocalizationCertificateEdit /></LazyRoute>} />
                              <Route path="localization-packs/:packId/returns/:templateId/edit" element={<LazyRoute module="Return Template Editor"><AdminLocalizationReturnEdit /></LazyRoute>} />
                              <Route path="infrastructure" element={<LazyRoute module="Infrastructure"><AdminInfrastructure /></LazyRoute>} />
                              <Route path="plan-builder" element={<LazyRoute module="Plan Builder"><AdminPlanBuilder /></LazyRoute>} />
                              <Route path="plan-builder/plans/new" element={<LazyRoute module="Create Plan"><AdminPlanCreatePage /></LazyRoute>} />
                              <Route path="plan-builder/plans/:id/edit" element={<LazyRoute module="Edit Plan"><AdminPlanEditPage /></LazyRoute>} />
                              <Route path="plan-builder/features/new" element={<LazyRoute module="Create Feature"><AdminFeatureCreatePage /></LazyRoute>} />
                              <Route path="plan-builder/features/:id/edit" element={<LazyRoute module="Edit Feature"><AdminFeatureEditPage /></LazyRoute>} />
                              <Route path="app-catalog" element={<LazyRoute module="App Catalog"><AdminAppCatalog /></LazyRoute>} />
                              <Route path="app-catalog/:id/edit" element={<LazyRoute module="Edit App"><AdminAppCatalogEditPage /></LazyRoute>} />
                              <Route path="payments" element={<LazyRoute module="Payments"><AdminPayments /></LazyRoute>} />
                              <Route path="audit-log" element={<LazyRoute module="Audit Log"><AdminAuditLog /></LazyRoute>} />
                              <Route path="hardware-ops" element={<LazyRoute module="Hardware Ops"><HardwareOpsPage /></LazyRoute>} />
                              <Route path="print-queue" element={<Navigate to="/platform/hardware/print-queue" replace />} />
                              <Route path="team" element={<LazyRoute module="Team"><AdminTeam /></LazyRoute>} />
                              <Route path="team/invite" element={<LazyRoute module="Invite Team Member"><AdminTeamInvitePage /></LazyRoute>} />
                              <Route path="team/:id/edit" element={<LazyRoute module="Edit Team Member"><AdminTeamMemberEditPage /></LazyRoute>} />
                              <Route path="groups" element={<LazyRoute module="Groups"><AdminGroups /></LazyRoute>} />
                              <Route path="groups/new" element={<LazyRoute module="Create Group"><AdminGroupCreatePage /></LazyRoute>} />
                              <Route path="groups/:id/edit" element={<LazyRoute module="Edit Group"><AdminGroupEditPage /></LazyRoute>} />
                            </Route>

                            {/* ============================================== */}
                            <Route
                              path="/vendor-portal/accept"
                              element={
                                <LazyRoute module="Vendor Portal">
                                  <VendorPortalAccept />
                                </LazyRoute>
                              }
                            />
                            <Route
                              path="/vendor-portal"
                              element={
                                <ProtectedRoute>
                                  <VendorPortalLayout>
                                    <LazyRoute module="Vendor Portal">
                                      <VendorDashboard />
                                    </LazyRoute>
                                  </VendorPortalLayout>
                                </ProtectedRoute>
                              }
                            />
                            <Route
                              path="/vendor-portal/purchase-orders"
                              element={
                                <ProtectedRoute>
                                  <VendorPortalLayout>
                                    <LazyRoute module="Vendor Portal">
                                      <VendorPurchaseOrders />
                                    </LazyRoute>
                                  </VendorPortalLayout>
                                </ProtectedRoute>
                              }
                            />
                            <Route
                              path="/vendor-portal/purchase-orders/:id"
                              element={
                                <ProtectedRoute>
                                  <VendorPortalLayout>
                                    <LazyRoute module="Vendor Portal">
                                      <VendorPODetail />
                                    </LazyRoute>
                                  </VendorPortalLayout>
                                </ProtectedRoute>
                              }
                            />
                            <Route
                              path="/vendor-portal/rfqs"
                              element={
                                <ProtectedRoute>
                                  <VendorPortalLayout>
                                    <LazyRoute module="Vendor Portal">
                                      <VendorRFQs />
                                    </LazyRoute>
                                  </VendorPortalLayout>
                                </ProtectedRoute>
                              }
                            />
                            <Route
                              path="/vendor-portal/rfqs/:id"
                              element={
                                <ProtectedRoute>
                                  <VendorPortalLayout>
                                    <LazyRoute module="Vendor Portal">
                                      <VendorRFQDetail />
                                    </LazyRoute>
                                  </VendorPortalLayout>
                                </ProtectedRoute>
                              }
                            />
                            <Route
                              path="/vendor-portal/profile"
                              element={
                                <ProtectedRoute>
                                  <VendorPortalLayout>
                                    <LazyRoute module="Vendor Portal">
                                      <VendorProfile />
                                    </LazyRoute>
                                  </VendorPortalLayout>
                                </ProtectedRoute>
                              }
                            />

                            {/* 404 */}
                            <Route path="*" element={<NotFound />} />
                          </Routes>
                          </OnboardingGate>
                          </DocumentPreviewProvider>
                          </CommandPaletteProvider>
                          </AuthenticatedShell>
                          <GlobalAIAssistant />
                          <MissingMappingsDialog />
                        </Router>
                        </AIAssistantProvider>

                            </TooltipProvider>
                          </RealtimeSyncProvider>
                        </ReadOnlyModeProvider>
                      </SubscriptionAccessProvider>
                    </NavigationModeProvider>
                    </ReportContextProvider>
                  </CurrencyProvider>

                </BranchProvider>
              </BusinessProvider>
            </OrganizationProvider>
          </SessionProvider>
          </PlatformIdentityProvider>
        </AuthProvider>
        </ConnectivityProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </SentryErrorBoundary>
);

export default App;
