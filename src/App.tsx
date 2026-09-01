import { Suspense, lazy } from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, HashRouter, Routes, Route, Navigate, useParams } from "react-router-dom";
import { isElectron } from "@/lib/environment";
import { AuthProvider } from "@/contexts/AuthContext";
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
import { RedirectIfAuthenticated } from "@/components/auth/RedirectIfAuthenticated";
import { InstitutionRoute } from "@/components/auth/InstitutionRoute";
import { PermissionProtectedRoute } from "@/components/auth/PermissionProtectedRoute";
import { AppInstalledGate } from "@/components/apps/AppInstalledGate";
import { SentryErrorBoundary } from "@/components/error/SentryErrorBoundary";
import { RouteLoadingFallback } from "@/components/common/RouteLoadingFallback";
import { RealtimeSyncProvider } from "./providers/RealtimeSyncProvider";
import { GlobalAIAssistant } from "./components/ai/GlobalAIAssistant";
import { AIAssistantProvider } from "@/contexts/AIAssistantContext";
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
import ForgotPassword from "./pages/ForgotPassword";
import ResetPassword from "./pages/ResetPassword";
import Dashboard from "./pages/Dashboard";
import Team from "./pages/Team";
import Settings from "./pages/Settings";
const WorkspaceSettings = lazy(() => import("./pages/settings/WorkspaceSettings"));
const CompanySettings = lazy(() => import("./pages/settings/CompanySettings"));
const GovernanceSoD = lazy(() => import("./pages/settings/GovernanceSoD"));
import OnboardingSetup from "./pages/OnboardingSetup";
import NotFound from "./pages/NotFound";
import Notifications from "./pages/Notifications";
import Home from "./pages/Home";
import { PrintRecoveryMount } from "@/components/printing/PrintRecoveryMount";

// Vendor Portal (lazy)

// ============================================
// LAZY IMPORTS (Only standalone modules that stay standalone)
// ============================================
import {
  // Studio & Compliance (platform-level, stay standalone)
  Studio,
  Compliance,
  FiscalComplianceWorkspace,
  AuditLogs,
} from "./routes/-lazyRoutes";

