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
import { AIAssistantProvider } from "@/contexts/AIAssistantContext";
import { SubscriptionAccessProvider } from "@/contexts/SubscriptionAccessContext";
import { ReadOnlyModeProvider } from "@/contexts/ReadOnlyModeContext";
import { AuthenticatedShell } from "@/components/auth/AuthenticatedShell";
import { OnboardingGate } from "@/components/auth/OnboardingGate";
import { CommandPaletteProvider } from "@/providers/CommandPaletteProvider";
import { DocumentPreviewProvider } from "@/components/documents/DocumentPreviewProvider";
import { ConnectivityProvider } from "@/contexts/ConnectivityContext";
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
  AdminEmailComposePage,
  AdminEmailCampaignCreatePage,
  AdminEmailTemplateCreatePage,
  AdminEmailTemplateEditPage,
  AdminEmailAutomationEditPage,
  AdminDemoRequestReplyPage,
  AdminOrgEntitlementOverrideCreatePage,
  AdminOrgEntitlementOverrideEditPage,
  AdminDemoVideoCreatePage,
  AdminDemoVideoEditPage,
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
const BranchNullDiagnostic = lazy(() => import("@/pages/diagnostics/BranchNullDiagnostic"));
const PrintLatencyDiagnostic = lazy(() => import("@/pages/diagnostics/PrintLatency"));
const UserProfilePage = lazy(() => import("@/pages/settings/UserProfilePage"));
const CarriersSettings = lazy(() => import("@/pages/settings/Carriers"));
const AppsAndSubscriptions = lazy(() => import("@/pages/settings/AppsAndSubscriptions"));
const FinanceApp = lazy(() => import("@/apps/finance/routes"));
const ContactsApp = lazy(() => import("@/apps/contacts/routes"));
// Wave 5 (Phase 3): hardware lifted out of POS to platform.
const HRApp = lazy(() => import("@/apps/hr/routes"));
// My Workspace — employee self-service shell (not an installable app, gated by employment)
const MeApp = lazy(() => import("@/apps/me/MeApp"));
// Scanner pairing page — mounted at top level (NOT under /pos/*) so that
// non-POS modules (Inventory, Sales, Purchases, etc.) can pair a phone
// without the POS subscription gate redirecting the phone to /dashboard.
// See .lovable/plan.md "Move scanner pairing route out of POS subscription gate".
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
                              
                              {/* AccrualFlow Edge: hydrate browser runtime from device_assignments (station-scoped rows) and route HTTPS-origin jobs through Supabase. */}
                              
                              {/* Phase 3 hardware platform: feed active org/business into the exec-log writer. */}
                              
                              {/* Track 1 event fabric: drain business_event_outbox → BusinessSaga handlers (labels, GRN, transfers, shipping). */}
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
                            {/* Back-compat: legacy QRs in the wild still use /pos/scan/:token.
                                Declared at top level so it wins over the /pos/* subtree
                                (react-router v6 picks the more-specific match) and dodges
                                the POS subscription gate. */}


                            
                            {/* Auth-only routes (no subscription check) */}
                            <Route path="/upgrade" element={<ProtectedRoute><NonVendorRoute><PortalUserRoute><Upgrade /></PortalUserRoute></NonVendorRoute></ProtectedRoute>} />
                            <Route path="/billing" element={<ProtectedRoute><NonVendorRoute><PortalUserRoute><Suspense fallback={<RouteLoadingFallback />}><BillingHistory /></Suspense></PortalUserRoute></NonVendorRoute></ProtectedRoute>} />
                            {/* Legacy mounts — consolidated reports now live inside the
                                Finance reports shell so the sidebar & reports nav reach them. */}
                            <Route path="/reports/consolidation" element={<Navigate to="/finance/reports/cross-company" replace />} />
                            <Route path="/reports/consolidated-trial-balance" element={<Navigate to="/finance/reports/consolidated-trial-balance" replace />} />
                            <Route path="/reports/consolidated-statements" element={<Navigate to="/finance/reports/consolidated-statements" replace />} />
                            <Route path="/reports/intercompany" element={<Navigate to="/finance/reports/intercompany" replace />} />
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
                            <Route path="/notifications" element={<ProtectedRoute><NonVendorRoute><Notifications /></NonVendorRoute></ProtectedRoute>} />



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
                            
                            {/* Inventory App */}

                            {/* Warehouse App (WMS execution layer — ADR 0079) */}

                            {/* Warehouse mobile / RF shell (Phase 13) */}
                            
                            
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
                            
                            {/* Projects App */}

                            {/* POS App (unified route) */}

                            {/* Hardware surface removed with the POS/Inventory domains. */}



                            {/* SMS App */}


                            
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

                            {/* 404 */}
                            <Route path="*" element={<NotFound />} />
                          </Routes>
                          </OnboardingGate>
                          </DocumentPreviewProvider>
                          </CommandPaletteProvider>
                          </AuthenticatedShell>
                          <GlobalAIAssistant />
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