// ============================================
// APP MODULES (Odoo-style app navigation)
// ============================================
const MigrationPage = lazy(() => import("@/pages/settings/MigrationPage"));
const BranchNullDiagnostic = lazy(() => import("@/pages/diagnostics/BranchNullDiagnostic"));
const PrintLatencyDiagnostic = lazy(() => import("@/pages/diagnostics/PrintLatency"));
const UserProfilePage = lazy(() => import("@/pages/settings/UserProfilePage"));
const CarriersSettings = lazy(() => import("@/pages/settings/Carriers"));
const FinanceApp = lazy(() => import("@/apps/finance/routes"));
const ContactsApp = lazy(() => import("@/apps/contacts/routes"));
const HRApp = lazy(() => import("@/apps/hr/routes"));
// My Workspace — employee self-service shell (not an installable app, gated by employment)
const MeApp = lazy(() => import("@/apps/me/MeApp"));
// Scanner pairing page — mounted at top level (NOT under /pos/*) so that
// non-POS modules (Inventory, Sales, Purchases, etc.) can pair a phone
// without the POS subscription gate redirecting the phone to /dashboard.
// See .lovable/plan.md "Move scanner pairing route out of POS subscription gate".

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
          <SessionProvider>
            <OrganizationProvider>
              <BusinessProvider>
                <BranchProvider>
                  <CurrencyProvider>
                    <ReportContextProvider>
                    <NavigationModeProvider>

                        <ReadOnlyModeProvider>
                          <RealtimeSyncProvider>
                            <TooltipProvider>
                              <Toaster />
                              <Sonner />
                              <ConnectivityBanner />
                              {/* Print recovery: reclaim print jobs stranded by a crashed session. */}
                              <PrintRecoveryMount />
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

                           {/* Public: the learning library shows videos the platform
                               admin published for a public audience (RLS enforces
                               that); signed-in users additionally see internal ones. */}
                           <Route path="/forgot-password" element={<RedirectIfAuthenticated><ForgotPassword /></RedirectIfAuthenticated>} />

                            <Route path="/reset-password" element={<RedirectIfAuthenticated allowRecoveryHash><ResetPassword /></RedirectIfAuthenticated>} />
                            <Route path="/accept-invitation" element={<AcceptInvitation />} />

                            {/* Scanner pairing — universal infrastructure, NOT POS-only.
                                Must live outside /pos/* so InstitutionRoute
                                doesn't bounce non-POS pairings (Inventory, Sales, …)
                                to /dashboard. Only needs ProtectedRoute (auth). */}
                            {/* Back-compat: legacy QRs in the wild still use /pos/scan/:token.
                                Declared at top level so it wins over the /pos/* subtree
                                (react-router v6 picks the more-specific match) and dodges
                                the POS subscription gate. */}


                            
                            {/* Auth-only routes (no subscription check) */}
                            {/* Legacy mounts — consolidated reports now live inside the
                                Finance reports shell so the sidebar & reports nav reach them. */}
                            <Route path="/reports/consolidation" element={<Navigate to="/finance/reports/cross-company" replace />} />
                            <Route path="/reports/consolidated-trial-balance" element={<Navigate to="/finance/reports/consolidated-trial-balance" replace />} />
                            <Route path="/reports/consolidated-statements" element={<Navigate to="/finance/reports/consolidated-statements" replace />} />
                            <Route path="/reports/intercompany" element={<Navigate to="/finance/reports/intercompany" replace />} />
                           <Route path="/settings" element={<ProtectedRoute><NonVendorRoute><Settings /></NonVendorRoute></ProtectedRoute>} />
                           <Route path="/settings/workspace" element={<ProtectedRoute><NonVendorRoute><PortalUserRoute><Suspense fallback={<RouteLoadingFallback />}><WorkspaceSettings /></Suspense></PortalUserRoute></NonVendorRoute></ProtectedRoute>} />
                           <Route path="/settings/company" element={<ProtectedRoute><NonVendorRoute><PortalUserRoute><Suspense fallback={<RouteLoadingFallback />}><CompanySettings /></Suspense></PortalUserRoute></NonVendorRoute></ProtectedRoute>} />
                            <Route path="/settings/team" element={<InstitutionRoute requiredFeature="team_management" allowReadOnly><PortalUserRoute><Team /></PortalUserRoute></InstitutionRoute>} />
                            <Route path="/settings/studio" element={<ProtectedRoute><NonVendorRoute><PortalUserRoute><LazyRoute module="Studio"><Studio /></LazyRoute></PortalUserRoute></NonVendorRoute></ProtectedRoute>} />
                            <Route path="/settings/audit-logs" element={<InstitutionRoute allowReadOnly><PortalUserRoute><LazyRoute module="Audit Logs"><AuditLogs /></LazyRoute></PortalUserRoute></InstitutionRoute>} />
                            <Route path="/settings/compliance" element={<InstitutionRoute allowReadOnly><PortalUserRoute><LazyRoute module="Compliance"><Compliance /></LazyRoute></PortalUserRoute></InstitutionRoute>} />
                            <Route path="/settings/governance/sod" element={<ProtectedRoute><NonVendorRoute><PortalUserRoute><Suspense fallback={<RouteLoadingFallback />}><GovernanceSoD /></Suspense></PortalUserRoute></NonVendorRoute></ProtectedRoute>} />
                            <Route path="/settings/migration" element={<ProtectedRoute><NonVendorRoute><PortalUserRoute><LazyRoute module="Migration"><MigrationPage /></LazyRoute></PortalUserRoute></NonVendorRoute></ProtectedRoute>} />
                            <Route path="/settings/diagnostics/branch-null" element={<ProtectedRoute><NonVendorRoute><PortalUserRoute><LazyRoute module="Branch-NULL Diagnostic"><BranchNullDiagnostic /></LazyRoute></PortalUserRoute></NonVendorRoute></ProtectedRoute>} />
                            <Route path="/settings/diagnostics/print-latency" element={<ProtectedRoute><NonVendorRoute><PortalUserRoute><LazyRoute module="Print Latency Diagnostic"><PrintLatencyDiagnostic /></LazyRoute></PortalUserRoute></NonVendorRoute></ProtectedRoute>} />
                            <Route path="/settings/profile" element={<ProtectedRoute><LazyRoute module="Profile"><UserProfilePage /></LazyRoute></ProtectedRoute>} />
                            <Route path="/settings/carriers" element={<ProtectedRoute><NonVendorRoute><PortalUserRoute><LazyRoute module="Carriers"><CarriersSettings /></LazyRoute></PortalUserRoute></NonVendorRoute></ProtectedRoute>} />
                            <Route path="/notifications" element={<ProtectedRoute><NonVendorRoute><Notifications /></NonVendorRoute></ProtectedRoute>} />



                            {/* ============================================== */}
                            {/* CORE STANDALONE ROUTES (kept as-is)            */}
                            {/* ============================================== */}
                            <Route
                              path="/home"
                              element={<InstitutionRoute><PortalUserRoute><Home /></PortalUserRoute></InstitutionRoute>}
                            />
                            <Route
                              path="/dashboard"
                              element={<InstitutionRoute><PortalUserRoute><Dashboard /></PortalUserRoute></InstitutionRoute>}
                            />
                            <Route
                              path="/team"
                              element={<InstitutionRoute requiredFeature="team_management" allowReadOnly><Team /></InstitutionRoute>}
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
                                <InstitutionRoute allowReadOnly>
                                  <LazyRoute module="Compliance"><Compliance /></LazyRoute>
                                </InstitutionRoute>
                              }
                            />
                            <Route
                              path="/compliance/etims"
                              element={
                                <InstitutionRoute allowReadOnly>
                                  <LazyRoute module="FiscalComplianceWorkspace">
                                    <FiscalComplianceWorkspace />
                                  </LazyRoute>
                                </InstitutionRoute>
                              }
                            />


                            {/* ============================================== */}
                            {/* APP-BASED ROUTES (Odoo-style navigation)       */}
                            {/* ============================================== */}
                            
                            {/* Finance App */}
                            <Route
                              path="/finance/*"
                              element={
                                <InstitutionRoute allowReadOnly>
                                  <PortalUserRoute>
                                    <LazyRoute module="Finance">
                                      <FinanceApp />
                                    </LazyRoute>
                                  </PortalUserRoute>
                                </InstitutionRoute>
                              }
                            />
                            
                            {/* Sales App */}
                            
                            {/* Contacts App */}
                            <Route
                              path="/contacts-app/*"
                              element={
                                <InstitutionRoute allowReadOnly>
                                  <PortalUserRoute>
                                    <LazyRoute module="Contacts">
                                      <ContactsApp />
                                    </LazyRoute>
                                  </PortalUserRoute>
                                </InstitutionRoute>
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
                                <InstitutionRoute allowReadOnly>
                                  <PortalUserRoute>
                                    <LazyRoute module="HR">
                                      <HRApp />
                                    </LazyRoute>
                                  </PortalUserRoute>
                                </InstitutionRoute>
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
                    </NavigationModeProvider>
                    </ReportContextProvider>
                  </CurrencyProvider>

                </BranchProvider>
              </BusinessProvider>
            </OrganizationProvider>
          </SessionProvider>
        </AuthProvider>
        </ConnectivityProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </SentryErrorBoundary>
);

export default App;
